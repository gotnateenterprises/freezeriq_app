/**
 * QB-INVOICE-1B — /api/integrations/quickbooks/customers/[customerId], executed for real
 * over the session, database and Intuit doubles. Hostile cases prove the negatives:
 * nothing is linked, nothing is created in QuickBooks, and no response or log line
 * carries a token, realm id, connection id or raw QuickBooks id.
 */

import { saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { captureConsole, fakeIntegrationDb, fakeIntuit, sandboxConfig, sandboxEnv } from './helpers/quickbooksFakes';
import { fakeLinkDb, fakeQuickBooksCustomers } from './helpers/quickbooksCustomerFakes';

let linkDb = fakeLinkDb(fakeIntegrationDb());
const dbAccess: string[] = [];
jest.mock('@/lib/db', () => ({
    get prisma() {
        return new Proxy(linkDb.db, { get(target, prop) { dbAccess.push(String(prop)); return (target as any)[prop]; } });
    },
}));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

import { GET, POST } from '@/app/api/integrations/quickbooks/customers/[customerId]/route';

const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const LEAKS = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|AUTHCODE|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET|9130000000000001|9130000000000002/;
const ATTEMPT = '0f8e1a52-2b6c-4d3e-9f10-3a4b5c6d7e8f';

const admin = (businessId = TENANT_A, extra: any = {}) => ({
    user: { id: `user-admin-${businessId}`, role: 'ADMIN', businessId, baseBusinessId: businessId, isViewingAsTenant: false, isSuperAdmin: false, ...extra },
});

let qbo = fakeQuickBooksCustomers();
let intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function useEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    for (const k of ['VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'DIRECT_URL', 'QBO_PRODUCTION_ENABLED']) delete process.env[k];
    for (const [k, v] of Object.entries(sandboxEnv(overrides))) (process.env as any)[k] = v;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

beforeEach(() => {
    linkDb = fakeLinkDb(fakeIntegrationDb());
    qbo = fakeQuickBooksCustomers();
    intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
    (global as any).fetch = intuit.fetchImpl;
    dbAccess.length = 0;
    mockAuth.mockReset();
    useEnv();
});
afterAll(() => {
    (global as any).fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
});

async function connect(businessId: string, realmId: string) {
    intuit.consentTo(realmId);
    const config = sandboxConfig();
    const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl);
    expect(await saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: `user-admin-${businessId}` },
        { db: linkDb.db, fetchImpl: intuit.fetchImpl, env: process.env })).toBe('connected');
}

const ctx = (customerId: string) => ({ params: Promise.resolve({ customerId }) });
const get = async (customerId: string, session: any = admin()) => {
    mockAuth.mockResolvedValue(session);
    return GET(new Request(`http://localhost:3000/api/integrations/quickbooks/customers/${customerId}`), ctx(customerId));
};
const post = async (customerId: string, body: unknown, session: any = admin(), contentType = 'application/json') => {
    mockAuth.mockResolvedValue(session);
    return POST(new Request(`http://localhost:3000/api/integrations/quickbooks/customers/${customerId}`, {
        method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }), ctx(customerId));
};

describe('QB-INVOICE-1B · customer mapping route — who may call it', () => {
    it('401 without a session; 403 for CHEF, DRIVER and a super admin viewing as the tenant', async () => {
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        expect((await get(org, null)).status).toBe(401);
        expect((await post(org, { action: 'link', confirmation: 'a'.repeat(40) }, null)).status).toBe(401);
        for (const session of [admin(TENANT_A, { role: 'CHEF' }), admin(TENANT_A, { role: 'DRIVER' }), admin(TENANT_A, { isViewingAsTenant: true, isSuperAdmin: true, baseBusinessId: 'platform' })]) {
            expect((await get(org, session)).status).toBe(403);
            expect((await post(org, { action: 'link', confirmation: 'a'.repeat(40) }, session)).status).toBe(403);
        }
        expect(qbo.calls).toHaveLength(0);
    });

    it('an organization of another tenant, or a malformed id, is 404 — no lookup, no write', async () => {
        await connect(TENANT_A, REALM_1);
        const orgOfB = linkDb.seedOrganization(TENANT_B, 'Lincoln PTA');
        expect((await get(orgOfB)).status).toBe(404);
        expect((await post(orgOfB, { action: 'create', confirmation: 'a'.repeat(40), attemptId: ATTEMPT })).status).toBe(404);
        expect((await get('..%2F..%2Fsecrets')).status).toBe(404);
        expect(qbo.calls).toHaveLength(0);
        expect(linkDb.links.size).toBe(0);
    });

    it('Preview (and any disabled environment) answers "disabled" without touching the database or QuickBooks', async () => {
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        dbAccess.length = 0;
        const res = await get(org);
        expect(await res.json()).toEqual({ state: 'disabled' });
        expect((await post(org, { action: 'link', confirmation: 'a'.repeat(40) })).status).toBe(503);
        expect(dbAccess).toEqual([]);
        expect(qbo.calls).toHaveLength(0);
    });

    it('POST accepts application/json only (415), and a bad body or action is 400', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
            expect((await post(org, 'action=create', admin(), type)).status).toBe(415);
        }
        expect((await post(org, '{not json')).status).toBe(400);
        expect((await post(org, { action: 'update', confirmation: 'a'.repeat(40) })).status).toBe(400);
        expect((await post(org, { action: 'delete' })).status).toBe(400);
        expect(qbo.creates()).toHaveLength(0);
    });
});

describe('QB-INVOICE-1B · customer mapping route — flows', () => {
    it('GET → exact match → POST link: linked for the SESSION tenant and user, whatever the body claims', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const status = await (await get(org)).json();
        expect(status).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } });

        const res = await post(org, {
            action: 'link', confirmation: status.lookup.confirmation,
            businessId: TENANT_B, userId: 'someone-else', qboCustomerId: '999', connectionId: 'forged', realmId: REALM_2,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ outcome: 'linked', status: { state: 'linked', organizationName: 'Lincoln PTA', qboDisplayName: 'Lincoln PTA' } });
        const [row] = [...linkDb.links.values()];
        expect(row).toMatchObject({ business_id: TENANT_A, customer_id: org, linked_by: `user-admin-${TENANT_A}` });
        expect(row.qbo_customer_id).not.toBe('999');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('GET → no match → POST create: 200 linked, and QuickBooks received the name only', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const status = await (await get(org)).json();
        const res = await post(org, { action: 'create', confirmation: status.lookup.confirmation, attemptId: ATTEMPT, email: 'pta@example.invalid' });
        expect(res.status).toBe(200);
        expect(qbo.creates().map((c) => c.body)).toEqual([{ DisplayName: 'Lincoln PTA' }]);
    });

    it('maps outcomes to statuses: stale 409, conflict 409, rejected 422, unknown 202', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const s1 = await (await get(org)).json();
        expect((await post(org, { action: 'link', confirmation: s1.lookup.confirmation })).status).toBe(409); // a create confirmation cannot link

        qbo.failNext({ op: 'create', kind: 'lost' });
        expect((await post(org, { action: 'create', confirmation: s1.lookup.confirmation, attemptId: ATTEMPT })).status).toBe(202);

        const org2 = linkDb.seedOrganization(TENANT_A, 'Band Boosters');
        qbo.seedOtherName(REALM_1, 'Band Boosters');
        const s2 = await (await get(org2)).json();
        const rejected = await post(org2, { action: 'create', confirmation: s2.lookup.confirmation, attemptId: ATTEMPT });
        expect(rejected.status).toBe(422);
        expect(await rejected.json()).toMatchObject({ outcome: 'rejected', reason: 'name_in_use' });
    });

    it('a confirmation from another tenant is stale (409) on your own organization, and nothing is linked', async () => {
        await connect(TENANT_A, REALM_1);
        await connect(TENANT_B, REALM_2);
        const orgA = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const orgB = linkDb.seedOrganization(TENANT_B, 'Lincoln PTA');
        qbo.seed(REALM_2, { DisplayName: 'Lincoln PTA' });
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const statusB = await (await get(orgB, admin(TENANT_B))).json();
        const res = await post(orgA, { action: 'link', confirmation: statusB.lookup.confirmation });
        expect(res.status).toBe(409);
        expect(linkDb.links.size).toBe(0);
    });

    it('ACCEPTANCE C: a stored link to a customer QuickBooks deactivated and renamed "(deleted)" answers relink_required with NO action confirmation, and POST create/link are refused (409) with nothing created or replaced', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const c = qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const exact = await (await get(org)).json();
        expect((await post(org, { action: 'link', confirmation: exact.lookup.confirmation })).status).toBe(200);

        qbo.makeInactiveLikeQuickBooks(REALM_1, c.Id);
        const text = await (await get(org)).text();
        expect(JSON.parse(text)).toEqual({ state: 'relink_required', organizationName: 'Lincoln PTA', reason: 'inactive', qboDisplayName: 'Lincoln PTA (deleted)', lookup: null });
        expect(text).not.toMatch(/confirmation/);
        for (const body of [
            { action: 'create', confirmation: 'a'.repeat(40), attemptId: ATTEMPT },
            { action: 'link', confirmation: exact.lookup.confirmation },
        ]) {
            const res = await post(org, body);
            expect(res.status).toBe(409);
            expect(await res.json()).toMatchObject({ outcome: 'stale', status: { state: 'relink_required', lookup: null } });
        }
        expect(qbo.creates()).toHaveLength(0);
        expect([...linkDb.links.values()]).toMatchObject([{ customer_id: org, qbo_customer_id: c.Id, source: 'existing' }]);
    });

    it('no response in any state, and no log line, carries a token, realm id, connection id or raw QuickBooks id', async () => {
        await connect(TENANT_A, REALM_1);
        const org = linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const bodies: string[] = [];
        const { output } = await captureConsole(async () => {
            bodies.push(await (await get(org)).text()); // no match
            const c = qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
            const exact = await (await get(org)).json();
            bodies.push(JSON.stringify(exact));
            bodies.push(await (await post(org, { action: 'link', confirmation: exact.lookup.confirmation })).text());
            bodies.push(await (await get(org)).text()); // linked
            qbo.setActive(REALM_1, c.Id, false);
            bodies.push(await (await get(org)).text()); // relink required
            qbo.failNext({ op: 'read', kind: 'status', status: 500 });
            bodies.push(await (await get(org)).text()); // unavailable
            for (const body of bodies) {
                expect(body).not.toMatch(LEAKS);
                expect(body).not.toContain(`"${c.Id}"`);
                for (const id of linkDb.connections.keys()) expect(body).not.toContain(id);
            }
        });
        expect(output).not.toMatch(LEAKS);
        expect(output).not.toMatch(/Lincoln/);
    });
});
