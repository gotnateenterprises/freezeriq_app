/**
 * QB-INVOICE-1D — POST {"action":"check_payment"} on /api/integrations/quickbooks/invoices/[invoiceId], executed for
 * real over the session, database and QuickBooks doubles.
 *
 * The gate is exactly the one every QuickBooks action already uses — `mayManageQuickBooks`: a tenant ADMIN acting as
 * themselves, with a string businessId and no View As. Not the weaker generic tenant check the invoice routes use.
 */

import { ADMIN_USER, BIZ, invoiceWorld, OTHER_BIZ, RECIPIENT, type World } from './helpers/quickbooksInvoiceWorld';
import { captureConsole, sandboxEnv } from './helpers/quickbooksFakes';
import { getQuickBooksInvoiceSendView, startQuickBooksInvoiceSend } from '@/lib/quickbooks/invoiceSend';

let current: World;
jest.mock('@/lib/db', () => ({ get prisma() { return current.store.db; } }));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

import * as invoiceRoute from '@/app/api/integrations/quickbooks/invoices/[invoiceId]/route';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const LEAKS = /ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET|9130000000000001|9130000000000002/;

function useEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    for (const k of ['VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'DIRECT_URL', 'QBO_PRODUCTION_ENABLED']) delete process.env[k];
    for (const [k, v] of Object.entries(sandboxEnv(overrides))) (process.env as any)[k] = v;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

const admin = (businessId: any = BIZ, extra: any = {}) => ({
    user: { id: ADMIN_USER, role: 'ADMIN', businessId, baseBusinessId: businessId, isViewingAsTenant: false, isSuperAdmin: false, ...extra },
});

beforeEach(async () => {
    useEnv();
    current = await invoiceWorld({ settlement: true });
    (global as any).fetch = current.intuit.fetchImpl;
    mockAuth.mockReset();
});
afterEach(() => { expect(current.store.violations).toEqual([]); });
afterAll(() => {
    (global as any).fetch = ORIGINAL_FETCH;
    process.env = ORIGINAL_ENV;
});

const checkPayment = async (invoiceId: string, session: any = admin(), body: unknown = { action: 'check_payment' }, contentType = 'application/json') => {
    mockAuth.mockResolvedValue(session);
    return invoiceRoute.POST(
        new Request(`http://localhost:3000/api/integrations/quickbooks/invoices/${invoiceId}`, { method: 'POST', headers: { 'content-type': contentType }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ invoiceId }) },
    );
};

async function paidInQuickBooks() {
    const inv = current.seedE2();
    const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: inv.id, config: current.config }, current.deps);
    const sent = await startQuickBooksInvoiceSend({ businessId: BIZ, invoiceId: inv.id, config: current.config, userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, current.deps);
    expect(sent.outcome).toBe('sent');
    const qboId = [...current.store.link.invoiceLinks.values()].find((l: any) => l.invoice_id === inv.id)!.qbo_invoice_id as string;
    current.qbo.receivePayment({ invoiceId: qboId, amount: 451.59, txnDate: '2026-09-20' });
    current.store.seedHeldOrders(BIZ, inv.campaign_id!, 2);
    return inv;
}

describe('QB-INVOICE-1D route · who may check a payment', () => {
    it('1. a non-admin (CHEF, DRIVER) is refused 403 — nothing read from QuickBooks, nothing settled', async () => {
        const inv = await paidInQuickBooks();
        const before = current.qbo.calls.length;
        for (const role of ['CHEF', 'DRIVER', 'admin', 'SUPER_ADMIN']) {
            expect((await checkPayment(inv.id, admin(BIZ, { role }))).status).toBe(403);
        }
        expect(current.qbo.calls).toHaveLength(before);
        expect(inv.status).toBe('SENT');
    });

    it('2. a super admin using View As is refused 403 — even with role ADMIN', async () => {
        const inv = await paidInQuickBooks();
        const before = current.qbo.calls.length;
        expect((await checkPayment(inv.id, admin(BIZ, { isViewingAsTenant: true, isSuperAdmin: true, baseBusinessId: 'platform-home' }))).status).toBe(403);
        // A session that switched tenant (baseBusinessId differs) is refused even if the View As flag is missing.
        expect((await checkPayment(inv.id, admin(BIZ, { baseBusinessId: 'platform-home' }))).status).toBe(403);
        expect(current.qbo.calls).toHaveLength(before);
        expect(inv.status).toBe('SENT');
    });

    it('3. another tenant’s invoice is 404, with nothing read or written', async () => {
        const other = current.store.seedInvoice({ business_id: OTHER_BIZ, customer_id: current.store.seedOrganization(OTHER_BIZ, 'Other Org'), status: 'SENT' });
        const res = await checkPayment(other.id);
        expect(res.status).toBe(404);
        expect(current.qbo.calls).toEqual([]);
        expect(current.store.settlementWrites).toEqual([]);
    });

    it('4. a missing, empty or non-string businessId fails closed (403) before anything is read', async () => {
        const inv = await paidInQuickBooks();
        const before = current.qbo.calls.length;
        // Built literally: `admin()`'s default parameter would turn an undefined businessId back into a valid tenant.
        for (const businessId of [undefined, null, '', 42]) {
            const session = { user: { id: ADMIN_USER, role: 'ADMIN', businessId, isViewingAsTenant: false, isSuperAdmin: false } };
            expect((await checkPayment(inv.id, session)).status).toBe(403);
        }
        mockAuth.mockResolvedValue(null);
        expect((await checkPayment(inv.id, null)).status).toBe(401);
        expect(current.qbo.calls).toHaveLength(before);
        expect(inv.status).toBe('SENT');
    });

    it('a non-JSON body is 415; QuickBooks disabled (Preview) is 503 — neither reads anything', async () => {
        const inv = await paidInQuickBooks();
        const before = current.qbo.calls.length;
        expect((await checkPayment(inv.id, admin(), { action: 'check_payment' }, 'text/plain')).status).toBe(415);
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        expect((await checkPayment(inv.id)).status).toBe(503);
        expect(current.qbo.calls).toHaveLength(before);
        expect(inv.status).toBe('SENT');
    });
});

describe('QB-INVOICE-1D route · the admin’s check', () => {
    it('settles a verified payment (200 paid), then answers already_paid (200) — no-store, and nothing secret in the response or logs', async () => {
        const inv = await paidInQuickBooks();
        const { result: res, output } = await captureConsole(() => checkPayment(inv.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
        const body = await res.json();
        expect(body).toMatchObject({ outcome: 'paid', settlement: { method: 'quickbooks', paidOn: '2026-09-20' } });
        expect(body.settlement.reference).toMatch(/^QuickBooks payment \d+ · invoice #\d+$/);
        expect(JSON.stringify(body) + output).not.toMatch(LEAKS);
        expect(inv.status).toBe('PAID');

        const again = await checkPayment(inv.id);
        expect(again.status).toBe(200);
        expect((await again.json()).outcome).toBe('already_paid');
        expect(current.store.orderWrites).toHaveLength(1);
    });

    it('a DRAFT is 409 blocked; an unpaid invoice is 200 not_paid', async () => {
        const draft = current.seedE2();
        const blocked = await checkPayment(draft.id);
        expect(blocked.status).toBe(409);
        expect(await blocked.json()).toEqual({ outcome: 'blocked', blocker: 'invoice_not_sent' });

        const inv = current.seedE2();
        const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: inv.id, config: current.config }, current.deps);
        await startQuickBooksInvoiceSend({ businessId: BIZ, invoiceId: inv.id, config: current.config, userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, current.deps);
        const unpaid = await checkPayment(inv.id);
        expect(unpaid.status).toBe(200);
        expect(await unpaid.json()).toEqual({ outcome: 'not_paid' });
    });

    it('a QuickBooks outage is 503 unavailable; review states are 409', async () => {
        const inv = await paidInQuickBooks();
        current.qbo.failNext({ op: 'payment_read', kind: 'status', status: 503 });
        const down = await checkPayment(inv.id);
        expect(down.status).toBe(503);
        expect(await down.json()).toEqual({ outcome: 'unavailable' });

        const qboId = [...current.store.link.invoiceLinks.values()].find((l: any) => l.invoice_id === inv.id)!.qbo_invoice_id as string;
        current.qbo.tamper(qboId, (q) => { q.DocNumber = '9999'; });
        const review = await checkPayment(inv.id);
        expect(review.status).toBe(409);
        expect((await review.json()).reason).toBe('qbo_invoice_changed');
        expect(inv.status).toBe('SENT');
    });
});
