/**
 * FULFILLMENT-CONTINUITY-1A — the manual-order serving-tier exception, closed.
 *
 * WHAT FULFILLMENT-CONTINUITY-1 LEFT OPEN
 *
 * FC-1 made Bundle.serving_tier the order-time authority on the three public /
 * coordinator intake routes, but deliberately left app/api/orders/route.ts
 * (authenticated tenant manual order entry) alone, on the reasoning that
 * components/AddOrderModal.tsx renders a serving-size selector separate from
 * the bundle selector, so a tenant might be making a deliberate custom sale.
 *
 * FC-1A re-traced that and the reasoning does not hold:
 *
 *   1. The size selector has NO PRICE EFFECT. app/api/orders/route.ts computes
 *      the line total purely from the Bundle's own price. Selling a Serves-2
 *      bundle "as Serves-5" charges the Serves-2 price and cooks double; the
 *      reverse charges the family price and cooks half. Neither is a coherent
 *      custom sale — there is no pricing mechanism behind it.
 *   2. The tier is INVISIBLE at the point of choice. The bundle dropdown renders
 *      name and price only, never serving_tier, so a tenant cannot see what they
 *      would be overriding.
 *   3. Tier is a property OF THE BUNDLE ROW. /api/bundles derives both cost and
 *      the price fallback from serving_tier, and CB-1 made Serves-2 and Serves-5
 *      separate Bundle rows paired by family_id. The bundle the tenant picks
 *      already IS a tier.
 *   4. The selector PREDATES that model. It is present in the initial commit,
 *      i.e. from before tier became a per-Bundle-row property — a vestige, not
 *      a designed override.
 *   5. Nothing documents it. No doc, comment or test describes a custom-size
 *      manual sale.
 *
 * Every manual order on this route is therefore MODERN BUNDLE-BACKED: the route
 * rejects any item whose bundle_id is absent from the tenant-scoped price map,
 * and Bundle.serving_tier is NOT NULL with a default. There is no legacy
 * no-bundle branch here to preserve.
 *
 * FAILING-FIRST PROOF: run section 1 against the pre-fix source and the two
 * override cases fail, reporting the client's tier. Sections 2 and 3 pass
 * before and after — they are preservation tests.
 *
 * These execute the REAL POST handler against a recording Prisma double and
 * assert on the OrderItem rows the handler actually built.
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const BUSINESS_ID = 'biz-fc1a-manual';
const OTHER_BUSINESS = 'biz-fc1a-other';
const BUNDLE_S5 = 'bundle-fc1a-s5';
const BUNDLE_S2 = 'bundle-fc1a-s2';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__fc1aPrisma; },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__fc1aPrisma = m.client; };

/** The tenant's menu. Both live tier vocabularies appear in real data. */
const bundleRows = [
    { id: BUNDLE_S5, name: 'Family Feast', price: 125, serving_tier: 'family' },
    { id: BUNDLE_S2, name: 'Cozy Couple', price: 60, serving_tier: 'serves_2' },
];

const postRequest = (body: any) =>
    new Request('http://localhost/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as any;

const orderBody = (items: any[]) => ({
    customer_name: 'Walk-in Customer',
    items,
    delivery_date: null,
    delivery_address: null,
});

/** The variant_size values the handler actually wrote, in line order. */
function writtenVariantSizes(): string[] {
    const create = mock.firstCall('order.create');
    const lines = create?.args?.data?.items?.create ?? [];
    return (Array.isArray(lines) ? lines : [lines]).map((l: any) => l.variant_size);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { businessId: BUSINESS_ID } });
    useMock(createPrismaMock({ results: { 'bundle.findMany': bundleRows } }));
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE DEFECT. Fails against pre-fix source.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. a modern Bundle-backed manual order takes its tier from the Bundle', () => {
    it('THE DEFECT: a Serves-2 bundle sent as serves_5 is still recorded serves_2', async () => {
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S2, quantity: 1, variant_size: 'serves_5' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_2']);
    });

    it('THE DEFECT, other direction: a Serves-5 bundle sent as serves_2 is still recorded serves_5', async () => {
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S5, quantity: 1, variant_size: 'serves_2' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_5']);
    });

    it('a mixed basket records each line from its own bundle', async () => {
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S5, quantity: 2, variant_size: 'serves_2' },
            { bundle_id: BUNDLE_S2, quantity: 3, variant_size: 'serves_5' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_5', 'serves_2']);
    });

    it('normalizes rather than rejecting — a mismatched request is still a 200', async () => {
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S2, quantity: 1, variant_size: 'serves_5' },
        ])));
        expect(res.status).toBe(200);
    });

    it('an omitted variant_size no longer defaults a Serves-2 bundle to serves_5', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S2, quantity: 1 }])));
        expect(writtenVariantSizes()).toEqual(['serves_2']);
    });

    it('a free-text tenant tier on the Bundle still resolves to a valid enum value', async () => {
        useMock(createPrismaMock({
            results: {
                'bundle.findMany': [{ id: BUNDLE_S5, name: 'Keto', price: 125, serving_tier: 'Family Size Keto' }],
            },
        }));
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S5, quantity: 1, variant_size: 'serves_2' }])));

        // Unrecognised free text falls back to the family baseline, exactly as
        // resolveVariantSize does everywhere else — never to the client's value.
        expect(writtenVariantSizes()).toEqual(['serves_5']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Tenant scoping — a foreign Bundle can never supply authority.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the tier comes from a TENANT-SCOPED bundle row', () => {
    it('every bundle lookup carries the session business_id', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S5, quantity: 1, variant_size: 'serves_5' }])));

        const reads = mock.callsTo('bundle.findMany');
        expect(reads.length).toBeGreaterThan(0);
        for (const call of reads) {
            expect(call.args?.where?.business_id).toBe(BUSINESS_ID);
        }
        // and never the caller's business, however supplied
        for (const call of reads) {
            expect(call.args?.where?.business_id).not.toBe(OTHER_BUSINESS);
        }
    });

    it('the handler asks the database for serving_tier', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S5, quantity: 1, variant_size: 'serves_5' }])));

        expect(mock.callsTo('bundle.findMany').some((c) => c.args?.select?.serving_tier === true)).toBe(true);
    });

    it('a bundle this tenant does not own is refused — no order is created', async () => {
        useMock(createPrismaMock({ results: { 'bundle.findMany': [] } }));
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([
            { bundle_id: 'bundle-owned-by-another-tenant', quantity: 1, variant_size: 'serves_5' },
        ])));

        expect(res.status).toBe(400);
        expect(mock.firstCall('order.create')).toBeUndefined();
    });

    it('an unauthenticated request is still refused before any bundle read', async () => {
        mockAuth.mockResolvedValue(null);
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S5, quantity: 1 }])));

        expect(res.status).toBe(401);
        expect(mock.firstCall('order.create')).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PRESERVATION — price, totals and the rest of the route are unchanged.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. manual-order behaviour is otherwise preserved', () => {
    it('a matching tier is recorded unchanged', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S5, quantity: 1, variant_size: 'serves_5' },
            { bundle_id: BUNDLE_S2, quantity: 1, variant_size: 'serves_2' },
        ])));
        expect(writtenVariantSizes()).toEqual(['serves_5', 'serves_2']);
    });

    it('PRICE is unaffected — the total still comes from the Bundle rows only', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([
            { bundle_id: BUNDLE_S5, quantity: 2, variant_size: 'serves_2' },
            { bundle_id: BUNDLE_S2, quantity: 3, variant_size: 'serves_5' },
        ])));

        const create = mock.firstCall('order.create');
        // 2 x 125 + 3 x 60 = 430, regardless of the tiers the client sent.
        expect(Number(create?.args?.data?.total_amount)).toBeCloseTo(430, 2);
    });

    it('quantity, bundle_id, source and status are unchanged', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S2, quantity: 4, variant_size: 'serves_5' }])));

        const data = mock.firstCall('order.create')?.args?.data;
        expect(data?.source).toBe('manual');
        expect(data?.status).toBe('pending');
        expect(data?.items?.create?.[0]).toMatchObject({ bundle_id: BUNDLE_S2, quantity: 4 });
    });

    it('no UPDATE is issued against existing order items — history is never re-tiered', async () => {
        const { POST } = await import('@/app/api/orders/route');
        await POST(postRequest(orderBody([{ bundle_id: BUNDLE_S2, quantity: 1, variant_size: 'serves_5' }])));

        expect(mock.callsTo('orderItem.update')).toHaveLength(0);
        expect(mock.callsTo('orderItem.updateMany')).toHaveLength(0);
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('a request with no items is still rejected', async () => {
        const { POST } = await import('@/app/api/orders/route');
        const res = await POST(postRequest({ customer_name: 'X', items: [] }));
        expect(res.status).toBe(400);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The route composes the shared authority rather than re-deriving it.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. app/api/orders/route.ts structure', () => {
    const read = (p: string) =>
        require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

    it('uses the shared sold-tier authority', () => {
        const src = read('app/api/orders/route.ts');
        expect(src).toMatch(/from\s+['"]@\/lib\/orderItemTier['"]/);
        expect(src).toMatch(/resolveSoldVariantSize/);
    });

    it('no longer writes the raw client tier', () => {
        const src = read('app/api/orders/route.ts');
        expect(src).not.toMatch(/variant_size:\s*item\.variant_size\s*\|\|/);
    });

    it('does not re-derive the tier vocabulary inline', () => {
        const src = read('app/api/orders/route.ts');
        expect(src).not.toMatch(/serving_tier\s*===\s*'(couple|family)'/);
    });
});
