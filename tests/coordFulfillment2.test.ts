/**
 * COORD-FULFILLMENT-2 — the printable day-of pickup tracker.
 *
 * WHAT THIS PHASE ADDS, AND THE ONE DEFECT IT FIXES
 *
 * The coordinator needs a sheet of paper they can carry to a pickup table and
 * tick people off on. That document is a FULFILMENT document, and it is not the
 * same set as the live order tracker:
 *
 *   live tracker  = every supporter COMMITMENT, including orders still at
 *                   `fundraiser_hold` while the organisation's invoice is unpaid.
 *   pickup tracker = food that actually exists, i.e. orders the paid-invoice
 *                   release has let through.
 *
 * The existing XLSX pickup sheet did not make that distinction: its query was
 * `{ campaign_id, canceled_at: null }` with no status filter at all, so a
 * fundraiser still waiting on payment produced a pickup sheet listing boxes
 * nobody had cooked. Section 1 proves that defect against the pre-fix source
 * and then locks the corrected behaviour.
 *
 * Everything else here is preservation: the security, lineage and privacy rules
 * COORD-FULFILLMENT-1 established must hold identically on the new surface, and
 * the same-name-supporter trap must not be reintroduced by grouping.
 *
 * These execute the REAL route handlers against a recording Prisma double and
 * assert on what the handler actually built.
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    toSupporterOrder,
    supporterEmail,
    supporterGroupKey,
    groupSupporterRows,
    isPickupEligibleOrder,
    formatServingTier,
    SUPPORTER_ORDER_SELECT,
} from '@/lib/coordinatorSupporterOrders';

const CAMPAIGN_A = 'campaign-cf2-a';
const CAMPAIGN_B = 'campaign-cf2-b';
const BUSINESS_A = 'biz-cf2-a';
const ORG_A = 'org-cf2-a';
const SUPPORTER_1 = 'cust-cf2-s1';
const SUPPORTER_2 = 'cust-cf2-s2';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__cf2Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__cf2CookieName && (global as any).__cf2Authed
                ? { name, value: 'cf2-test-secret' }
                : undefined,
    }),
}));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__cf2Prisma = m.client; };
const setAuthenticated = (a: boolean) => {
    (global as any).__cf2CookieName = coordinatorSessionCookieName();
    (global as any).__cf2Authed = a;
};

const sessionFor = (campaignId: string, o: Record<string, any> = {}) => ({
    id: 'session-cf2', campaign_id: campaignId,
    expires_at: new Date(Date.now() + 3_600_000), revoked_at: null, ...o,
});

const campaignRow = {
    id: CAMPAIGN_A,
    name: 'Fall Fundraiser',
    status: 'Active',
    customer_id: ORG_A,
    // Present ON PURPOSE. This route builds an explicit DTO rather than
    // spreading the campaign row, so correct code never copies this field and
    // the "no portal_token" assertions genuinely bite — a fixture without it
    // would let a leak pass, because JSON.stringify silently drops undefined.
    portal_token: 'PORTAL-TOKEN-MUST-NOT-LEAK',
    pickup_location: 'School gym, north entrance',
    delivery_date: new Date('2026-10-14T00:00:00Z'),
    delivery_time: '4:00-6:00 PM',
    payment_instructions: 'Checks payable to the PTO',
    bundle_selection_status: 'not_required',
    bundle_selection_limit: 2,
    closed_at: null,
    end_date: null,
    customer: {
        name: 'Paris PTO',
        contact_name: 'Dana Coordinator',
        contact_email: 'dana@paris-pto.example',
        business_id: BUSINESS_A,
        business: { name: 'Freezer Co', display_name: 'Freezer Co', slug: 'freezerco' },
    },
};

/** A released supporter order (public path: distinct Customer identity). */
const released = (id: string, name: string, customerId: string, email: string | null, phone: string | null, items?: any[]) => ({
    id,
    customer_name: name,
    participant_name: 'Team Blue',
    total_amount: 89.99,
    created_at: new Date('2026-08-30T15:00:00Z'),
    canceled_at: null,
    source: 'fundraiser',
    status: 'production_ready',
    phone,
    customer_id: customerId,
    customer: email === null ? null : { contact_email: email },
    items: items ?? [{ quantity: 1, variant_size: 'serves_5', item_name: 'Keto', bundle_id: 'b-keto-5' }],
});

/** A HELD order — the campaign's invoice has not been paid.
 *  Deliberately its OWN supporter identity: sharing one with a released order
 *  would merge the two into a single group whose name came from the released
 *  one, and the "held order is absent" assertion would pass even if the held
 *  order leaked through. */
const HELD_SUPPORTER = 'cust-cf2-held';
const held = (id: string, name: string) => ({
    ...released(id, name, HELD_SUPPORTER, 'held@example.com', '217-555-0000'),
    status: 'fundraiser_hold',
});

/** A coordinator-entered order: linked to the ORGANISATION. */
const coordinatorEntered = (id: string, name: string, phone: string | null) => ({
    ...released(id, name, ORG_A, 'dana@paris-pto.example', phone),
    participant_name: null,
});

const getRequest = (url = 'http://localhost/api/coordinator/pickup-tracker') =>
    new Request(url, { method: 'GET', headers: { origin: 'http://localhost' } }) as any;

async function callTracker(url?: string) {
    const { GET } = await import('@/app/api/coordinator/pickup-tracker/route');
    const res = await GET(getRequest(url));
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
}

const results = (orders: any[], o: Record<string, any> = {}) => ({
    'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
    'fundraiserCampaign.findFirst': campaignRow,
    'order.findMany': orders,
    'bundle.findMany': [],
    ...o,
});

beforeEach(() => { jest.clearAllMocks(); setAuthenticated(true); });

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE DEFECT — held orders must never reach a day-of pickup document.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. pickup eligibility: released work only', () => {
    it('the pickup-tracker query excludes fundraiser_hold and canceled orders', async () => {
        useMock(createPrismaMock({ results: results([]) }));
        await callTracker();

        const where = mock.firstCall('order.findMany')?.args?.where;
        expect(where?.campaign_id).toBe(CAMPAIGN_A);
        expect(where?.canceled_at).toBeNull();
        expect(JSON.stringify(where)).toContain('fundraiser_hold');
    });

    it('a held order is not returned even when it belongs to this campaign', async () => {
        // The double ignores `where`, so this proves the SECOND line of defence:
        // the handler filters what it received as well as what it asked for.
        useMock(createPrismaMock({
            results: results([
                released('o-ok', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101'),
                held('o-held', 'Held Helen'),
            ]),
        }));

        const { body } = await callTracker();
        const names = body.groups.map((g: any) => g.customer_name);
        expect(names).toContain('Bob Jones');
        expect(names).not.toContain('Held Helen');
    });

    it('a canceled order is not returned', async () => {
        useMock(createPrismaMock({
            results: results([
                released('o-ok', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101'),
                { ...released('o-x', 'Cancelled Casey', SUPPORTER_2, 'c@example.com', null), canceled_at: new Date() },
            ]),
        }));
        const { body } = await callTracker();
        expect(body.groups.map((g: any) => g.customer_name)).toEqual(['Bob Jones']);
    });

    it('the rule composes lib/productionIntake rather than restating it', () => {
        expect(isPickupEligibleOrder({ status: 'fundraiser_hold', source: 'fundraiser', canceled_at: null })).toBe(false);
        expect(isPickupEligibleOrder({ status: 'production_ready', source: 'fundraiser', canceled_at: null })).toBe(true);
        expect(isPickupEligibleOrder({ status: 'production_ready', source: 'fundraiser', canceled_at: new Date() })).toBe(false);
        // Released work that has moved further along is still owed to a supporter.
        for (const s of ['in_production', 'ready_to_ship', 'completed', 'delivered', 'pending']) {
            expect(isPickupEligibleOrder({ status: s, source: 'fundraiser', canceled_at: null })).toBe(true);
        }
    });

    it('the LIVE tracker keeps showing held commitments — the two sets differ on purpose', async () => {
        const { GET } = await import('@/app/api/coordinator/route');
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
                'fundraiserCampaign.findFirst': {
                    ...campaignRow,
                    orders: [held('o-held', 'Held Helen')],
                },
                'order.findMany': [],
                'bundle.findMany': [],
            },
        }));
        const res = await GET(getRequest('http://localhost/api/coordinator'));
        const body = JSON.parse(await res.text());
        expect(body.orders.map((o: any) => o.customer_name)).toContain('Held Helen');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. SECURITY — session-bound, exactly as the live tracker.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. campaign and tenant isolation', () => {
    it('scopes every query to the SESSION campaign', async () => {
        useMock(createPrismaMock({ results: results([]) }));
        await callTracker();
        expect(mock.firstCall('fundraiserCampaign.findFirst')?.args?.where).toEqual({ id: CAMPAIGN_A });
        expect(mock.firstCall('order.findMany')?.args?.where?.campaign_id).toBe(CAMPAIGN_A);
    });

    it('ignores a client-supplied campaign id in the URL', async () => {
        useMock(createPrismaMock({ results: results([]) }));
        await callTracker(
            `http://localhost/api/coordinator/pickup-tracker?campaignId=${CAMPAIGN_B}&campaign_id=${CAMPAIGN_B}&id=${CAMPAIGN_B}`,
        );
        for (const call of mock.calls) {
            expect(JSON.stringify(call.args ?? {})).not.toContain(CAMPAIGN_B);
        }
    });

    it('a second campaign at the same organisation is never queried', async () => {
        useMock(createPrismaMock({ results: results([]) }));
        await callTracker();
        for (const call of mock.calls) {
            expect(JSON.stringify(call.args ?? {})).not.toContain(CAMPAIGN_B);
        }
    });

    it('unauthenticated / revoked / expired / unknown sessions get no manifest', async () => {
        const cases: Array<[string, any]> = [
            ['revoked', sessionFor(CAMPAIGN_A, { revoked_at: new Date() })],
            ['expired', sessionFor(CAMPAIGN_A, { expires_at: new Date(Date.now() - 1000) })],
            ['unknown', null],
        ];
        for (const [, session] of cases) {
            useMock(createPrismaMock({ results: results([], { 'coordinatorSession.findUnique': session }) }));
            const { status } = await callTracker();
            expect(status).toBe(401);
            expect(mock.firstCall('order.findMany')).toBeUndefined();
        }

        setAuthenticated(false);
        useMock(createPrismaMock({ results: results([]) }));
        const { status, text } = await callTracker();
        expect(status).toBe(401);
        expect(text).not.toContain('bob@example.com');
        setAuthenticated(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PRIVACY — contact yes, address and credentials never.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. manifest privacy', () => {
    beforeEach(() => {
        useMock(createPrismaMock({
            results: results([released('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101')]),
        }));
    });

    it('returns supporter name, email and phone', async () => {
        const { body } = await callTracker();
        expect(body.groups[0]).toMatchObject({
            customer_name: 'Bob Jones', email: 'bob@example.com', phone: '217-555-0101',
        });
    });

    it('never selects or returns a home address', async () => {
        const { body, text } = await callTracker();
        const select = mock.firstCall('order.findMany')?.args?.select;
        expect(select).not.toHaveProperty('delivery_address');
        expect(select?.customer?.select).not.toHaveProperty('delivery_address');
        expect(text).not.toContain('delivery_address');
        for (const g of body.groups) expect(g).not.toHaveProperty('delivery_address');
    });

    it('never returns portal_token or any credential-shaped field', async () => {
        const { body, text } = await callTracker();
        expect(body.campaign).not.toHaveProperty('portal_token');
        for (const secret of ['portal_token', 'session_hash', 'client_secret', 'sk_live']) {
            expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
        }
    });

    it('does not leak internal customer or campaign ids into the manifest groups', async () => {
        const { body } = await callTracker();
        for (const g of body.groups) {
            expect(g).not.toHaveProperty('customer_id');
            expect(g).not.toHaveProperty('customer');
            expect(g).not.toHaveProperty('campaign_id');
        }
    });

    it('carries the campaign pickup location, date and time for the header', async () => {
        const { body } = await callTracker();
        expect(body.campaign.pickup_location).toBe('School gym, north entrance');
        expect(body.campaign.delivery_time).toBe('4:00-6:00 PM');
        expect(body.campaign.name).toBe('Fall Fundraiser');
        expect(body.campaign.organization_name).toBe('Paris PTO');
    });

    it('invents no per-supporter payment status', async () => {
        const { text } = await callTracker();
        expect(text).not.toMatch(/"paid"\s*:/i);
        expect(text).not.toMatch(/payment_status/i);
        expect(text).not.toMatch(/\bUNPAID\b/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. LINEAGE + GROUPING — the same-name trap.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. supporter identity', () => {
    it('two supporters WITH THE SAME NAME are never merged', async () => {
        useMock(createPrismaMock({
            results: results([
                released('o-1', 'John Smith', SUPPORTER_1, 'john.a@example.com', '217-555-0001'),
                released('o-2', 'John Smith', SUPPORTER_2, 'john.b@example.com', '217-555-0002'),
            ]),
        }));
        const { body } = await callTracker();
        expect(body.groups).toHaveLength(2);
        expect(body.groups.map((g: any) => g.email).sort())
            .toEqual(['john.a@example.com', 'john.b@example.com']);
    });

    it('two orders from the SAME durable supporter identity DO merge', async () => {
        useMock(createPrismaMock({
            results: results([
                released('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101',
                    [{ quantity: 1, variant_size: 'serves_5', item_name: 'Keto', bundle_id: 'b1' }]),
                released('o-2', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101',
                    [{ quantity: 1, variant_size: 'serves_2', item_name: 'Keto', bundle_id: 'b2' }]),
            ]),
        }));
        const { body } = await callTracker();
        expect(body.groups).toHaveLength(1);
        expect(body.groups[0].items).toHaveLength(2);
        expect(Number(body.groups[0].total)).toBeCloseTo(89.99 * 2, 2);
    });

    it('coordinator-entered orders are NOT merged, because they all share the org id', async () => {
        useMock(createPrismaMock({
            results: results([
                coordinatorEntered('o-c1', 'Walk-in One', '217-555-0301'),
                coordinatorEntered('o-c2', 'Walk-in Two', '217-555-0302'),
            ]),
        }));
        const { body } = await callTracker();
        expect(body.groups).toHaveLength(2);
        expect(body.groups.map((g: any) => g.customer_name).sort()).toEqual(['Walk-in One', 'Walk-in Two']);
    });

    it('a coordinator-entered order never reports the organisation email as the supporter\'s', async () => {
        useMock(createPrismaMock({
            results: results([coordinatorEntered('o-c1', 'Walk-in One', '217-555-0301')]),
        }));
        const { body } = await callTracker();
        expect(body.groups[0].email).toBeNull();
        expect(body.groups[0].phone).toBe('217-555-0301');
        expect(JSON.stringify(body.groups)).not.toContain('dana@paris-pto.example');
    });

    it('the grouping key is durable identity, never a name', () => {
        expect(supporterGroupKey({ id: 'o1', customer_id: SUPPORTER_1 }, ORG_A)).toBe(`customer:${SUPPORTER_1}`);
        expect(supporterGroupKey({ id: 'o1', customer_id: ORG_A }, ORG_A)).toBe('order:o1');
        expect(supporterGroupKey({ id: 'o1', customer_id: null }, ORG_A)).toBe('order:o1');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. CONTENT — bundle, tier, quantity, multi-item.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. manifest content', () => {
    it('a multi-bundle supporter shows EVERY item line with bundle, tier and quantity', async () => {
        useMock(createPrismaMock({
            results: results([
                released('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101', [
                    { quantity: 1, variant_size: 'serves_5', item_name: 'Keto', bundle_id: 'b1' },
                    { quantity: 1, variant_size: 'serves_2', item_name: 'Keto', bundle_id: 'b2' },
                ]),
            ]),
        }));
        const { body } = await callTracker();
        const items = body.groups[0].items;
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ item_name: 'Keto', variant_size: 'serves_5', quantity: 1 });
        expect(items[1]).toMatchObject({ item_name: 'Keto', variant_size: 'serves_2', quantity: 1 });
    });

    it('serving tier is rendered human-readably, not as a raw enum', () => {
        expect(formatServingTier('serves_5')).toBe('Serves 5');
        expect(formatServingTier('serves_2')).toBe('Serves 2');
        expect(formatServingTier(null)).toBe('');
        expect(formatServingTier('')).toBe('');
    });

    it('carries participant, total and timestamp', async () => {
        useMock(createPrismaMock({
            results: results([released('o-1', 'Bob Jones', SUPPORTER_1, 'bob@example.com', '217-555-0101')]),
        }));
        const { body } = await callTracker();
        expect(body.groups[0].participant_name).toBe('Team Blue');
        expect(Number(body.groups[0].total)).toBeCloseTo(89.99, 2);
        expect(body.groups[0].firstOrderedAt).toBeTruthy();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The shared authority itself.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. lib/coordinatorSupporterOrders', () => {
    const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

    it('never selects an address', () => {
        expect(SUPPORTER_ORDER_SELECT).not.toHaveProperty('delivery_address');
        expect((SUPPORTER_ORDER_SELECT as any).customer.select).not.toHaveProperty('delivery_address');
    });

    it('applies the email lineage rule', () => {
        const row: any = { id: 'o', customer_id: SUPPORTER_1, customer: { contact_email: 'a@b.c' } };
        expect(supporterEmail(row, ORG_A)).toBe('a@b.c');
        expect(supporterEmail({ ...row, customer_id: ORG_A }, ORG_A)).toBeNull();
        expect(supporterEmail({ ...row, customer_id: null }, ORG_A)).toBeNull();
    });

    it('the DTO drops working fields', () => {
        const dto: any = toSupporterOrder(
            { id: 'o', customer_id: SUPPORTER_1, customer: { contact_email: 'a@b.c' }, items: [] } as any,
            ORG_A,
        );
        expect(dto).not.toHaveProperty('customer');
        expect(dto).not.toHaveProperty('customer_id');
        expect(dto.email).toBe('a@b.c');
    });

    it('groups take contact from whichever order actually carries it', () => {
        // Rows, not DTOs: the DTO has no customer_id (by design), so grouping
        // DTOs would have no durable identity to group on.
        const a: any = { id: 'o1', customer_name: 'Bob', customer_id: SUPPORTER_1, phone: null, customer: { contact_email: 'bob@x.com' }, items: [] };
        const b: any = { id: 'o2', customer_name: 'Bob', customer_id: SUPPORTER_1, phone: '555', customer: { contact_email: 'bob@x.com' }, items: [] };
        const groups = groupSupporterRows([a, b], ORG_A);
        expect(groups).toHaveLength(1);
        const [g] = groups;
        expect(g.email).toBe('bob@x.com');
        expect(g.phone).toBe('555');
        expect(g.orders).toHaveLength(2);
    });

    it('the grouped DTOs still carry no identity fields', () => {
        const a: any = { id: 'o1', customer_name: 'Bob', customer_id: SUPPORTER_1, customer: { contact_email: 'bob@x.com' }, items: [] };
        const [g] = groupSupporterRows([a], ORG_A);
        expect(g.orders[0]).not.toHaveProperty('customer_id');
        expect(g.orders[0]).not.toHaveProperty('customer');
    });

    it('is pure — no Prisma client import, so both server routes and the print page can use it', () => {
        const src = read('lib/coordinatorSupporterOrders.ts');
        expect(src).not.toMatch(/from\s+['"]@\/lib\/db['"]/);
        expect(src).not.toMatch(/from\s+['"]\.\/db['"]/);
        expect(src).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    });
});
