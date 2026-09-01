/**
 * FULFILLMENT-CONTINUITY-1 — Bundle.serving_tier is the order-time authority.
 *
 * THE DEFECT THESE TESTS PROVE
 *
 * OrderItem.variant_size decides how much food is cooked (lib/kitchen_engine.ts
 * scales every ingredient by serves_5 = 1.0 / serves_2 = 0.5) and how much
 * bundle stock is decremented. Three order-intake routes took that value
 * straight from the request body — resolveVariantSize(item.serving_tier) —
 * while carefully re-deriving the PRICE of the same line from the tenant-scoped
 * Bundle row. Price was server-authoritative; tier was not.
 *
 * A hand-edited request could therefore buy a Serves-2 bundle at its correct
 * Serves-2 price and have the kitchen cook it at the Serves-5 multiplier.
 *
 * FAILING-FIRST PROOF: run section 2 against the pre-fix source and every
 * "records the BUNDLE's tier" assertion fails, reporting the client's tier
 * instead. Section 1 (the pure rule) and section 4 (legacy compatibility) pass
 * before and after — they are preservation tests, not defect tests.
 *
 * These execute the REAL POST handler against the recording Prisma double
 * (tests/helpers/routeHarness.ts) and assert on the OrderItem row the handler
 * actually built, not on a re-implementation of its rules.
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { resolveSoldVariantSize, clientTierDisagreesWithBundle } from '@/lib/orderItemTier';

const CAMPAIGN_ID = 'campaign-fc1-tier';
const BUSINESS_ID = 'biz-fc1-tier';
const BUNDLE_S5 = 'bundle-fc1-s5';
const BUNDLE_S2 = 'bundle-fc1-s2';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__fc1TierPrisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__fc1TierCookieName && (global as any).__fc1TierAuthed
                ? { name, value: 'fc1-tier-test-secret' }
                : undefined,
    }),
}));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__fc1TierPrisma = m.client; };
const setAuthenticated = (authenticated: boolean) => {
    (global as any).__fc1TierCookieName = coordinatorSessionCookieName();
    (global as any).__fc1TierAuthed = authenticated;
};

const validSession = {
    id: 'session-fc1-tier',
    campaign_id: CAMPAIGN_ID,
    expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: null,
};

const legacyCampaign = {
    id: CAMPAIGN_ID,
    closed_at: null,
    status: 'Active',
    bundle_selection_status: 'not_required',
    customer_id: 'customer-fc1-tier',
    customer: {
        business_id: BUSINESS_ID,
        business: { plan: 'FREE', id: BUSINESS_ID },
    },
};

/** The tenant's real menu. Note the two live tier vocabularies: a tenant may
 *  author 'family' or 'serves_5' for the same tier, and both occur in real data. */
const bundleRows = [
    { id: BUNDLE_S5, name: 'Family Feast', price: 89.99, serving_tier: 'family' },
    { id: BUNDLE_S2, name: 'Cozy Couple', price: 45.5, serving_tier: 'serves_2' },
];

const postRequest = (body: any) =>
    new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify(body),
    }) as any;

const orderBody = (items: any[]) => ({
    customerName: 'Fundraiser Coordinator',
    participantName: 'Team Bake Sale',
    items,
    totalAmount: 999999.99,
    deliveryAddress: null,
    phone: null,
});

/** The variant_size values the handler actually wrote, in line order. */
function writtenVariantSizes(): string[] {
    const create = mock.firstCall('order.create');
    const lines = create?.args?.data?.items?.create ?? [];
    return (Array.isArray(lines) ? lines : [lines]).map((l: any) => l.variant_size);
}

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock({
        results: {
            'coordinatorSession.findUnique': validSession,
            'fundraiserCampaign.findFirst': legacyCampaign,
            'bundle.findMany': bundleRows,
        },
    }));
    setAuthenticated(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. The pure rule. PRESERVATION — passes before and after.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. resolveSoldVariantSize — the menu defines what was sold', () => {
    it('uses the bundle tier and ignores a conflicting client tier', () => {
        expect(resolveSoldVariantSize('serves_2', 'serves_5')).toBe('serves_2');
        expect(resolveSoldVariantSize('serves_5', 'serves_2')).toBe('serves_5');
    });

    it('accepts either live tier vocabulary on the bundle', () => {
        expect(resolveSoldVariantSize('family', 'serves_2')).toBe('serves_5');
        expect(resolveSoldVariantSize('couple', 'serves_5')).toBe('serves_2');
        expect(resolveSoldVariantSize('Family Size', 'serves_2')).toBe('serves_5');
    });

    it('falls back to the client tier ONLY when there is no bundle to speak for the line', () => {
        expect(resolveSoldVariantSize(null, 'serves_2')).toBe('serves_2');
        expect(resolveSoldVariantSize(undefined, 'couple')).toBe('serves_2');
        expect(resolveSoldVariantSize('   ', 'serves_2')).toBe('serves_2');
    });

    it('defaults to serves_5 when neither side says anything, matching the column default', () => {
        expect(resolveSoldVariantSize(null, null)).toBe('serves_5');
        expect(resolveSoldVariantSize(undefined, undefined)).toBe('serves_5');
    });

    it('never returns a value outside the VariantSize enum, even for nonsense', () => {
        for (const bundleTier of ['nonsense', '', null, undefined, 'Family Size Keto']) {
            expect(['serves_2', 'serves_5']).toContain(resolveSoldVariantSize(bundleTier as any, 'nonsense'));
        }
    });

    it('names a client/bundle disagreement without rejecting it', () => {
        expect(clientTierDisagreesWithBundle('serves_2', 'serves_5')).toBe(true);
        expect(clientTierDisagreesWithBundle('family', 'serves_2')).toBe(true);
        expect(clientTierDisagreesWithBundle('family', 'serves_5')).toBe(false);
        expect(clientTierDisagreesWithBundle('serves_2', 'couple')).toBe(false);
        // No bundle tier, or no client tier, is not a disagreement.
        expect(clientTierDisagreesWithBundle(null, 'serves_5')).toBe(false);
        expect(clientTierDisagreesWithBundle('serves_2', null)).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE DEFECT. Fails against pre-fix source.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. a client cannot redefine the bundle tier (POST /api/coordinator)', () => {
    it('THE DEFECT: a Serves-2 bundle claimed as Serves-5 is still recorded serves_2', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S2, quantity: 1, serving_tier: 'serves_5' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_2']);
    });

    it('THE DEFECT, other direction: a Serves-5 bundle claimed as Serves-2 is still recorded serves_5', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S5, quantity: 1, serving_tier: 'serves_2' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_5']);
    });

    it('a mixed basket records each line from its own bundle, not from the request', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S5, quantity: 2, serving_tier: 'serves_2' },
            { bundleId: BUNDLE_S2, quantity: 3, serving_tier: 'serves_5' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_5', 'serves_2']);
    });

    it('an omitted client tier no longer silently defaults a Serves-2 bundle to serves_5', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S2, quantity: 1 },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_2']);
    });

    it('NORMALIZES rather than rejecting — a conflicting tier is still a 200', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S2, quantity: 1, serving_tier: 'family' },
        ])));

        expect(res.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Tenant scoping — the tier must come from a tenant-scoped row.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the tier is read from a TENANT-SCOPED bundle row', () => {
    it('every bundle lookup on the order path carries business_id', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 1, serving_tier: 'serves_5' }])));

        const bundleReads = mock.callsTo('bundle.findMany');
        expect(bundleReads.length).toBeGreaterThan(0);
        for (const call of bundleReads) {
            expect(call.args?.where?.business_id).toBe(BUSINESS_ID);
        }
    });

    it('the handler asks the database for serving_tier', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 1, serving_tier: 'serves_5' }])));

        const selectsTier = mock.callsTo('bundle.findMany')
            .some((c) => c.args?.select?.serving_tier === true);
        expect(selectsTier).toBe(true);
    });

    it('a bundle the tenant does not own cannot supply a tier — the order is refused', async () => {
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': validSession,
                'fundraiserCampaign.findFirst': legacyCampaign,
                // Tenant-scoped lookup returns nothing for a foreign bundle.
                'bundle.findMany': [],
            },
        }));

        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: 'bundle-owned-by-another-tenant', quantity: 1, serving_tier: 'serves_5' },
        ])));

        expect(res.status).toBe(400);
        expect(mock.firstCall('order.create')).toBeUndefined();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. PRESERVATION — correct orders are unchanged, and historical rows untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. correct orders and history are preserved', () => {
    it('a correct Serves-5 order still records serves_5 and still returns 200', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S5, quantity: 2, serving_tier: 'family' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_5']);
    });

    it('a correct Serves-2 order still records serves_2 and still returns 200', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S2, quantity: 4, serving_tier: 'serves_2' },
        ])));

        expect(res.status).toBe(200);
        expect(writtenVariantSizes()).toEqual(['serves_2']);
    });

    it('server-authoritative PRICE behaviour is untouched — the client total is still ignored', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S2, quantity: 2, serving_tier: 'serves_5' },
        ])));

        const create = mock.firstCall('order.create');
        expect(Number(create?.args?.data?.total_amount)).toBeCloseTo(45.5 * 2, 2);
    });

    it('no UPDATE is issued against existing order items — history is never re-tiered', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S2, quantity: 1, serving_tier: 'serves_5' }])));

        expect(mock.callsTo('orderItem.update')).toHaveLength(0);
        expect(mock.callsTo('orderItem.updateMany')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The rule module stays pure and composes rather than duplicating.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. lib/orderItemTier.ts structure', () => {
    const read = (p: string) =>
        require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

    it('does not import the Prisma client, so the rule is testable without a database', () => {
        const src = read('lib/orderItemTier.ts');
        expect(src).not.toMatch(/from\s+['"]@?\/?(\.\/)?lib\/db['"]/);
        expect(src).not.toMatch(/from\s+['"]@prisma\/client['"]/);
    });

    it('delegates the tier vocabulary to lib/serving_multipliers rather than redefining it', () => {
        const src = read('lib/orderItemTier.ts');
        expect(src).toMatch(/from\s+['"]\.\/serving_multipliers['"]/);
        // No second alias table: that is how "serves_2 read as family" defects start.
        expect(src).not.toMatch(/['"]couple['"]\s*:/);
        expect(src).not.toMatch(/['"]family['"]\s*:/);
    });
});
