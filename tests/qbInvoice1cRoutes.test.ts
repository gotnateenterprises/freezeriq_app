/**
 * QB-INVOICE-1C — /api/integrations/quickbooks/invoice-settings and /api/integrations/quickbooks/invoices/[invoiceId],
 * executed for real over the session, database and QuickBooks doubles.
 *
 * The guard shape is QB-INVOICE-1B's, unchanged: tenant ADMIN acting as themselves (401/403, never View As), JSON
 * bodies only (415), QuickBooks disabled in Preview and any unconfigured environment WITHOUT touching the database or
 * QuickBooks, the tenant always the session's, no-store responses, and nothing in any response or log line that is a
 * token, the realm id, the connection id or a raw QuickBooks id.
 */

import { ADMIN_USER, BIZ, invoiceWorld, OTHER_BIZ, RECIPIENT, type World } from './helpers/quickbooksInvoiceWorld';
import { captureConsole, sandboxEnv } from './helpers/quickbooksFakes';

let current: World;
const dbAccess: string[] = [];
jest.mock('@/lib/db', () => ({
    get prisma() {
        return new Proxy(current.store.db, { get(target, prop) { dbAccess.push(String(prop)); return (target as any)[prop]; } });
    },
}));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

import * as settingsRoute from '@/app/api/integrations/quickbooks/invoice-settings/route';
import * as invoiceRoute from '@/app/api/integrations/quickbooks/invoices/[invoiceId]/route';

const LEAKS = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|AUTHCODE|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET|9130000000000001|9130000000000002/;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function useEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    for (const k of ['VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'DIRECT_URL', 'QBO_PRODUCTION_ENABLED']) delete process.env[k];
    for (const [k, v] of Object.entries(sandboxEnv(overrides))) (process.env as any)[k] = v;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

const admin = (businessId = BIZ, extra: any = {}) => ({
    user: { id: ADMIN_USER, role: 'ADMIN', businessId, baseBusinessId: businessId, isViewingAsTenant: false, isSuperAdmin: false, ...extra },
});

beforeEach(async () => {
    useEnv();
    current = await invoiceWorld();
    (global as any).fetch = current.intuit.fetchImpl;
    dbAccess.length = 0;
    mockAuth.mockReset();
});
afterEach(() => { expect(current.store.violations).toEqual([]); });
afterAll(() => {
    (global as any).fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
});

const request = (path: string, method: string, body?: unknown, contentType = 'application/json') =>
    new Request(`http://localhost:3000${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const ctx = (invoiceId: string) => ({ params: Promise.resolve({ invoiceId }) });
const getInvoice = async (invoiceId: string, session: any = admin()) => { mockAuth.mockResolvedValue(session); return invoiceRoute.GET(request(`/api/integrations/quickbooks/invoices/${invoiceId}`, 'GET'), ctx(invoiceId)); };
const postInvoice = async (invoiceId: string, body: unknown, session: any = admin(), contentType?: string) => {
    mockAuth.mockResolvedValue(session);
    return invoiceRoute.POST(request(`/api/integrations/quickbooks/invoices/${invoiceId}`, 'POST', body, contentType), ctx(invoiceId));
};
const getSettings = async (session: any = admin()) => { mockAuth.mockResolvedValue(session); return settingsRoute.GET(); };
const putSettings = async (body: unknown, session: any = admin(), contentType?: string) => { mockAuth.mockResolvedValue(session); return settingsRoute.PUT(request('/api/integrations/quickbooks/invoice-settings', 'PUT', body, contentType)); };
const postSettings = async (body: unknown, session: any = admin(), contentType?: string) => { mockAuth.mockResolvedValue(session); return settingsRoute.POST(request('/api/integrations/quickbooks/invoice-settings', 'POST', body, contentType)); };

describe('QB-INVOICE-1C routes · who may call them', () => {
    it('401 without a session; 403 for CHEF, DRIVER and a super admin viewing as the tenant — nothing read from QuickBooks', async () => {
        const inv = current.seedE2();
        expect((await getInvoice(inv.id, null)).status).toBe(401);
        expect((await postInvoice(inv.id, { action: 'send' }, null)).status).toBe(401);
        expect((await getSettings(null)).status).toBe(401);
        expect((await putSettings({}, null)).status).toBe(401);
        expect((await postSettings({ action: 'create_item' }, null)).status).toBe(401);
        for (const session of [admin(BIZ, { role: 'CHEF' }), admin(BIZ, { role: 'DRIVER' }), admin(BIZ, { isViewingAsTenant: true, isSuperAdmin: true, baseBusinessId: 'platform' })]) {
            expect((await getInvoice(inv.id, session)).status).toBe(403);
            expect((await postInvoice(inv.id, { action: 'send' }, session)).status).toBe(403);
            expect((await getSettings(session)).status).toBe(403);
            expect((await putSettings({}, session)).status).toBe(403);
            expect((await postSettings({ action: 'create_item' }, session)).status).toBe(403);
        }
        expect(current.qbo.calls).toEqual([]);
    });

    it('another tenant’s invoice, or a malformed id, is 404 with nothing read from or written to QuickBooks', async () => {
        const other = current.store.seedInvoice({ business_id: OTHER_BIZ, customer_id: current.store.seedOrganization(OTHER_BIZ, 'Other Org') });
        expect((await getInvoice(other.id)).status).toBe(404);
        for (const action of ['send', 'resume', 'check_delivery', 'resend']) {
            expect((await postInvoice(other.id, { action, reviewToken: 'a'.repeat(64), recipientTo: RECIPIENT })).status).toBe(404);
        }
        expect((await getInvoice('..%2F..%2Fsecrets')).status).toBe(404);
        expect(current.qbo.calls).toEqual([]);
        expect(current.store.sends.size).toBe(0);
    });

    it('Preview (QuickBooks disabled) answers without touching the database or QuickBooks', async () => {
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        const inv = current.seedE2();
        dbAccess.length = 0;
        expect(await (await getInvoice(inv.id)).json()).toEqual({ state: 'disabled' });
        expect((await postInvoice(inv.id, { action: 'send', reviewToken: 'a'.repeat(64), recipientTo: RECIPIENT })).status).toBe(503);
        expect(await (await getSettings()).json()).toEqual({ state: 'disabled' });
        expect((await putSettings({ salesItemKey: 'a'.repeat(32) })).status).toBe(503);
        expect((await postSettings({ action: 'create_item' })).status).toBe(503);
        expect(dbAccess).toEqual([]);
        expect(current.qbo.calls).toEqual([]);
    });

    it('Production without the explicit enable flag is disabled too', async () => {
        useEnv({ VERCEL: '1', VERCEL_ENV: 'production', QBO_ENVIRONMENT: 'production' });
        const inv = current.seedE2();
        dbAccess.length = 0;
        expect(await (await getInvoice(inv.id)).json()).toEqual({ state: 'disabled' });
        expect((await postInvoice(inv.id, { action: 'send', reviewToken: 'a'.repeat(64), recipientTo: RECIPIENT })).status).toBe(503);
        expect(dbAccess).toEqual([]);
        expect(current.qbo.calls).toEqual([]);
    });

    it('writes accept application/json only (415); a bad body or action is 400', async () => {
        const inv = current.seedE2();
        for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
            expect((await postInvoice(inv.id, 'action=send', admin(), type)).status).toBe(415);
            expect((await putSettings('salesItemKey=x', admin(), type)).status).toBe(415);
            expect((await postSettings('action=create_item', admin(), type)).status).toBe(415);
        }
        expect((await postInvoice(inv.id, '{nope')).status).toBe(400);
        expect((await postInvoice(inv.id, { action: 'create' })).status).toBe(400);
        expect((await postInvoice(inv.id, { action: 'mark_paid' })).status).toBe(400);
        expect((await postSettings({ action: 'create_account' })).status).toBe(400);
        expect(current.qbo.writes()).toEqual([]);
    });
});

describe('QB-INVOICE-1C routes · flows', () => {
    it('GET ready → POST send: 200 sent for the SESSION tenant and user, whatever the body claims', async () => {
        const inv = current.seedE2();
        const ready = await (await getInvoice(inv.id)).json();
        expect(ready).toMatchObject({ state: 'ready', preview: { totals: { total: 451.59 } } });
        const res = await postInvoice(inv.id, {
            action: 'send', reviewToken: ready.reviewToken, recipientTo: RECIPIENT, recipientCc: null,
            businessId: OTHER_BIZ, userId: 'someone-else', qboInvoiceId: '999', qboCustomerId: '1', connectionId: 'forged', realmId: '9130000000000002', payment: { card: true },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toMatchObject({ outcome: 'sent', view: { state: 'sent', autoSent: false, sendCount: 1 } });
        expect(current.store.sends.get(inv.id)).toMatchObject({ business_id: BIZ, started_by: ADMIN_USER, sent_by: ADMIN_USER, allow_online_card: false });
        expect(current.qbo.creates()[0].body.CustomerRef.value).toBe(current.qboCustomer.Id);
        expect(current.qbo.sends()).toHaveLength(1);
        expect(current.store.invoices.get(inv.id)!.status).toBe('SENT');
    });

    it('maps outcomes: stale 409, invalid 400, paused 202, stopped 409, blocked 409, unreachable 503; check_delivery 200; resend 200', async () => {
        const inv = current.seedE2();
        expect((await postInvoice(inv.id, { action: 'send', reviewToken: 'c'.repeat(64), recipientTo: RECIPIENT })).status).toBe(409); // stale
        const ready = await (await getInvoice(inv.id)).json();
        expect((await postInvoice(inv.id, { action: 'send', reviewToken: ready.reviewToken, recipientTo: 'nope' })).status).toBe(400);

        current.qbo.failNext({ op: 'send', kind: 'status', status: 503 });
        expect((await postInvoice(inv.id, { action: 'send', reviewToken: ready.reviewToken, recipientTo: RECIPIENT })).status).toBe(202);
        expect((await postInvoice(inv.id, { action: 'resume' })).status).toBe(200);
        expect((await postInvoice(inv.id, { action: 'check_delivery' })).status).toBe(200);
        expect((await postInvoice(inv.id, { action: 'resend', recipientTo: 'fixed@lincoln-pta.example' })).status).toBe(200);

        const blocked = current.seedE2({ status: 'PAID' });
        expect((await postInvoice(blocked.id, { action: 'send', reviewToken: ready.reviewToken, recipientTo: RECIPIENT })).status).toBe(409);
        expect((await postInvoice(blocked.id, { action: 'check_delivery' })).status).toBe(409);

        const stopped = current.seedE2();
        const r2 = await (await getInvoice(stopped.id)).json();
        current.qbo.afterNext('create', (i) => { i.TotalAmt = 1; });
        expect((await postInvoice(stopped.id, { action: 'send', reviewToken: r2.reviewToken, recipientTo: RECIPIENT })).status).toBe(409);

        const unreachable = current.seedE2();
        const r3 = await (await getInvoice(unreachable.id)).json();
        current.qbo.failNext({ op: 'preferences', kind: 'status', status: 503 });
        const res = await postInvoice(unreachable.id, { action: 'send', reviewToken: r3.reviewToken, recipientTo: RECIPIENT });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
    });

    it('settings: GET options → PUT save → POST create item (confirmation required)', async () => {
        current.store.settings.clear();
        const v = await (await getSettings()).json();
        expect(v).toMatchObject({ state: 'ready', saved: null });
        const saved = await putSettings({ salesItemKey: v.options.items.sales[0].key, shareItemKey: v.options.items.share[0].key, taxItemKey: v.options.items.tax[0].key, termKey: v.options.terms[1].key, allowOnlineCard: false, allowOnlineAch: false, defaultCc: null, businessId: OTHER_BIZ, connectionId: 'forged' });
        expect(saved.status).toBe(200);
        expect(current.store.settings.get(BIZ)).toMatchObject({ connection_id: current.generationId, updated_by: ADMIN_USER });
        expect((await putSettings({ salesItemKey: current.items.sales.Id, termKey: v.options.terms[1].key })).status).toBe(400);
        expect((await postSettings({ action: 'create_item', role: 'sales', accountKey: v.options.accounts.sales[0].key, name: 'FreezerIQ Fundraiser Sales', confirmation: 'b'.repeat(40), attemptId: '0f8e1a52-2b6c-4d3e-9f10-3a4b5c6d7e8f' })).status).toBe(409);
        expect(current.qbo.calls.filter((c) => c.op === 'item_create')).toEqual([]);
    });

    it('no response in any state, and no log line, carries a token, realm id, connection id or raw QuickBooks id', async () => {
        const inv = current.seedE2();
        const bodies: string[] = [];
        const { output } = await captureConsole(async () => {
            bodies.push(await (await getSettings()).text());
            const ready = await (await getInvoice(inv.id)).json();
            bodies.push(JSON.stringify(ready));
            current.qbo.failNext({ op: 'send', kind: 'status', status: 503 });
            bodies.push(await (await postInvoice(inv.id, { action: 'send', reviewToken: ready.reviewToken, recipientTo: RECIPIENT })).text());
            bodies.push(await (await getInvoice(inv.id)).text());
            bodies.push(await (await postInvoice(inv.id, { action: 'resume' })).text());
            bodies.push(await (await postInvoice(inv.id, { action: 'check_delivery' })).text());
            bodies.push(await (await getInvoice(inv.id)).text());
        });
        const qboIds = [...current.qbo.invoices.keys(), current.qboCustomer.Id, ...Object.values(current.items).map((i) => i.Id), ...Object.values(current.accounts).map((a) => a.Id), ...Object.values(current.terms).map((t) => t.Id)];
        for (const body of bodies) {
            expect(body).not.toMatch(LEAKS);
            expect(body).not.toContain(current.generationId);
            for (const id of qboIds) expect(body).not.toContain(`"${id}"`);
        }
        expect(output).not.toMatch(LEAKS);
        expect(output).not.toMatch(/lincoln-pta|Lincoln/);
    });
});
