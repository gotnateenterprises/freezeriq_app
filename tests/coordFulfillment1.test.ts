/**
 * COORD-FULFILLMENT-1 — campaign-scoped supporter contact for coordinators.
 *
 * THE OWNER RULING THIS ENFORCES
 *
 * A coordinator running a fundraiser needs to be able to reach the people who
 * ordered from it. For THEIR OWN campaign they may see supporter name, email,
 * phone, participant, bundle, tier, quantity, total and timestamp. They may
 * never see a supporter's home address, another campaign's supporters, another
 * tenant's supporters, or any credential — in particular the campaign's own
 * portal_token, which the previous broad `include` shipped to the browser on
 * every portal load.
 *
 * These are BEHAVIOURAL tests: they execute the real GET handler against a
 * recording Prisma double and assert on the response body the coordinator
 * actually receives, and on the query the handler actually built. The privacy
 * assertions they replace were source-text greps over the route file, which
 * could only ever prove what the source looked like — not what shipped.
 *
 * The supporter-facing disclosure already states that name, email and phone are
 * shared with the fundraiser coordinator, so this widening matches what buyers
 * were told. tests/privacyDisclosure1.test.ts pins that wording.
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';

const CAMPAIGN_A = 'campaign-cf1-a';
const CAMPAIGN_B = 'campaign-cf1-b';
const BUSINESS_A = 'biz-cf1-a';
const ORG_A = 'org-cf1-a';

/** A per-supporter Customer row, as the public order path creates. */
const SUPPORTER_1 = 'cust-cf1-supporter-1';
const SUPPORTER_2 = 'cust-cf1-supporter-2';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__cf1Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__cf1CookieName && (global as any).__cf1Authed
                ? { name, value: 'cf1-test-secret' }
                : undefined,
    }),
}));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__cf1Prisma = m.client; };
const setAuthenticated = (authenticated: boolean) => {
    (global as any).__cf1CookieName = coordinatorSessionCookieName();
    (global as any).__cf1Authed = authenticated;
};

const sessionFor = (campaignId: string, overrides: Record<string, any> = {}) => ({
    id: 'session-cf1',
    campaign_id: campaignId,
    expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: null,
    ...overrides,
});

/**
 * Campaign A's payload. Note customer_id === ORG_A: that is the organisation
 * running the fundraiser, and it is what coordinator-entered orders link to.
 */
const campaignA = (orders: any[]) => ({
    id: CAMPAIGN_A,
    name: 'Fall Fundraiser',
    status: 'Active',
    end_date: null,
    delivery_date: null,
    delivery_time: null,
    closed_at: null,
    settlement_total: null,
    pickup_location: 'School gym',
    external_payment_link: null,
    payment_instructions: 'Checks payable to the PTO',
    bundle_goal: 50,
    total_sales: 0,
    org_share_percent: 20,
    participant_label: 'Student',
    bundle_selection_status: 'not_required',
    bundle_selection_limit: 2,
    public_token: 'public-token-a',
    customer_id: ORG_A,
    customer: {
        name: 'Paris PTO',
        contact_name: 'Dana Coordinator',
        contact_email: 'dana@paris-pto.example',
        business_id: BUSINESS_A,
        business: {
            name: 'Freezer Co', display_name: 'Freezer Co', slug: 'freezerco',
            custom_domain: null, logo_url: null, plan: 'FREE', subscription_status: 'active',
        },
    },
    orders,
});

/** A supporter's own order: linked to a distinct per-supporter Customer row. */
const supporterOrder = (id: string, name: string, customerId: string, email: string | null, phone: string | null) => ({
    id,
    participant_name: 'Team Blue',
    customer_name: name,
    total_amount: 89.99,
    created_at: new Date('2026-08-30T15:00:00Z'),
    source: 'fundraiser',
    phone,
    customer_id: customerId,
    customer: email === null ? null : { contact_email: email },
    items: [{ quantity: 2, variant_size: 'serves_5', item_name: 'Family Feast' }],
});

/** A coordinator-entered order: linked to the ORGANISATION, not a supporter. */
const coordinatorEnteredOrder = (id: string, name: string, phone: string | null) => ({
    id,
    participant_name: null,
    customer_name: name,
    total_amount: 45.5,
    created_at: new Date('2026-08-30T16:00:00Z'),
    source: 'fundraiser',
    phone,
    customer_id: ORG_A,
    customer: { contact_email: 'dana@paris-pto.example' },
    items: [{ quantity: 1, variant_size: 'serves_2', item_name: 'Cozy Couple' }],
});

const getRequest = () =>
    new Request('http://localhost/api/coordinator', {
        method: 'GET',
        headers: { origin: 'http://localhost' },
    }) as any;

async function callGet() {
    const { GET } = await import('@/app/api/coordinator/route');
    const res = await GET(getRequest());
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
}

const baseResults = (campaign: any, overrides: Record<string, any> = {}) => ({
    'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
    'fundraiserCampaign.findFirst': campaign,
    'order.findMany': [],
    'bundle.findMany': [],
    ...overrides,
});

beforeEach(() => {
    jest.clearAllMocks();
    setAuthenticated(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE OWNER CONTRACT — the coordinator can reach their own supporters.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. supporter contact is returned for the session\'s own campaign', () => {
    beforeEach(() => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([
                supporterOrder('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101'),
            ])),
        }));
    });

    it('returns supporter name, email and phone', async () => {
        const { status, body } = await callGet();
        expect(status).toBe(200);
        expect(body.orders).toHaveLength(1);
        expect(body.orders[0]).toMatchObject({
            customer_name: 'Bob Jones',
            email: 'bob@example.com',
            phone: '217-555-0101',
        });
    });

    it('PRESERVES participant, bundle, tier, quantity, total and timestamp', async () => {
        const { body } = await callGet();
        const o = body.orders[0];
        expect(o.participant_name).toBe('Team Blue');
        expect(Number(o.total_amount)).toBeCloseTo(89.99, 2);
        expect(o.created_at).toBeTruthy();
        expect(o.items).toHaveLength(1);
        expect(o.items[0]).toMatchObject({
            quantity: 2, variant_size: 'serves_5', item_name: 'Family Feast',
        });
    });

    it('asks the database for phone and the linked customer email', async () => {
        await callGet();
        const q = mock.firstCall('fundraiserCampaign.findFirst');
        const ordersSelect = q?.args?.select?.orders?.select;
        expect(ordersSelect?.phone).toBe(true);
        expect(ordersSelect?.customer?.select?.contact_email).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. CREDENTIAL MINIMIZATION — portal_token must never ship.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the campaign projection is an allowlist', () => {
    // WHICH ASSERTION IS LOAD-BEARING: the recording double returns its fixture
    // verbatim and does not apply Prisma's `select`, so a body-level check can
    // only ever prove that the handler did not ADD a credential back after the
    // query. The guard that actually stops portal_token reaching the browser is
    // the query-shape assertion below — it is the one that fails if the
    // allowlist is widened. Verified by mutation: reinstating
    // `portal_token: true` kills that test, not the body one.
    beforeEach(() => {
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
    });

    it('the response body contains no portal_token', async () => {
        const { body, text } = await callGet();
        expect(body).not.toHaveProperty('portal_token');
        expect(text).not.toContain('portal_token');
    });

    it('the query never even SELECTS portal_token', async () => {
        await callGet();
        const q = mock.firstCall('fundraiserCampaign.findFirst');
        expect(q?.args?.select).toBeDefined();
        expect(q?.args?.select).not.toHaveProperty('portal_token');
        // An allowlist, not a spread: `include` would return every scalar.
        expect(q?.args?.include).toBeUndefined();
    });

    it('carries no other credential-shaped material', async () => {
        const { text } = await callGet();
        for (const secret of [
            'session_hash', 'portal_token', 'access_token', 'secret',
            'square_access', 'stripe_secret', 'sk_live', 'client_secret',
        ]) {
            expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
        }
    });

    it('still returns the PUBLIC scoreboard token the portal links to', async () => {
        // public_token addresses /fundraiser/<token>, a no-auth page. Dropping it
        // would break the coordinator's share link; it is not a credential.
        const { body } = await callGet();
        expect(body.public_token).toBe('public-token-a');
    });

    it('does not leak the working customer_id used to classify orders', async () => {
        const { body } = await callGet();
        expect(body).not.toHaveProperty('customer_id');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ISOLATION — the session decides the campaign, nothing else can.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. campaign and tenant isolation', () => {
    it('the campaign query is scoped to the SESSION campaign id', async () => {
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
        await callGet();
        expect(mock.firstCall('fundraiserCampaign.findFirst')?.args?.where).toEqual({ id: CAMPAIGN_A });
    });

    it('a client-supplied campaign id in the URL is ignored', async () => {
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
        const { GET } = await import('@/app/api/coordinator/route');
        await GET(new Request(
            `http://localhost/api/coordinator?campaignId=${CAMPAIGN_B}&campaign_id=${CAMPAIGN_B}&id=${CAMPAIGN_B}`,
            { method: 'GET', headers: { origin: 'http://localhost' } },
        ) as any);

        const where = mock.firstCall('fundraiserCampaign.findFirst')?.args?.where;
        expect(where).toEqual({ id: CAMPAIGN_A });
        expect(JSON.stringify(where)).not.toContain(CAMPAIGN_B);
    });

    it('a second campaign at the SAME organisation is never queried', async () => {
        // Same org, same tenant, different campaign — must stay invisible.
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
        await callGet();
        for (const call of mock.calls) {
            expect(JSON.stringify(call.args ?? {})).not.toContain(CAMPAIGN_B);
        }
    });

    it('the canceled-orders query is campaign-scoped too', async () => {
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
        await callGet();
        expect(mock.firstCall('order.findMany')?.args?.where?.campaign_id).toBe(CAMPAIGN_A);
    });

    it('an unauthenticated caller receives no supporter data', async () => {
        setAuthenticated(false);
        useMock(createPrismaMock({ results: baseResults(campaignA([])) }));
        const { status, text } = await callGet();
        expect(status).toBe(401);
        expect(text).not.toContain('bob@example.com');
        expect(mock.firstCall('fundraiserCampaign.findFirst')).toBeUndefined();
    });

    it('a REVOKED session receives no supporter data', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([]), {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A, { revoked_at: new Date() }),
            }),
        }));
        const { status } = await callGet();
        expect(status).toBe(401);
        expect(mock.firstCall('fundraiserCampaign.findFirst')).toBeUndefined();
    });

    it('an EXPIRED session receives no supporter data', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([]), {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A, { expires_at: new Date(Date.now() - 1000) }),
            }),
        }));
        const { status } = await callGet();
        expect(status).toBe(401);
        expect(mock.firstCall('fundraiserCampaign.findFirst')).toBeUndefined();
    });

    it('an unknown session receives no supporter data', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([]), { 'coordinatorSession.findUnique': null }),
        }));
        const { status } = await callGet();
        expect(status).toBe(401);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. DURABLE IDENTITY — never join contact data by display name.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. contact data is joined by durable identity, not by name', () => {
    it('two supporters WITH THE SAME NAME keep their own distinct contact details', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([
                supporterOrder('o-1', 'Chris Smith', SUPPORTER_1, 'chris.first@example.com', '217-555-0001'),
                supporterOrder('o-2', 'Chris Smith', SUPPORTER_2, 'chris.second@example.com', '217-555-0002'),
            ])),
        }));

        const { body } = await callGet();
        expect(body.orders).toHaveLength(2);
        const byId = Object.fromEntries(body.orders.map((o: any) => [o.id, o]));
        expect(byId['o-1'].email).toBe('chris.first@example.com');
        expect(byId['o-1'].phone).toBe('217-555-0001');
        expect(byId['o-2'].email).toBe('chris.second@example.com');
        expect(byId['o-2'].phone).toBe('217-555-0002');
    });

    it('a coordinator-entered order does NOT report the organisation\'s email as the supporter\'s', async () => {
        // This order links customer_id = the campaign's own organisation. Its
        // contact_email is the coordinator's own inbox; reporting it as the
        // buyer's contact would be actively misleading.
        useMock(createPrismaMock({
            results: baseResults(campaignA([
                coordinatorEnteredOrder('o-coord', 'Walk-in Neighbour', '217-555-0303'),
            ])),
        }));

        const { body } = await callGet();
        expect(body.orders[0].customer_name).toBe('Walk-in Neighbour');
        expect(body.orders[0].email).toBeNull();
        // the phone the coordinator typed IS theirs to see
        expect(body.orders[0].phone).toBe('217-555-0303');
        // The org's own contact_email legitimately appears elsewhere in the
        // payload (campaign.customer.contact_email — the inbox the new-order
        // notification goes to, and the coordinator's own address). What must
        // never happen is it appearing as a SUPPORTER's contact detail.
        expect(JSON.stringify(body.orders)).not.toContain('dana@paris-pto.example');
    });

    it('a supporter order with no linked customer reports no email rather than guessing', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([
                { ...supporterOrder('o-x', 'No Link', SUPPORTER_1, null, null), customer_id: null, customer: null },
            ])),
        }));
        const { body } = await callGet();
        expect(body.orders[0].email).toBeNull();
        expect(body.orders[0].phone).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. HOME ADDRESS STAYS OUT.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. no supporter home address, ever', () => {
    beforeEach(() => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([
                supporterOrder('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101'),
            ])),
        }));
    });

    it('the orders query never selects an address column', async () => {
        await callGet();
        const ordersSelect = mock.firstCall('fundraiserCampaign.findFirst')?.args?.select?.orders?.select;
        expect(ordersSelect).not.toHaveProperty('delivery_address');
        expect(ordersSelect?.customer?.select).not.toHaveProperty('delivery_address');
    });

    it('no order in the response carries an address field', async () => {
        const { body } = await callGet();
        for (const o of body.orders) {
            expect(o).not.toHaveProperty('delivery_address');
            expect(o).not.toHaveProperty('address');
        }
    });

    it('the campaign pickup_location IS returned — that is the fulfilment address', async () => {
        const { body } = await callGet();
        expect(body.pickup_location).toBe('School gym');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Canceled orders follow the same projection.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. the canceled-order list uses the same safe shape', () => {
    it('carries contact but never address or raw customer objects', async () => {
        useMock(createPrismaMock({
            results: baseResults(campaignA([]), {
                'order.findMany': [{
                    ...supporterOrder('o-cancel', 'Dana Buyer', SUPPORTER_1, 'dana.buyer@example.com', '217-555-0909'),
                    canceled_at: new Date('2026-08-31T10:00:00Z'),
                }],
            }),
        }));

        const { body } = await callGet();
        expect(body.canceledOrders).toHaveLength(1);
        const c = body.canceledOrders[0];
        expect(c).toMatchObject({ customer_name: 'Dana Buyer', email: 'dana.buyer@example.com', phone: '217-555-0909' });
        expect(c).not.toHaveProperty('delivery_address');
        expect(c).not.toHaveProperty('customer');
        expect(c).not.toHaveProperty('customer_id');
        expect(c.canceled_at).toBeTruthy();
    });
});
