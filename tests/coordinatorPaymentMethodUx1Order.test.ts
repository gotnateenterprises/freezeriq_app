/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — the REAL supporter order route with payment methods configured.
 *
 * What the route does with them: reads the campaign's supporter-facing projection, returns it with
 * the confirmation, hands it to the receipt, and counts an online method as "may already have paid —
 * verify" in the coordinator's notification. What it must NOT do: change the order, its prices, its
 * tax or its total, or mark anything paid. Proved by placing the same order against the same
 * campaign with and without methods and comparing everything the route wrote and answered.
 * (Harness after tests/frSupporterLead1.test.ts.) All data is fictional.
 */
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { checkPaymentMethods, toPublicPaymentMethods } from '@/lib/supporterPaymentMethods';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pmu1OrderPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const supporterConfirmation = jest.fn(async () => undefined);
const coordinatorNotification = jest.fn(async () => true);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: jest.fn(async () => undefined),
    sendOrderConfirmationEmail: (...a: any[]) => supporterConfirmation(...(a as [])),
    sendFundraiserCoordinatorNotification: (...a: any[]) => coordinatorNotification(...(a as [])),
    getTenantSender: async () => ({ from: 'tenant@example.invalid' }),
}));

const TENANT = 'biz-pmu1-order';
const BUNDLE = 'bundle-pmu1';
const PAYEE = 'Lincoln PTO (fixture)';
const stored = (input: unknown) => { const r = checkPaymentMethods(input); if (!r.ok) throw new Error(r.error); return r.value; };
const VENMO_CHECK = stored([{ type: 'check' }, { type: 'venmo', handle: '@maple-fixture' }]);
const CASH_ONLY = stored([{ type: 'cash' }]);

const campaignRow = (over: Record<string, unknown> = {}) => ({
    id: 'camp-pmu1-order', name: 'Maple Fundraiser (fixture)', status: 'Active', closed_at: null, end_date: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 2,
    payment_instructions: null, external_payment_link: null, checks_payable: PAYEE, payment_methods: null,
    tax_status: 'TAXABLE', tax_rate_percent: '1.00',
    customer: { id: 'org-pmu1', business_id: TENANT, name: 'Maple Ridge Robotics (fixture)', contact_email: 'coord@example.invalid', business: { timezone: 'America/Chicago' } },
    ...over,
});

let mock: PrismaMock;
function useCampaign(over: Record<string, unknown> = {}) {
    mock = createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT, slug: 'kitchen-pmu1', timezone: 'America/Chicago', name: 'Kitchen (fixture)' },
            'user.findFirst': { email: 'owner@example.invalid' },
            'bundle.findMany': (args: any) => (args?.where?.is_active === false ? [] : [{ id: BUNDLE, name: 'Harvest (fixture)', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT }]),
            'bundle.findUnique': { id: BUNDLE, name: 'Harvest (fixture)', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT },
            'campaignBundle.findMany': [],
            'customer.findFirst': null,
            'order.create': (args: any) => ({ id: 'order-pmu1-1', ...args?.data, items: [] }),
            'order.findFirst': null,
            'fundraiserCampaign.findUnique': campaignRow(over),
            $queryRaw: [],
        },
    });
    (global as any).__pmu1OrderPrisma = mock.client;
}
const postOrder = async () => {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', {
        slug: 'kitchen-pmu1', campaignId: 'camp-pmu1-order',
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

describe('COORDINATOR-PAYMENT-METHOD-UX-1 · the order route', () => {
    it('O1. the confirmation response carries the campaign\'s supporter-facing methods (25, 26)', async () => {
        useCampaign({ payment_methods: VENMO_CHECK });
        const res = await postOrder();
        expect(res.status).toBe(200);
        expect(res.body.paymentData.paymentMethods).toEqual(toPublicPaymentMethods(VENMO_CHECK, PAYEE));
        expect(JSON.stringify(res.body)).not.toMatch(/"v":1|"handle"|paid/i);
    });

    it('O2. a legacy campaign answers null — "never configured" — and nothing is guessed', async () => {
        useCampaign({ payment_instructions: 'Venmo @someone or cash' });
        const res = await postOrder();
        expect(res.body.paymentData.paymentMethods).toBeNull();
        expect(res.body.paymentData.paymentInstructions).toBe('Venmo @someone or cash');
    });

    it('O3. the order, its prices, its tax and its total are byte-for-byte what they were without methods (32–36)', async () => {
        useCampaign({ payment_methods: VENMO_CHECK, payment_instructions: 'Thanks!' });
        const withMethods = await postOrder();
        const createdWith = mock.firstCall('order.create')!.args.data;

        jest.resetModules();
        useCampaign({ payment_instructions: 'Thanks!' });
        const without = await postOrder();
        const createdWithout = mock.firstCall('order.create')!.args.data;

        const { paymentData: _a, ...restWith } = withMethods.body;
        const { paymentData: _b, ...restWithout } = without.body;
        expect(restWith).toEqual(restWithout);
        expect(withMethods.body).toMatchObject({ subtotal: 125, taxAmount: 1.25, total: 126.25 });
        const strip = (d: any) => { const { external_id: _x, submission_key: _y, submission_fingerprint: _z, created_at: _w, ...rest } = d; return rest; };
        expect(strip(createdWith)).toEqual(strip(createdWithout));
        expect(createdWith).toMatchObject({ total_amount: 125, tax_amount: 1.25, status: 'fundraiser_hold', source: 'fundraiser' });
    });

    it('O4. placing an order never marks it paid (29)', async () => {
        useCampaign({ payment_methods: VENMO_CHECK });
        await postOrder();
        const created = mock.firstCall('order.create')!.args.data;
        expect(created).not.toHaveProperty('paid_at');
        expect(created).not.toHaveProperty('paid_by');
        expect(mock.callsTo('order.update')).toHaveLength(0);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('O5. the receipt gets the same methods; a storefront order would get none (25)', async () => {
        useCampaign({ payment_methods: VENMO_CHECK });
        await postOrder();
        const args = supporterConfirmation.mock.calls[0] as any[];
        expect(args[0]).toBe('ada.fixture@example.test');
        expect(args[7]).toEqual({ methods: toPublicPaymentMethods(VENMO_CHECK, PAYEE) });
        const src = require('fs').readFileSync(require('path').join(process.cwd(), 'app/api/public/order/route.ts'), 'utf8');
        expect(src).toContain('campaign ? { methods: paymentMethods } : undefined');
    });

    it('O6. the coordinator is told to VERIFY when an online method was offered, and to collect when only cash/check', async () => {
        useCampaign({ payment_methods: VENMO_CHECK });
        await postOrder();
        expect((coordinatorNotification.mock.calls[0] as any[])[0].hasExternalPaymentLink).toBe(true);

        jest.clearAllMocks(); jest.resetModules();
        useCampaign({ payment_methods: CASH_ONLY });
        await postOrder();
        expect((coordinatorNotification.mock.calls[0] as any[])[0].hasExternalPaymentLink).toBe(false);
    });
});
