/**
 * STOREFRONT-CUSTOMER-EXPERIENCE-1B — an UNLISTED fundraiser is still a fully live fundraiser.
 *
 * `listed_on_storefront` decides one thing: whether the storefront's public Active Fundraisers
 * section advertises the campaign. These tests run the real handlers and helpers that a
 * fundraiser depends on, with the campaign row carrying `listed_on_storefront: false`, and
 * require the same outcome as a listed one:
 *
 *   C  the direct supporter page's payload
 *   D  supporter ordering (POST /api/public/order) and the shared order gate
 *   E  the coordinator portal (GET /api/coordinator)
 *   F  the public scoreboard (GET /api/fundraiser/[token])
 *   G  the closeout and deadline rules
 *
 * tests/storefrontExperience1b.test.ts proves the complementary half: no file outside the
 * storefront query and the tenant CRM mentions the flag at all.
 */
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { toPublicCampaign } from '@/lib/publicFundraiserPayload';
import { isCampaignClosed, isCampaignPastOrderDeadline } from '@/lib/campaignBundleSelection';
import { resolveCampaignOrderMode } from '@/lib/campaignOrderBundles';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__sf1bIsoPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__sf1bIsoPrisma = m.client; };

jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__sf1bIsoCookie ? { name, value: 'sf1b-iso-secret' } : undefined),
    }),
}));
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: jest.fn(async () => undefined),
    sendOrderConfirmationEmail: jest.fn(async () => undefined),
    sendFundraiserCoordinatorNotification: jest.fn(async () => undefined),
    getTenantSender: async () => ({ from: 'tenant@example.invalid' }),
}));

const TENANT = 'biz-sf1b-iso';
const BUNDLE = 'bundle-sf1b-1';
const LISTED = [false, true] as const;

/** A request body or query never asks the database about the listing. */
const mentionsFlag = (v: unknown) => JSON.stringify(v ?? null).includes('listed_on_storefront');

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__sf1bIsoCookie = coordinatorSessionCookieName();
});

// ═════════════════════════════════════════════════════════════════════════════
// C. The direct supporter page.
// ═════════════════════════════════════════════════════════════════════════════
describe('C. the direct fundraiser page is identical whether or not the campaign is listed', () => {
    const row = (listed: boolean) => ({
        id: 'camp-c', name: 'Clark Co Fundraiser', status: 'Active', about_text: 'Support our members',
        mission_text: null, payment_instructions: 'Pay the coordinator', external_payment_link: null,
        end_date: '2026-10-12', delivery_date: '2026-10-17', bundle_selection_status: 'selected',
        participant_label: 'Seller', listed_on_storefront: listed,
        customer_fundraiser_info: { delivery_date: '2026-10-17', delivery_time: '4:00 PM' },
    });

    it('the public payload is the same for both values, and never carries the flag', () => {
        const off = toPublicCampaign(row(false));
        const on = toPublicCampaign(row(true));
        expect(off).toEqual(on);
        expect(off).not.toHaveProperty('listed_on_storefront');
        expect(off?.name).toBe('Clark Co Fundraiser');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// D. Supporter ordering.
// ═════════════════════════════════════════════════════════════════════════════
describe('D. an unlisted campaign still takes supporter orders', () => {
    const campaignRow = (listed: boolean) => ({
        id: 'camp-d', name: 'Jasper Co Fundraiser', status: 'Active', closed_at: null, end_date: null,
        bundle_selection_status: 'not_required', bundle_selection_limit: 2,
        payment_instructions: 'Pay the coordinator', external_payment_link: null, profit_percentage: '20',
        listed_on_storefront: listed,
        customer: {
            id: 'org-d', business_id: TENANT, name: 'Jasper Co Farm Bureau', contact_email: 'coord@example.invalid',
            business: { timezone: 'America/Chicago' },
        },
    });

    const order = async (listed: boolean) => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT, slug: 'sf1b-iso', timezone: 'America/Chicago', name: 'Freezer Chef' },
                'user.findFirst': { email: 'owner@example.invalid' },
                'bundle.findMany': (args: any) => (args?.where?.is_active === false
                    ? []
                    : [{ id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT }]),
                'bundle.findUnique': { id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT },
                'campaignBundle.findMany': [],
                'customer.findFirst': null,
                'order.create': (args: any) => ({ id: 'order-d', ...args?.data, items: [] }),
                'order.findFirst': null,
                'fundraiserCampaign.findUnique': campaignRow(listed),
                $queryRaw: [],
            },
        }));
        const { POST } = await import('@/app/api/public/order/route');
        return readJson(await POST(jsonRequest('http://localhost/api/public/order', {
            slug: 'sf1b-iso',
            campaignId: 'camp-d',
            customer: { firstName: 'Dana', lastName: 'Fields', email: 'dana@example.invalid', phone: '555-0100' },
            items: [{ bundleId: BUNDLE, quantity: 2 }],
        })));
    };

    it.each(LISTED)('listed_on_storefront=%s: the order is accepted and held for the fundraiser', async (listed) => {
        const res = await order(listed);
        expect(res.status).toBe(200);
        const created = mock.firstCall('order.create')!.args.data;
        expect(created).toMatchObject({ campaign_id: 'camp-d', business_id: TENANT, status: 'fundraiser_hold', source: 'fundraiser' });
    });

    it('the order path never asks about the listing', async () => {
        await order(false);
        for (const c of mock.callsTo('fundraiserCampaign.findUnique')) expect(mentionsFlag(c.args)).toBe(false);
    });

    it('the shared order gate returns the same answer either way, in every state', async () => {
        useMock(createPrismaMock());
        const base = { id: 'camp-g', status: 'Active', closed_at: null, end_date: '2099-01-01', bundle_selection_status: 'not_required', bundle_selection_limit: 2 };
        const states = [
            base,
            { ...base, bundle_selection_status: 'pending' },
            { ...base, closed_at: new Date('2026-09-01T00:00:00Z') },
            { ...base, end_date: '2020-01-01' },
            { ...base, status: 'Lead' },
        ];
        for (const s of states) {
            const off = await resolveCampaignOrderMode({ ...s, listed_on_storefront: false }, TENANT, 'America/Chicago');
            const on = await resolveCampaignOrderMode({ ...s, listed_on_storefront: true }, TENANT, 'America/Chicago');
            expect(off).toEqual(on);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// E. The coordinator portal.
// ═════════════════════════════════════════════════════════════════════════════
describe('E. the coordinator portal loads an unlisted campaign exactly as before', () => {
    const campaign = (listed: boolean) => ({
        id: 'camp-e', name: 'Cumberland Co Fundraiser', status: 'Active', end_date: null, delivery_date: null,
        delivery_time: null, closed_at: null, settlement_total: null, pickup_location: 'School gym',
        external_payment_link: null, payment_instructions: 'Checks payable to the PTO', bundle_goal: 50,
        total_sales: 0, org_share_percent: 20, participant_label: 'Student', bundle_selection_status: 'not_required',
        bundle_selection_limit: 2, public_token: 'public-token-e', customer_id: 'org-e', listed_on_storefront: listed,
        customer: {
            name: 'Paris PTO', contact_name: 'Dana Coordinator', contact_email: 'dana@example.invalid', business_id: TENANT,
            business: {
                name: 'Freezer Co', display_name: 'Freezer Co', slug: 'freezerco',
                custom_domain: null, logo_url: null, plan: 'FREE', subscription_status: 'active',
            },
        },
        orders: [],
    });

    const portal = async (listed: boolean) => {
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': {
                    id: 'session-e', campaign_id: 'camp-e', expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
                },
                'fundraiserCampaign.findFirst': campaign(listed),
                'order.findMany': [],
                'bundle.findMany': [],
            },
        }));
        const { GET } = await import('@/app/api/coordinator/route');
        return readJson(await GET(new Request('http://localhost/api/coordinator', {
            method: 'GET', headers: { origin: 'http://localhost' },
        }) as any));
    };

    it.each(LISTED)('listed_on_storefront=%s: the portal loads the campaign and its ordering state', async (listed) => {
        const res = await portal(listed);
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Cumberland Co Fundraiser');
        expect(res.body.orderMode).toMatchObject({ allowed: true });
    });

    it('the portal never asks about the listing', async () => {
        await portal(false);
        for (const c of mock.callsTo('fundraiserCampaign.findFirst')) expect(mentionsFlag(c.args)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// F. The public scoreboard.
// ═════════════════════════════════════════════════════════════════════════════
describe('F. the scoreboard shows an unlisted campaign exactly as before', () => {
    const scoreboard = async (listed: boolean) => {
        useMock(createPrismaMock({
            results: {
                'fundraiserCampaign.findUnique': {
                    id: 'camp-f', name: 'Shelby Co Fundraiser', public_token: 'tok-f', total_sales: 0, bundle_goal: 20,
                    listed_on_storefront: listed, customer: { name: 'Shelby County Farm Bureau Foundation' },
                    orders: [{ customer_name: 'Pat Doe', total_amount: 62.5, created_at: new Date('2026-09-29T12:00:00Z'), items: [] }],
                },
            },
        }));
        const { GET } = await import('@/app/api/fundraiser/[token]/route');
        return readJson(await GET(new Request('http://localhost/api/fundraiser/tok-f') as any, {
            params: Promise.resolve({ token: 'tok-f' }),
        } as any));
    };

    it.each(LISTED)('listed_on_storefront=%s: the scoreboard renders, names masked, totals computed', async (listed) => {
        const res = await scoreboard(listed);
        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Shelby Co Fundraiser');
        expect(res.body.orders[0].customer_name).toBe('Pat D.');
        expect(res.body.total_sales).toBe(62.5);
    });

    it('the scoreboard never selects the listing', async () => {
        await scoreboard(false);
        expect(mentionsFlag(mock.firstCall('fundraiserCampaign.findUnique')!.args)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// G. Closeout and deadline rules.
// ═════════════════════════════════════════════════════════════════════════════
describe('G. closeout and deadline rules ignore the listing', () => {
    const cases = [
        { status: 'Active', closed_at: null, end_date: '2099-01-01' },
        { status: 'Active', closed_at: new Date('2026-09-20T15:00:00Z'), end_date: '2026-09-18' },
        { status: 'Completed', closed_at: null, end_date: '2026-09-18' },
        { status: 'Active', closed_at: null, end_date: '2020-01-01' },
    ];

    it.each(cases)('closed and past-deadline answers are identical for %o', (c) => {
        const now = new Date('2026-09-30T17:00:00Z');
        for (const listed of LISTED) {
            const row = { ...c, listed_on_storefront: listed };
            expect(isCampaignClosed(row)).toBe(isCampaignClosed(c));
            expect(isCampaignPastOrderDeadline(row, 'America/Chicago', now)).toBe(isCampaignPastOrderDeadline(c, 'America/Chicago', now));
        }
    });
});
