/**
 * QB-INVOICE-1A — the stored QuickBooks connection, exercised end to end against
 * an in-memory integrations table with real compare-and-swap and lock semantics,
 * and a fake Intuit that is as strict as the real one where safety depends on it
 * (tokens reach only their own company; a rotated refresh token dies at once).
 *
 * Covers: encrypted persistence, realm verification and binding, cross-tenant
 * isolation (including two tenants racing for one company), refresh rotation,
 * CONCURRENT refresh (one Intuit call, no lost token, no stale overwrite, lease
 * takeover healing), transient database errors on commit, ambiguous refreshes,
 * key rotation, invalid_grant, disconnect + revoke, forget, and the truthful
 * health model including the read-only CompanyInfo proof.
 */

import {
    checkQuickBooksHealth,
    disconnectQuickBooks,
    forgetQuickBooksConnection,
    getQuickBooksAccess,
    loadQuickBooksConnection,
    saveAuthorizedConnection,
} from '@/lib/quickbooks/connection';
import { consumeOAuthAttempt, recordOAuthAttempt, QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER } from '@/lib/quickbooks/oauthAttempt';
import { exchangeAuthorizationCode, IntuitError } from '@/lib/quickbooks/intuitClient';
import { QUICKBOOKS_API_BASE, QUICKBOOKS_MINOR_VERSION } from '@/lib/quickbooks/config';
import {
    captureConsole, fakeIntegrationDb, fakeIntuit, gate, sandboxConfig, sandboxEnv,
    TEST_CLIENT_SECRET, TEST_TOKEN_KEY, TEST_AUTH_SECRET,
} from './helpers/quickbooksFakes';

const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const HOUR = 60 * 60 * 1000;

const config = sandboxConfig();
const env = sandboxEnv();
const noSleep = () => new Promise<void>((r) => setImmediate(r));
const isolated = () => new Promise<any>((resolve) => jest.isolateModules(() => resolve(require('@/lib/quickbooks/connection'))));

/** Polls until the stored refresh envelope carries a lease satisfying `pred`. */
async function untilLeased(businessId: string, deps: any, pred: (lease: any) => boolean = () => true) {
    for (let i = 0; i < 2000; i++) {
        const c: any = await loadQuickBooksConnection(businessId, deps);
        if (c.kind === 'connected' && c.lease && pred(c.lease)) return c.lease;
        await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error('refresh never claimed');
}

function setup(opts: Parameters<typeof fakeIntuit>[0] = {}) {
    const store = fakeIntegrationDb();
    const intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], ...opts });
    let clock = Date.parse('2026-09-13T12:00:00Z');
    const deps = { db: store.db, fetchImpl: intuit.fetchImpl, env, now: () => clock, sleep: noSleep };
    return {
        store, intuit, deps,
        advance: (ms: number) => { clock += ms; },
        /** A genuine consent to `realmId`, then the save. */
        async connect(businessId: string, realmId: string) {
            intuit.consentTo(realmId);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl, deps.now);
            return saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: `admin-of-${businessId}` }, deps);
        },
    };
}

/** Every string an attacker or a log reader must never see in plaintext. */
const SECRET_PATTERN = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|AUTHCODE|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET/;

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · persistence is encrypted and tenant-bound', () => {
    it('stores one row for the tenant, provider "quickbooks", with nothing in plaintext', async () => {
        const t = setup();
        expect(await t.connect(TENANT_A, REALM_1)).toBe('connected');

        const rows = [...t.store.rows.values()];
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.business_id).toBe(TENANT_A);
        expect(row.provider).toBe('quickbooks');
        for (const col of [row.access_token, row.refresh_token, row.realm_id]) {
            expect(col).toMatch(/^v1\./);
            expect(col).not.toMatch(SECRET_PATTERN);
            expect(col).not.toContain(REALM_1);
        }
        expect(row.expires_at).toBeInstanceOf(Date);

        const loaded = await loadQuickBooksConnection(TENANT_A, t.deps);
        expect(loaded).toMatchObject({ kind: 'connected', realmId: REALM_1, accessToken: 'ACCESSTOKEN-SECRET-1', refreshToken: 'REFRESHTOKEN-SECRET-1' });
    });

    it('keeps a minimal audit record: who authorised and when, preserved across refresh; who disconnected and when', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const connectedAt = t.deps.now();
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ audit: { by: `admin-of-${TENANT_A}`, at: new Date(connectedAt) } });

        t.advance(61 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ refreshToken: 'REFRESHTOKEN-SECRET-2', audit: { by: `admin-of-${TENANT_A}`, at: new Date(connectedAt) } });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'connected', connectedAt: new Date(connectedAt).toISOString() });

        await disconnectQuickBooks({ businessId: TENANT_A, config, actorUserId: 'the-admin' }, t.deps);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'admin_disconnect', by: 'the-admin', at: new Date(t.deps.now()) });
        // The audit data lives only inside the sealed envelope.
        expect(JSON.stringify([...t.store.rows.values()])).not.toMatch(/admin-of-|the-admin/);
    });

    it('connection rows are only ever written conditionally (no plain update/delete)', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(2 * 60 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);
        await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps);
        expect(t.store.ops.filter((op) => !['findUnique', 'findMany', 'create', 'updateMany', 'deleteMany', '$transaction', '$executeRaw'].includes(op))).toEqual([]);
    });

    it('a sealed credential copied from tenant A’s row into tenant B’s row is unusable', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const a = t.store.rows.get(`${TENANT_A}|quickbooks`)!;
        t.store.rows.set(`${TENANT_B}|quickbooks`, { ...a, business_id: TENANT_B });
        const before = t.intuit.companyInfoCalls().length;
        expect(await loadQuickBooksConnection(TENANT_B, t.deps)).toMatchObject({ kind: 'unreadable' });
        expect(await checkQuickBooksHealth({ businessId: TENANT_B, config }, t.deps)).toMatchObject({ state: 'reconnect_required', cause: 'unreadable' });
        // …and B's health check never called Intuit with A's token.
        expect(t.intuit.companyInfoCalls()).toHaveLength(before);
    });

    it('a legacy plaintext "qbo" row is invisible to the new connector', async () => {
        const t = setup();
        t.store.rows.set(`${TENANT_A}|qbo`, {
            business_id: TENANT_A, provider: 'qbo', access_token: 'plaintext-legacy', refresh_token: 'plaintext', expires_at: null, realm_id: REALM_1, updated_at: new Date(),
        });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toEqual({ kind: 'none' });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'not_connected' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · the realm is verified before it is bound (review F1)', () => {
    it('a realmId that the tokens cannot reach is refused: nothing stored, nothing revoked', async () => {
        const t = setup();
        t.intuit.consentTo(REALM_1); // the admin really authorised company 1…
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', t.intuit.fetchImpl, t.deps.now);
        // …but the redirect was altered to name company 2 (e.g. another tenant's company id).
        const outcome = await saveAuthorizedConnection({ businessId: TENANT_B, realmId: REALM_2, tokens, config, authorizedByUserId: 'u' }, t.deps);
        expect(outcome).toBe('realm_unverified');
        expect(t.store.rows.size).toBe(0);
        expect(t.intuit.revoked).toEqual([]);
        // The verification call used the named realm and the new token.
        const check = t.intuit.companyInfoCalls()[0];
        expect(check.url).toContain(`/v3/company/${REALM_2}/companyinfo/${REALM_2}`);
        expect(check.headers.get('authorization')).toBe('Bearer ACCESSTOKEN-SECRET-1');
    });

    it('a squatted realm cannot block its real owner: the forged save never happened', async () => {
        const t = setup();
        t.intuit.consentTo(REALM_2);
        const forged = await exchangeAuthorizationCode(config, 'AUTHCODE-1', t.intuit.fetchImpl, t.deps.now);
        expect(await saveAuthorizedConnection({ businessId: TENANT_B, realmId: REALM_1, tokens: forged, config, authorizedByUserId: 'b' }, t.deps)).toBe('realm_unverified');
        expect(await t.connect(TENANT_A, REALM_1)).toBe('connected');
    });

    it('QuickBooks unavailable during verification stores nothing', async () => {
        const t = setup({ companyInfoStatus: 503 });
        expect(await t.connect(TENANT_A, REALM_1)).toBe('verification_failed');
        expect(t.store.rows.size).toBe(0);
        expect(t.intuit.revoked).toEqual([]);
    });

    it('a malformed realm is refused before anything is stored', async () => {
        const t = setup();
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', t.intuit.fetchImpl);
        await expect(saveAuthorizedConnection({ businessId: TENANT_A, realmId: '1/companyinfo/2', tokens, config, authorizedByUserId: 'u' }, t.deps)).rejects.toThrow();
        expect(t.store.rows.size).toBe(0);
    });
});

describe('QB-INVOICE-1A · realm binding (Part 17) and cross-tenant isolation', () => {
    it('reconnecting the SAME company updates the one row', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        expect(await t.connect(TENANT_A, REALM_1)).toBe('connected');
        expect(t.store.rows.size).toBe(1);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ accessToken: 'ACCESSTOKEN-SECRET-2', realmId: REALM_1 });
    });

    it('authorising a DIFFERENT company is not absorbed: nothing stored, and nothing revoked', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const before = { ...t.store.rows.get(`${TENANT_A}|quickbooks`)! };

        expect(await t.connect(TENANT_A, REALM_2)).toBe('realm_mismatch');
        expect(t.store.rows.get(`${TENANT_A}|quickbooks`)).toEqual(before);
        // Revoking would remove FreezerIQ from company 2 entirely — which another
        // tenant might be storing at this very moment. A refused grant is left unused.
        expect(t.intuit.revoked).toEqual([]);
    });

    it('a disconnected tenant still cannot slide onto a different company without forgetting first', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);

        expect(await t.connect(TENANT_A, REALM_2)).toBe('realm_mismatch');
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps)).toBe('forgotten');
        expect(await t.connect(TENANT_A, REALM_2)).toBe('connected');
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', realmId: REALM_2 });
    });

    it('a company live-connected to tenant A cannot be connected to tenant B, and the refusal does not revoke A', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        expect(await t.connect(TENANT_B, REALM_1)).toBe('realm_in_use');
        expect(t.store.rows.has(`${TENANT_B}|quickbooks`)).toBe(false);
        expect(t.intuit.revoked).toEqual([]);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', realmId: REALM_1 });
    });

    it('RACE: two tenants connecting the same company at the same moment — exactly one wins (review F7)', async () => {
        const t = setup();
        t.intuit.consentTo(REALM_1);
        const tokensA = await exchangeAuthorizationCode(config, 'AUTHCODE-A', t.intuit.fetchImpl, t.deps.now);
        const tokensB = await exchangeAuthorizationCode(config, 'AUTHCODE-B', t.intuit.fetchImpl, t.deps.now);
        const outcomes = await Promise.all([
            saveAuthorizedConnection({ businessId: TENANT_A, realmId: REALM_1, tokens: tokensA, config, authorizedByUserId: 'a' }, t.deps),
            saveAuthorizedConnection({ businessId: TENANT_B, realmId: REALM_1, tokens: tokensB, config, authorizedByUserId: 'b' }, t.deps),
        ]);
        expect(outcomes.sort()).toEqual(['connected', 'realm_in_use']);
        expect([...t.store.rows.keys()]).toHaveLength(1);
        expect(t.store.ops.filter((o) => o === '$executeRaw')).toHaveLength(2);
    });

    it('another tenant’s connection whose refresh token has expired does not hold the company forever', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(101 * 24 * HOUR); // A's rolling refresh window has lapsed, A never refreshed
        expect(await t.connect(TENANT_B, REALM_1)).toBe('connected');
    });

    it('two tenants with two companies are fully independent', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        await t.connect(TENANT_B, REALM_2);
        const before = t.intuit.companyInfoCalls().length;
        const hA = await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps);
        const hB = await checkQuickBooksHealth({ businessId: TENANT_B, config }, t.deps);
        expect(hA).toMatchObject({ state: 'connected', companyName: 'Sandbox Company 1' });
        expect(hB).toMatchObject({ state: 'connected', companyName: 'Sandbox Company 2' });

        const info = t.intuit.companyInfoCalls().slice(before);
        expect(info.map((c) => [c.url.includes(REALM_1) ? 1 : 2, c.headers.get('authorization')])).toEqual([
            [1, 'Bearer ACCESSTOKEN-SECRET-1'],
            [2, 'Bearer ACCESSTOKEN-SECRET-2'],
        ]);

        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);
        expect(await checkQuickBooksHealth({ businessId: TENANT_B, config }, t.deps)).toMatchObject({ state: 'connected' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · refresh token handling (Part 16)', () => {
    it('a fresh access token is used as-is, with no Intuit call', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const a = await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        expect(a).toEqual({ accessToken: 'ACCESSTOKEN-SECRET-1', realmId: REALM_1 });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(0);
    });

    it('an expired access token is refreshed server-side and the ROTATED refresh token persisted', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const a = await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        expect(a.accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(new URLSearchParams(t.intuit.tokenCalls('refresh_token')[0].body).get('refresh_token')).toBe('REFRESHTOKEN-SECRET-1');

        const stored = await loadQuickBooksConnection(TENANT_A, t.deps);
        expect(stored).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-2', accessToken: 'ACCESSTOKEN-SECRET-2', lease: null });
        expect((stored as any).accessExpiresAt.getTime()).toBe(t.deps.now() + 3600 * 1000);
        expect((stored as any).refreshExpiresAt).toBeInstanceOf(Date);

        t.advance(61 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        const used = t.intuit.tokenCalls('refresh_token').map((c) => new URLSearchParams(c.body).get('refresh_token'));
        expect(used).toEqual(['REFRESHTOKEN-SECRET-1', 'REFRESHTOKEN-SECRET-2']);
    });

    it('Intuit returning the SAME refresh token within 24h is handled normally', async () => {
        const t = setup({ stableRefreshToken: true });
        await t.connect(TENANT_A, REALM_1);
        for (let i = 0; i < 3; i++) {
            t.advance(61 * 60 * 1000);
            await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        }
        expect(t.intuit.tokenCalls('refresh_token').map((c) => new URLSearchParams(c.body).get('refresh_token'))).toEqual(['REFRESHTOKEN-SECRET-1', 'REFRESHTOKEN-SECRET-1', 'REFRESHTOKEN-SECRET-1']);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', accessToken: 'ACCESSTOKEN-SECRET-4' });
    });

    it('CONCURRENT in one instance: 25 simultaneous requests cause exactly ONE Intuit refresh', async () => {
        const t = setup({ refreshDelayMs: 20 });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const results = await Promise.all(Array.from({ length: 25 }, () => getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)));

        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
        expect(new Set(results.map((r) => r.accessToken))).toEqual(new Set(['ACCESSTOKEN-SECRET-2']));
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ refreshToken: 'REFRESHTOKEN-SECRET-2', lease: null });
    });

    it('CONCURRENT across instances without shared memory: CAS still yields one refresh owner', async () => {
        const g = gate();
        const t = setup({ refreshGates: [g.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const instances = await Promise.all([0, 1, 2, 3].map(() => isolated()));
        const pending = instances.map((m) =>
            m.getQuickBooksAccess({ businessId: TENANT_A, config }, { ...t.deps, sleep: () => new Promise<void>((r) => setTimeout(r, 2)) }));
        await untilLeased(TENANT_A, t.deps);
        await new Promise((r) => setTimeout(r, 20)); // the others are now waiting on the lease
        g.release();
        const results = await Promise.all(pending);
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
        expect(new Set(results.map((r: any) => r.accessToken))).toEqual(new Set(['ACCESSTOKEN-SECRET-2']));
    });

    it('while another request refreshes, a still-valid stored token is served instead of waiting (review F10)', async () => {
        const g = gate();
        const t = setup({ refreshGates: [g.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(59 * 60 * 1000); // inside the 2-minute refresh skew, 60s left on the token

        const holder = getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        await untilLeased(TENANT_A, t.deps);
        const other = await isolated();
        const served = await other.getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        expect(served.accessToken).toBe('ACCESSTOKEN-SECRET-1');
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
        g.release();
        expect((await holder).accessToken).toBe('ACCESSTOKEN-SECRET-2');
    });

    it('an expired-token waiter waits for the holder and adopts its token instead of failing', async () => {
        const g = gate();
        const t = setup({ refreshGates: [g.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const holder = getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        await untilLeased(TENANT_A, t.deps);
        const other = await isolated();
        const waiter = other.getQuickBooksAccess({ businessId: TENANT_A, config }, { ...t.deps, sleep: () => new Promise<void>((r) => setTimeout(r, 1)) });
        await new Promise((r) => setTimeout(r, 30));
        g.release();
        expect((await waiter).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect((await holder).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
    });

    it('LEASE TAKEOVER refused because of the holder’s rotation is healed with the holder’s token — nothing revoked (review F4)', async () => {
        const g = gate();
        const t = setup({ refreshGates: [g.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);
        const takeover = await isolated();

        // Holder claims; Intuit rotates R1→R2, but the response is held.
        const slow = getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        await untilLeased(TENANT_A, t.deps);
        t.advance(61 * 1000); // the holder's lease is now overdue
        // The takeover sends the rotated (dead) R1 and is refused.
        await expect(takeover.getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'revoked' });

        g.release();
        const a = await slow;
        expect(a.accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-2', realmId: REALM_1 });
        expect(t.intuit.revoked).toEqual([]);
    });

    it('LEASE TAKEOVER still in flight: the holder stores its newer token over the takeover, and the takeover adopts it', async () => {
        const gA = gate();
        const gB = gate();
        const t = setup({ refreshGates: [gA.promise, gB.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);
        const takeover = await isolated();

        const slow = getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        const firstLease = await untilLeased(TENANT_A, t.deps);
        t.advance(61 * 1000);
        const b = takeover.getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        await untilLeased(TENANT_A, t.deps, (l) => l.id !== firstLease.id); // B has taken over and is at Intuit

        gA.release();
        expect((await slow).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        gB.release();
        expect((await b).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-2' });
        expect(t.intuit.revoked).toEqual([]);
    });

    it('a transient database error on the commit is retried — the rotated token is not lost (review F3)', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);
        const isCommit = (args: any) => !!args.where?.refresh_token && !!args.data?.access_token;
        t.store.failOnce('updateMany', isCommit, 'throw_before');

        expect((await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-2', lease: null });

        t.advance(61 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
        expect(t.intuit.tokenCalls('refresh_token').map((c) => new URLSearchParams(c.body).get('refresh_token'))).toEqual(['REFRESHTOKEN-SECRET-1', 'REFRESHTOKEN-SECRET-2']);
    });

    it('a commit that landed but reported an error is recognised as committed', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);
        t.store.failOnce('updateMany', (args: any) => !!args.where?.refresh_token && !!args.data?.access_token, 'throw_after');
        expect((await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ refreshToken: 'REFRESHTOKEN-SECRET-2' });
    });

    it('opts in to the hard-expiry field, stores the 5-year limit, and keeps it across a refresh that omits it', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        expect(t.intuit.tokenCalls('authorization_code')[0].headers.get('x-include-refresh-token-hard-expires-in')).toBe('true');
        const stored: any = await loadQuickBooksConnection(TENANT_A, t.deps);
        expect(stored.hardExpiresAt.getTime()).toBe(t.deps.now() + 157_680_000 * 1000);

        t.advance(61 * 60 * 1000);
        const noHard = { ...t.deps, fetchImpl: async (url: string, init?: RequestInit) => {
            const res = await t.intuit.fetchImpl(url, init);
            if (!url.includes('/tokens/bearer')) return res;
            const body = await res.json();
            delete body.x_refresh_token_hard_expires_in;
            return new Response(JSON.stringify(body), { status: res.status });
        } };
        expect((await getQuickBooksAccess({ businessId: TENANT_A, config }, noHard)).accessToken).toBe('ACCESSTOKEN-SECRET-2');
        const after: any = await loadQuickBooksConnection(TENANT_A, t.deps);
        expect(after.refreshToken).toBe('REFRESHTOKEN-SECRET-2');
        expect(after.hardExpiresAt.getTime()).toBe(stored.hardExpiresAt.getTime());
    });

    it('a token response without expires_in keeps the rotated token (default 60 minutes) instead of discarding it', async () => {
        const t = setup({ omitExpiresIn: true });
        await t.connect(TENANT_A, REALM_1);
        const stored: any = await loadQuickBooksConnection(TENANT_A, t.deps);
        expect(stored.accessExpiresAt.getTime()).toBe(t.deps.now() + 3600 * 1000);
    });

    it('past the hard 5-year limit, nothing is sent to Intuit and reconnect is required', async () => {
        const t = setup();
        t.intuit.setHardExpiresIn(2 * 60 * 60);
        await t.connect(TENANT_A, REALM_1);
        t.advance(3 * 60 * 60 * 1000);
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(0);
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'reconnect_required', cause: 'refresh_expired' });
    });

    it('invalid_grant marks the connection revoked and requires reconnect — no retry loop', async () => {
        const t = setup({ refreshError: 'invalid_grant' });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const { output } = await captureConsole(async () => {
            await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'revoked', realmId: REALM_1 });
        expect(output).not.toMatch(SECRET_PATTERN);
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'reconnect_required', cause: 'revoked', canForget: true });
    });

    it('a refresh whose response was lost, then refused, is recorded as refresh_lost — not as a user revocation (review F9)', async () => {
        const t = setup({ refreshLostOnce: true });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'refresh_failed' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-1', lease: null });
        expect((await loadQuickBooksConnection(TENANT_A, t.deps) as any).ambiguousSince).toBeInstanceOf(Date);

        // Intuit had rotated R1 away, so the next attempt is refused.
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'refresh_lost' });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'reconnect_required', cause: 'refresh_lost' });
    });

    it('a transient Intuit failure releases the claim and reports a recoverable state', async () => {
        const t = setup({ refreshError: 'server_error' });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'refresh_failed' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', refreshToken: 'REFRESHTOKEN-SECRET-1', lease: null, ambiguousSince: null });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'refresh_required' });
    });

    it('an expired refresh token is not sent to Intuit; the connection requires reconnect', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.advance(101 * 24 * HOUR);
        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'reconnect_required' });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(0);
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'reconnect_required', cause: 'refresh_expired' });
    });

    it('a disconnect that lands during a refresh is not undone; the late refresh result is discarded, NOT revoked', async () => {
        const g = gate();
        const t = setup({ refreshGates: [g.promise] });
        await t.connect(TENANT_A, REALM_1);
        t.advance(61 * 60 * 1000);

        const refreshing = getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps).catch((e) => e);
        await untilLeased(TENANT_A, t.deps);
        expect(await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ outcome: 'disconnected' });
        g.release();

        expect(await refreshing).toMatchObject({ kind: 'disconnected' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'admin_disconnect' });
        // Only the admin disconnect revokes (the token it could see). The late result is never
        // revoked: by then another tenant may hold the company, and revocation is company-wide.
        expect(t.intuit.revoked).toEqual(['REFRESHTOKEN-SECRET-1']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · encryption key rotation (review F2)', () => {
    it('after rotating and one refresh, EVERY column — realm included — is under the new key; dropping the old key keeps the connection', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);

        const rotated = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48), INTEGRATION_TOKEN_KEY_PREVIOUS: TEST_TOKEN_KEY });
        t.advance(61 * 60 * 1000);
        await getQuickBooksAccess({ businessId: TENANT_A, config }, { ...t.deps, env: rotated });

        const onlyNew = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48) });
        expect(await loadQuickBooksConnection(TENANT_A, { ...t.deps, env: onlyNew })).toMatchObject({ kind: 'connected', realmId: REALM_1, refreshToken: 'REFRESHTOKEN-SECRET-2' });
    });

    it('a disconnect after rotating re-seals the realm too', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const rotated = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48), INTEGRATION_TOKEN_KEY_PREVIOUS: TEST_TOKEN_KEY });
        await disconnectQuickBooks({ businessId: TENANT_A, config }, { ...t.deps, env: rotated });
        expect(await loadQuickBooksConnection(TENANT_A, { ...t.deps, env: sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48) }) }))
            .toMatchObject({ kind: 'disconnected', realmId: REALM_1 });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · disconnect / reconnect (Parts 18, 21)', () => {
    it('disconnect revokes at Intuit, disables credentials and keeps only a tombstone', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const before = t.intuit.companyInfoCalls().length;

        const r = await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);
        expect(r).toEqual({ outcome: 'disconnected', revoked: true });

        const revokeCall = t.intuit.calls.find((c) => c.url.endsWith('/tokens/revoke'))!;
        expect(revokeCall.method).toBe('POST');
        expect(JSON.parse(revokeCall.body)).toEqual({ token: 'REFRESHTOKEN-SECRET-1' });
        expect(revokeCall.headers.get('content-type')).toBe('application/json');

        const row = t.store.rows.get(`${TENANT_A}|quickbooks`)!;
        expect(row.refresh_token).toBeNull();
        expect(row.expires_at).toBeNull();
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected', reason: 'admin_disconnect', realmId: REALM_1 });

        await expect(getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps)).rejects.toMatchObject({ kind: 'disconnected' });
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'disconnected', canForget: true });
        expect(t.intuit.companyInfoCalls()).toHaveLength(before);
    });

    it('disconnect still disables local credentials when Intuit does not confirm revocation', async () => {
        const t = setup({ revokeStatus: 500 });
        await t.connect(TENANT_A, REALM_1);
        expect(await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps)).toEqual({ outcome: 'disconnected', revoked: false });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'disconnected' });
    });

    it('disconnect is idempotent and a no-op when nothing is connected', async () => {
        const t = setup();
        expect(await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps)).toEqual({ outcome: 'not_connected', revoked: null });
        await t.connect(TENANT_A, REALM_1);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);
        expect(await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps)).toEqual({ outcome: 'already_disconnected', revoked: null });
        expect(t.intuit.revoked).toHaveLength(1);
    });

    it('connect → disconnect → reconnect: same company, one row, no stale token reused', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);
        expect(await t.connect(TENANT_A, REALM_1)).toBe('connected');

        expect(t.store.rows.size).toBe(1);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected', realmId: REALM_1, accessToken: 'ACCESSTOKEN-SECRET-2', refreshToken: 'REFRESHTOKEN-SECRET-2' });
        const before = t.intuit.companyInfoCalls().length;
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'connected' });
        expect(t.intuit.companyInfoCalls().slice(before).map((c) => c.headers.get('authorization'))).toEqual(['Bearer ACCESSTOKEN-SECRET-2']);
    });

    it('forget refuses while connected', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps)).toBe('still_connected');
        expect(t.store.rows.size).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · single-use OAuth attempt (review F8)', () => {
    it('stores only a digest; consumable exactly once, even by concurrent callers', async () => {
        const t = setup();
        const expiresAt = new Date(t.deps.now() + 600_000);
        await recordOAuthAttempt({ businessId: TENANT_A, nonce: 'NONCE-SECRET-VALUE', expiresAt }, t.deps);
        const row = t.store.rows.get(`${TENANT_A}|${QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER}`)!;
        expect(row.access_token).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(JSON.stringify(row)).not.toContain('NONCE-SECRET-VALUE');

        const results = await Promise.all([1, 2, 3].map(() => consumeOAuthAttempt({ businessId: TENANT_A, nonce: 'NONCE-SECRET-VALUE' }, t.deps)));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await consumeOAuthAttempt({ businessId: TENANT_A, nonce: 'NONCE-SECRET-VALUE' }, t.deps)).toBe(false);
    });

    it('a superseded, expired, wrong-tenant or wrong-nonce attempt cannot be consumed', async () => {
        const t = setup();
        const exp = new Date(t.deps.now() + 600_000);
        await recordOAuthAttempt({ businessId: TENANT_A, nonce: 'first', expiresAt: exp }, t.deps);
        await recordOAuthAttempt({ businessId: TENANT_A, nonce: 'second', expiresAt: exp }, t.deps);
        expect(await consumeOAuthAttempt({ businessId: TENANT_A, nonce: 'first' }, t.deps)).toBe(false);
        expect(await consumeOAuthAttempt({ businessId: TENANT_B, nonce: 'second' }, t.deps)).toBe(false);
        expect(await consumeOAuthAttempt({ businessId: TENANT_A, nonce: 'other' }, t.deps)).toBe(false);
        t.advance(601_000);
        expect(await consumeOAuthAttempt({ businessId: TENANT_A, nonce: 'second' }, t.deps)).toBe(false);
    });

    it('an attempt row is never mistaken for a connection', async () => {
        const t = setup();
        await recordOAuthAttempt({ businessId: TENANT_A, nonce: 'n', expiresAt: new Date(t.deps.now() + 600_000) }, t.deps);
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toEqual({ kind: 'none' });
        expect(await t.connect(TENANT_B, REALM_1)).toBe('connected');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · health is truthful (Part 19) and the CompanyInfo proof (Part 20)', () => {
    it('not connected', async () => {
        const t = setup();
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toEqual({ state: 'not_connected', environment: 'sandbox' });
    });

    it('connected only after a live read-only CompanyInfo call for the stored realm', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const before = t.intuit.companyInfoCalls().length;
        const h = await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps);
        expect(h).toMatchObject({ state: 'connected', environment: 'sandbox', companyName: 'Sandbox Company 1' });

        const calls = t.intuit.companyInfoCalls().slice(before);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe('GET');
        expect(calls[0].url).toBe(`${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM_1}/companyinfo/${REALM_1}?minorversion=${QUICKBOOKS_MINOR_VERSION}`);
        expect(JSON.stringify(h)).not.toMatch(/example\.invalid|9130/);
    });

    it('an API 401 forces one refresh and retries; a persistent refusal means no company access', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        t.intuit.expireAllAccessTokens();
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps)).toMatchObject({ state: 'connected' });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);

        const t2 = setup();
        await t2.connect(TENANT_A, REALM_1);
        const refuse = { ...t2.deps, fetchImpl: async (url: string, init?: RequestInit) => (url.includes('/companyinfo/') ? new Response('{}', { status: 403 }) : t2.intuit.fetchImpl(url, init)) };
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, refuse)).toMatchObject({ state: 'reconnect_required', cause: 'no_company_access', canForget: false });
    });

    it('an HTTP 200 carrying a Fault is not treated as a healthy CompanyInfo read', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const fault = { ...t.deps, fetchImpl: async (url: string, init?: RequestInit) => (url.includes('/companyinfo/') ? new Response(JSON.stringify({ Fault: { type: 'SystemFault' } }), { status: 200 }) : t.intuit.fetchImpl(url, init)) };
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, fault)).toMatchObject({ state: 'error' });
    });

    it('QuickBooks being unreachable is an error state, not "connected" and not "disconnected"', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const down = { ...t.deps, fetchImpl: async (url: string, init?: RequestInit) => (url.includes('/companyinfo/') ? new Response('', { status: 503 }) : t.intuit.fetchImpl(url, init)) };
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, down)).toMatchObject({ state: 'error', cause: 'intuit_unavailable' });
        expect(await loadQuickBooksConnection(TENANT_A, t.deps)).toMatchObject({ kind: 'connected' });
    });

    it('credentials unreadable after the key is lost → reconnect required, never a crash', async () => {
        const t = setup();
        await t.connect(TENANT_A, REALM_1);
        const lostKey = { ...t.deps, env: sandboxEnv({ INTEGRATION_TOKEN_KEY: 'Z'.repeat(40) }) };
        expect(await checkQuickBooksHealth({ businessId: TENANT_A, config }, lostKey)).toMatchObject({ state: 'reconnect_required', cause: 'unreadable', canForget: true });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · no secret reaches a log, error or thrown value', () => {
    it('across connect, verification refusal, refresh, failures, disconnect and health', async () => {
        const { output } = await captureConsole(async () => {
            const t = setup();
            await t.connect(TENANT_A, REALM_1);
            await t.connect(TENANT_A, REALM_2); // mismatch
            await t.connect(TENANT_B, REALM_1); // in use
            t.intuit.consentTo(REALM_1);
            const forged = await exchangeAuthorizationCode(config, 'AUTHCODE-1', t.intuit.fetchImpl, t.deps.now);
            await saveAuthorizedConnection({ businessId: TENANT_B, realmId: REALM_2, tokens: forged, config, authorizedByUserId: 'b' }, t.deps);
            t.advance(61 * 60 * 1000);
            await getQuickBooksAccess({ businessId: TENANT_A, config }, t.deps);
            await checkQuickBooksHealth({ businessId: TENANT_A, config }, t.deps);
            await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps);

            const bad = setup({ refreshLostOnce: true, revokeStatus: 500 });
            await bad.connect(TENANT_A, REALM_1);
            bad.advance(61 * 60 * 1000);
            await getQuickBooksAccess({ businessId: TENANT_A, config }, bad.deps).catch((e) => console.error(e));
            await getQuickBooksAccess({ businessId: TENANT_A, config }, bad.deps).catch((e) => console.error(e));
            await checkQuickBooksHealth({ businessId: TENANT_A, config }, bad.deps);
        });
        expect(output).not.toMatch(SECRET_PATTERN);
        expect(output).not.toContain(REALM_1);
        expect(output).not.toContain(TEST_CLIENT_SECRET);
        expect(output).not.toContain(TEST_TOKEN_KEY);
        expect(output).not.toContain(TEST_AUTH_SECRET);
    });

    it('an Intuit error body (which can echo the code or token) never reaches the error message', async () => {
        const t = setup({ exchangeError: 'invalid_grant' });
        const err = await exchangeAuthorizationCode(config, 'AUTHCODE-SECRET', t.intuit.fetchImpl).catch((e) => e);
        expect(err).toBeInstanceOf(IntuitError);
        expect(err.kind).toBe('invalid_grant');
        expect(JSON.stringify({ message: err.message, ...err })).not.toMatch(SECRET_PATTERN);
    });
});
