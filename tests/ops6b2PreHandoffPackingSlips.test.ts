/**
 * OPS-6B.2 — PRE-HANDOFF packing slips, without reopening the OPS-6B.1
 * active-Delivery population fix.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7, §8, §11 Rule 8.
 *
 * THE OWNER RULING THIS ENCODES: a packing slip is the paper that goes INSIDE
 * the box, so it must be printable while the order is still in Packed & Ready.
 * OPS-6B.1 had moved all slip printing behind Send to Delivery, which inverted
 * the physical workflow.
 *
 * TWO WORKFLOW POPULATIONS ARE LEGITIMATE. TWO BOX AUTHORITIES ARE NOT. These
 * tests pin both halves: the populations are deliberately different, and the
 * rendered document is deliberately identical. A future engineer who "unifies"
 * the populations breaks the first half; one who forks the payload assembly
 * breaks the second.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PRE = 'app/api/production/packing-slips/route.ts';
const REPRINT = 'app/api/delivery/packing-slips/route.ts';
const QUEUE_UI = 'components/production/DeliveryQueue.tsx';
const PAGE = 'app/delivery/print-packing-slips/page.tsx';
const CONTENTS = 'lib/packingSlipContents.ts';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6b2Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6b2Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ── Fixtures ────────────────────────────────────────────────────────────────
const order = (over: any = {}) => ({
    id: 'ord-packed',
    first_name: 'Laurie', last_name: 'Hacker', customer_name: 'Laurie Hacker',
    status: 'ready_to_ship', canceled_at: null, released_to_delivery_at: null,
    delivery_date: null, delivery_sequence: 1,
    campaign: { delivery_date: new Date('2026-08-25') },
    items: [{
        id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5', item_name: 'Comfort Foods',
        bundle: { id: 'b-1', name: 'Comfort Foods', serving_tier: 'family', contents: [{ quantity: 2, recipe: { name: 'Lasagna' } }] },
    }],
    ...over,
});

const PACKED = order();                                                  // unreleased, Packed & Ready
const RELEASED = order({ id: 'ord-released', released_to_delivery_at: new Date('2026-09-05') });

/** A mock that evaluates the eligibility predicates the routes actually send. */
const evaluatingMock = (rows: any[]) => createPrismaMock({ results: {
    'order.findMany': (args: any) => {
        const w = args?.where ?? {};
        return rows.filter((r: any) => {
            if (w.released_to_delivery_at === null && r.released_to_delivery_at !== null) return false;
            if (w.released_to_delivery_at?.not === null && r.released_to_delivery_at === null) return false;
            if (w.canceled_at === null && r.canceled_at !== null) return false;
            if (w.status?.in && !w.status.in.includes(r.status)) return false;
            if (w.NOT?.status?.in && w.NOT.status.in.includes(r.status)) return false;
            if (w.id?.in && !w.id.in.includes(r.id)) return false;
            return true;
        });
    },
    'order.count': 0,
} });

const callPre = async (orderIds: string[]) => {
    const { POST } = await import('@/app/api/production/packing-slips/route');
    const res = await POST(new Request('http://localhost/api/production/packing-slips', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds }),
    }) as any);
    return { status: res.status, body: await res.json() };
};
const callReprint = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/packing-slips/route');
    const res = await GET(new Request(`http://localhost/api/delivery/packing-slips${qs}`) as any);
    return { status: res.status, body: await res.json() };
};

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: 'biz-a' } });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRE-HANDOFF ACCESS (1-4)
// ═════════════════════════════════════════════════════════════════════════════
describe('PRE-HANDOFF ACCESS', () => {
    it('A1. an UNRELEASED Packed & Ready order CAN print its primary packing slip', async () => {
        useMock(evaluatingMock([PACKED]));
        const { status, body } = await callPre(['ord-packed']);
        expect(status).toBe(200);
        expect(body.boxes).toHaveLength(1);
        expect(body.boxes[0].supporterName).toBe('Laurie Hacker');
    });

    it('A2. that same unreleased order is still EXCLUDED from Delivery Slips', async () => {
        useMock(evaluatingMock([PACKED]));
        const { body } = await callReprint();
        expect(body.boxes).toHaveLength(0);
        // The Delivery route still demands the handoff.
        expect(mock.firstCall('order.findMany')?.args?.where?.released_to_delivery_at).toEqual({ not: null });
    });

    it('A3. a RELEASED order is excluded from the pre-handoff population (its slip is a reprint)', async () => {
        useMock(evaluatingMock([RELEASED]));
        const { body } = await callPre(['ord-released']);
        expect(body.boxes).toHaveLength(0);
        expect(body.unavailableCount).toBe(1);
        expect(mock.firstCall('order.findMany')?.args?.where?.released_to_delivery_at).toBeNull();
    });

    it('A4. a released order IS included in the Delivery reprint', async () => {
        useMock(evaluatingMock([RELEASED]));
        const { body } = await callReprint();
        expect(body.boxes).toHaveLength(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIFECYCLE NON-MUTATION (5-9)
// ═════════════════════════════════════════════════════════════════════════════
describe('LIFECYCLE NON-MUTATION', () => {
    it('B1. the pre-handoff route contains NO write of any kind', () => {
        const s = strip(read(PRE));
        expect(s).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\.deleteMany\(|\$executeRaw|\$transaction/);
        expect(s).not.toMatch(/released_to_delivery_at:\s*new Date|released_to_delivery_by/);
        expect(s).not.toMatch(/status:\s*'delivered'/);
        expect(s).not.toMatch(/packagingItem/);
    });

    it('B2. printing performs zero Prisma writes at runtime', async () => {
        useMock(evaluatingMock([PACKED]));
        await callPre(['ord-packed']);
        for (const m of ['order.update', 'order.updateMany', 'order.create', 'packagingItem.update', 'packagingItem.updateMany']) {
            expect(mock.callsTo(m)).toHaveLength(0);
        }
    });

    it('B3. queuing slips in the UI never calls the handoff route', () => {
        const s = strip(read(QUEUE_UI));
        const handler = s.slice(s.indexOf('const queuePackingSlips'), s.indexOf('const sendToDelivery'));
        expect(handler.length).toBeGreaterThan(100);
        expect(handler).not.toMatch(/\/api\/delivery\/handoff|released_to_delivery/);
        expect(handler).toMatch(/writePackingSlipBatch/);
    });

    it('B4. Send to Delivery still exists and is still the only release action', () => {
        const s = strip(read(QUEUE_UI));
        expect(s).toMatch(/const sendToDelivery = async/);
        expect(s).toMatch(/'\/api\/delivery\/handoff'/);
        expect((s.match(/\/api\/delivery\/handoff/g) || []).length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ONE PHYSICAL-BOX AUTHORITY + KEYSTONE (10-17)
// ═════════════════════════════════════════════════════════════════════════════
describe('SHARED BOX + RENDERING AUTHORITY', () => {
    const withItems = (items: any[], over: any = {}) => order({ items, ...over });

    it('C1. one Serves-5 -> one pre-handoff slip', async () => {
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5', item_name: 'A', bundle: { id: 'b-1', name: 'A', contents: [] } },
        ])]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(1);
        expect(body.largeBoxCount).toBe(1);
    });

    it('C2. two same-order Serves-2 -> ONE pre-handoff slip', async () => {
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 2, variant_size: 'serves_2', item_name: 'A', bundle: { id: 'b-1', name: 'A', contents: [] } },
        ])]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(1);
        expect(body.largeBoxCount).toBe(1);
    });

    it('C3. three Serves-2 -> TWO pre-handoff slips (large + small)', async () => {
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 3, variant_size: 'serves_2', item_name: 'A', bundle: { id: 'b-1', name: 'A', contents: [] } },
        ])]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(2);
        expect(body.largeBoxCount).toBe(1);
        expect(body.smallBoxCount).toBe(1);
    });

    it('C4. separate orders never pair', async () => {
        const mk = (id: string) => withItems([
            { id: `oi-${id}`, bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2', item_name: 'A', bundle: { id: 'b-1', name: 'A', contents: [] } },
        ], { id });
        useMock(evaluatingMock([mk('ord-1'), mk('ord-2')]));
        const { body } = await callPre(['ord-1', 'ord-2']);
        expect(body.boxes).toHaveLength(2);
        expect(body.smallBoxCount).toBe(2);
    });

    it('C5. the sold tier is the FROZEN variant_size, not the mutable bundle tier', async () => {
        // serving_tier says "family"; the sale was Serves-2.
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2', item_name: 'A',
              bundle: { id: 'b-1', name: 'A', serving_tier: 'family', contents: [] } },
        ])]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes[0].boxType).toBe('small');
        expect(body.boxes[0].contents[0].servingTier).toBe('Serves 2');
    });

    it('C6. KEYSTONE — the pre-handoff slip and its later Delivery reprint are the SAME document', async () => {
        // Same order, printed before release...
        useMock(evaluatingMock([PACKED]));
        const before = (await callPre(['ord-packed'])).body;

        // ...then released, and reprinted from Delivery.
        const released = { ...PACKED, released_to_delivery_at: new Date('2026-09-05') };
        useMock(evaluatingMock([released]));
        const after = (await callReprint()).body;

        expect(before.boxes).toHaveLength(1);
        expect(after.boxes).toHaveLength(1);

        // Identical cartons, identity, Box N/M, tier and contents.
        expect(after.boxes).toEqual(before.boxes);
        expect(after.mealsByOrderItemId).toEqual(before.mealsByOrderItemId);
        expect(after.deliveryDateByOrderId).toEqual(before.deliveryDateByOrderId);
        expect(after.physicalBoxCount).toBe(before.physicalBoxCount);
    });

    it('C7. both routes share ONE select and ONE payload builder — neither forks the assembly', () => {
        for (const f of [PRE, REPRINT]) {
            const s = strip(read(f));
            expect(s).toMatch(/PACKING_SLIP_ORDER_SELECT/);
            expect(s).toMatch(/buildPackingSlipPayload\(/);
            // No local re-derivation of packing, identity, dates or meals.
            expect(s).not.toMatch(/buildPhysicalBoxManifest\(|resolveSlipDeliveryDate\(|buildMealsByOrderItemId\(|orderBoxesByDeliverySequence\(/);
        }
        // The shared builder is the only place that assembly lives.
        expect(strip(read(CONTENTS))).toMatch(/export function buildPackingSlipPayload/);
    });

    it('C8. the print page renders ONE contract for both contexts — only the fetch differs', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/const isPreHandoff = searchParams\.get\('source'\) === 'packed-ready';/);
        expect(s).toMatch(/\/api\/production\/packing-slips/);
        expect(s).toMatch(/\/api\/delivery\/packing-slips/);
        // One renderer: the box map appears exactly once.
        expect((s.match(/boxes\.map\(\(box\)/g) || []).length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY REFUSALS + TENANCY (18-21)
// ═════════════════════════════════════════════════════════════════════════════
describe('ELIGIBILITY AND TENANCY', () => {
    it('D1. Tenant A cannot print Tenant B pre-handoff slips', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': (args: any) => (args?.where?.business_id === 'biz-a' ? [] : [PACKED]),
        } }));
        mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: 'biz-a' } });
        const { body } = await callPre(['ord-of-tenant-b']);
        expect(body.boxes).toHaveLength(0);
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
    });

    it('D2. a canceled order is refused', async () => {
        useMock(evaluatingMock([order({ canceled_at: new Date('2026-08-01') })]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(0);
        expect(mock.firstCall('order.findMany')?.args?.where?.canceled_at).toBeNull();
    });

    it('D3. a delivered order is refused', async () => {
        useMock(evaluatingMock([order({ status: 'delivered' })]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(0);
    });

    it('D4. an order not yet Packed & Ready is refused', async () => {
        useMock(evaluatingMock([order({ status: 'in_production' })]));
        const { body } = await callPre(['ord-packed']);
        expect(body.boxes).toHaveLength(0);
        const statuses = mock.firstCall('order.findMany')?.args?.where?.status?.in;
        expect(statuses).toEqual(expect.arrayContaining(['ready_to_ship']));
        expect(statuses).not.toContain('in_production');
    });

    it('D5. an unauthenticated request is refused before any DB access', async () => {
        useMock(createPrismaMock({ results: {} }));
        mockAuth.mockResolvedValue(null);
        const { status } = await callPre(['ord-packed']);
        expect(status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('D6. a client-supplied businessId is ignored', async () => {
        useMock(evaluatingMock([PACKED]));
        const { POST } = await import('@/app/api/production/packing-slips/route');
        await POST(new Request('http://localhost/api/production/packing-slips', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: ['ord-packed'], businessId: 'biz-b' }),
        }) as any);
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
    });

    it('D7. refusals never distinguish "another tenant\'s" from "not eligible"', async () => {
        useMock(evaluatingMock([RELEASED]));
        const { body } = await callPre(['ord-released']);
        expect(body.unavailableCount).toBe(1);
        expect(JSON.stringify(body)).not.toMatch(/tenant|belongs|another business/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// OPS-6B.1 PRESERVED (22-25)
// ═════════════════════════════════════════════════════════════════════════════
describe('OPS-6B.1 PRESERVED', () => {
    it('E1. the Delivery Slips badge still describes ACTIVE DELIVERY only', () => {
        const s = read('app/delivery/page.tsx');
        expect(s).toMatch(/api\/delivery\/packing-slips/);
        expect(s).not.toMatch(/api\/production\/packing-slips/);
        expect(s).toMatch(/\{slipCount \?\? stats\?\.physicalBoxCount \?\? 0\}/);
    });

    it('E2. a Kelsi-style unreleased order can never return to Delivery Slips', async () => {
        const kelsi = order({ id: 'ord-kelsi', customer_name: 'Kelsi H', released_to_delivery_at: null });
        useMock(evaluatingMock([RELEASED, kelsi]));
        const { body } = await callReprint();
        const names = body.boxes.map((b: any) => b.supporterName);
        expect(names).not.toContain('Kelsi H');
    });

    it('E3. the selected Delivery week still governs reprints', async () => {
        useMock(evaluatingMock([RELEASED]));
        await callReprint('?delivery_week_start=2026-08-23');
        const or = mock.firstCall('order.findMany')?.args?.where?.OR;
        expect(Array.isArray(or)).toBe(true);
        expect(or[0]).toHaveProperty('campaign.delivery_date');
    });

    it('E4. PART H — the pre-handoff print is NOT governed by any dashboard week', async () => {
        useMock(evaluatingMock([PACKED]));
        await callPre(['ord-packed']);
        const where = mock.firstCall('order.findMany')?.args?.where;
        // The operator explicitly selected these orders; no week predicate applies.
        expect(where.OR).toBeUndefined();
        expect(strip(read(PRE))).not.toMatch(/delivery_week_start|parseDeliveryWeek/);
        // But the PRINTED date still uses the canonical effective date.
        const { body } = await callPre(['ord-packed']);
        expect(body.deliveryDateByOrderId['ord-packed']).toContain('2026-08-25');
    });

    it('E5. the shared active-Delivery population authority is untouched', () => {
        const s = strip(read('lib/delivery/activeDeliveryPopulation.ts'));
        expect(s).toMatch(/released_to_delivery_at: \{ not: null \}/);
        expect(s).not.toMatch(/packed-ready|production\/packing-slips/);
    });
});
