/**
 * OPS-6B — SEND TO DELIVERY: the explicit Production → Delivery handoff.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §8, §11 Rule 8.
 *
 * Covers the mission's HANDOFF (10), PACKAGING INVENTORY (9) and SECURITY (5)
 * matrices. The box-authority, dashboard, manifest and regression matrices live
 * in tests/ops6bDeliveryBoxTruth.test.ts.
 *
 * Supersedes the temporary tests/ops6bFailingFirstProbe.test.ts, which proved
 * against HEAD b0b7a5c that none of this existed: no handoff route, no persisted
 * marker, no lane exit, and a packaging decrement driven by client-supplied
 * counts on a repeatable print event.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const HANDOFF = 'app/api/delivery/handoff/route.ts';
const QUEUE_ROUTE = 'app/api/delivery/queue/route.ts';
const DASH = 'app/api/production/dashboard/route.ts';
const PRINTJOB = 'app/api/delivery/record-print-job/route.ts';
const QUEUE_UI = 'components/production/DeliveryQueue.tsx';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6bHandoffPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6bHandoffPrisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/delivery/handoff/route');
    const res = await POST(new Request('http://localhost/api/delivery/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as any);
    return { status: res.status, body: await res.json() };
};

/** A Packed & Ready order: one Serves-5 line, one tray recipe. */
const READY = (over: any = {}) => ({
    id: 'ord-1',
    status: 'ready_to_ship',
    canceled_at: null,
    released_to_delivery_at: null,
    items: [{
        id: 'oi-1',
        bundle_id: 'b-1',
        quantity: 1,
        variant_size: 'serves_5',
        bundle: { contents: [{ quantity: 1, recipe: { container_type: 'tray' } }] },
    }],
    ...over,
});

const asAuthed = (businessId = 'biz-a') =>
    mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId } });

beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
});

// ═════════════════════════════════════════════════════════════════════════════
// HANDOFF (10)
// ═════════════════════════════════════════════════════════════════════════════
describe('HANDOFF', () => {
    it('H1. the Packed & Ready lane exposes an explicit Send to Delivery action', () => {
        const s = strip(read(QUEUE_UI));
        expect(s).toMatch(/const sendToDelivery = async/);
        expect(s).toMatch(/Send to Delivery/);
        expect(s).toMatch(/'\/api\/delivery\/handoff'/);
        // Deliberate: it asks before it acts.
        expect(s).toMatch(/if \(!confirm\(/);
    });

    it('H2. an order that is not Packed & Ready cannot be released', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY({ status: 'in_production' })],
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(400);
        expect(body.code).toBe('ORDER_NOT_PACKED');
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('H3. printing box labels or packing slips writes NOTHING, so printing cannot release', () => {
        for (const f of ['app/api/production/box-labels/route.ts', 'app/api/delivery/packing-slips/route.ts']) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\.create\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\$executeRaw|\$transaction/);
            expect(s).not.toMatch(/released_to_delivery/);
        }
    });

    it('H4. reprinting cannot release — the print-job route never touches an order', () => {
        const s = strip(read(PRINTJOB));
        expect(s).not.toMatch(/prisma\.order|released_to_delivery|\.order\./);
    });

    it('H5. a released order leaves the ACTIVE Packed & Ready lane', () => {
        const s = strip(read(DASH));
        const lane = s.slice(
            s.indexOf('const completedOrders = await prisma.order.findMany'),
            s.indexOf('// Aggregate for Prep List'),
        );
        expect(lane).toMatch(/released_to_delivery_at: null/);
    });

    it('H6. a released order becomes ACTIVE in Delivery', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        const { GET } = await import('@/app/api/delivery/queue/route');
        await GET(new Request('http://localhost/api/delivery/queue') as any);
        const where = mock.firstCall('order.findMany')?.args?.where;
        expect(where?.released_to_delivery_at).toEqual({ not: null });
        expect(where?.business_id).toBe('biz-a');
        expect(where?.canceled_at).toBeNull();
    });

    it('H7. a duplicate release is idempotent — already-released rows are a no-op, not an error', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY({ released_to_delivery_at: new Date('2026-09-01') })],
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(200);
        expect(body.released).toBe(0);
        expect(body.unchanged).toBe(1);
        // Nothing was written, and nothing was consumed.
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
        expect(mock.callsTo('packagingItem.updateMany')).toHaveLength(0);
    });

    it('H8. a concurrent release is safe — losing the compare-and-set consumes nothing', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            // Someone else flipped the row first: the guarded update matches 0.
            'order.updateMany': { count: 0 },
            'packagingItem.findFirst': { id: 'pi-1', name: 'Tape', quantity: 100 },
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(200);
        expect(body.released).toBe(0);
        expect(mock.callsTo('packagingItem.updateMany')).toHaveLength(0);
    });

    it('H9. Tenant A cannot release Tenant B\'s order', async () => {
        useMock(createPrismaMock({ results: {
            // Tenant-scoped query returns nothing for a foreign id.
            'order.findMany': (args: any) => (args?.where?.business_id === 'biz-a' ? [] : [READY()]),
        } }));
        asAuthed('biz-a');
        const { status, body } = await post({ orderIds: ['ord-of-tenant-b'] });
        expect(status).toBe(404);
        expect(body.code).toBe('ORDER_NOT_FOUND');
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('H10. a delivered order does not reappear as active Delivery', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        const { GET } = await import('@/app/api/delivery/queue/route');
        await GET(new Request('http://localhost/api/delivery/queue') as any);
        const where = mock.firstCall('order.findMany')?.args?.where;
        expect(where?.NOT?.status?.in).toEqual(expect.arrayContaining(['delivered']));
    });

    it('H12. the release is a COMPARE-AND-SET — the race guards are in the WHERE clause itself', async () => {
        // ADDED AFTER MUTATION TESTING. H7/P6 only exercised the
        // already-released path, which short-circuits before updateMany is ever
        // called — so mutants that stripped `released_to_delivery_at: null` and
        // the status pin OUT OF THE QUERY survived. Those predicates are the
        // entire concurrency story: two requests that both pass preflight are
        // separated only by the database, and only if the guard is in the SQL.
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            'packagingItem.findFirst': null,
        } }));
        await post({ orderIds: ['ord-1'] });

        const write = mock.callsTo('order.updateMany')[0];
        expect(write).toBeDefined();
        // The idempotency key: a second writer finds no NULL to claim.
        expect(write.args.where.released_to_delivery_at).toBeNull();
        // The status pin: an order that moved between preflight and write loses.
        expect(write.args.where.status).toBe('ready_to_ship');
        // Never releases a row that was canceled in the meantime.
        expect(write.args.where.canceled_at).toBeNull();
        // Tenant scope travels with the write, not just the read.
        expect(write.args.where.business_id).toBe('biz-a');
        // And it is a guarded updateMany, never a blind update-by-id.
        expect(mock.callsTo('order.update')).toHaveLength(0);
    });

    it('H11. the handoff NEVER writes a status — Send to Delivery is not Delivered', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            'packagingItem.findFirst': null,
        } }));
        await post({ orderIds: ['ord-1'] });
        for (const call of mock.callsTo('order.updateMany')) {
            expect(call.args?.data?.status).toBeUndefined();
        }
        const s = strip(read(HANDOFF));
        expect(s).not.toMatch(/data:\s*\{[^}]*status:/);
        expect(s).not.toMatch(/'delivered'/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PACKAGING INVENTORY (9)
// ═════════════════════════════════════════════════════════════════════════════
describe('PACKAGING INVENTORY', () => {
    /** Four Serves-2 on one order: canonically 2 LARGE cartons, not 4 boxes. */
    const FOUR_S2 = READY({
        items: [{
            id: 'oi-1',
            bundle_id: 'b-1',
            quantity: 4,
            variant_size: 'serves_2',
            bundle: { contents: [{ quantity: 1, recipe: { container_type: 'tray' } }] },
        }],
    });

    it('P1. packaging need uses CANONICAL boxes, not purchased bundles', () => {
        const { computePackagingNeed } = require('@/lib/deliveryPackaging');
        const need = computePackagingNeed([FOUR_S2]);
        // 4 x Serves-2 pair into 2 LARGE cartons.
        expect(need.physicalBoxCount).toBe(2);
        expect(need.largeBoxCount).toBe(2);
        expect(need.smallBoxCount).toBe(0);
        // But the MEALS still scale with bundles: 4 small trays, not 2.
        expect(need.smallTrays).toBe(4);
        expect(need.smallLids).toBe(4);
    });

    it('P2. the server computes the quantities — the request body carries only orderIds', () => {
        const s = strip(read(HANDOFF));
        expect(s).toMatch(/const \{ orderIds \} = body \?\? \{\};/);
        expect(s).toMatch(/computePackagingNeed\(won as any\)/);
        expect(s).not.toMatch(/body\.largeBoxes|body\.smallBoxes|body\.packaging|body\.businessId/);
    });

    it('P3. a client-supplied large-box count is ignored', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [FOUR_S2],
            'packagingItem.findFirst': (args: any) => ({ id: 'pi-1', name: 'Tape', quantity: 1000 }),
        } }));
        await post({ orderIds: ['ord-1'], largeBoxes: 9999, smallBoxes: 9999 });
        const decrements = mock.callsTo('packagingItem.updateMany')
            .map(c => c.args?.data?.quantity?.decrement)
            .filter((n: any) => typeof n === 'number');
        // ceil(2 boxes / 30) = 1 roll of tape. Never 9999-derived.
        expect(Math.max(...decrements)).toBeLessThanOrEqual(4);
        expect(decrements).not.toContain(9999);
    });

    it('P4. a client-supplied small-box/packaging payload is ignored', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [FOUR_S2],
            'packagingItem.findFirst': (args: any) => ({ id: 'pi-1', name: 'Small Container', quantity: 1000 }),
        } }));
        await post({ orderIds: ['ord-1'], packaging: { smallTrays: 5000, gallonBags: 5000 } });
        const decrements = mock.callsTo('packagingItem.updateMany')
            .map(c => c.args?.data?.quantity?.decrement)
            .filter((n: any) => typeof n === 'number');
        expect(decrements).not.toContain(5000);
    });

    it('P5. REPRINTING does not decrement packaging — the print route only touches sheets', () => {
        const s = strip(read(PRINTJOB));
        expect(s).toMatch(/const \{ sheetsUsed \} = await req\.json\(\);/);
        expect(s).toMatch(/deductItem\('Avery', sheets\)/);
        // Every box-derived consumable is gone from this route.
        for (const gone of ['Tape', 'Large Tray', 'Large Lid', 'Small Container', 'Small Lid', 'Gallon Ziplock', 'Quart Ziplock']) {
            expect(s).not.toContain(`deductItem('${gone}'`);
        }
    });

    it('P6. a duplicate handoff does not decrement twice', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY({ released_to_delivery_at: new Date('2026-09-01') })],
            'packagingItem.findFirst': { id: 'pi-1', name: 'Tape', quantity: 100 },
        } }));
        await post({ orderIds: ['ord-1'] });
        expect(mock.callsTo('packagingItem.updateMany')).toHaveLength(0);
    });

    it('P7. a concurrent handoff does not decrement twice', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            'order.updateMany': { count: 0 },
            'packagingItem.findFirst': { id: 'pi-1', name: 'Tape', quantity: 100 },
        } }));
        await post({ orderIds: ['ord-1'] });
        expect(mock.callsTo('packagingItem.updateMany')).toHaveLength(0);
    });

    it('P8. the decrement is scoped to the session tenant on every call', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            'packagingItem.findFirst': { id: 'pi-1', name: 'Tape', quantity: 100 },
        } }));
        asAuthed('biz-a');
        await post({ orderIds: ['ord-1'] });
        for (const c of mock.callsTo('packagingItem.findFirst')) {
            expect(c.args?.where?.business_id).toBe('biz-a');
        }
        for (const c of mock.callsTo('packagingItem.updateMany')) {
            expect(c.args?.where?.business_id).toBe('biz-a');
        }
    });

    it('P9. stock is never driven negative, and the shortage is reported rather than hidden', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY()],
            'packagingItem.findFirst': { id: 'pi-1', name: 'Tape', quantity: 0 },
            // Guarded decrement matches nothing because stock is insufficient.
            'packagingItem.updateMany': { count: 0 },
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(200);
        // The release still happened — bookkeeping never strands packed boxes.
        expect(body.released).toBe(1);
        expect(body.shortages.length).toBeGreaterThan(0);
        // And the clamp write sets zero rather than a negative number.
        const clamps = mock.callsTo('packagingItem.updateMany').filter(c => c.args?.data?.quantity === 0);
        expect(clamps.length).toBeGreaterThan(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECURITY (5)
// ═════════════════════════════════════════════════════════════════════════════
describe('SECURITY', () => {
    it('S1. an unauthenticated handoff is rejected before any DB access', async () => {
        useMock(createPrismaMock({ results: {} }));
        mockAuth.mockResolvedValue(null);
        const { status } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('S2. a client-supplied businessId is ignored — the session is the only tenant authority', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        asAuthed('biz-a');
        await post({ orderIds: ['ord-1'], businessId: 'biz-b', business_id: 'biz-b' });
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
        const s = strip(read(HANDOFF));
        expect(s).not.toMatch(/searchParams\.get\(['"]business/i);
        expect(s).toMatch(/session\?\.user\?\.businessId/);
    });

    it('S3. a cross-tenant order id is refused identically to a missing one (no existence oracle)', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        const { status, body } = await post({ orderIds: ['ord-does-not-exist'] });
        expect(status).toBe(404);
        expect(body.code).toBe('ORDER_NOT_FOUND');
        // The reason never distinguishes "another tenant's" from "no such order".
        expect(JSON.stringify(body)).not.toMatch(/tenant|business|belongs/i);
    });

    it('S4. no PII is passed in a query string — the handoff takes opaque ids in a POST body', () => {
        const s = strip(read(HANDOFF));
        expect(s).not.toMatch(/searchParams/);
        const ui = strip(read(QUEUE_UI));
        const handler = ui.slice(ui.indexOf('const sendToDelivery'), ui.indexOf('const queueBoxLabels'));
        expect(handler).toMatch(/JSON\.stringify\(\{ orderIds \}\)/);
        expect(handler).not.toMatch(/address|phone|email|customer_name/i);
    });

    it('S5. eligibility is re-checked SERVER-SIDE at mutation time, not trusted from the client', async () => {
        // A stale tab still showing a button for an order that has moved on.
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY({ status: 'delivered' })],
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(400);
        expect(body.code).toBe('ORDER_NOT_PACKED');
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('S6. a canceled order can never be sent to Delivery', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [READY({ canceled_at: new Date('2026-08-01') })],
        } }));
        const { status, body } = await post({ orderIds: ['ord-1'] });
        expect(status).toBe(400);
        expect(body.code).toBe('ORDER_CANCELED');
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('S7. the handoff route exists and is the ONLY writer of the handoff column', () => {
        expect(existsSync(join(ROOT, HANDOFF))).toBe(true);
        const writers: string[] = [];
        const walk = (dir: string) => {
            const fs = require('fs');
            const path = require('path');
            let entries: any[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (/\.(ts|tsx)$/.test(e.name)) {
                    const src = fs.readFileSync(full, 'utf8');
                    // A WRITE is `released_to_delivery_at:` inside a `data:` block.
                    if (/data:\s*\{[^}]*released_to_delivery_at/s.test(src)) writers.push(full);
                }
            }
        };
        walk(join(ROOT, 'app'));
        walk(join(ROOT, 'lib'));
        walk(join(ROOT, 'components'));
        expect(writers).toHaveLength(1);
        expect(writers[0].replace(/\\/g, '/')).toContain('app/api/delivery/handoff/route.ts');
    });
});
