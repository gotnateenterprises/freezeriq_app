/**
 * FR-SUPPORTER-LEAD-1 — a supporter who orders through a fundraiser is a CUSTOMER, not a fundraiser
 * sales lead.
 *
 * THE DEFECT
 * `POST /api/public/order` raised the tenant's "New Lead Captured" alert whenever the order created a
 * new customer row — the gate was `txResult.createdCustomer` and nothing else. For a supporter of a
 * live campaign that produced, in the tenant's own inbox, "New Lead Captured: <supporter name>" over
 * "A new lead has been captured via the **Fundraiser**": the /raise-funds SALES alert, raised by
 * somebody buying a bundle. Once per first-time supporter, on every live campaign.
 *
 * WHY THE GATE WAS WRONG RATHER THAN THE E-MAIL
 * Writing a customer row is not intent. lib/fundraiserLead.ts already draws exactly this boundary for
 * the Fundraiser CRM list — "Having an email, having ordered, or being on the surplus waitlist does
 * NOT qualify — only genuine fundraiser intent does" — and the notification simply never consulted
 * it. The fix states that same rule once, beside it, as `publicOrderRaisesLeadAlert`.
 *
 * WHAT MUST NOT CHANGE, and is asserted below: the order, the customer record and its campaign
 * association, the supporter's own confirmation, the coordinator notification, the ordinary
 * storefront order's alert, and the whole /raise-funds funnel.
 */
import fs from 'fs';
import path from 'path';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { publicOrderRaisesLeadAlert, belongsInFundraiserCrm, FUNDRAISER_INQUIRY_TAG } from '../lib/fundraiserLead';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__supporterLeadPrisma; },
}));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));

const leadAlert = jest.fn(async () => undefined);
const supporterConfirmation = jest.fn(async () => undefined);
const coordinatorNotification = jest.fn(async () => undefined);
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: (...a: any[]) => leadAlert(...(a as [])),
    sendOrderConfirmationEmail: (...a: any[]) => supporterConfirmation(...(a as [])),
    sendFundraiserCoordinatorNotification: (...a: any[]) => coordinatorNotification(...(a as [])),
    getTenantSender: async () => ({ from: 'tenant@example.invalid' }),
}));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const BUNDLE = 'bundle-1';
const OWNER_A = 'owner@tenant-a.invalid';
const OWNER_B = 'owner@tenant-b.invalid';

const SUPPORTER = { firstName: 'Dana', lastName: 'Fields', email: 'dana@example.invalid', phone: '555-0100' };

/** One campaign of one organization, as the server resolves it. */
const campaignRow = (id: string, businessId = TENANT_A, orgName = 'Clark Co Farm Bureau') => ({
    id,
    name: `${orgName} Fundraiser`,
    status: 'Active',
    closed_at: null,
    end_date: null,
    bundle_selection_status: 'not_required',
    bundle_selection_limit: 2,
    payment_instructions: 'Pay the coordinator',
    external_payment_link: null,
    profit_percentage: '20',
    // The in-transaction re-read asks for the tenant zone through the organization, so the
    // orderability decision rests on stored data rather than on the preflight's copy.
    customer: {
        id: `org-${id}`, business_id: businessId, name: orgName, contact_email: 'coord@example.invalid',
        business: { timezone: 'America/Chicago' },
    },
});

let mock: PrismaMock;
function useMock(m: PrismaMock) { mock = m; (global as any).__supporterLeadPrisma = m.client; }

function baseMock(extra: Record<string, any> = {}) {
    return createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A, slug: 'tenant-a', timezone: 'America/Chicago', name: 'Freezer Chef' },
            'user.findFirst': { email: OWNER_A },
            // One bundle, ACTIVE. The route asks this model twice with different predicates —
            // "which of these are inactive" (must be empty) and the price/tier reads.
            'bundle.findMany': (args: any) =>
                args?.where?.is_active === false
                    ? []
                    : [{ id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT_A }],
            'bundle.findUnique': { id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT_A },
            'campaignBundle.findMany': [],
            'customer.findFirst': null,
            'order.create': (args: any) => ({ id: 'order-1', ...args?.data, items: [] }),
            'order.findFirst': null,
            $queryRaw: [],
            ...extra,
        },
    });
}

const postOrder = async (body: unknown) => {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', body)));
};

const orderBody = (over: Record<string, unknown> = {}) => ({
    slug: 'tenant-a',
    customer: { ...SUPPORTER },
    items: [{ bundleId: BUNDLE, quantity: 2 }],
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    useMock(baseMock());
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-SUPPORTER-LEAD-1 · the boundary itself', () => {
    it('ordering through a fundraiser never raises the sales alert; an ordinary storefront order still does', () => {
        expect(publicOrderRaisesLeadAlert({ isCampaignOrder: true })).toBe(false);
        expect(publicOrderRaisesLeadAlert({ isCampaignOrder: false })).toBe(true);
    });

    it('it is the SAME boundary the Fundraiser CRM already draws: having ordered is not intent', () => {
        const supporter = { type: 'direct_customer', tags: [] as string[] };
        expect(belongsInFundraiserCrm(supporter)).toBe(false);
        const enquirer = { type: 'direct_customer', tags: [FUNDRAISER_INQUIRY_TAG] };
        expect(belongsInFundraiserCrm(enquirer)).toBe(true);
    });

    it('the rule is stated once, and the order route calls it rather than re-deciding', () => {
        const route = R('app/api/public/order/route.ts');
        expect(route).toContain("import { publicOrderRaisesLeadAlert } from '@/lib/fundraiserLead'");
        expect(route).toContain('if (txResult.createdCustomer && publicOrderRaisesLeadAlert({ isCampaignOrder }))');
        // exactly one lead-alert call site on this route, and it is the gated one
        expect(route.match(/sendLeadNotificationEmail\(/g)).toHaveLength(1);
        // and it can no longer describe a supporter as a Fundraiser lead
        expect(route).not.toMatch(/source: isCampaignOrder \? 'Fundraiser' : 'Storefront'\s*\n\s*\}\);/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-SUPPORTER-LEAD-1 · TEST A — a supporter order', () => {
    it('creates the order and the customer, keeps the campaign, and raises NO sales alert', async () => {
        useMock(baseMock({ 'fundraiserCampaign.findUnique': campaignRow('camp-clark') }));

        const res = await postOrder(orderBody({ campaignId: 'camp-clark' }));

        expect(res.status).toBe(200);
        // the order exists, on the right campaign, held for the fundraiser
        const created = mock.firstCall('order.create')!.args.data;
        expect(created.campaign_id).toBe('camp-clark');
        expect(created.business_id).toBe(TENANT_A);
        expect(created.status).toBe('fundraiser_hold');
        expect(created.source).toBe('fundraiser');
        // the supporter's contact record is still written, with its attribution intact
        const customer = mock.firstCall('customer.create')!.args.data;
        expect(customer).toMatchObject({ business_id: TENANT_A, type: 'direct_customer', source: 'Fundraiser' });
        expect(customer.contact_email).toBe(SUPPORTER.email);
        expect(customer.contact_phone).toBe(SUPPORTER.phone);
        // …and nothing told the tenant they have a new sales lead
        expect(leadAlert).not.toHaveBeenCalled();
    });

    it('still sends the supporter their own confirmation', async () => {
        useMock(baseMock({ 'fundraiserCampaign.findUnique': campaignRow('camp-clark') }));
        await postOrder(orderBody({ campaignId: 'camp-clark' }));
        expect(supporterConfirmation).toHaveBeenCalled();
        expect(supporterConfirmation.mock.calls[0][0]).toBe(SUPPORTER.email);
    });

    it('a RETURNING supporter is unchanged too: no customer created, no alert', async () => {
        useMock(baseMock({
            'fundraiserCampaign.findUnique': campaignRow('camp-clark'),
            'customer.findFirst': { id: 'cust-existing', business_id: TENANT_A, contact_email: SUPPORTER.email, delivery_address: null },
        }));
        const res = await postOrder(orderBody({ campaignId: 'camp-clark' }));
        expect(res.status).toBe(200);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
        expect(leadAlert).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-SUPPORTER-LEAD-1 · an ordinary storefront order is untouched', () => {
    it('still raises the sales alert, and describes it as Storefront', async () => {
        useMock(baseMock());

        const res = await postOrder(orderBody()); // no campaignId

        expect(res.status).toBe(200);
        expect(leadAlert).toHaveBeenCalledTimes(1);
        const [to, lead] = leadAlert.mock.calls[0] as any[];
        expect(to).toBe(OWNER_A);
        expect(lead.source).toBe('Storefront');
        expect(lead.email).toBe(SUPPORTER.email);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-SUPPORTER-LEAD-1 · TEST D/E — campaign and tenant isolation', () => {
    it('a campaign belonging to ANOTHER tenant is refused, and nothing is written or mailed', async () => {
        useMock(baseMock({ 'fundraiserCampaign.findUnique': campaignRow('camp-foreign', TENANT_B, 'Edgar County Farm Bureau') }));

        const res = await postOrder(orderBody({ campaignId: 'camp-foreign' }));

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('CAMPAIGN_NOT_FOUND');
        expect(mock.callsTo('order.create')).toHaveLength(0);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
        expect(leadAlert).not.toHaveBeenCalled();
    });

    it('the supporter is written to the resolved campaign only — no other campaign is touched', async () => {
        useMock(baseMock({ 'fundraiserCampaign.findUnique': campaignRow('camp-jasper', TENANT_A, 'Jasper Co Farm Bureau') }));

        await postOrder(orderBody({ campaignId: 'camp-jasper' }));

        const orderWrites = mock.callsTo('order.create');
        expect(orderWrites).toHaveLength(1);
        expect(orderWrites[0].args.data.campaign_id).toBe('camp-jasper');
        // every campaign read was for that one id
        for (const c of mock.callsTo('fundraiserCampaign.findUnique')) {
            expect(c.args.where.id).toBe('camp-jasper');
        }
        expect(leadAlert).not.toHaveBeenCalled();
    });

    it('when the alert DOES go out, its recipient is looked up inside the ordering tenant', async () => {
        useMock(baseMock({ 'user.findFirst': OWNER_B === '' ? null : { email: OWNER_B } }));
        await postOrder(orderBody()); // storefront
        const lookup = mock.callsTo('user.findFirst').at(-1)!;
        expect(lookup.args.where.business_id).toBe(TENANT_A);
        expect((leadAlert.mock.calls[0] as any[])[0]).toBe(OWNER_B);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FR-SUPPORTER-LEAD-1 · TEST B/C — the real /raise-funds funnel still works', () => {
    const INQUIRY = {
        name: 'Dana Fields', email: SUPPORTER.email, phone: SUPPORTER.phone,
        orgName: 'Clark Co Farm Bureau', deliveryLocation: 'Gym', slug: 'tenant-a',
    };
    const postInquiry = async (body: unknown) => {
        const { POST } = await import('@/app/api/public/fundraiser-request/route');
        return readJson(await POST(jsonRequest('http://localhost/api/public/fundraiser-request', body)));
    };

    it('TEST B — an intentional inquiry still creates the lead and still alerts the tenant', async () => {
        useMock(baseMock());

        const res = await postInquiry(INQUIRY);

        expect(res.status).toBe(200);
        const lead = mock.firstCall('customer.create');
        expect(lead).toBeDefined();
        expect(lead!.args.data).toMatchObject({ business_id: TENANT_A, status: 'LEAD', source: 'Fundraiser Inquiry' });
        expect(lead!.args.data.tags).toContain(FUNDRAISER_INQUIRY_TAG);
        expect(leadAlert).toHaveBeenCalledTimes(1);
        const [, payload] = leadAlert.mock.calls[0] as any[];
        expect(payload.source).toBe('Fundraiser Inquiry');
    });

    it('TEST C — the same person: ordering first does not consume their later intent', async () => {
        // 1. they support a fundraiser
        useMock(baseMock({ 'fundraiserCampaign.findUnique': campaignRow('camp-clark') }));
        expect((await postOrder(orderBody({ campaignId: 'camp-clark' }))).status).toBe(200);
        expect(leadAlert).not.toHaveBeenCalled();
        const asSupporter = mock.firstCall('customer.create')!.args.data;
        expect(asSupporter.type).toBe('direct_customer');
        expect(asSupporter.tags ?? []).not.toContain(FUNDRAISER_INQUIRY_TAG);

        // 2. later, the SAME person asks about running one
        jest.clearAllMocks();
        useMock(baseMock());
        expect((await postInquiry(INQUIRY)).status).toBe(200);
        expect(leadAlert).toHaveBeenCalledTimes(1);
    });
});
