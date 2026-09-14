/**
 * QB-INVOICE-1B — QuickBooks customer mapping for FreezerIQ organizations.
 *
 * A FreezerIQ organization is a `Customer` row. It is linked to at most one
 * QuickBooks customer, and only inside the tenant's LIVE connection generation
 * (lib/quickbooks/connectionGenerations.ts: Forget ends the generation and deletes
 * every customer link; reconnecting — even to the same company — starts a new
 * generation and requires relinking).
 *
 * OWNER-LOCKED RULES, enforced here and not in the UI:
 *   1. A stored link that QuickBooks still reports as an active, top-level customer wins.
 *   2. Otherwise QuickBooks is searched by EXACT DisplayName — byte for byte, active
 *      and inactive customers both. Intuit's own comparison ignores letter case,
 *      so a case-only difference is reported, never linked.
 *   3. Never by email, never fuzzy, never "the only result".
 *   4. Nothing is linked or created without an explicit admin confirmation, and a
 *      confirmation is bound to the exact state the admin saw (connection,
 *      organization, organization name, candidate, existing link): if anything
 *      changed, the action is refused as stale and the new state is returned.
 *   5. An inactive (deleted or merged), missing or sub-customer match is not
 *      linkable and blocks creation — it must be resolved in QuickBooks.
 *      A STORED link whose customer is inactive, deleted, merged, missing or a
 *      sub-customer is TERMINAL in V1 (owner rule after sandbox acceptance, 2026-09-14):
 *      "relink required", no name lookup, and therefore no Create and no Link — the
 *      stored link takes precedence over any fresh lookup. QuickBooks renames an inactive
 *      customer "<name> (deleted)", so a lookup would report "no match" and invite a
 *      duplicate. The link is never replaced or deleted here; a future explicit relink
 *      workflow may be designed separately.
 *      With NO stored link, an inactive customer named EXACTLY "<organization name> (deleted)"
 *      blocks Create the same way (owner ruling B). No other suffix and no fuzzy match.
 *   6. A QuickBooks customer is never renamed or updated. Creation sends the
 *      DisplayName and nothing else, and the name is the organization's FreezerIQ
 *      name exactly; a name QuickBooks cannot take verbatim is reported, never altered.
 *   7. One QuickBooks customer per organization, one organization per QuickBooks
 *      customer inside a generation — enforced by unique indexes, not by this file —
 *      and a link can only name the tenant's live generation (a foreign key). A link
 *      is written under the generation lock, only while the stored connection still
 *      reaches the company the lookup used.
 *
 * The tenant is always the caller's session tenant, and the company is always the
 * tenant's verified stored connection. No input can name either. Nothing returned
 * contains a token, the realm id, the connection id or a raw QuickBooks id: actions
 * carry an opaque confirmation instead.
 *
 * Log lines carry reason codes only — never an organization or customer name.
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { QUICKBOOKS_PROVIDER, type QuickBooksConfig } from '@/lib/quickbooks/config';
import {
    getQuickBooksAccess,
    loadQuickBooksConnection,
    QuickBooksConnectionError,
    type Deps,
    type QuickBooksAccess,
} from '@/lib/quickbooks/connection';
import {
    ensureLiveGeneration,
    findLiveGenerationId,
    withLiveConnection,
    type GenerationDb,
    type GenerationDeps,
} from '@/lib/quickbooks/connectionGenerations';
import {
    createCustomer,
    displayNameProblem,
    fetchCompanyInfo,
    findCustomersByDisplayName,
    findInactiveCustomersByDisplayName,
    IntuitError,
    readCustomer,
    type DisplayNameProblem,
    type QuickBooksCustomerSummary,
} from '@/lib/quickbooks/intuitClient';

export type CustomerLinkDb = Pick<
    typeof prisma,
    'integration' | '$transaction' | 'customer' | 'quickBooksConnection' | 'quickBooksCustomerLink'
>;

export interface CustomerLinkDeps extends Omit<Deps, 'db'> {
    db?: CustomerLinkDb;
}

/** What the lookup found for an organization with no usable link. */
export type CustomerLookup =
    /** One exact, active, top-level customer. Linking needs `confirmation`. */
    | { result: 'exact_match'; qboDisplayName: string; confirmation: string }
    /** Nothing named exactly this. Creating one needs `confirmation`. */
    | { result: 'no_match'; proposedDisplayName: string; confirmation: string }
    /** Something blocks both linking and creating; it must be resolved in QuickBooks (or in FreezerIQ). */
    | {
        result: 'resolution_required';
        reason:
            | 'inactive_match'              // an inactive (deleted or merged) customer has exactly this name
            | 'sub_customer_match'          // the exact match is a sub-customer or project
            | 'case_variant'                // QuickBooks has this name with different letter case
            | 'multiple_matches'            // more than one exact match (should not happen)
            | 'linked_to_other_organization'; // the exact match already belongs to another organization
        qboDisplayName: string | null;
    };

export type CustomerLinkStatus =
    | { state: 'not_connected' }
    | { state: 'reconnect_required' }
    | { state: 'unavailable' }
    | { state: 'name_unusable'; organizationName: string; problem: DisplayNameProblem }
    | { state: 'linked'; organizationName: string; qboDisplayName: string }
    | {
        state: 'relink_required';
        organizationName: string;
        /** inactive = deleted or merged in QuickBooks; stale_connection = made under a generation that is no longer live. */
        reason: 'inactive' | 'missing' | 'sub_customer' | 'stale_connection';
        qboDisplayName: string | null;
        /** Always null in V1: this state is terminal — no lookup runs, so no action can be offered (rule 5). */
        lookup: CustomerLookup | null;
    }
    | ({ state: 'unlinked'; organizationName: string } & { lookup: CustomerLookup });

export type LinkActionResult =
    | { outcome: 'linked'; status: CustomerLinkStatus }
    /** The confirmation no longer matches reality; nothing was written. */
    | { outcome: 'stale'; status: CustomerLinkStatus }
    /** Another request linked this organization or this customer first; nothing of ours was written. */
    | { outcome: 'conflict'; status: CustomerLinkStatus }
    /**
     * QuickBooks refused the create; nothing was created. name_in_use: the name is
     * held by a vendor or employee (QuickBooks names are unique across all three).
     */
    | { outcome: 'rejected'; reason: 'name_in_use' | 'invalid'; status: CustomerLinkStatus }
    /** The create's result is unknown — the customer may exist. Nothing was linked. */
    | { outcome: 'unknown' }
    | { outcome: 'unavailable'; status: CustomerLinkStatus };

export class OrganizationNotFoundError extends Error {
    constructor() {
        super('Organization not found for this tenant');
        Object.setPrototypeOf(this, OrganizationNotFoundError.prototype); // ES5 target
        this.name = 'OrganizationNotFoundError';
    }
}

const CONFIRMATION = /^[a-f0-9]{40}$/;
const ATTEMPT_ID = /^[A-Za-z0-9-]{16,64}$/;

function digest(label: string, parts: string[]): string {
    return createHash('sha256').update([label, ...parts].join('|')).digest('hex').slice(0, 40);
}

/** Opaque, deterministic confirmation for one exact state. Not a secret; it only binds a confirmation to what was shown. */
const confirmationFor = (kind: 'link' | 'create', parts: string[]) => digest(`freezeriq/quickbooks-customer-${kind}/v1`, parts);

function resolve(deps: CustomerLinkDeps) {
    return {
        db: deps.db ?? (prisma as unknown as CustomerLinkDb),
        fetchImpl: deps.fetchImpl ?? fetch,
        env: deps.env,
        now: deps.now ?? Date.now,
        sleep: deps.sleep,
    };
}
type Resolved = ReturnType<typeof resolve>;
const connectorDeps = (d: Resolved): Deps => ({ db: d.db as any, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });
const generationDeps = (d: Resolved): GenerationDeps => ({ db: d.db as unknown as GenerationDb, env: d.env });

// ── Connection generation ───────────────────────────────────────────────────

/** A refreshed access token reached a different company: a Forget and reconnect landed mid-request. */
class ConnectionChangedError extends Error {
    constructor() {
        super('QuickBooks connection changed during the request');
        Object.setPrototypeOf(this, ConnectionChangedError.prototype); // ES5 target
        this.name = 'ConnectionChangedError';
    }
}

interface LiveConnection {
    /** The live generation of the company `access` reaches. */
    connectionId: string;
    access: QuickBooksAccess;
}

type ConnectionProblem = Extract<CustomerLinkStatus, { state: 'not_connected' | 'reconnect_required' | 'unavailable' }>;

/**
 * A usable access token AND the live generation of the company it reaches, or why not.
 * The generation is read — or recorded, the first time — under the generation lock,
 * which re-checks that the stored connection still reaches the token's company, so one
 * generation can never be paired with another company.
 */
async function liveConnection(businessId: string, config: QuickBooksConfig, d: Resolved): Promise<LiveConnection | ConnectionProblem> {
    const stored = await loadQuickBooksConnection(businessId, connectorDeps(d));
    if (stored.kind === 'none') return { state: 'not_connected' };
    if (stored.kind === 'unreadable') return { state: 'reconnect_required' };
    if (stored.kind === 'disconnected') return stored.reason === 'admin_disconnect' ? { state: 'not_connected' } : { state: 'reconnect_required' };

    let access: QuickBooksAccess;
    try {
        access = await getQuickBooksAccess({ businessId, config }, connectorDeps(d));
    } catch (e) {
        return connectionProblem(e);
    }
    const holder = { access };
    let connectionId: string | null;
    try {
        connectionId = await ensureLiveGeneration({
            businessId,
            realmId: access.realmId,
            environment: config.environment,
            readCompanyName: async () => (await withAccess(businessId, config, holder, d,
                (a) => fetchCompanyInfo(config, a.accessToken, a.realmId, d.fetchImpl))).companyName,
        }, generationDeps(d));
    } catch (e) {
        if (e instanceof QuickBooksConnectionError) return connectionProblem(e);
        if (e instanceof IntuitError || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] connection generation unavailable: ${e instanceof IntuitError ? e.kind : 'connection_changed'}`);
            return { state: 'unavailable' };
        }
        throw e;
    }
    // null: no longer connected to that company (a Disconnect or Forget landed in between).
    if (!connectionId) return { state: 'unavailable' };
    return { connectionId, access: holder.access };
}

function connectionProblem(e: unknown): ConnectionProblem {
    if (e instanceof QuickBooksConnectionError) {
        if (e.kind === 'not_connected' || e.kind === 'disconnected') return { state: 'not_connected' };
        if (e.kind === 'refresh_failed' || e.kind === 'refresh_contended') return { state: 'unavailable' };
        return { state: 'reconnect_required' };
    }
    return { state: 'unavailable' };
}

const isProblem = (x: LiveConnection | ConnectionProblem): x is ConnectionProblem => 'state' in x;

/**
 * Runs an Accounting call, refreshing once if QuickBooks refuses a token it had not
 * expired. The refreshed token must reach the SAME company; after a Forget and a
 * reconnect it would not, and the call is abandoned.
 */
async function withAccess<T>(
    businessId: string, config: QuickBooksConfig, holder: { access: QuickBooksAccess }, d: Resolved,
    call: (access: QuickBooksAccess) => Promise<T>,
): Promise<T> {
    try {
        return await call(holder.access);
    } catch (e) {
        if (!(e instanceof IntuitError) || e.kind !== 'unauthorized') throw e;
        const again = await getQuickBooksAccess({ businessId, config, rejectedAccessToken: holder.access.accessToken }, connectorDeps(d));
        if (again.realmId !== holder.access.realmId) throw new ConnectionChangedError();
        holder.access = again;
        return call(again);
    }
}

// ── Status ──────────────────────────────────────────────────────────────────

interface Evaluation {
    status: CustomerLinkStatus;
    /** Present only when an action is possible; never leaves this module. */
    plan?:
        | { kind: 'link'; confirmation: string; connectionId: string; candidate: QuickBooksCustomerSummary; existingLinkId: string | null; existingQboId: string | null }
        | { kind: 'create'; confirmation: string; connectionId: string; displayName: string; existingLinkId: string | null; existingQboId: string | null };
    live?: LiveConnection;
    organizationName?: string;
    /** For a linked organization: what the link is, so a repeated confirmation can be recognised as already applied. */
    linked?: { connectionId: string; organizationId: string; organizationName: string; qboCustomerId: string; source: 'existing' | 'created' };
}

async function organization(businessId: string, customerId: string, d: Resolved) {
    const org = await d.db.customer.findFirst({ where: { id: customerId, business_id: businessId }, select: { id: true, name: true } });
    if (!org) throw new OrganizationNotFoundError();
    return org;
}

async function evaluate(input: { businessId: string; customerId: string; config: QuickBooksConfig }, d: Resolved): Promise<Evaluation> {
    const { businessId, customerId, config } = input;
    const org = await organization(businessId, customerId, d);
    const live = await liveConnection(businessId, config, d);
    if (isProblem(live)) return { status: live };

    try {
        const link = await d.db.quickBooksCustomerLink.findUnique({
            where: { business_id_customer_id: { business_id: businessId, customer_id: customerId } },
            select: { id: true, connection_id: true, qbo_customer_id: true, source: true },
        });
        if (link && link.connection_id === live.connectionId) {
            const qbo = await withAccess(businessId, config, live, d, (a) => readCustomer(config, a.accessToken, a.realmId, link.qbo_customer_id, d.fetchImpl));
            if (qbo && qbo.active && !qbo.subCustomer) {
                return {
                    status: { state: 'linked', organizationName: org.name, qboDisplayName: qbo.displayName },
                    linked: { connectionId: live.connectionId, organizationId: org.id, organizationName: org.name, qboCustomerId: link.qbo_customer_id, source: link.source },
                };
            }
            // TERMINAL (rule 5): the stored link takes precedence over any name lookup. No lookup
            // runs, so no plan exists — nothing can be linked or created until this is resolved.
            const reason = !qbo ? 'missing' : !qbo.active ? 'inactive' : 'sub_customer';
            return { status: { state: 'relink_required', organizationName: org.name, reason, qboDisplayName: qbo?.displayName ?? null, lookup: null } };
        }
        if (link) {
            // Defensively — the live-generation foreign key makes this impossible — a link from
            // another generation: never reused, and just as terminal.
            return { status: { state: 'relink_required', organizationName: org.name, reason: 'stale_connection', qboDisplayName: null, lookup: null } };
        }

        // No stored link: the exact-name lookup decides what may be offered.
        const found = await lookup(org, live, null, null, input, d);
        if (!found.lookup) return { status: { state: 'name_unusable', organizationName: org.name, problem: displayNameProblem(org.name)! } };
        return { status: { state: 'unlinked', organizationName: org.name, lookup: found.lookup }, plan: found.plan, live, organizationName: org.name };
    } catch (e) {
        if (e instanceof OrganizationNotFoundError) throw e;
        if (e instanceof IntuitError || e instanceof QuickBooksConnectionError || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] customer link status unavailable: ${e instanceof ConnectionChangedError ? 'connection_changed' : e.kind}`);
            return { status: e instanceof QuickBooksConnectionError ? connectionProblem(e) : { state: 'unavailable' } };
        }
        throw e;
    }
}

async function lookup(
    org: { id: string; name: string },
    live: LiveConnection,
    existingLinkId: string | null,
    existingQboId: string | null,
    input: { businessId: string; customerId: string; config: QuickBooksConfig },
    d: Resolved,
): Promise<{ lookup: CustomerLookup | null; plan?: Evaluation['plan'] }> {
    if (displayNameProblem(org.name)) return { lookup: null };
    const { businessId, config } = input;
    const found = await withAccess(businessId, config, live, d, (a) => findCustomersByDisplayName(config, a.accessToken, a.realmId, org.name, d.fetchImpl));
    const exact = found.filter((c) => c.displayName === org.name);
    const stateParts = [live.connectionId, org.id, org.name, existingLinkId ?? '-', existingQboId ?? '-'];

    if (exact.length > 1) return { lookup: { result: 'resolution_required', reason: 'multiple_matches', qboDisplayName: org.name } };
    if (exact.length === 1) {
        const c = exact[0];
        if (c.subCustomer) return { lookup: { result: 'resolution_required', reason: 'sub_customer_match', qboDisplayName: c.displayName } };
        if (!c.active) return { lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: c.displayName } };
        const taken = await d.db.quickBooksCustomerLink.findFirst({
            where: { connection_id: live.connectionId, qbo_customer_id: c.id, NOT: { customer_id: org.id } },
            select: { id: true },
        });
        if (taken) return { lookup: { result: 'resolution_required', reason: 'linked_to_other_organization', qboDisplayName: c.displayName } };
        const confirmation = confirmationFor('link', [...stateParts, c.id]);
        return {
            lookup: { result: 'exact_match', qboDisplayName: c.displayName, confirmation },
            plan: { kind: 'link', confirmation, connectionId: live.connectionId, candidate: c, existingLinkId, existingQboId },
        };
    }
    if (found.length > 0) {
        return { lookup: { result: 'resolution_required', reason: 'case_variant', qboDisplayName: found[0].displayName } };
    }
    // Owner ruling B (sandbox acceptance, 2026-09-14): QuickBooks renames a customer it makes inactive
    // "<name> (deleted)". An inactive customer with EXACTLY that name blocks Create until it is resolved in
    // QuickBooks. Exact only — no other suffix, no fuzzy match — and it is never offered for linking.
    const deletedName = `${org.name} (deleted)`;
    const deleted = await withAccess(businessId, config, live, d, (a) => findInactiveCustomersByDisplayName(config, a.accessToken, a.realmId, deletedName, d.fetchImpl));
    if (deleted.some((c) => c.displayName === deletedName && !c.active)) {
        return { lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: deletedName } };
    }
    const confirmation = confirmationFor('create', stateParts);
    return {
        lookup: { result: 'no_match', proposedDisplayName: org.name, confirmation },
        plan: { kind: 'create', confirmation, connectionId: live.connectionId, displayName: org.name, existingLinkId, existingQboId },
    };
}

/** The organization's QuickBooks customer state. Read-only: never writes a link and never changes QuickBooks. */
export async function getCustomerLinkStatus(
    input: { businessId: string; customerId: string; config: QuickBooksConfig },
    deps: CustomerLinkDeps = {},
): Promise<CustomerLinkStatus> {
    return (await evaluate(input, resolve(deps))).status;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/**
 * Writes the confirmed link under the generation lock: only for the generation the admin
 * confirmed, only while it is live, and only while the stored connection still reaches
 * the company `live.access` looked the customer up in. A link is only ever CREATED: V1 never
 * replaces a stored link (rule 5), so an organization that already has one can only conflict.
 */
async function writeLink(
    input: { businessId: string; customerId: string; userId: string | null },
    plan: NonNullable<Evaluation['plan']>,
    qboCustomerId: string,
    source: 'existing' | 'created',
    live: LiveConnection,
    d: Resolved,
): Promise<'written' | 'already' | 'conflict' | 'gone'> {
    const data = {
        connection_id: plan.connectionId,
        qbo_customer_id: qboCustomerId,
        source,
        linked_by: input.userId,
        linked_at: new Date(d.now()),
    };
    try {
        const locked = await withLiveConnection({ businessId: input.businessId, realmId: live.access.realmId }, generationDeps(d), async (tx, now) => {
            if (now.generationId !== plan.connectionId) return 'gone' as const;
            await tx.quickBooksCustomerLink.create({
                data: { business_id: input.businessId, customer_id: input.customerId, provider: QUICKBOOKS_PROVIDER, ...data },
            });
            return 'written' as const;
        });
        if (!locked.ok) return 'gone';
        return locked.value;
    } catch (e: any) {
        if (e?.code === 'P2003') return 'gone'; // the organization (or the live generation) no longer exists
        if (e?.code !== 'P2002') throw e;
    }
    // Lost a race. It is ours only if the stored link is now exactly this one.
    const now = await d.db.quickBooksCustomerLink.findUnique({
        where: { business_id_customer_id: { business_id: input.businessId, customer_id: input.customerId } },
        select: { connection_id: true, qbo_customer_id: true },
    });
    return now && now.connection_id === plan.connectionId && now.qbo_customer_id === qboCustomerId ? 'already' : 'conflict';
}

const planMatches = (ev: Evaluation, kind: 'link' | 'create', confirmation: string) =>
    ev.plan?.kind === kind && ev.plan.confirmation === confirmation;

/**
 * True when the organization is ALREADY linked exactly as this confirmation asked —
 * a double-submit that arrived after its twin finished. The confirmation of a first
 * link is recomputed from the stored link.
 */
function alreadyApplied(ev: Evaluation, kind: 'link' | 'create', confirmation: string): boolean {
    const l = ev.linked;
    if (ev.status.state !== 'linked' || !l || !CONFIRMATION.test(confirmation)) return false;
    const firstLinkState = [l.connectionId, l.organizationId, l.organizationName, '-', '-'];
    return kind === 'link'
        ? l.source === 'existing' && confirmationFor('link', [...firstLinkState, l.qboCustomerId]) === confirmation
        : l.source === 'created' && confirmationFor('create', firstLinkState) === confirmation;
}

/**
 * Links the organization to the exact QuickBooks customer the admin confirmed.
 * Re-evaluates everything first; the confirmation must still describe the current state.
 */
export async function linkExistingCustomer(
    input: { businessId: string; customerId: string; confirmation: string; userId: string | null; config: QuickBooksConfig },
    deps: CustomerLinkDeps = {},
): Promise<LinkActionResult> {
    const d = resolve(deps);
    const ev = await evaluate(input, d);
    if (!CONFIRMATION.test(input.confirmation) || !planMatches(ev, 'link', input.confirmation)) {
        if (alreadyApplied(ev, 'link', input.confirmation)) return { outcome: 'linked', status: ev.status };
        return ev.status.state === 'unavailable' ? { outcome: 'unavailable', status: ev.status } : { outcome: 'stale', status: ev.status };
    }
    const plan = ev.plan as Extract<NonNullable<Evaluation['plan']>, { kind: 'link' }>;
    const written = await writeLink(input, plan, plan.candidate.id, 'existing', ev.live!, d);
    if (written === 'gone') return { outcome: 'stale', status: await getCustomerLinkStatus(input, deps) };
    if (written === 'conflict') return { outcome: 'conflict', status: await getCustomerLinkStatus(input, deps) };
    return { outcome: 'linked', status: { state: 'linked', organizationName: ev.organizationName!, qboDisplayName: plan.candidate.displayName } };
}

/**
 * Creates a QuickBooks customer named exactly the organization's name, then links it.
 * `attemptId` is fresh per confirmation dialog: a double-submit of the same dialog
 * reuses the same Intuit requestid and so can never create twice.
 */
export async function createAndLinkCustomer(
    input: { businessId: string; customerId: string; confirmation: string; attemptId: string; userId: string | null; config: QuickBooksConfig },
    deps: CustomerLinkDeps = {},
): Promise<LinkActionResult> {
    const d = resolve(deps);
    const ev = await evaluate(input, d);
    if (!CONFIRMATION.test(input.confirmation) || !ATTEMPT_ID.test(input.attemptId) || !planMatches(ev, 'create', input.confirmation)) {
        if (ATTEMPT_ID.test(input.attemptId) && alreadyApplied(ev, 'create', input.confirmation)) return { outcome: 'linked', status: ev.status };
        return ev.status.state === 'unavailable' ? { outcome: 'unavailable', status: ev.status } : { outcome: 'stale', status: ev.status };
    }
    const plan = ev.plan as Extract<NonNullable<Evaluation['plan']>, { kind: 'create' }>;
    const live = ev.live!;
    const requestId = digest('freezeriq/quickbooks-customer-create-request/v1', [plan.confirmation, input.attemptId]);

    if ((await findLiveGenerationId(input.businessId, generationDeps(d))) !== plan.connectionId) {
        return { outcome: 'stale', status: await getCustomerLinkStatus(input, deps) };
    }
    let created: QuickBooksCustomerSummary;
    try {
        // A 401 means Intuit did not process the request, so repeating it (same requestid) is safe.
        created = await withAccess(input.businessId, input.config, live, d,
            (a) => createCustomer(input.config, a.accessToken, a.realmId, plan.displayName, requestId, d.fetchImpl));
    } catch (e) {
        if (e instanceof IntuitError && e.kind === 'duplicate_name') {
            // Someone (possibly our own twin request) holds the name now. Never auto-link: show the new state.
            const status = await getCustomerLinkStatus(input, deps);
            const stillNoCustomer = (status.state === 'unlinked' || status.state === 'relink_required') && status.lookup?.result === 'no_match';
            if (stillNoCustomer) {
                // No CUSTOMER has the name, so a vendor or employee does.
                console.warn('[quickbooks] customer create refused: name held by another QuickBooks record');
                return { outcome: 'rejected', reason: 'name_in_use', status };
            }
            return { outcome: 'stale', status };
        }
        if (e instanceof IntuitError && e.kind === 'rejected') {
            console.warn('[quickbooks] customer create rejected by QuickBooks');
            return { outcome: 'rejected', reason: 'invalid', status: await getCustomerLinkStatus(input, deps) };
        }
        if (e instanceof QuickBooksConnectionError) {
            const status = connectionProblem(e);
            return { outcome: 'unavailable', status };
        }
        if (e instanceof ConnectionChangedError) {
            // Only a refused (401) first attempt leads here, so nothing was created.
            return { outcome: 'stale', status: await getCustomerLinkStatus(input, deps) };
        }
        console.warn(`[quickbooks] customer create outcome unknown: ${e instanceof IntuitError ? e.kind : 'unknown'}`);
        return { outcome: 'unknown' };
    }
    // Link only what was actually asked for.
    if (created.displayName !== plan.displayName || !created.active || created.subCustomer) {
        console.warn('[quickbooks] customer create returned an unexpected customer; not linked');
        return { outcome: 'unknown' };
    }
    const written = await writeLink(input, plan, created.id, 'created', live, d);
    if (written === 'gone') return { outcome: 'stale', status: await getCustomerLinkStatus(input, deps) };
    if (written === 'conflict') return { outcome: 'conflict', status: await getCustomerLinkStatus(input, deps) };
    return { outcome: 'linked', status: { state: 'linked', organizationName: ev.organizationName!, qboDisplayName: created.displayName } };
}
