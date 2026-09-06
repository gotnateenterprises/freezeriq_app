/**
 * OPS-6B.1 — ONE active Delivery population across every Delivery surface.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §8, §11 Rule 8.
 *
 * WHAT THIS PINS SHUT: a live Production acceptance failure. One order was sent
 * to Delivery and became the only active stop, yet the Print Queue, the
 * Large/Small cards, the Slips badge and the packing-slip page all still
 * described a different set — a second supporter who had never been handed over
 * printed a slip anyway, and the badge read the same number before and after the
 * handoff. Separately the week selector read "Aug 23-29" while the slips it
 * printed were dated 9/22, because every route filtered on Order.delivery_date
 * while every slip PRINTS Campaign.delivery_date.
 *
 * Supersedes tests/ops6b1FailingFirstProbe.test.ts, which proved both halves
 * against HEAD 13d83d8 before the fix.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import {
    activeDeliveryOrderWhere,
    activeDeliveryBaseWhere,
    parseDeliveryWeek,
    effectiveDeliveryDateInWeek,
} from '@/lib/delivery/activeDeliveryPopulation';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const AUTHORITY = 'lib/delivery/activeDeliveryPopulation.ts';
const QUEUE = 'app/api/delivery/queue/route.ts';
const STATS = 'app/api/delivery/stats/route.ts';
const SLIPS = 'app/api/delivery/packing-slips/route.ts';
const HANDOFF = 'app/api/delivery/handoff/route.ts';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6b1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6b1Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ── Fixture population ──────────────────────────────────────────────────────
const order = (over: any = {}) => ({
    id: 'ord-x', first_name: 'A', last_name: 'B', customer_name: 'A B',
    status: 'ready_to_ship', canceled_at: null, released_to_delivery_at: new Date('2026-09-05'),
    delivery_date: null, delivery_sequence: 1, external_id: 'E', delivery_address: null,
    campaign: { delivery_date: new Date('2026-08-25') }, customer: null,
    items: [{ id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5',
        item_name: 'Comfort Foods', bundle: { id: 'b-1', name: 'Comfort Foods', contents: [] } }],
    ...over,
});

const RELEASED = order({ id: 'ord-released', first_name: 'Laurie', last_name: 'Hacker', customer_name: 'Laurie Hacker' });
const UNRELEASED = order({ id: 'ord-unreleased', first_name: 'Kelsi', last_name: 'H', customer_name: 'Kelsi H', released_to_delivery_at: null });

/**
 * A mock that actually EVALUATES the predicates under test, so a route that
 * omits one gets more rows — exactly as Postgres behaved in Production.
 */
const POPULATION = [RELEASED, UNRELEASED];
const evaluatingMock = (rows = POPULATION) => createPrismaMock({ results: {
    'order.findMany': (args: any) => {
        const w = args?.where ?? {};
        return rows.filter((r: any) => {
            if (w.released_to_delivery_at !== undefined) {
                const wantsNotNull = w.released_to_delivery_at?.not === null;
                if (wantsNotNull && r.released_to_delivery_at === null) return false;
            }
            if (w.canceled_at === null && r.canceled_at !== null) return false;
            if (w.NOT?.status?.in && w.NOT.status.in.includes(r.status)) return false;
            return true;
        });
    },
    'order.count': 0,
} });

const callQueue = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/queue/route');
    return (await (await import('@/app/api/delivery/queue/route')).GET(
        new Request(`http://localhost/api/delivery/queue${qs}`) as any)).json();
};
const callStats = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/stats/route');
    return (await GET(new Request(`http://localhost/api/delivery/stats${qs}`) as any)).json();
};
const callSlips = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/packing-slips/route');
    return (await GET(new Request(`http://localhost/api/delivery/packing-slips${qs}`) as any)).json();
};

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: 'biz-a' } });
});

// ═════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY (1-5)
// ═════════════════════════════════════════════════════════════════════════════
describe('ELIGIBILITY', () => {
    it('E1. an unreleased ready_to_ship order is excluded from active Delivery', () => {
        const w = activeDeliveryBaseWhere('biz-a');
        expect(w.released_to_delivery_at).toEqual({ not: null });
    });

    it('E2. a released order is included', async () => {
        useMock(evaluatingMock());
        const q = await callQueue();
        expect(q.map((o: any) => o.id)).toEqual(['ord-released']);
    });

    it('E3. a delivered order is excluded even though it is released', () => {
        const w = activeDeliveryBaseWhere('biz-a');
        expect(w.NOT.status.in).toEqual(expect.arrayContaining(['delivered']));
    });

    it('E4. a canceled order is excluded even though it is released', () => {
        expect(activeDeliveryBaseWhere('biz-a').canceled_at).toBeNull();
    });

    it('E5. tenant scope is in the WHERE, from the session only', async () => {
        useMock(evaluatingMock());
        mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: 'biz-a' } });
        await callQueue();
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
        for (const f of [QUEUE, STATS, SLIPS]) {
            expect(strip(read(f))).not.toMatch(/searchParams\.get\(['"]business/i);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SHARED POPULATION (6-8) + KEYSTONE
// ═════════════════════════════════════════════════════════════════════════════
describe('SHARED POPULATION', () => {
    it('P1. all three routes build their WHERE from the ONE authority', () => {
        for (const f of [QUEUE, STATS, SLIPS]) {
            const s = strip(read(f));
            expect(s).toMatch(/activeDeliveryOrderWhere\(/);
            expect(s).toMatch(/parseDeliveryWeek\(/);
            // And none of them restates membership locally any more.
            expect(s).not.toMatch(/released_to_delivery_at:\s*\{\s*not:\s*null\s*\}/);
            expect(s).not.toMatch(/created_at:\s*\{\s*gte:\s*(thirtyDaysAgo|hatchFloor)/);
        }
    });

    it('P2. KEYSTONE — queue, stats and slips return the SAME order ids for one fixture', async () => {
        useMock(evaluatingMock());
        const q = await callQueue();
        const queueWhere = mock.firstCall('order.findMany')?.args?.where;

        useMock(evaluatingMock());
        const stats = await callStats();
        const statsWhere = mock.firstCall('order.findMany')?.args?.where;

        useMock(evaluatingMock());
        const slips = await callSlips();
        const slipsWhere = mock.firstCall('order.findMany')?.args?.where;

        // Identical membership predicates, not merely similar ones.
        expect(statsWhere).toEqual(queueWhere);
        expect(slipsWhere).toEqual(queueWhere);

        // And identical resulting populations.
        const queueIds = q.map((o: any) => o.id).sort();
        const slipIds = [...new Set(slips.boxes.map((b: any) => b.orderId))].sort();
        expect(slipIds).toEqual(queueIds);
        expect(stats.physicalBoxCount).toBe(slips.boxes.length);
        expect(stats.physicalBoxCount).toBe(1);
    });

    it('P3. THE OWNER REGRESSION — the unreleased supporter no longer prints a slip', async () => {
        useMock(evaluatingMock());
        const slips = await callSlips();
        const names = slips.boxes.map((b: any) => b.supporterName);
        expect(names).toEqual(['Laurie Hacker']);
        expect(names).not.toContain('Kelsi H');
    });

    it('P4. the Slips count CHANGES with the handoff (it used to read the same before and after)', async () => {
        // Nothing released.
        useMock(evaluatingMock([{ ...RELEASED, released_to_delivery_at: null }, UNRELEASED]));
        const before = (await callSlips()).boxes.length;

        // One released.
        useMock(evaluatingMock());
        const after = (await callSlips()).boxes.length;

        expect(before).toBe(0);
        expect(after).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SELECTED WEEK (9-11)
// ═════════════════════════════════════════════════════════════════════════════
describe('SELECTED WEEK', () => {
    it('W1. every route applies the identical week window', async () => {
        const qs = '?delivery_week_start=2026-08-23';
        useMock(evaluatingMock()); await callQueue(qs);
        const a = mock.firstCall('order.findMany')?.args?.where?.OR;
        useMock(evaluatingMock()); await callStats(qs);
        const b = mock.firstCall('order.findMany')?.args?.where?.OR;
        useMock(evaluatingMock()); await callSlips(qs);
        const c = mock.firstCall('order.findMany')?.args?.where?.OR;

        expect(b).toEqual(a);
        expect(c).toEqual(a);
        expect(a).toEqual(effectiveDeliveryDateInWeek(parseDeliveryWeek('2026-08-23')!));
    });

    it('W2. the week filters on the SAME date a packing slip prints (campaign first)', () => {
        const branches = effectiveDeliveryDateInWeek(parseDeliveryWeek('2026-08-23')!);
        // Campaign date wins, exactly as resolveSlipDeliveryDate does.
        expect(branches[0]).toHaveProperty('campaign.delivery_date');
        expect(branches[1]).toHaveProperty('campaign.delivery_date', null);
        expect(branches[2]).toHaveProperty('campaign_id', null);

        const contents = strip(read('lib/packingSlipContents.ts'));
        expect(contents).toMatch(/if \(order\.campaign\?\.delivery_date\) return order\.campaign\.delivery_date;/);
    });

    it('W3. an order whose CAMPAIGN date is outside the selected week is excluded', () => {
        const week = parseDeliveryWeek('2026-08-23')!;
        const branches = effectiveDeliveryDateInWeek(week);
        // Sep 22 is outside Aug 23 - Aug 30.
        const sep22 = new Date('2026-09-22');
        expect(sep22 >= week.start && sep22 < week.end).toBe(false);
        expect(branches[0].campaign.delivery_date.gte).toEqual(week.start);
        expect(branches[0].campaign.delivery_date.lt).toEqual(week.end);
    });

    it('W4. an order whose campaign date is INSIDE the week is included', () => {
        const week = parseDeliveryWeek('2026-08-23')!;
        const aug25 = new Date('2026-08-25');
        expect(aug25 >= week.start && aug25 < week.end).toBe(true);
    });

    it('W5. the dateless-into-every-week escape hatch is gone from all three routes', () => {
        for (const f of [QUEUE, STATS, SLIPS]) {
            expect(strip(read(f))).not.toMatch(/delivery_date:\s*null,\s*created_at/);
        }
        expect(strip(read(AUTHORITY))).not.toMatch(/delivery_date:\s*null,\s*created_at/);
    });

    it('W6. an unparseable week means NO filter, never a window around the epoch', () => {
        expect(parseDeliveryWeek('not-a-date')).toBeNull();
        expect(parseDeliveryWeek('')).toBeNull();
        expect(parseDeliveryWeek(null)).toBeNull();
        expect(activeDeliveryOrderWhere('biz-a', null).OR).toBeUndefined();
    });

    it('W7. released work with no effective date is REPORTED, not silently hidden', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [], 'order.count': 3 } }));
        const stats = await callStats('?delivery_week_start=2026-08-23');
        expect(stats.undatedActiveCount).toBe(3);
        expect(read('app/delivery/page.tsx')).toMatch(/undatedActiveCount/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PACKING TRUTH (12-14)
// ═════════════════════════════════════════════════════════════════════════════
describe('PACKING TRUTH', () => {
    const withItems = (items: any[]) => order({ id: 'ord-released', items });

    it('K1. one released Serves-5 order -> one stop, one large box, one slip', async () => {
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5', item_name: 'A',
              bundle: { id: 'b-1', name: 'A', contents: [] } },
        ])]));
        const stats = await callStats();
        useMock(evaluatingMock([withItems([
            { id: 'oi-1', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_5', item_name: 'A',
              bundle: { id: 'b-1', name: 'A', contents: [] } },
        ])]));
        const slips = await callSlips();
        expect(stats.physicalBoxCount).toBe(1);
        expect(stats.largeBoxCount).toBe(1);
        expect(slips.boxes).toHaveLength(1);
    });

    it('K2. same-order 2 x Serves-2 -> ONE large box and ONE slip', async () => {
        const items = [{ id: 'oi-1', bundle_id: 'b-1', quantity: 2, variant_size: 'serves_2', item_name: 'A',
            bundle: { id: 'b-1', name: 'A', contents: [] } }];
        useMock(evaluatingMock([withItems(items)]));
        const stats = await callStats();
        useMock(evaluatingMock([withItems(items)]));
        const slips = await callSlips();
        expect(stats.physicalBoxCount).toBe(1);
        expect(stats.largeBoxCount).toBe(1);
        expect(slips.boxes).toHaveLength(1);
    });

    it('K3. separate released orders never pair', async () => {
        const mk = (id: string) => order({ id, released_to_delivery_at: new Date('2026-09-05'),
            items: [{ id: `oi-${id}`, bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2', item_name: 'A',
                bundle: { id: 'b-1', name: 'A', contents: [] } }] });
        useMock(evaluatingMock([mk('ord-1'), mk('ord-2')]));
        const stats = await callStats();
        expect(stats.physicalBoxCount).toBe(2);
        expect(stats.smallBoxCount).toBe(2);
    });

    it('K4. canonical packing was NOT altered by this phase', () => {
        for (const f of ['lib/physicalBoxPacking.ts', 'lib/supporterBoxManifest.ts']) {
            const s = strip(read(f));
            expect(s).not.toMatch(/released_to_delivery|activeDeliveryPopulation/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRESERVED BEHAVIOUR (16-20)
// ═════════════════════════════════════════════════════════════════════════════
describe('PRESERVED BEHAVIOUR', () => {
    it('R1. Send to Delivery still works and is still the only writer', () => {
        const s = strip(read(HANDOFF));
        expect(s).toMatch(/released_to_delivery_at: releasedAt/);
        expect(s).toMatch(/released_to_delivery_at: null/); // the compare-and-set guard
    });

    it('R2. printing still does not release', () => {
        for (const f of ['app/api/production/box-labels/route.ts', SLIPS]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\.create\(|\.update\(|\.updateMany\(|\.upsert\(|\$transaction/);
        }
    });

    it('R3. no Delivered or Archive behaviour was added', () => {
        for (const f of [AUTHORITY, QUEUE, STATS, SLIPS]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/archive/i);
            expect(s).not.toMatch(/status:\s*'delivered'/);
        }
    });

    it('R4. the orderClassification contract is preserved — grouping is unchanged and its tripwire stays armed', () => {
        // This phase changes WHICH orders are active, never how they are grouped
        // into stops: one order is still one stop, so ordinary customer delivery
        // keeps its own per-order stop at its own address and no campaign is
        // collapsed. The discriminator therefore stays unimported, and the
        // zero-importer tripwire in tests/fulfillmentContinuity1Classification.ts
        // stays armed for the grouping phase it was built for.
        const hits: string[] = [];
        let scanned = 0;
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next') continue;
                    walk(full);
                } else if (/\.(ts|tsx)$/.test(e.name)) {
                    scanned++;
                    if (readFileSync(full, 'utf8').includes('delivery/orderClassification')) hits.push(full);
                }
            }
        };
        for (const root of ['app', 'components', 'lib']) walk(join(ROOT, root));
        expect(scanned).toBeGreaterThan(100);
        expect(hits).toEqual([]);
        // And no grouping/aggregation was introduced into the population authority.
        expect(strip(read(AUTHORITY))).not.toMatch(/groupBy|campaignId|groupOrdersForDelivery/);
    });

    it('R6. the stop and its packing slip resolve identity by the SAME frozen authority', async () => {
        // Part J. The board displayed Order.customer_name directly — frozen
        // order-time truth, NOT the mutable Customer relation, so nothing was
        // leaking. But the slip prefers the distinct first/last pair, so the two
        // surfaces could name the same order differently. They now agree.
        const split = order({
            id: 'ord-released',
            first_name: 'Laurie', last_name: 'Hacker',
            customer_name: 'Vesper Test',
        });

        useMock(evaluatingMock([split]));
        const q = await callQueue();
        useMock(evaluatingMock([split]));
        const slips = await callSlips();

        expect(q[0].supporterName).toBe('Laurie Hacker');
        expect(slips.boxes[0].supporterName).toBe('Laurie Hacker');
        expect(q[0].supporterName).toBe(slips.boxes[0].supporterName);

        // The page renders the server-resolved name, not its own chain.
        expect(read('app/delivery/page.tsx')).toMatch(/customerName: o\.supporterName \|\|/);
    });

    it('R7. an unnameable stop still appears — identity never removes a delivery', async () => {
        // resolveSupporterName returns null for placeholders; a box that cannot
        // be named still has to be delivered, so the stop survives.
        const nameless = order({ id: 'ord-released', first_name: null, last_name: null, customer_name: 'Guest' });
        useMock(evaluatingMock([nameless]));
        const q = await callQueue();
        expect(q).toHaveLength(1);
        expect(q[0].supporterName).toBe('Guest');
    });

    it('R5. no schema change was needed for this phase', () => {
        const schema = read('prisma/schema.prisma');
        // The OPS-6B columns are the only handoff schema, unchanged.
        expect((schema.match(/released_to_delivery_at/g) || []).length).toBe(1);
        expect((schema.match(/released_to_delivery_by/g) || []).length).toBe(1);
    });
});
