/**
 * COORDINATOR-BANK-ACH-LINK-1 — the REAL supporter order route on a campaign that offers Bank / ACH.
 *
 * The route returns the campaign's supporter-facing projection with the confirmation, hands it to the
 * receipt, and tells the coordinator to VERIFY (a supporter may have used the bank page). It must not
 * change the order, its prices, tax or total, or mark anything paid. Harness after
 * tests/coordinatorPaymentMethodUx1Order.test.ts. All data is fictional.
 */
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { checkPaymentMethods, toPublicPaymentMethods } from '@/lib/supporterPaymentMethods';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__bach1OrderPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const supporterConfirmation = jest.fn(async () => undefined);
const coordinatorNotification = jest.fn(async () => true);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: jest.fn(async () => undefined),
    sendOrderConfirmationEmail: (...a: any[]) => supporterConfirmation(...(a as [])),
    sendFundraiserCoordinatorNotification: (...a: any[]) => coordinatorNotification(...(a as [])),
    getTenantSender: async () => ({ from: 'tenant@example.invalid' }),
}));

const TENANT = 'biz-bach1-order';
const BUNDLE = 'bundle-bach1';
const PAYEE = 'Lincoln PTO (fixture)';
const BANK_LINK = 'https://pay.examplebank.test/pto/maple?campaign=fall';
const stored = (input: unknown) => { const r = checkPaymentMethods(input); if (!r.ok) throw new Error(r.error); return r.value; };
const BANK_ONLY = stored([{ type: 'bank_ach', link: BANK_LINK, note: 'Enter your order total.' }]);

const campaignRow = (over: Record<string, unknown> = {}) => ({
    id: 'camp-bach1-order', name: 'Maple Fundraiser (fixture)', status: 'Active', closed_at: null, end_date: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 2,
    payment_instructions: null, external_payment_link: null, checks_payable: PAYEE, payment_methods: null,
    tax_status: 'TAXABLE', tax_rate_percent: '1.00',
    customer: { id: 'org-bach1', business_id: TENANT, name: 'Maple Ridge Robotics (fixture)', contact_email: 'coord@example.invalid', business: { timezone: 'America/Chicago' } },
    ...over,
});

let mock: PrismaMock;
function useCampaign(over: Record<string, unknown> = {}) {
    mock = createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT, slug: 'kitchen-bach1', timezone: 'America/Chicago', name: 'Kitchen (fixture)' },
            'user.findFirst': { email: 'owner@example.invalid' },
            'bundle.findMany': (args: any) => (args?.where?.is_active === false ? [] : [{ id: BUNDLE, name: 'Harvest (fixture)', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT }]),
            'bundle.findUnique': { id: BUNDLE, name: 'Harvest (fixture)', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT },
            'campaignBundle.findMany': [],
            'customer.findFirst': null,
            'order.create': (args: any) => ({ id: 'order-bach1-1', ...args?.data, items: [] }),
            'order.findFirst': null,
            'fundraiserCampaign.findUnique': campaignRow(over),
            $queryRaw: [],
        },
    });
    (global as any).__bach1OrderPrisma = mock.client;
}
const postOrder = async () => {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', {
        slug: 'kitchen-bach1', campaignId: 'camp-bach1-order',
        customer: { firstName: 'Ada', lastName: 'Fixturely', email: 'ada.fixture@example.test', phone: '555-0100' },
        items: [{ bundleId: BUNDLE, quantity: 2 }],
    })));
};

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => { jest.clearAllMocks(); jest.resetModules(); });

describe('COORDINATOR-BANK-ACH-LINK-1 · the order route', () => {
    it('R1. the confirmation carries the Bank / ACH projection — never the stored object', async () => {
        useCampaign({ payment_methods: BANK_ONLY });
        const res = await postOrder();
        expect(res.status).toBe(200);
        expect(res.body.paymentData.paymentMethods).toEqual(toPublicPaymentMethods(BANK_ONLY, PAYEE));
        expect(res.body.paymentData.paymentMethods[0]).toMatchObject({ type: 'bank_ach', href: BANK_LINK, actionLabel: 'Open bank payment' });
        expect(JSON.stringify(res.body)).not.toMatch(/"v":1|"link"|"note"|paid/i);
    });

    it('R2. the order, its prices, tax and total are exactly what they are without Bank / ACH', async () => {
        useCampaign({ payment_methods: BANK_ONLY });
        const withBank = await postOrder();
        const createdWith = mock.firstCall('order.create')!.args.data;
        jest.resetModules();
        useCampaign();
        const without = await postOrder();
        const createdWithout = mock.firstCall('order.create')!.args.data;
        const { paymentData: _a, ...restWith } = withBank.body;
        const { paymentData: _b, ...restWithout } = without.body;
        expect(restWith).toEqual(restWithout);
        expect(withBank.body).toMatchObject({ subtotal: 125, taxAmount: 1.25, total: 126.25 });
        const strip = (d: any) => { const { external_id: _x, submission_key: _y, submission_fingerprint: _z, created_at: _w, ...rest } = d; return rest; };
        expect(strip(createdWith)).toEqual(strip(createdWithout));
        expect(createdWith).toMatchObject({ total_amount: 125, tax_amount: 1.25, status: 'fundraiser_hold', source: 'fundraiser' });
    });

    it('R3. placing an order on a Bank / ACH campaign never marks it paid', async () => {
        useCampaign({ payment_methods: BANK_ONLY });
        await postOrder();
        const created = mock.firstCall('order.create')!.args.data;
        expect(created).not.toHaveProperty('paid_at');
        expect(created).not.toHaveProperty('paid_by');
        expect(mock.callsTo('order.update')).toHaveLength(0);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
        expect(mock.callsTo('coordinatorActionEvent.create')).toHaveLength(0);
    });

    it('R4. the receipt gets the same methods, and the coordinator is told to VERIFY payment', async () => {
        useCampaign({ payment_methods: BANK_ONLY });
        await postOrder();
        expect((supporterConfirmation.mock.calls[0] as any[])[7]).toEqual({ methods: toPublicPaymentMethods(BANK_ONLY, PAYEE) });
        expect((coordinatorNotification.mock.calls[0] as any[])[0].hasExternalPaymentLink).toBe(true);
    });
});
