/**
 * QB-INVOICE-1A — a tenant's QuickBooks connection: storage, refresh,
 * disconnect and health.
 *
 * ── STORAGE (NO MIGRATION) ──────────────────────────────────────────────────
 *
 * One `integrations` row, keyed by the existing composite primary key
 * (business_id, provider='quickbooks'). `provider` is a free string, so the new
 * key needs no schema change, and the primary key makes a duplicate row for one
 * tenant impossible. 'quickbooks' is deliberately NOT the legacy 'qbo' key, so no
 * retired reader or writer can ever touch these rows.
 *
 *     access_token   sealed envelope: {s:'connected', t:<access token>, by, at}
 *                    or a tombstone:  {s:'disconnected', r:<reason>, at, by?}
 *                    (by/at: the FreezerIQ user who authorised or disconnected,
 *                    and when — the minimal audit record, kept with no migration)
 *     refresh_token  sealed envelope: {t:<refresh token>, exp, hx, lease?, amb?}  — null once disconnected
 *                    (exp = rolling expiry, hx = Intuit's 5-year hard expiry when
 *                    reported, amb = a refresh whose outcome we could not read)
 *     expires_at     access-token expiry (not sensitive)
 *     realm_id       sealed QuickBooks company id — re-sealed (under the current
 *                    key) whenever the whole row is written: connect, a successful
 *                    refresh commit, and a tombstone. The refresh lease claim and
 *                    release touch refresh_token only. KEPT on disconnect so a later
 *                    reconnect to a different company is detected, not absorbed.
 *                    (Encryption-key rotation is an operational procedure — see
 *                    docs/ai/QUICKBOOKS_INTEGRATION.md "Encryption-key rotation".)
 *
 * Every sealed value is bound to this tenant and this column
 * (lib/integrationTokenCrypto.ts), so a value copied between rows opens to null.
 *
 * ── CONNECTING: VERIFY, THEN BIND UNDER A PER-COMPANY LOCK ──────────────────
 *
 * The realmId arrives on the callback URL, which the browser can alter. Before
 * anything is stored, a read-only CompanyInfo call proves the new tokens really
 * belong to that realm. The one-company-one-tenant check and the write then run
 * inside a transaction holding a Postgres advisory lock keyed on the company, so
 * two tenants connecting the same company at once cannot both succeed.
 *
 * A grant FreezerIQ refuses to store is never revoked. Intuit's revocation
 * removes the app's access to the whole company, so revoking a refused grant can
 * disconnect a connection that another tenant — or this tenant, a moment
 * earlier — legitimately holds for that same company. An unstored grant cannot be
 * used by anyone and expires unused.
 *
 * ── REFRESH: ONE OWNER, COMPARE-AND-SWAP ────────────────────────────────────
 *
 * Intuit rotates refresh tokens, and a rotated token is dead immediately. Two
 * requests refreshing at once would each send the same token and one would be
 * refused. Serverless instances do not share memory, so an in-process lock alone
 * cannot prevent that. The protocol here:
 *
 *   1. CLAIM: write a lease into the refresh envelope with
 *      `updateMany where refresh_token = <exactly what I read>`. Every write
 *      produces a new ciphertext (random IV), so exactly one concurrent claimant
 *      matches; the rest see count 0.
 *   2. The lease holder alone calls Intuit. Other requests use the stored access
 *      token while it is still valid, or wait for the holder's result.
 *   3. COMMIT over my own claim, retrying a transient database error so a
 *      rotated token Intuit has already issued is not simply dropped.
 *   4. If the row moved under the claim, the result is reconciled rather than
 *      thrown away: a takeover that is still using the token I just rotated, or
 *      that concluded "revoked" because of my rotation, is healed with my newer
 *      token. A result that is not stored is never revoked — not even after an
 *      admin disconnect: revocation removes the app's access to the whole
 *      company, and by then another tenant may legitimately hold that company.
 *
 * An in-process single-flight map sits in front so one instance does not even
 * contend with itself.
 *
 * Nothing in this module logs or returns a token, the realm id or a client
 * secret. Logs carry event codes and Intuit's `intuit_tid` only.
 */

import { prisma } from '@/lib/db';
import {
    integrationTokenKeys,
    openIntegrationSecret,
    sealIntegrationSecret,
    type SealContext,
} from '@/lib/integrationTokenCrypto';
import { QUICKBOOKS_PROVIDER, type QuickBooksConfig, type QuickBooksEnvironment } from '@/lib/quickbooks/config';
import {
    IntuitError,
    fetchCompanyInfo,
    isValidRealmId,
    refreshAccessToken,
    revokeToken,
    type FetchLike,
    type IntuitTokenSet,
} from '@/lib/quickbooks/intuitClient';

export type QuickBooksDb = Pick<typeof prisma, 'integration' | '$transaction'>;

export type DisconnectReason =
    /** A tenant admin disconnected in FreezerIQ. */
    | 'admin_disconnect'
    /** Intuit refused the refresh token (disconnected in QuickBooks, or revoked). */
    | 'revoked'
    /** The rolling or 5-year refresh-token lifetime ended. */
    | 'refresh_expired'
    /** A refresh whose result could not be read was followed by a refusal: the rotated token was lost on our side. */
    | 'refresh_lost';

/** Access is refreshed this long before Intuit's stated expiry. */
const ACCESS_SKEW_MS = 2 * 60 * 1000;
/** While another request refreshes, a stored token with at least this long left is still handed out. */
const USABLE_MARGIN_MS = 30 * 1000;
/**
 * How long a refresh claim is honoured: twice the 30s refresh timeout, so a live
 * holder is essentially never overtaken.
 */
const LEASE_MS = 60 * 1000;
/** Commits are retried only while this much of the lease remains. */
const COMMIT_LEASE_RESERVE_MS = 5 * 1000;
const WAIT_STEP_MS = 250;
/** Longest a request waits for another request's refresh (covers the 30s Intuit timeout). */
const WAIT_BUDGET_MS = 40 * 1000;
/** Upper bound on waits regardless of the clock (tests use a frozen clock). */
const MAX_WAITS = 200;
/** Lost compare-and-swap races before giving up. */
const MAX_ATTEMPTS = 12;
const MAX_COMMIT_TRIES = 3;

export interface Deps {
    db?: QuickBooksDb;
    fetchImpl?: FetchLike;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

function resolveDeps(deps: Deps = {}) {
    return {
        db: deps.db ?? prisma,
        fetchImpl: deps.fetchImpl ?? fetch,
        env: deps.env ?? process.env,
        now: deps.now ?? Date.now,
        sleep: deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    };
}

export class QuickBooksConnectionError extends Error {
    readonly kind:
        | 'not_connected'
        | 'disconnected'
        | 'unreadable'
        | 'reconnect_required'
        | 'refresh_failed'
        | 'refresh_contended'
        | 'encryption_unavailable';

    constructor(kind: QuickBooksConnectionError['kind']) {
        super(`QuickBooks connection unavailable: ${kind}`);
        Object.setPrototypeOf(this, QuickBooksConnectionError.prototype); // ES5 target; see IntuitError
        this.name = 'QuickBooksConnectionError';
        this.kind = kind;
    }
}

// ── Envelopes ───────────────────────────────────────────────────────────────

interface ConnectedAccess { s: 'connected'; t: string; by: string | null; at: string | null }
interface Tombstone { s: 'disconnected'; r: DisconnectReason; at: string; by: string | null }
interface Lease { id: string; until: number }
interface RefreshEnvelope { t: string; exp: string | null; hx: string | null; lease?: Lease; amb?: string }

/** Who authorised a connection and when. Not a secret, but kept inside the sealed envelope. */
export interface ConnectionAudit {
    by: string | null;
    at: Date | null;
}

const ctx = (businessId: string, field: SealContext['field']): SealContext =>
    ({ provider: QUICKBOOKS_PROVIDER, businessId, field });

async function seal(value: string, businessId: string, field: SealContext['field'], env: NodeJS.ProcessEnv): Promise<string> {
    const sealed = await sealIntegrationSecret(value, ctx(businessId, field), env);
    if (!sealed) throw new QuickBooksConnectionError('encryption_unavailable');
    return sealed;
}

async function openJson(sealed: unknown, businessId: string, field: SealContext['field'], env: NodeJS.ProcessEnv): Promise<any> {
    const plain = await openIntegrationSecret(sealed, ctx(businessId, field), env);
    if (plain === null) return null;
    try {
        const parsed = JSON.parse(plain);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

const DISCONNECT_REASONS: DisconnectReason[] = ['admin_disconnect', 'revoked', 'refresh_expired', 'refresh_lost'];

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

function asAccess(v: any): ConnectedAccess | Tombstone | null {
    if (v?.s === 'connected' && typeof v.t === 'string' && v.t) return { s: 'connected', t: v.t, by: str(v.by), at: str(v.at) };
    if (v?.s === 'disconnected' && DISCONNECT_REASONS.includes(v.r)) {
        return { s: 'disconnected', r: v.r, at: typeof v.at === 'string' ? v.at : '', by: str(v.by) };
    }
    return null;
}

function asRefresh(v: any): RefreshEnvelope | null {
    if (typeof v?.t !== 'string' || !v.t) return null;
    const lease = v.lease && typeof v.lease.id === 'string' && typeof v.lease.until === 'number'
        ? { id: v.lease.id, until: v.lease.until }
        : undefined;
    return { t: v.t, exp: str(v.exp), hx: str(v.hx), lease, amb: str(v.amb) ?? undefined };
}

function validDate(iso: string | null | undefined): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function leaseId(): string {
    const b = new Uint8Array(12);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type StoredConnection =
    | { kind: 'none' }
    | { kind: 'unreadable'; sealedAccess: string }
    | {
        kind: 'disconnected';
        reason: DisconnectReason;
        at: Date | null;
        /** The admin who disconnected, when it was an admin action. */
        by: string | null;
        /** null when the stored realm cannot be opened. */
        realmId: string | null;
        sealedAccess: string;
    }
    | {
        kind: 'connected';
        realmId: string;
        accessToken: string;
        accessExpiresAt: Date | null;
        refreshToken: string;
        refreshExpiresAt: Date | null;
        /** Intuit's absolute 5-year limit for this authorization, when reported. */
        hardExpiresAt: Date | null;
        lease: Lease | null;
        /** Set when a refresh reached Intuit but its result could not be read. */
        ambiguousSince: Date | null;
        /** Who authorised this connection, and when. Preserved across refreshes. */
        audit: ConnectionAudit;
        sealedAccess: string;
        sealedRefresh: string;
    };

type ConnectedConnection = Extract<StoredConnection, { kind: 'connected' }>;

/** The tenant's stored connection. The business id is the only key it accepts. */
export async function loadQuickBooksConnection(businessId: string, deps: Deps = {}): Promise<StoredConnection> {
    const { db, env } = resolveDeps(deps);
    const row = await db.integration.findUnique({
        where: { business_id_provider: { business_id: businessId, provider: QUICKBOOKS_PROVIDER } },
    });
    if (!row) return { kind: 'none' };

    const access = asAccess(await openJson(row.access_token, businessId, 'access_token', env));
    if (!access) return { kind: 'unreadable', sealedAccess: row.access_token };

    const realmPlain = row.realm_id ? await openIntegrationSecret(row.realm_id, ctx(businessId, 'realm_id'), env) : null;
    const realmId = isValidRealmId(realmPlain) ? realmPlain : null;

    if (access.s === 'disconnected') {
        return { kind: 'disconnected', reason: access.r, at: validDate(access.at), by: access.by, realmId, sealedAccess: row.access_token };
    }

    const refresh = row.refresh_token ? asRefresh(await openJson(row.refresh_token, businessId, 'refresh_token', env)) : null;
    if (!refresh || !realmId || !row.refresh_token) return { kind: 'unreadable', sealedAccess: row.access_token };

    return {
        kind: 'connected',
        realmId,
        accessToken: access.t,
        accessExpiresAt: row.expires_at ?? null,
        refreshToken: refresh.t,
        refreshExpiresAt: validDate(refresh.exp),
        hardExpiresAt: validDate(refresh.hx),
        lease: refresh.lease ?? null,
        ambiguousSince: validDate(refresh.amb),
        audit: { by: access.by, at: validDate(access.at) },
        sealedAccess: row.access_token,
        sealedRefresh: row.refresh_token,
    };
}

function refreshEnvelope(t: string, exp: Date | null, hx: Date | null, extra: { lease?: Lease; amb?: string } = {}): string {
    return JSON.stringify({ t, exp: iso(exp), hx: iso(hx), ...extra });
}

/** Every column of a connected row, all sealed under the CURRENT key (realm included). */
async function connectedFields(
    businessId: string, realmId: string, tokens: IntuitTokenSet, env: NodeJS.ProcessEnv, now: number,
    audit: ConnectionAudit, previousHardExpiresAt: Date | null = null,
) {
    return {
        access_token: await seal(
            JSON.stringify({ s: 'connected', t: tokens.accessToken, by: audit.by, at: iso(audit.at) }),
            businessId, 'access_token', env,
        ),
        // The hard limit never resets; keep the last known value if a response omits it.
        refresh_token: await seal(
            refreshEnvelope(tokens.refreshToken, tokens.refreshExpiresAt, tokens.hardExpiresAt ?? previousHardExpiresAt),
            businessId, 'refresh_token', env,
        ),
        realm_id: await seal(realmId, businessId, 'realm_id', env),
        expires_at: tokens.accessExpiresAt,
        updated_at: new Date(now),
    };
}

/** A tombstone. The realm is re-sealed under the current key when known, else left as stored. */
async function tombstoneFields(
    businessId: string, reason: DisconnectReason, env: NodeJS.ProcessEnv, now: number,
    realmId: string | null, by: string | null = null,
) {
    return {
        access_token: await seal(
            JSON.stringify({ s: 'disconnected', r: reason, at: new Date(now).toISOString(), by }),
            businessId, 'access_token', env,
        ),
        refresh_token: null,
        expires_at: null,
        updated_at: new Date(now),
        ...(realmId ? { realm_id: await seal(realmId, businessId, 'realm_id', env) } : {}),
    };
}

function where(businessId: string, extra: Record<string, unknown> = {}) {
    return { business_id: businessId, provider: QUICKBOOKS_PROVIDER, ...extra };
}

function tidSuffix(e: unknown): string {
    return e instanceof IntuitError && e.intuitTid ? ` intuit_tid=${e.intuitTid}` : '';
}

// ── Connecting ──────────────────────────────────────────────────────────────

export type SaveOutcome =
    /** Stored for this tenant. */
    | 'connected'
    /** The tokens do not grant access to the realm the redirect named. Nothing stored. */
    | 'realm_unverified'
    /** QuickBooks could not be reached to verify the company. Nothing stored. */
    | 'verification_failed'
    /** The tenant is (or was) bound to a different company. Nothing stored. */
    | 'realm_mismatch'
    /** Another tenant already holds a live connection to this company. Nothing stored. */
    | 'realm_in_use'
    /** The existing row cannot be read, so the company cannot be compared. Nothing stored. */
    | 'reconnect_blocked'
    /** A concurrent write won. Nothing stored. */
    | 'conflict';

/**
 * A lock key for one QuickBooks company. Keyed by the encryption key so the
 * realm id is not recoverable from a database lock listing or statement log.
 * 56 bits keeps it a positive bigint.
 */
async function realmLockKey(realmId: string, env: NodeJS.ProcessEnv): Promise<bigint> {
    const [secret] = integrationTokenKeys(env);
    if (!secret) throw new QuickBooksConnectionError('encryption_unavailable');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`freezeriq/quickbooks-realm-lock/v1|${realmId}`)));
    let n = BigInt(0);
    for (let i = 0; i < 7; i++) n = (n << BigInt(8)) | BigInt(mac[i]);
    return n;
}

/**
 * Binds freshly authorised tokens to the tenant the callback verified.
 *
 * `businessId` must come from the verified OAuth state + session, and `realmId`
 * from Intuit's redirect to that same verified callback. It is accepted only
 * after CompanyInfo confirms the tokens reach that realm — this function is the
 * only place a realm id is ever accepted, and nothing later can change it.
 *
 * Nothing refused here is revoked (see the module comment).
 */
export async function saveAuthorizedConnection(
    input: {
        businessId: string;
        realmId: string;
        tokens: IntuitTokenSet;
        config: QuickBooksConfig;
        /** The FreezerIQ admin whose verified OAuth attempt produced these tokens. */
        authorizedByUserId: string;
    },
    deps: Deps = {},
): Promise<SaveOutcome> {
    const { db, env, now, fetchImpl } = resolveDeps(deps);
    const { businessId, realmId, tokens, config } = input;
    if (!isValidRealmId(realmId)) throw new QuickBooksConnectionError('unreadable');

    const refuse = (outcome: SaveOutcome): SaveOutcome => {
        console.warn(`[quickbooks] authorization not stored: ${outcome}`);
        return outcome;
    };

    // 1. Prove the tokens belong to the realm the redirect named.
    try {
        await fetchCompanyInfo(config, tokens.accessToken, realmId, fetchImpl);
    } catch (e) {
        if (e instanceof IntuitError && e.kind === 'unauthorized') {
            console.warn(`[quickbooks] company verification refused${tidSuffix(e)}`);
            return refuse('realm_unverified');
        }
        console.warn(`[quickbooks] company verification failed: ${e instanceof IntuitError ? e.kind : 'unknown'}${tidSuffix(e)}`);
        return refuse('verification_failed');
    }

    // 2. Check and write under a per-company lock.
    const lockKey = await realmLockKey(realmId, env);
    const t = now();
    const fields = await connectedFields(businessId, realmId, tokens, env, t, { by: input.authorizedByUserId || null, at: new Date(t) });

    const outcome = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;
        const txDeps = { db: tx as unknown as QuickBooksDb, env };

        // One company, one tenant: another tenant's LIVE connection to this realm
        // wins. Rows of other tenants are opened with THEIR context; nothing about
        // them is returned. A row whose refresh token has expired is not live.
        const others = await tx.integration.findMany({
            where: { provider: QUICKBOOKS_PROVIDER, NOT: { business_id: businessId } },
            select: { business_id: true },
        });
        for (const other of others) {
            const conn = await loadQuickBooksConnection(other.business_id, txDeps);
            if (conn.kind !== 'connected' || conn.realmId !== realmId) continue;
            const dead = (conn.refreshExpiresAt !== null && conn.refreshExpiresAt.getTime() <= t)
                || (conn.hardExpiresAt !== null && conn.hardExpiresAt.getTime() <= t);
            if (!dead) return 'realm_in_use' as const;
        }

        const existing = await loadQuickBooksConnection(businessId, txDeps);
        if (existing.kind === 'none') {
            try {
                await tx.integration.create({ data: { business_id: businessId, provider: QUICKBOOKS_PROVIDER, ...fields } });
                return 'connected' as const;
            } catch (e: any) {
                if (e?.code === 'P2002') return 'conflict' as const;
                throw e;
            }
        }
        if (existing.kind === 'unreadable') return 'reconnect_blocked' as const;
        if (existing.kind === 'disconnected' && existing.realmId === null) return 'reconnect_blocked' as const;
        if (existing.realmId !== realmId) return 'realm_mismatch' as const;

        const res = await tx.integration.updateMany({
            where: where(businessId, { access_token: existing.sealedAccess }),
            data: fields,
        });
        return res.count === 1 ? ('connected' as const) : ('conflict' as const);
    }, { maxWait: 10_000, timeout: 15_000 });

    return outcome === 'connected' ? outcome : refuse(outcome);
}

// ── Using ───────────────────────────────────────────────────────────────────

export interface QuickBooksAccess {
    accessToken: string;
    /** Always the tenant's stored realm. */
    realmId: string;
}

const inflight = new Map<string, Promise<QuickBooksAccess>>();

/**
 * A usable access token for the tenant, refreshing server-side when needed.
 *
 * `rejectedAccessToken`: the API just refused this token although its clock
 * expiry had not passed. It is refreshed only if it is STILL the stored token —
 * if another request already replaced it, the replacement is used instead.
 */
export function getQuickBooksAccess(
    input: { businessId: string; config: QuickBooksConfig; rejectedAccessToken?: string },
    deps: Deps = {},
): Promise<QuickBooksAccess> {
    const key = `${input.businessId}|${input.rejectedAccessToken ? 'forced' : 'normal'}`;
    const running = inflight.get(key);
    if (running) return running;
    const p = accessLoop(input, deps).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

async function accessLoop(
    input: { businessId: string; config: QuickBooksConfig; rejectedAccessToken?: string },
    deps: Deps,
): Promise<QuickBooksAccess> {
    const { db, env, now, sleep, fetchImpl } = resolveDeps(deps);
    const { businessId, config } = input;
    const waitDeadline = now() + WAIT_BUDGET_MS;
    let waits = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const conn = await loadQuickBooksConnection(businessId, { db, env });
        if (conn.kind === 'none') throw new QuickBooksConnectionError('not_connected');
        if (conn.kind === 'disconnected') throw new QuickBooksConnectionError('disconnected');
        if (conn.kind === 'unreadable') throw new QuickBooksConnectionError('unreadable');

        const t = now();
        const forced = !!input.rejectedAccessToken && input.rejectedAccessToken === conn.accessToken;
        const expiresMs = conn.accessExpiresAt ? conn.accessExpiresAt.getTime() : -Infinity;
        if (!forced && expiresMs - ACCESS_SKEW_MS > t) return { accessToken: conn.accessToken, realmId: conn.realmId };

        const refreshDead = (conn.refreshExpiresAt !== null && conn.refreshExpiresAt.getTime() <= t)
            || (conn.hardExpiresAt !== null && conn.hardExpiresAt.getTime() <= t);
        if (refreshDead) {
            await db.integration.updateMany({
                where: where(businessId, { refresh_token: conn.sealedRefresh }),
                data: await tombstoneFields(businessId, 'refresh_expired', env, t, conn.realmId),
            });
            throw new QuickBooksConnectionError('reconnect_required');
        }

        // Someone else holds a live claim.
        if (conn.lease && conn.lease.until > t) {
            // The stored token still works for a while: use it rather than wait.
            if (!forced && expiresMs - USABLE_MARGIN_MS > t) return { accessToken: conn.accessToken, realmId: conn.realmId };
            if (waits < MAX_WAITS && now() < waitDeadline) {
                waits++;
                attempt--; // waiting is not a lost race
                await sleep(WAIT_STEP_MS);
                continue;
            }
            throw new QuickBooksConnectionError('refresh_contended');
        }

        // 1. CLAIM
        const lease: Lease = { id: leaseId(), until: t + LEASE_MS };
        const amb = conn.ambiguousSince ? { amb: conn.ambiguousSince.toISOString() } : {};
        const leased = await seal(
            refreshEnvelope(conn.refreshToken, conn.refreshExpiresAt, conn.hardExpiresAt, { lease, ...amb }),
            businessId, 'refresh_token', env,
        );
        const claim = await db.integration.updateMany({
            where: where(businessId, { refresh_token: conn.sealedRefresh }),
            data: { refresh_token: leased },
        });
        if (claim.count !== 1) continue; // lost the claim; re-read

        // 2. Only the lease holder reaches Intuit.
        let tokens: IntuitTokenSet;
        try {
            tokens = await refreshAccessToken(config, conn.refreshToken, fetchImpl, now);
        } catch (e) {
            if (e instanceof IntuitError && e.kind === 'invalid_grant') {
                // Only conclude anything if my claim still stands. If the row moved,
                // someone else refreshed (Intuit rejects a rotated token) — re-read.
                const reason: DisconnectReason = conn.ambiguousSince ? 'refresh_lost' : 'revoked';
                const marked = await db.integration.updateMany({
                    where: where(businessId, { refresh_token: leased }),
                    data: await tombstoneFields(businessId, reason, env, now(), conn.realmId),
                });
                if (marked.count !== 1) continue;
                console.warn(`[quickbooks] refresh rejected (invalid_grant); connection marked ${reason}${tidSuffix(e)}`);
                throw new QuickBooksConnectionError('reconnect_required');
            }
            // Not a refusal: release the claim so a later request can try. If the
            // request may have reached Intuit, remember that — a refusal on the next
            // attempt then means we lost a rotated token, not that the user revoked.
            const ambiguous = e instanceof IntuitError
                && (e.kind === 'network' || (e.kind === 'malformed' && !!e.status && e.status >= 200 && e.status < 300));
            const released = ambiguous
                ? await seal(refreshEnvelope(conn.refreshToken, conn.refreshExpiresAt, conn.hardExpiresAt, { amb: new Date(now()).toISOString() }), businessId, 'refresh_token', env)
                : conn.sealedRefresh;
            await db.integration.updateMany({
                where: where(businessId, { refresh_token: leased }),
                data: { refresh_token: released },
            });
            console.warn(`[quickbooks] refresh failed: ${e instanceof IntuitError ? e.kind : 'unknown'}${ambiguous ? ' (outcome unknown)' : ''}${tidSuffix(e)}`);
            throw new QuickBooksConnectionError('refresh_failed');
        }

        // 3. COMMIT over my own claim, surviving a transient database error.
        const data = await connectedFields(businessId, conn.realmId, tokens, env, now(), conn.audit, conn.hardExpiresAt);
        const committed = await commitOverClaim(businessId, leased, data, lease, { db, now, sleep });
        if (committed === 'committed') return { accessToken: tokens.accessToken, realmId: conn.realmId };
        if (committed === 'unavailable') {
            console.warn('[quickbooks] refresh_commit_failed; rotated token not stored');
            throw new QuickBooksConnectionError('refresh_failed');
        }

        // 4. The row moved under my claim. Reconcile.
        const healed = await reconcileAfterLostCommit(businessId, conn, tokens, t, { db, env, now, fetchImpl, config });
        if (healed) return { accessToken: tokens.accessToken, realmId: conn.realmId };
    }
    throw new QuickBooksConnectionError('refresh_contended');
}

/**
 * Writes the refreshed tokens where the row still holds my claim. A thrown write
 * may or may not have landed, so the row is re-read before retrying.
 */
async function commitOverClaim(
    businessId: string,
    leased: string,
    data: Awaited<ReturnType<typeof connectedFields>>,
    lease: Lease,
    d: { db: QuickBooksDb; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<'committed' | 'moved' | 'unavailable'> {
    for (let tryNo = 0; tryNo < MAX_COMMIT_TRIES; tryNo++) {
        try {
            const res = await d.db.integration.updateMany({ where: where(businessId, { refresh_token: leased }), data });
            return res.count === 1 ? 'committed' : 'moved';
        } catch {
            try {
                const row = await d.db.integration.findUnique({
                    where: { business_id_provider: { business_id: businessId, provider: QUICKBOOKS_PROVIDER } },
                    select: { refresh_token: true },
                });
                if (row?.refresh_token === data.refresh_token) return 'committed'; // the write landed
                if (row?.refresh_token !== leased) return 'moved';
            } catch {
                // database still unavailable: retry while the lease lasts
            }
            if (d.now() >= lease.until - COMMIT_LEASE_RESERVE_MS) break;
            await d.sleep(WAIT_STEP_MS);
        }
    }
    return 'unavailable';
}

/**
 * My refresh succeeded at Intuit, but the row no longer holds my claim.
 *
 *   - still connected with the token I just used (someone took over the lease and
 *     is sending that now-dead token): store my newer token over theirs;
 *   - tombstoned 'revoked' at or after my claim (the takeover was refused BECAUSE
 *     my refresh rotated the token): restore the connection with my token;
 *   - disconnected by an admin, or gone: discard mine WITHOUT revoking. The admin's
 *     disconnect already revoked the token it could see; revoking this late result
 *     too could cut off another tenant that connected the same company in the
 *     meantime (Intuit revocation is company-wide). It is never stored and expires
 *     unused — the same treatment as any refused grant;
 *   - connected with a DIFFERENT token (a newer result is stored): discard mine,
 *     and do not revoke, since revocation would disconnect the company.
 *
 * Returns true when my token was stored.
 */
async function reconcileAfterLostCommit(
    businessId: string,
    mine: ConnectedConnection,
    tokens: IntuitTokenSet,
    claimedAt: number,
    d: { db: QuickBooksDb; env: NodeJS.ProcessEnv; now: () => number; fetchImpl: FetchLike; config: QuickBooksConfig },
): Promise<boolean> {
    for (let tryNo = 0; tryNo < 3; tryNo++) {
        const after = await loadQuickBooksConnection(businessId, { db: d.db, env: d.env });
        const data = await connectedFields(businessId, mine.realmId, tokens, d.env, d.now(), mine.audit, mine.hardExpiresAt);

        if (after.kind === 'connected' && after.refreshToken === mine.refreshToken) {
            const res = await d.db.integration.updateMany({ where: where(businessId, { refresh_token: after.sealedRefresh }), data });
            if (res.count === 1) {
                console.warn('[quickbooks] refresh reconciled: newer token stored over a takeover');
                return true;
            }
            continue;
        }
        if (after.kind === 'disconnected' && after.reason === 'revoked' && after.realmId === mine.realmId
            && after.at !== null && after.at.getTime() >= claimedAt) {
            const res = await d.db.integration.updateMany({ where: where(businessId, { access_token: after.sealedAccess }), data });
            if (res.count === 1) {
                console.warn('[quickbooks] refresh reconciled: connection restored after a takeover was refused');
                return true;
            }
            continue;
        }
        if (after.kind === 'none' || (after.kind === 'disconnected' && after.reason === 'admin_disconnect')) {
            console.warn('[quickbooks] refresh result discarded (not revoked): connection was disconnected during refresh');
            return false;
        }
        console.warn('[quickbooks] refresh result discarded: a newer token was stored during refresh');
        return false;
    }
    return false;
}

// ── Disconnecting ───────────────────────────────────────────────────────────

export interface DisconnectResult {
    outcome: 'disconnected' | 'already_disconnected' | 'not_connected';
    /** Whether Intuit confirmed revocation. null when there was nothing to revoke. */
    revoked: boolean | null;
}

/**
 * Revokes at Intuit (best effort) and ALWAYS disables local credentials.
 *
 * The tombstone keeps the sealed realm so a later reconnect to a different
 * company is caught, and records when and why — nothing else survives.
 */
export async function disconnectQuickBooks(
    input: { businessId: string; config: QuickBooksConfig; actorUserId?: string },
    deps: Deps = {},
): Promise<DisconnectResult> {
    const { db, env, now, fetchImpl } = resolveDeps(deps);
    const { businessId, config } = input;

    for (let attempt = 0; attempt < 5; attempt++) {
        const conn = await loadQuickBooksConnection(businessId, { db, env });
        if (conn.kind === 'none') return { outcome: 'not_connected', revoked: null };
        if (conn.kind === 'disconnected') return { outcome: 'already_disconnected', revoked: null };

        let revoked: boolean | null = null;
        if (conn.kind === 'connected') {
            const r = await revokeToken(config, conn.refreshToken, fetchImpl);
            revoked = r.revoked;
            if (!r.revoked) {
                console.warn(`[quickbooks] revoke not confirmed${r.status ? ` (HTTP ${r.status})` : ''}${r.intuitTid ? ` intuit_tid=${r.intuitTid}` : ''}; local credentials disabled anyway`);
            }
        }

        const res = await db.integration.updateMany({
            where: where(businessId, { access_token: conn.sealedAccess }),
            data: await tombstoneFields(businessId, 'admin_disconnect', env, now(), conn.kind === 'connected' ? conn.realmId : null, input.actorUserId ?? null),
        });
        if (res.count === 1) return { outcome: 'disconnected', revoked };
        // A refresh committed in between: loop, revoking the newer token too.
    }
    throw new QuickBooksConnectionError('refresh_contended');
}

/**
 * Removes a NON-connected row entirely, so the tenant may authorise a different
 * company. Refuses while connected: disconnect (and revoke) must come first.
 */
export async function forgetQuickBooksConnection(
    input: { businessId: string },
    deps: Deps = {},
): Promise<'forgotten' | 'not_found' | 'still_connected'> {
    const { db, env } = resolveDeps(deps);
    const conn = await loadQuickBooksConnection(input.businessId, { db, env });
    if (conn.kind === 'none') return 'not_found';
    if (conn.kind === 'connected') return 'still_connected';
    const res = await db.integration.deleteMany({ where: where(input.businessId, { access_token: conn.sealedAccess }) });
    return res.count === 1 ? 'forgotten' : 'still_connected';
}

// ── Health ──────────────────────────────────────────────────────────────────

export type QuickBooksHealth =
    | { state: 'not_connected'; environment: QuickBooksEnvironment }
    | { state: 'connected'; environment: QuickBooksEnvironment; companyName: string | null; verifiedAt: string; connectedAt: string | null }
    | { state: 'refresh_required'; environment: QuickBooksEnvironment }
    | {
        state: 'reconnect_required';
        environment: QuickBooksEnvironment;
        cause: 'revoked' | 'refresh_expired' | 'refresh_lost' | 'unreadable' | 'no_company_access';
        /** True when the stored row is no longer a live connection and may be forgotten. */
        canForget: boolean;
    }
    | { state: 'disconnected'; environment: QuickBooksEnvironment; cause: DisconnectReason; disconnectedAt: string | null; canForget: true }
    | { state: 'error'; environment: QuickBooksEnvironment; cause: 'intuit_unavailable' };

/**
 * The truthful status: a stored row is never reported as connected until a live,
 * read-only CompanyInfo call for the tenant's own realm has just succeeded.
 */
export async function checkQuickBooksHealth(
    input: { businessId: string; config: QuickBooksConfig },
    deps: Deps = {},
): Promise<QuickBooksHealth> {
    const d = resolveDeps(deps);
    const { businessId, config } = input;
    const environment = config.environment;

    const stored = await loadQuickBooksConnection(businessId, d);
    if (stored.kind === 'none') return { state: 'not_connected', environment };
    if (stored.kind === 'unreadable') return { state: 'reconnect_required', environment, cause: 'unreadable', canForget: true };
    if (stored.kind === 'disconnected') {
        // A tombstone whose company can no longer be read cannot be reconnected
        // (saveAuthorizedConnection answers reconnect_blocked): only Forget helps.
        if (stored.realmId === null) return { state: 'reconnect_required', environment, cause: 'unreadable', canForget: true };
        if (stored.reason !== 'admin_disconnect') {
            return { state: 'reconnect_required', environment, cause: stored.reason, canForget: true };
        }
        return {
            state: 'disconnected', environment, cause: stored.reason,
            disconnectedAt: stored.at ? stored.at.toISOString() : null, canForget: true,
        };
    }

    const reconnectCause = async (): Promise<QuickBooksHealth> => {
        const now = await loadQuickBooksConnection(businessId, d);
        const cause = now.kind === 'disconnected' && now.reason !== 'admin_disconnect' ? now.reason : 'revoked';
        return { state: 'reconnect_required', environment, cause, canForget: true };
    };

    const fromError = async (e: unknown): Promise<QuickBooksHealth> => {
        if (e instanceof QuickBooksConnectionError) {
            if (e.kind === 'reconnect_required' || e.kind === 'disconnected') return reconnectCause();
            if (e.kind === 'unreadable' || e.kind === 'encryption_unavailable') return { state: 'reconnect_required', environment, cause: 'unreadable', canForget: true };
            if (e.kind === 'not_connected') return { state: 'not_connected', environment };
            return { state: 'refresh_required', environment };
        }
        return { state: 'error', environment, cause: 'intuit_unavailable' };
    };

    let access: QuickBooksAccess;
    try {
        access = await getQuickBooksAccess({ businessId, config }, d);
    } catch (e) {
        return fromError(e);
    }

    for (let tryNo = 0; tryNo < 2; tryNo++) {
        try {
            const info = await fetchCompanyInfo(config, access.accessToken, access.realmId, d.fetchImpl);
            return {
                state: 'connected', environment, companyName: info.companyName,
                verifiedAt: new Date(d.now()).toISOString(),
                connectedAt: stored.audit.at ? stored.audit.at.toISOString() : null,
            };
        } catch (e) {
            if (e instanceof IntuitError && e.kind === 'unauthorized' && tryNo === 0) {
                try {
                    access = await getQuickBooksAccess({ businessId, config, rejectedAccessToken: access.accessToken }, d);
                    continue;
                } catch (inner) {
                    return fromError(inner);
                }
            }
            if (e instanceof IntuitError && e.kind === 'unauthorized') {
                console.warn(`[quickbooks] CompanyInfo refused after refresh${tidSuffix(e)}`);
                return { state: 'reconnect_required', environment, cause: 'no_company_access', canForget: false };
            }
            if (e instanceof IntuitError) {
                console.warn(`[quickbooks] CompanyInfo failed: ${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}${tidSuffix(e)}`);
            }
            return fromError(e);
        }
    }
    return { state: 'error', environment, cause: 'intuit_unavailable' };
}
