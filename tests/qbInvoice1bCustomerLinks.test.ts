/**
 * QB-INVOICE-1B — QuickBooks customer mapping, exercised end to end: the real 1A
 * connector (token exchange, encrypted storage, refresh) over the in-memory
 * integrations table, the QB-INVOICE-1B tables with their unique indexes, composite
 * foreign keys, retained connection generations, the generation lock and what Forget
 * does, and a fake Intuit Accounting API that is as strict as the real one where
 * mapping safety depends on it.
 */

import { disconnectQuickBooks, forgetQuickBooksConnection, saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import {
    createAndLinkCustomer,
    getCustomerLinkStatus,
    linkExistingCustomer,
    OrganizationNotFoundError,
    type CustomerLinkStatus,
} from '@/lib/quickbooks/customerLinks';
import { customerLinkCardView } from '@/lib/quickbooks/customerLinkView';
import { captureConsole, fakeIntegrationDb, fakeIntuit, gate, sandboxConfig, sandboxEnv } from './helpers/quickbooksFakes';
import { fakeLinkDb, fakeQuickBooksCustomers } from './helpers/quickbooksCustomerFakes';

const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const config = sandboxConfig();
const env = sandboxEnv();
const noSleep = () => new Promise<void>((r) => setImmediate(r));
const ATTEMPT = '0f8e1a52-2b6c-4d3e-9f10-3a4b5c6d7e8f';
const ATTEMPT_2 = '7c2d9e40-11aa-4b5c-8d9e-0f1a2b3c4d5e';

/** Strings that must never appear in a status, a payload or a log line. */
const LEAKS = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|AUTHCODE|TESTCLIENTSECRET|TESTTOKENKEY|9130000000000001|9130000000000002/;

const opened: Array<ReturnType<typeof fakeLinkDb>> = [];
afterEach(() => {
    // Every generation and customer link was written under the generation lock, and no
    // generation (history) was ever updated or deleted.
    for (const db of opened.splice(0)) expect(db.violations).toEqual([]);
});

function setup() {
    const store = fakeIntegrationDb();
    const linkDb = fakeLinkDb(store);
    opened.push(linkDb);
    const qbo = fakeQuickBooksCustomers();
    const intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
    let clock = Date.parse('2026-09-13T12:00:00Z');
    const deps = { db: linkDb.db, fetchImpl: intuit.fetchImpl, env, now: () => clock, sleep: noSleep };
    return {
        store, linkDb, qbo, intuit, deps,
        advance: (ms: number) => { clock += ms; },
        async connect(businessId: string, realmId: string) {
            intuit.consentTo(realmId);
            const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl, deps.now);
            const outcome = await saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: `admin-of-${businessId}` }, deps);
            expect(outcome).toBe('connected');
        },
        status: (businessId: string, customerId: string) => getCustomerLinkStatus({ businessId, customerId, config }, deps),
        link: (businessId: string, customerId: string, confirmation: string) =>
            linkExistingCustomer({ businessId, customerId, confirmation, userId: `admin-of-${businessId}`, config }, deps),
        create: (businessId: string, customerId: string, confirmation: string, attemptId = ATTEMPT) =>
            createAndLinkCustomer({ businessId, customerId, confirmation, attemptId, userId: `admin-of-${businessId}`, config }, deps),
    };
}

const lookupOf = (s: CustomerLinkStatus): any => ((s as any).lookup ?? null);
const confirmationOf = (s: CustomerLinkStatus) => lookupOf(s)?.confirmation as string;

/** Tenant A connected to company 1, with "Lincoln PTA" linked to an existing QuickBooks customer. */
async function linkedTenant() {
    const t = setup();
    const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
    await t.connect(TENANT_A, REALM_1);
    const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
    const confirmation = confirmationOf(await t.status(TENANT_A, org));
    expect((await t.link(TENANT_A, org, confirmation)).outcome).toBe('linked');
    return { t, org, c, confirmation };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · connection states', () => {
    it('no connection → not_connected, with no QuickBooks call and no connection id minted', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        expect(await t.status(TENANT_A, org)).toEqual({ state: 'not_connected' });
        expect(t.qbo.calls).toHaveLength(0);
        expect(t.linkDb.connections.size).toBe(0);
    });

    it('an admin-disconnected connection → not_connected; revoked → reconnect_required', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(await t.status(TENANT_A, org)).toEqual({ state: 'not_connected' });

        const u = setup();
        const org2 = u.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await u.connect(TENANT_A, REALM_1);
        const row = u.store.rows.get(`${TENANT_A}|quickbooks`)!;
        u.store.rows.set(`${TENANT_A}|quickbooks`, { ...row, access_token: 'v1.not.readable' });
        expect(await u.status(TENANT_A, org2)).toEqual({ state: 'reconnect_required' });
    });

    it('an organization of another tenant is not found — never looked up, never linked', async () => {
        const t = setup();
        const orgOfB = t.linkDb.seedOrganization(TENANT_B, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        await expect(t.status(TENANT_A, orgOfB)).rejects.toBeInstanceOf(OrganizationNotFoundError);
        await expect(t.link(TENANT_A, orgOfB, 'a'.repeat(40))).rejects.toBeInstanceOf(OrganizationNotFoundError);
        await expect(t.create(TENANT_A, orgOfB, 'a'.repeat(40))).rejects.toBeInstanceOf(OrganizationNotFoundError);
        expect(t.qbo.calls).toHaveLength(0);
        expect(t.linkDb.links.size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · resolution order and exact-name lookup', () => {
    it('no link → exact lookup (active AND inactive, then the exact inactive "(deleted)" name), no match → create is offered with the organization name, nothing is written', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', organizationName: 'Lincoln PTA', lookup: { result: 'no_match', proposedDisplayName: 'Lincoln PTA' } });
        expect(t.qbo.calls.map((c) => c.query)).toEqual([
            "select * from Customer where DisplayName = 'Lincoln PTA' maxresults 20",
            "select * from Customer where DisplayName = 'Lincoln PTA' and Active = false maxresults 20",
            "select * from Customer where DisplayName = 'Lincoln PTA (deleted)' and Active = false maxresults 20",
        ]);
        expect(t.qbo.creates()).toHaveLength(0);
        expect(t.linkDb.links.size).toBe(0);
        expect(t.linkDb.connections.size).toBe(1); // the connection id is minted for the live connection
        expect(JSON.stringify(s)).not.toMatch(LEAKS);
        expect(JSON.stringify(s)).not.toContain([...t.linkDb.connections.keys()][0]);
    });

    it('an exact active match still requires confirmation — a lookup never links', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match', qboDisplayName: 'Lincoln PTA' } });
        expect(confirmationOf(s)).toMatch(/^[a-f0-9]{40}$/);
        expect(JSON.stringify(s)).not.toContain(`"${c.Id}"`);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('matching by email is never done: a customer with the organization’s email but another name is ignored', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln Elementary Parent Teacher Association', PrimaryEmailAddr: { Address: 'pta@lincoln.example' } });
        expect(lookupOf(await t.status(TENANT_A, org))).toMatchObject({ result: 'no_match' });
        expect(t.qbo.calls.every((c) => !/email|PrimaryEmailAddr/i.test(c.query ?? ''))).toBe(true);
    });

    it('fuzzy names are never matched: punctuation, suffixes and prefixes are different names', async () => {
        for (const other of ['Lincoln P.T.A.', 'Lincoln PTA Inc', 'The Lincoln PTA', 'Lincoln  PTA']) {
            const t = setup();
            const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
            await t.connect(TENANT_A, REALM_1);
            t.qbo.seed(REALM_1, { DisplayName: other });
            expect({ other, lookup: lookupOf(await t.status(TENANT_A, org)).result }).toEqual({ other, lookup: 'no_match' });
        }
    });

    it('a name that differs only in letter case is reported, never linked and never offered for creation', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'LINCOLN PTA' });
        const s = await t.status(TENANT_A, org);
        expect(lookupOf(s)).toEqual({ result: 'resolution_required', reason: 'case_variant', qboDisplayName: 'LINCOLN PTA' });
        const view = customerLinkCardView(s);
        expect(view.link).toBeNull();
        expect(view.create).toBeNull();
    });

    it('an exact INACTIVE (deleted/merged) match blocks both linking and creating a duplicate', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA', Active: false });
        const s = await t.status(TENANT_A, org);
        expect(lookupOf(s)).toEqual({ result: 'resolution_required', reason: 'inactive_match', qboDisplayName: 'Lincoln PTA' });
        // Even a confirmation that would once have been valid for "create" cannot create now.
        const fresh = setup();
        const org2 = fresh.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA', org);
        await fresh.connect(TENANT_A, REALM_1);
        const noMatch = confirmationOf(await fresh.status(TENANT_A, org2));
        fresh.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA', Active: false });
        const r = await fresh.create(TENANT_A, org2, noMatch);
        expect(r.outcome).toBe('stale');
        expect(fresh.qbo.creates()).toHaveLength(0);
    });

    it('an exact sub-customer or project match is not linkable', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA', Job: true });
        expect(lookupOf(await t.status(TENANT_A, org))).toMatchObject({ result: 'resolution_required', reason: 'sub_customer_match' });
    });

    it('apostrophes are escaped in the query and still match exactly', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, "St. Mary's Band Boosters");
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: "St. Mary's Band Boosters" });
        const s = await t.status(TENANT_A, org);
        expect(lookupOf(s)).toMatchObject({ result: 'exact_match', qboDisplayName: "St. Mary's Band Boosters" });
        expect(t.qbo.calls[0].query).toBe("select * from Customer where DisplayName = 'St. Mary\\'s Band Boosters' maxresults 20");
    });

    it('a name QuickBooks cannot take verbatim is reported and never altered or looked up', async () => {
        for (const [name, problem] of [['Lincoln: PTA', 'forbidden_character'], [' Lincoln PTA', 'surrounding_whitespace'], ['L'.repeat(101), 'too_long'], ['Back\\slash', 'forbidden_character']] as const) {
            const t = setup();
            const org = t.linkDb.seedOrganization(TENANT_A, name);
            await t.connect(TENANT_A, REALM_1);
            expect(await t.status(TENANT_A, org)).toEqual({ state: 'name_unusable', organizationName: name, problem });
            expect(t.qbo.calls).toHaveLength(0);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · linking an existing customer', () => {
    it('links only with the confirmation for that exact state; stores ids and audit only; never writes to QuickBooks', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const s = await t.status(TENANT_A, org);
        const r = await t.link(TENANT_A, org, confirmationOf(s));
        expect(r).toEqual({ outcome: 'linked', status: { state: 'linked', organizationName: 'Lincoln PTA', qboDisplayName: 'Lincoln PTA' } });
        const rows = [...t.linkDb.links.values()];
        expect(rows).toEqual([{
            id: expect.any(String), business_id: TENANT_A, customer_id: org, connection_id: [...t.linkDb.connections.keys()][0],
            provider: 'quickbooks', qbo_customer_id: c.Id, source: 'existing', linked_by: `admin-of-${TENANT_A}`, linked_at: expect.any(Date),
        }]);
        expect(t.qbo.calls.every((x) => x.method === 'GET')).toBe(true);
    });

    it('the stored valid link wins: status reads that customer by id and does not search by name', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        await t.link(TENANT_A, org, confirmationOf(await t.status(TENANT_A, org)));
        t.qbo.calls.length = 0;
        c.DisplayName = 'Lincoln PTA (renamed in QuickBooks)';
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'linked', organizationName: 'Lincoln PTA', qboDisplayName: 'Lincoln PTA (renamed in QuickBooks)' });
        expect(t.qbo.calls.map((x) => x.op)).toEqual(['read']);
        expect(customerLinkCardView(s).detail).toMatch(/never renames/);
    });

    it('a forged, reused or out-of-date confirmation writes nothing', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const confirmation = confirmationOf(await t.status(TENANT_A, org));

        expect((await t.link(TENANT_A, org, 'f'.repeat(40))).outcome).toBe('stale');
        expect((await t.link(TENANT_A, org, 'not-hex')).outcome).toBe('stale');
        expect((await t.create(TENANT_A, org, confirmation)).outcome).toBe('stale'); // a link confirmation cannot create
        // The organization is renamed after the admin looked.
        t.linkDb.renameOrganization(org, 'Lincoln PTA Boosters');
        expect((await t.link(TENANT_A, org, confirmation)).outcome).toBe('stale');
        t.linkDb.renameOrganization(org, 'Lincoln PTA');
        // The QuickBooks customer the admin saw is replaced by another with the same name.
        t.qbo.remove(REALM_1, c.Id);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        expect((await t.link(TENANT_A, org, confirmation)).outcome).toBe('stale');
        expect(t.linkDb.links.size).toBe(0);
        expect(t.qbo.creates()).toHaveLength(0);
    });

    it('two concurrent confirmations of the same link produce exactly one link', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        const results = await Promise.all([t.link(TENANT_A, org, confirmation), t.link(TENANT_A, org, confirmation)]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['linked', 'linked']);
        expect(t.linkDb.links.size).toBe(1);
    });

    it('two organizations cannot claim the same QuickBooks customer, even racing', async () => {
        const t = setup();
        const orgA = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const orgB = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const [ca, cb] = [confirmationOf(await t.status(TENANT_A, orgA)), confirmationOf(await t.status(TENANT_A, orgB))];
        const results = await Promise.all([t.link(TENANT_A, orgA, ca), t.link(TENANT_A, orgB, cb)]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['conflict', 'linked']);
        expect(t.linkDb.links.size).toBe(1);
        // The loser now sees why.
        const loser = results[0].outcome === 'conflict' ? orgA : orgB;
        expect(lookupOf(await t.status(TENANT_A, loser))).toMatchObject({ result: 'resolution_required', reason: 'linked_to_other_organization' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · stale links and relinking', () => {
    const linked = linkedTenant;

    // Inactive, deleted, merged, missing and sub-customer stored links: see "ACCEPTANCE C" below.

    it('a different company after Forget never reuses anything from the old one', async () => {
        const { t, org } = await linked();
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any);
        await t.connect(TENANT_A, REALM_2);
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'no_match' } }); // realm 2 has no such customer
        expect(t.qbo.calls.filter((x) => x.realm === REALM_2).length).toBeGreaterThan(0);
    });

    it('defensively (the live-generation foreign key makes it unreachable), a link naming a generation other than the live one is stale and never reused', async () => {
        const { t, org } = await linked();
        const [old] = [...t.linkDb.connections.values()];
        t.linkDb.connections.delete(old.id);
        t.linkDb.connections.set('replacement-connection', { ...old, id: 'replacement-connection' });
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'stale_connection', qboDisplayName: null, lookup: null });
        const view = customerLinkCardView(s);
        expect([view.link, view.create]).toEqual([null, null]);
        expect(t.qbo.creates()).toHaveLength(0);
    });

});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · RULING B — an UNLINKED organization whose name QuickBooks holds only as an inactive "<name> (deleted)" customer', () => {
    it('exactly "<name> (deleted)" and inactive → resolution required: no Create, no Link, and an older create dialog is refused', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const oldCreate = confirmationOf(await t.status(TENANT_A, org)); // a dialog opened before any customer existed
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        t.qbo.makeInactiveLikeQuickBooks(REALM_1, c.Id);
        t.qbo.calls.length = 0;
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'unlinked', organizationName: 'Lincoln PTA', lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: 'Lincoln PTA (deleted)' } });
        expect(t.qbo.calls.map((x) => x.query)).toEqual([
            "select * from Customer where DisplayName = 'Lincoln PTA' maxresults 20",
            "select * from Customer where DisplayName = 'Lincoln PTA' and Active = false maxresults 20",
            "select * from Customer where DisplayName = 'Lincoln PTA (deleted)' and Active = false maxresults 20",
        ]);
        const view = customerLinkCardView(s);
        expect([view.link, view.create]).toEqual([null, null]);
        expect(view.detail).toContain('“Lincoln PTA (deleted)”');
        expect(await t.create(TENANT_A, org, oldCreate)).toMatchObject({ outcome: 'stale', status: { lookup: { reason: 'inactive_match' } } });
        expect(t.qbo.creates()).toHaveLength(0);
        expect(t.qbo.calls.every((x) => x.method === 'GET')).toBe(true);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('the apostrophe is escaped in that query too, and a name long enough to push the suffix past 100 characters is still checked', async () => {
        for (const name of ["St. Mary's Band Boosters", 'L'.repeat(100)]) {
            const t = setup();
            const org = t.linkDb.seedOrganization(TENANT_A, name);
            await t.connect(TENANT_A, REALM_1);
            t.qbo.seed(REALM_1, { DisplayName: `${name} (deleted)`, Active: false });
            const s = await t.status(TENANT_A, org);
            expect({ name: name.slice(0, 12), lookup: lookupOf(s) })
                .toEqual({ name: name.slice(0, 12), lookup: { result: 'resolution_required', reason: 'inactive_match', qboDisplayName: `${name} (deleted)` } });
        }
    });

    it('otherwise the normal Create path remains: an ACTIVE "<name> (deleted)", another suffix, another spacing or another letter case does not block', async () => {
        for (const [other, active] of [
            ['Lincoln PTA (deleted)', true],
            ['Lincoln PTA (Deleted)', false],
            ['LINCOLN PTA (deleted)', false],
            ['Lincoln PTA(deleted)', false],
            ['Lincoln PTA (deleted 2)', false],
        ] as const) {
            const t = setup();
            const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
            await t.connect(TENANT_A, REALM_1);
            t.qbo.seed(REALM_1, { DisplayName: other, Active: active });
            const s = await t.status(TENANT_A, org);
            expect({ other, active, result: lookupOf(s)?.result }).toEqual({ other, active, result: 'no_match' });
            expect(customerLinkCardView(s).create).toMatchObject({ displayName: 'Lincoln PTA' });
        }
    });

    it('the check runs only when nothing matches exactly: an exact active customer is still offered for linking, and a case variant still blocks', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const gone = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        t.qbo.makeInactiveLikeQuickBooks(REALM_1, gone.Id);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' }); // a new active customer with the exact name
        t.qbo.calls.length = 0;
        expect(lookupOf(await t.status(TENANT_A, org))).toMatchObject({ result: 'exact_match', qboDisplayName: 'Lincoln PTA' });
        expect(t.qbo.calls.some((x) => /\(deleted\)/.test(x.query ?? ''))).toBe(false);

        const u = setup();
        const lower = u.linkDb.seedOrganization(TENANT_A, 'lincoln pta');
        await u.connect(TENANT_A, REALM_1);
        u.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        u.qbo.seed(REALM_1, { DisplayName: 'lincoln pta (deleted)', Active: false });
        expect(lookupOf(await u.status(TENANT_A, lower))).toMatchObject({ result: 'resolution_required', reason: 'case_variant' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · ACCEPTANCE C — a stored link to an unusable QuickBooks customer is TERMINAL in V1 (owner rule)', () => {
    /** What the organization's card offers — exactly what the UI renders from the status. */
    const offers = (s: CustomerLinkStatus) => {
        const v = customerLinkCardView(s);
        return { label: v.label, link: v.link, create: v.create, recheck: v.showRecheck };
    };

    it('1. stored linked customer active → linked (read by id; no name search; nothing offered)', async () => {
        const { t, org } = await linkedTenant();
        t.qbo.calls.length = 0;
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'linked', organizationName: 'Lincoln PTA', qboDisplayName: 'Lincoln PTA' });
        expect(t.qbo.calls.map((x) => x.op)).toEqual(['read']);
        expect(offers(s)).toMatchObject({ link: null, create: null });
    });

    it('2. stored linked customer INACTIVE with the same DisplayName → relink required; no name search, no Create, no Link', async () => {
        const { t, org, c } = await linkedTenant();
        t.qbo.setActive(REALM_1, c.Id, false);
        t.qbo.calls.length = 0;
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'inactive', qboDisplayName: 'Lincoln PTA', lookup: null });
        expect(t.qbo.calls.map((x) => x.op)).toEqual(['read']); // the stored link decides
        expect(offers(s)).toEqual({ label: 'Relink required', link: null, create: null, recheck: true });
    });

    it('3. stored linked customer inactive AND renamed "<name> (deleted)" by QuickBooks (the live sandbox defect) → relink required; no Create, no Link, and neither can be forced', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Test Customer - Hearty Meals');
        await t.connect(TENANT_A, REALM_1);
        const oldCreate = confirmationOf(await t.status(TENANT_A, org)); // an old dialog from before the customer existed
        const c = t.qbo.seed(REALM_1, { DisplayName: 'Test Customer - Hearty Meals' });
        const linkConfirmation = confirmationOf(await t.status(TENANT_A, org));
        expect((await t.link(TENANT_A, org, linkConfirmation)).outcome).toBe('linked');

        t.qbo.makeInactiveLikeQuickBooks(REALM_1, c.Id);
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Test Customer - Hearty Meals', reason: 'inactive', qboDisplayName: 'Test Customer - Hearty Meals (deleted)', lookup: null });
        const view = customerLinkCardView(s);
        expect([view.label, view.link, view.create, view.showRecheck]).toEqual(['Relink required', null, null, true]);
        expect(view.detail).toContain('“Test Customer - Hearty Meals (deleted)” is inactive (deleted or merged)');
        expect(view.detail).not.toMatch(/No QuickBooks customer has exactly this name|Confirm to link/);

        // Stale dialogs and forged confirmations are refused before any QuickBooks write.
        const attempts = [
            await t.create(TENANT_A, org, oldCreate),
            await t.create(TENANT_A, org, oldCreate, ATTEMPT_2),
            await t.link(TENANT_A, org, linkConfirmation),
            await t.create(TENANT_A, org, 'c'.repeat(40)),
            await t.link(TENANT_A, org, 'd'.repeat(40)),
        ];
        for (const r of attempts) expect(r).toMatchObject({ outcome: 'stale', status: { state: 'relink_required', reason: 'inactive', lookup: null } });
        expect(t.qbo.creates()).toHaveLength(0);
        expect(t.qbo.all(REALM_1).filter((x) => x.DisplayName.startsWith('Test Customer - Hearty Meals'))).toHaveLength(1);
        expect([...t.linkDb.links.values()]).toMatchObject([{ customer_id: org, qbo_customer_id: c.Id, source: 'existing' }]);
    });

    it('4. stored linked customer MISSING → relink required; no Create, no Link, the stored link is neither replaced nor deleted', async () => {
        const { t, org, c, confirmation } = await linkedTenant();
        t.qbo.remove(REALM_1, c.Id);
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'missing', qboDisplayName: null, lookup: null });
        expect(offers(s)).toMatchObject({ link: null, create: null, recheck: true });
        expect((await t.create(TENANT_A, org, 'e'.repeat(40))).outcome).toBe('stale');
        expect((await t.link(TENANT_A, org, confirmation)).outcome).toBe('stale');
        expect(t.qbo.creates()).toHaveLength(0);
        expect([...t.linkDb.links.values()]).toMatchObject([{ customer_id: org, qbo_customer_id: c.Id, source: 'existing' }]);
    });

    it('5. stored linked customer MERGED away ("(deleted)") while another active customer now has the exact name → relink required; that customer is NOT offered for linking', async () => {
        const { t, org, c } = await linkedTenant();
        t.qbo.makeInactiveLikeQuickBooks(REALM_1, c.Id);
        const survivor = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' }); // e.g. the merge survivor, or a re-created customer
        t.qbo.calls.length = 0;
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'inactive', qboDisplayName: 'Lincoln PTA (deleted)', lookup: null });
        expect(offers(s)).toMatchObject({ link: null, create: null });
        expect(t.qbo.calls.some((x) => x.op === 'query')).toBe(false); // no name search, so no "exact match" to offer
        expect((await t.link(TENANT_A, org, 'f'.repeat(40))).outcome).toBe('stale');
        expect([...t.linkDb.links.values()].map((l) => l.qbo_customer_id)).toEqual([c.Id]);
        expect(survivor.Id).not.toBe(c.Id);
    });

    it('5. stored linked customer turned into a sub-customer or project (otherwise unusable) → relink required; no Create, no Link', async () => {
        const { t, org, c } = await linkedTenant();
        t.qbo.get(REALM_1, c.Id)!.Job = true;
        const s = await t.status(TENANT_A, org);
        expect(s).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'sub_customer', qboDisplayName: 'Lincoln PTA', lookup: null });
        expect(offers(s)).toMatchObject({ link: null, create: null });
    });

    it('6. NO stored link and genuinely no exact match → Create remains available', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'no_match' } });
        const view = customerLinkCardView(s);
        expect(view.link).toBeNull();
        expect(view.create).toMatchObject({ displayName: 'Lincoln PTA' });
    });

    it('7. a case-only collision stays blocked: resolution required, no Create, no Link', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'test customer - hearty meals');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Test Customer - Hearty Meals' });
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'resolution_required', reason: 'case_variant', qboDisplayName: 'Test Customer - Hearty Meals' } });
        expect(offers(s)).toMatchObject({ link: null, create: null });
    });

    it('8. rendering and re-checking the stale-link state never changes QuickBooks or the stored link', async () => {
        const { t, org, c } = await linkedTenant();
        t.qbo.makeInactiveLikeQuickBooks(REALM_1, c.Id);
        const qboBefore = JSON.stringify(t.qbo.all(REALM_1));
        const linksBefore = JSON.stringify([...t.linkDb.links.values()]);
        t.qbo.calls.length = 0;
        for (let i = 0; i < 3; i++) customerLinkCardView(await t.status(TENANT_A, org)); // page load, refresh, "Check again"
        expect(t.qbo.calls.map((x) => `${x.method} ${x.op}`)).toEqual(['GET read', 'GET read', 'GET read']);
        expect(t.qbo.creates()).toHaveLength(0);
        expect(JSON.stringify(t.qbo.all(REALM_1))).toBe(qboBefore);
        expect(JSON.stringify([...t.linkDb.links.values()])).toBe(linksBefore);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · connection generations', () => {
    it('a generation is recorded once, for a connected tenant, with non-secret evidence only: environment, company name, who authorized and when', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const companyInfoBefore = t.intuit.companyInfoCalls().length;
        await t.status(TENANT_A, org);
        await t.status(TENANT_A, org);
        const generations = t.linkDb.generations(TENANT_A);
        expect(generations).toEqual([{
            id: expect.any(String), business_id: TENANT_A, live_business_id: TENANT_A, live_provider: 'quickbooks',
            environment: 'sandbox', company_name: 'Sandbox Company 1', authorized_by: `admin-of-${TENANT_A}`,
            authorized_at: new Date('2026-09-13T12:00:00Z'), created_at: expect.any(Date),
        }]);
        expect(t.intuit.companyInfoCalls().length - companyInfoBefore).toBe(1); // read once, when recorded
        expect(JSON.stringify(generations)).not.toMatch(LEAKS);
        expect(t.linkDb.lockLog.every((k) => k === `${TENANT_A}|quickbooks`)).toBe(true);
    });

    it('Disconnect keeps the generation live, and reconnecting the SAME company keeps the generation and its links', async () => {
        const { t, org } = await linkedTenant();
        const [g] = t.linkDb.generations(TENANT_A);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(t.linkDb.liveGeneration(TENANT_A)).toEqual(g);
        expect(t.linkDb.links.size).toBe(1);
        expect(await t.status(TENANT_A, org)).toEqual({ state: 'not_connected' });
        await t.connect(TENANT_A, REALM_1);
        expect(await t.status(TENANT_A, org)).toMatchObject({ state: 'linked' });
        expect(t.linkDb.generations(TENANT_A)).toEqual([g]);
    });

    it('Forget ENDS the generation but keeps its record and deletes the customer links; connecting again — even to the SAME company — starts a new generation that requires relinking', async () => {
        const { t, org, c, confirmation } = await linkedTenant();
        const [g1] = t.linkDb.generations(TENANT_A);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any)).toBe('forgotten');
        expect(t.linkDb.links.size).toBe(0);
        expect(t.linkDb.generations(TENANT_A)).toEqual([{ ...g1, live_business_id: null, live_provider: null }]); // evidence unchanged

        await t.connect(TENANT_A, REALM_1);
        const s = await t.status(TENANT_A, org);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } }); // the old mapping is never reused
        const [ended, g2] = t.linkDb.generations(TENANT_A);
        expect(ended).toEqual({ ...g1, live_business_id: null, live_provider: null });
        expect(g2).toMatchObject({ live_business_id: TENANT_A, live_provider: 'quickbooks', company_name: 'Sandbox Company 1' });
        expect(g2.id).not.toBe(g1.id);

        // The confirmation from generation 1 is stale; relinking is a new, explicit confirmation.
        expect(confirmationOf(s)).not.toBe(confirmation);
        expect((await t.link(TENANT_A, org, confirmation)).outcome).toBe('stale');
        expect(t.linkDb.links.size).toBe(0);
        expect((await t.link(TENANT_A, org, confirmationOf(s))).outcome).toBe('linked');
        expect([...t.linkDb.links.values()]).toMatchObject([{ connection_id: g2.id, qbo_customer_id: c.Id }]);
    });

    it('a Forget and same-company reconnect landing between the admin’s look and the write link nothing', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        const [g1] = t.linkDb.generations(TENANT_A);

        const hold = gate();
        t.qbo.failNext({ op: 'query', kind: 'gate', wait: hold.promise });
        const callsBefore = t.qbo.calls.length;
        const action = t.link(TENANT_A, org, confirmation);
        while (t.qbo.calls.length <= callsBefore) await new Promise((r) => setImmediate(r)); // the action's lookup is in flight
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any)).toBe('forgotten');
        await t.connect(TENANT_A, REALM_1);
        hold.release();

        const r = await action;
        expect(r.outcome).toBe('stale');
        expect(lookupOf((r as any).status)).toMatchObject({ result: 'exact_match' });
        expect(t.linkDb.links.size).toBe(0);
        expect(t.linkDb.rejectedWrites).toEqual([]); // refused under the lock, before the database had to
        expect(t.linkDb.generations(TENANT_A)[0]).toEqual({ ...g1, live_business_id: null, live_provider: null });
    });

    it('a create dialog whose generation ended while it re-evaluated sends NO create to QuickBooks', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));

        const hold = gate();
        t.qbo.failNext({ op: 'query', kind: 'gate', wait: hold.promise });
        const callsBefore = t.qbo.calls.length;
        const action = t.create(TENANT_A, org, confirmation);
        while (t.qbo.calls.length <= callsBefore) await new Promise((r) => setImmediate(r)); // the dialog's re-evaluation is in flight
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any)).toBe('forgotten');
        await t.connect(TENANT_A, REALM_1);
        hold.release();

        expect((await action).outcome).toBe('stale');
        expect(t.qbo.creates()).toHaveLength(0);
        expect(t.qbo.all(REALM_1)).toHaveLength(0);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('recording a generation is idempotent: a view that finishes first while another is reading the company name leaves ONE generation and no refused write', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const hold = gate();
        let held = false;
        let reached!: () => void;
        const companyNameRequested = new Promise<void>((r) => { reached = r; });
        const fetchImpl = async (url: string, init?: RequestInit) => {
            if (!held && url.includes('/companyinfo/')) {
                held = true;
                reached();
                await hold.promise;
            }
            return t.intuit.fetchImpl(url, init);
        };
        const slow = getCustomerLinkStatus({ businessId: TENANT_A, customerId: org, config }, { ...t.deps, fetchImpl });
        await companyNameRequested;
        await t.status(TENANT_A, org); // records the generation
        hold.release();
        expect(await slow).toMatchObject({ state: 'unlinked' });
        expect(t.linkDb.generations(TENANT_A)).toHaveLength(1);
        expect(t.linkDb.rejectedWrites).toEqual([]);
    });

    it('a generation is never recorded against a different company: a Forget and reconnect during the company-name read records nothing', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        let armed = true;
        const fetchImpl = async (url: string, init?: RequestInit) => {
            const res = await t.intuit.fetchImpl(url, init);
            if (armed && url.includes('/companyinfo/')) {
                armed = false;
                await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
                await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any);
                await t.connect(TENANT_A, REALM_2);
            }
            return res;
        };
        expect(await getCustomerLinkStatus({ businessId: TENANT_A, customerId: org, config }, { ...t.deps, fetchImpl })).toEqual({ state: 'unavailable' });
        expect(t.linkDb.generations(TENANT_A)).toEqual([]);
        expect(t.qbo.calls).toHaveLength(0);
        // The next look records the generation of the company that is really connected now.
        await t.status(TENANT_A, org);
        expect(t.linkDb.generations(TENANT_A)).toMatchObject([{ live_business_id: TENANT_A, company_name: 'Sandbox Company 2' }]);
    });

    it('a refreshed access token that reaches a different company is never used', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        await t.status(TENANT_A, org); // generation 1 recorded
        t.qbo.seed(REALM_2, { DisplayName: 'Lincoln PTA' });
        t.intuit.expireAllAccessTokens(); // QuickBooks refuses the next lookup
        let armed = true;
        const fetchImpl = async (url: string, init?: RequestInit) => {
            const res = await t.intuit.fetchImpl(url, init);
            if (armed && res.status === 401) {
                armed = false;
                await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
                await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any);
                await t.connect(TENANT_A, REALM_2);
            }
            return res;
        };
        expect(await getCustomerLinkStatus({ businessId: TENANT_A, customerId: org, config }, { ...t.deps, fetchImpl })).toEqual({ state: 'unavailable' });
        expect(t.qbo.calls.filter((c) => c.realm === REALM_2)).toHaveLength(0);
        expect(t.linkDb.links.size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · creating a customer', () => {
    it('sends DisplayName and nothing else, with a requestid; links it as created', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const r = await t.create(TENANT_A, org, confirmationOf(await t.status(TENANT_A, org)));
        expect(r).toEqual({ outcome: 'linked', status: { state: 'linked', organizationName: 'Lincoln PTA', qboDisplayName: 'Lincoln PTA' } });
        const creates = t.qbo.creates();
        expect(creates).toHaveLength(1);
        expect(creates[0].body).toEqual({ DisplayName: 'Lincoln PTA' });
        expect(creates[0].requestId).toMatch(/^[a-f0-9]{40}$/);
        expect([...t.linkDb.links.values()][0]).toMatchObject({ source: 'created', qbo_customer_id: t.qbo.all(REALM_1)[0].Id });
    });

    it('requires the create confirmation for the current state and a valid attempt id', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        expect((await t.create(TENANT_A, org, 'b'.repeat(40))).outcome).toBe('stale');
        expect((await t.create(TENANT_A, org, confirmation, 'short')).outcome).toBe('stale');
        expect(t.qbo.creates()).toHaveLength(0);
    });

    it('a double-submit of one confirmation dialog creates ONE QuickBooks customer and ONE link (same requestid)', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        const results = await Promise.all([t.create(TENANT_A, org, confirmation), t.create(TENANT_A, org, confirmation)]);
        expect(t.qbo.all(REALM_1)).toHaveLength(1);
        expect(t.linkDb.links.size).toBe(1);
        expect(results.some((r) => r.outcome === 'linked')).toBe(true);
        expect(results.every((r) => r.outcome === 'linked' || r.outcome === 'stale')).toBe(true);
        // Both submissions that reached QuickBooks carried the SAME requestid, so the
        // second was answered with the first's customer instead of creating another.
        const creates = t.qbo.creates();
        expect(creates.length).toBeGreaterThanOrEqual(1);
        expect(new Set(creates.map((c) => c.requestId)).size).toBe(1);
    });

    it('requestid replay: the same dialog submitted twice while the first is still in flight answers with the first customer', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        let release!: () => void;
        t.qbo.failNext({ op: 'create', kind: 'gate', wait: new Promise<void>((r) => { release = r; }) });
        const first = t.create(TENANT_A, org, confirmation);
        while (t.qbo.creates().length === 0) await new Promise((r) => setImmediate(r));
        const second = t.create(TENANT_A, org, confirmation); // evaluates while the first create is unanswered
        await new Promise((r) => setTimeout(r, 20));
        release();
        const results = await Promise.all([first, second]);
        expect(results.map((r) => r.outcome)).toContain('linked');
        expect(t.qbo.all(REALM_1)).toHaveLength(1);
        expect(t.linkDb.links.size).toBe(1);
        expect(new Set(t.qbo.creates().map((c) => c.requestId)).size).toBe(1);
    });

    it('two different confirmations racing still create ONE customer: QuickBooks refuses the duplicate name, and the loser is never auto-linked', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        const results = await Promise.all([t.create(TENANT_A, org, confirmation, ATTEMPT), t.create(TENANT_A, org, confirmation, ATTEMPT_2)]);
        expect(t.qbo.all(REALM_1)).toHaveLength(1);
        expect(t.linkDb.links.size).toBe(1);
        expect(results.map((r) => r.outcome).sort()).toEqual(['linked', 'stale']);
    });

    it('an ambiguous create (processed, response lost) links nothing; the next look shows an exact match that still needs confirmation', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        t.qbo.failNext({ op: 'create', kind: 'lost' });
        expect(await t.create(TENANT_A, org, confirmation)).toEqual({ outcome: 'unknown' });
        expect(t.linkDb.links.size).toBe(0);
        expect(t.qbo.all(REALM_1)).toHaveLength(1);

        // Retrying the SAME dialog re-evaluates first: the customer now exists, so the create
        // confirmation is stale and nothing is sent — the admin must confirm the link instead.
        const retry = await t.create(TENANT_A, org, confirmation);
        expect(retry.outcome).toBe('stale');
        expect(lookupOf((retry as any).status)).toMatchObject({ result: 'exact_match' });
        expect(t.qbo.creates()).toHaveLength(1);
        expect(t.qbo.all(REALM_1)).toHaveLength(1);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('after an ambiguous create, a NEW dialog sees the exact match rather than creating again', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        t.qbo.failNext({ op: 'create', kind: 'lost' });
        await t.create(TENANT_A, org, confirmation);
        const s = await t.status(TENANT_A, org);
        expect(lookupOf(s)).toMatchObject({ result: 'exact_match' });
        expect((await t.create(TENANT_A, org, confirmation, ATTEMPT_2)).outcome).toBe('stale');
        expect(t.qbo.all(REALM_1)).toHaveLength(1);
    });

    it('a name held by a vendor or employee is refused as name_in_use, and nothing is created or linked', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seedOtherName(REALM_1, 'Lincoln PTA');
        const r = await t.create(TENANT_A, org, confirmationOf(await t.status(TENANT_A, org)));
        expect(r).toMatchObject({ outcome: 'rejected', reason: 'name_in_use' });
        expect(t.qbo.all(REALM_1)).toHaveLength(0);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('a 5xx on create is ambiguous (unknown), a 4xx validation fault is rejected — neither links', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const confirmation = confirmationOf(await t.status(TENANT_A, org));
        t.qbo.failNext({ op: 'create', kind: 'status', status: 503 });
        expect(await t.create(TENANT_A, org, confirmation)).toEqual({ outcome: 'unknown' });
        t.qbo.failNext({ op: 'create', kind: 'status', status: 400, code: '2050' });
        expect((await t.create(TENANT_A, org, confirmation, ATTEMPT_2)).outcome).toBe('rejected');
        expect(t.linkDb.links.size).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · failing closed', () => {
    it('a Fault on HTTP 200, a malformed body or a 5xx during lookup is "unavailable" — never "no match"', async () => {
        for (const failure of [{ kind: 'fault200' }, { kind: 'malformed' }, { kind: 'status', status: 500 }] as const) {
            const t = setup();
            const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
            await t.connect(TENANT_A, REALM_1);
            t.qbo.failNext({ op: 'query', ...failure } as any);
            expect({ failure: failure.kind, status: await t.status(TENANT_A, org) }).toEqual({ failure: failure.kind, status: { state: 'unavailable' } });
        }
    });

    it('a failed read of the linked customer is "unavailable", not "relink required"', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        await t.link(TENANT_A, org, confirmationOf(await t.status(TENANT_A, org)));
        t.qbo.failNext({ op: 'read', kind: 'status', status: 503 });
        expect(await t.status(TENANT_A, org)).toEqual({ state: 'unavailable' });
        expect(t.linkDb.links.size).toBe(1);
    });

    it('an access token QuickBooks refuses is refreshed once and the lookup retried', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        t.intuit.expireAllAccessTokens();
        expect(lookupOf(await t.status(TENANT_A, org))).toMatchObject({ result: 'no_match' });
        expect(t.intuit.tokenCalls('refresh_token')).toHaveLength(1);
    });

    it('logs carry reason codes only: no organization or customer name, token, realm or code', async () => {
        const t = setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        const { output } = await captureConsole(async () => {
            const confirmation = confirmationOf(await t.status(TENANT_A, org));
            t.qbo.failNext({ op: 'create', kind: 'lost' });
            await t.create(TENANT_A, org, confirmation);
            t.qbo.failNext({ op: 'query', kind: 'fault200' });
            await t.status(TENANT_A, org);
            t.qbo.seedOtherName(REALM_1, 'Other Org');
            const other = t.linkDb.seedOrganization(TENANT_A, 'Other Org');
            await t.create(TENANT_A, other, confirmationOf(await t.status(TENANT_A, other)));
        });
        expect(output).not.toMatch(LEAKS);
        expect(output).not.toMatch(/Lincoln|Other Org/);
        expect(output).toMatch(/\[quickbooks\]/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · tenant and company isolation', () => {
    it('each tenant searches only its own connected company', async () => {
        const t = setup();
        const orgA = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const orgB = t.linkDb.seedOrganization(TENANT_B, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        await t.connect(TENANT_B, REALM_2);
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        expect(lookupOf(await t.status(TENANT_A, orgA))).toMatchObject({ result: 'exact_match' });
        expect(lookupOf(await t.status(TENANT_B, orgB))).toMatchObject({ result: 'no_match' });
        expect(new Set(t.qbo.calls.filter((c) => c.op === 'query').map((c) => c.realm))).toEqual(new Set([REALM_1, REALM_2]));
    });

    it('a confirmation issued to one tenant is useless to another tenant', async () => {
        const t = setup();
        const orgA = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        await t.connect(TENANT_A, REALM_1);
        await t.connect(TENANT_B, REALM_2);
        const orgB = t.linkDb.seedOrganization(TENANT_B, 'Lincoln PTA');
        t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        t.qbo.seed(REALM_2, { DisplayName: 'Lincoln PTA' });
        const confirmationA = confirmationOf(await t.status(TENANT_A, orgA));
        expect((await t.link(TENANT_B, orgB, confirmationA)).outcome).toBe('stale');
        expect(t.linkDb.links.size).toBe(0);
    });
});
