/**
 * OPS-1 — coordinator order validity / closeout-blocker prevention.
 *
 * FR-OPS-LOCKDOWN-AUDIT-1 found that POST /api/coordinator validates bundle
 * eligibility (CB-5) and price (LAW 1) but never validates item.quantity at
 * all — it flows straight from the request body into the server-computed
 * total and the OrderItem row. lib/fundraiserCloseoutMath.ts documents the
 * consequence already observed in Production: an order with total_amount > 0
 * and zero reconciling OrderItems makes its whole campaign impossible to
 * close out (assertLinesReconcile refuses with a 409, naming the offender).
 *
 * These tests execute the REAL POST handler against a recording Prisma
 * double (tests/helpers/routeHarness.ts), per this repo's established
 * standard that source greps cannot distinguish "returns refuse()" from
 * "returns ok" (tests/outreachConsent1.test.ts:646-652), the same standard
 * SEC-RECIPE-PUT-1 used (tests/secRecipePut1.test.ts).
 *
 * PART D PROOF: run against the pre-fix source, every test under section 2
 * fails (or 500s instead of a clean 400 — Order.total_amount and
 * OrderItem.quantity are non-nullable schema fields, so an omitted/NaN
 * quantity trips Prisma's own client-side validation and falls into the
 * route's generic catch, not a deliberate 400). Run against the fixed
 * source, every test passes.
 */
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { aggregateBundleLines, sumLineTotals, assertLinesReconcile } from '@/lib/fundraiserCloseoutMath';

const CAMPAIGN_ID = 'campaign-ops1-1';
const BUSINESS_ID = 'biz-ops1-1';
const BUNDLE_S5 = 'bundle-ops1-s5';
const BUNDLE_S2 = 'bundle-ops1-s2';
const FOREIGN_BUNDLE = 'bundle-not-in-campaign';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__ops1Prisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__ops1CookieName && (global as any).__ops1Authenticated
                ? { name, value: 'ops1-test-secret' }
                : undefined,
    }),
}));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops1Prisma = m.client; };
const setAuthenticated = (authenticated: boolean) => {
    (global as any).__ops1CookieName = coordinatorSessionCookieName();
    (global as any).__ops1Authenticated = authenticated;
};

const validSession = {
    id: 'session-ops1-1',
    campaign_id: CAMPAIGN_ID,
    expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: null,
};

/** Legacy mode: bundle_selection_status 'not_required' short-circuits
 *  resolveCampaignOrderMode with no extra DB calls — the simplest fixture
 *  that still exercises the exact code path production traffic uses. */
const legacyCampaign = {
    id: CAMPAIGN_ID,
    closed_at: null,
    status: 'Active',
    bundle_selection_status: 'not_required',
    customer_id: 'customer-ops1-1',
    customer: {
        business_id: BUSINESS_ID,
        business: { plan: 'FREE', id: BUSINESS_ID },
    },
};

/** 'selected' mode, for the campaign-authorization test below. */
const selectedCampaign = {
    ...legacyCampaign,
    bundle_selection_status: 'selected',
};

const bundleRows = [
    { id: BUNDLE_S5, name: 'Family Feast', price: 89.99, serving_tier: 'serves_5' },
    { id: BUNDLE_S2, name: 'Cozy Couple', price: 45.5, serving_tier: 'serves_2' },
];

function baseResults(overrides: Record<string, any> = {}) {
    return {
        'coordinatorSession.findUnique': validSession,
        'fundraiserCampaign.findFirst': legacyCampaign,
        'bundle.findMany': bundleRows,
        ...overrides,
    };
}

const postRequest = (body: any) =>
    new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify(body),
    }) as any;

/** For the one case a real JSON round-trip cannot carry: JSON.stringify
 *  turns NaN into null, so a literal in-memory NaN needs a hand-built
 *  Request whose .json() bypasses serialization entirely. */
const postRequestWithRawBody = (body: any) => {
    const req = new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: '{}',
    }) as any;
    req.json = async () => body;
    return req;
};

const orderBody = (items: any[], extra: Record<string, any> = {}) => ({
    customerName: 'Fundraiser Coordinator',
    participantName: 'Team Bake Sale',
    items,
    totalAmount: 999999.99, // deliberately wrong — must never be trusted
    deliveryAddress: null,
    phone: null,
    ...extra,
});

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock({ results: baseResults() }));
    setAuthenticated(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Happy path — valid coordinator orders still succeed.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. valid coordinator orders succeed', () => {
    it('a valid one-item order succeeds (200)', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 2, serving_tier: 'serves_5' }])));
        expect(res.status).toBe(200);
    });

    it('a valid multi-item order succeeds (200)', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S5, quantity: 2, serving_tier: 'serves_5' },
            { bundleId: BUNDLE_S2, quantity: 3, serving_tier: 'serves_2' },
        ])));
        expect(res.status).toBe(200);
    });

    it('quantity 1 succeeds', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 1 }])));
        expect(res.status).toBe(200);
    });

    it('quantity > 1 succeeds', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 25 }])));
        expect(res.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE DEFECT — invalid quantities. PART D proof: every case here must
//    currently be attemptable; the assertions state what SHOULD happen.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. invalid item quantities are rejected before any write', () => {
    const cases: Array<[string, any]> = [
        ['quantity omitted', [{ bundleId: BUNDLE_S5 }]],
        ['quantity 0', [{ bundleId: BUNDLE_S5, quantity: 0 }]],
        ['negative quantity', [{ bundleId: BUNDLE_S5, quantity: -3 }]],
        ['non-numeric quantity (string)', [{ bundleId: BUNDLE_S5, quantity: '2' }]],
        ['fractional quantity', [{ bundleId: BUNDLE_S5, quantity: 2.5 }]],
        ['Infinity', [{ bundleId: BUNDLE_S5, quantity: Infinity }]],
        ['every item quantity zero (multi-item)', [
            { bundleId: BUNDLE_S5, quantity: 0 },
            { bundleId: BUNDLE_S2, quantity: 0 },
        ]],
        ['one valid item plus one zero-quantity item', [
            { bundleId: BUNDLE_S5, quantity: 2 },
            { bundleId: BUNDLE_S2, quantity: 0 },
        ]],
    ];

    for (const [label, items] of cases) {
        it(`${label} -> 400 INVALID_QUANTITY, zero writes`, async () => {
            const { POST } = await import('@/app/api/coordinator/route');
            const res = await POST(postRequest(orderBody(items)));
            const body = await res.json();

            expect(res.status).toBe(400);
            expect(body.code).toBe('INVALID_QUANTITY');
            expect(mock.callsTo('order.create')).toHaveLength(0);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        });
    }

    it('a NaN quantity (not representable over real JSON — hand-built body) -> 400 INVALID_QUANTITY, zero writes', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequestWithRawBody(orderBody([{ bundleId: BUNDLE_S5, quantity: NaN }])));
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.code).toBe('INVALID_QUANTITY');
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('empty item list -> 400, zero writes (pre-existing behavior, regression-tested here)', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([])));

        expect(res.status).toBe(400);
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Bundle authorization — pre-existing CB-5 behavior, regression-tested.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. bundle authorization is unaffected by the quantity fix', () => {
    it('a malformed / unknown bundle id is refused, zero writes', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([{ bundleId: 'does-not-exist', quantity: 1 }])));

        expect(res.status).toBe(400);
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('a bundle not authorized for this campaign is refused, zero writes', async () => {
        // FOREIGN_BUNDLE is deliberately a REAL, validly-priced, tenant-owned
        // bundle here (present in bundle.findMany with a price) — it is simply
        // not one of the campaign's active CampaignBundle assignments. That
        // isolates CB-5 eligibility as the ONLY thing that can reject it: if
        // FOREIGN_BUNDLE were absent from bundle.findMany entirely, the later
        // price-lookup catch would reject it independently of eligibility, and
        // this test would pass even with the CB-5 gate deleted (proven by the
        // OPS-1 Part N mutation battery — M6 initially survived for exactly
        // this reason, before the fixture was corrected to isolate the gate).
        useMock(createPrismaMock({
            results: baseResults({
                'fundraiserCampaign.findFirst': selectedCampaign,
                'bundle.findMany': [...bundleRows, { id: FOREIGN_BUNDLE, name: 'Outside Bundle', price: 50, serving_tier: 'serves_5' }],
                'campaignBundle.findMany': [
                    { bundle: { id: BUNDLE_S5, business_id: BUSINESS_ID, is_active: true, family_id: 'fam-1', serving_tier: 'serves_5' } },
                    { bundle: { id: BUNDLE_S2, business_id: BUSINESS_ID, is_active: true, family_id: 'fam-1', serving_tier: 'serves_2' } },
                ],
            }),
        }));

        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([{ bundleId: FOREIGN_BUNDLE, quantity: 1 }])));

        expect(res.status).toBe(400);
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Total-amount authority — server-derived, client value never trusted.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. order total is derived server-side and a spoofed client total has no effect', () => {
    it('persisted total is price x quantity, never the client-supplied totalAmount', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 2 }], { totalAmount: 1 })));

        const create = mock.firstCall('order.create');
        expect(create).toBeDefined();
        expect(create!.args.data.total_amount).toBeCloseTo(89.99 * 2, 2);
        expect(create!.args.data.total_amount).not.toBe(1);
    });

    it('a wildly inflated client totalAmount is still ignored', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S2, quantity: 1 }], { totalAmount: 5_000_000 })));

        const create = mock.firstCall('order.create');
        expect(create!.args.data.total_amount).toBeCloseTo(45.5, 2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Failed validation writes nothing — Order and OrderItem are a single
//    nested Prisma create, so "zero OrderItem rows" is proven by "zero
//    order.create calls": there is no separate orderItem.create call in this
//    handler for a nested write to leave partially applied.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. rejected requests create zero Order rows and zero OrderItem rows', () => {
    it('quantity 0 leaves no trace in Prisma calls at all beyond reads', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody([{ bundleId: BUNDLE_S5, quantity: 0 }])));

        expect(mock.callsTo('order.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. PART O — a valid coordinator order satisfies the REAL closeout gate.
//    Not a hand-written mirror: this calls the actual
//    lib/fundraiserCloseoutMath.ts functions closeout uses.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. a valid coordinator order reconciles against the real closeout gate', () => {
    it('S5 + S2 + multi-quantity: order.total_amount === sum of authoritative OrderItem lines', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody([
            { bundleId: BUNDLE_S5, quantity: 3, serving_tier: 'serves_5' },
            { bundleId: BUNDLE_S2, quantity: 4, serving_tier: 'serves_2' },
        ])));
        expect(res.status).toBe(200);

        const create = mock.firstCall('order.create')!;
        const persistedTotal = Number(create.args.data.total_amount);
        const createdItems = create.args.data.items.create as Array<{ bundle_id: string; quantity: number; unit_price: number; variant_size: string; item_name: string | null }>;

        expect(persistedTotal).toBeCloseTo(89.99 * 3 + 45.5 * 4, 2);

        // Feed the ACTUAL created items into the ACTUAL closeout gate.
        const lines = aggregateBundleLines(createdItems.map((it) => ({
            bundleId: it.bundle_id,
            description: it.item_name ?? 'item',
            variantSize: it.variant_size,
            quantity: it.quantity,
            unitPrice: Number(it.unit_price),
        })));
        const lineSum = sumLineTotals(lines);

        expect(lineSum).toBeCloseTo(persistedTotal, 2);
        expect(() => assertLinesReconcile(lines, persistedTotal)).not.toThrow();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Public order route is untouched by this phase (source-level guard —
//    the shared helper extraction must not change ITS behavior; the full
//    existing public-order test suites are the runtime proof, run in Part R).
// ═════════════════════════════════════════════════════════════════════════════
describe('7. public order route quantity rule is unchanged in shape', () => {
    it('still returns the same error code and message this repo already shipped', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'public', 'order', 'route.ts'), 'utf8');
        expect(src).toContain('INVALID_QUANTITY');
        expect(src).toContain('Every item quantity must be a positive integer');
    });
});
