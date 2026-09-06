/**
 * OPS-6B — ONE box authority across every Delivery surface.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 Rule 5 (the menu
 * owns the tier; OrderItem.variant_size is frozen thereafter) and Rule 8
 * (reuse, do not re-derive — "a second inline copy of any of these rules is a
 * defect, regardless of whether it currently agrees").
 *
 * THE DEFECT THIS PINS SHUT: the Delivery dashboard showed "49 labels needed /
 * 14 Large / 35 Small" for a week whose real answer was 2 physical cartons, and
 * the Slips badge repeated the same wrong number character-for-character while
 * the page it opened printed 2 slips. Five independent box rules existed —
 * stats, two inside print-manifest, one on the driver's phone, and print-batch
 * consuming stats — none of which read the frozen sold tier.
 *
 * Covers BOX AUTHORITY (8), DASHBOARD (6), MANIFEST (5), PRINT LABELS (3) and
 * REGRESSION (9).
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { summarizeItemPacking } from '@/lib/physicalBoxPacking';
import { computePackagingNeed } from '@/lib/deliveryPackaging';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const STATS = 'app/api/delivery/stats/route.ts';
const DELIVERY_PAGE = 'app/delivery/page.tsx';
const MANIFEST = 'app/delivery/print-manifest/page.tsx';
const RUN = 'app/delivery/run/page.tsx';
const BATCH = 'app/delivery/print-batch/page.tsx';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops6bTruthPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops6bTruthPrisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const callStats = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/stats/route');
    const res = await GET(new Request(`http://localhost/api/delivery/stats${qs}`) as any);
    return { status: res.status, body: await res.json() };
};
const callSlips = async (qs = '') => {
    const { GET } = await import('@/app/api/delivery/packing-slips/route');
    const res = await GET(new Request(`http://localhost/api/delivery/packing-slips${qs}`) as any);
    return { status: res.status, body: await res.json() };
};

/** A line sold at a given tier. `serving_tier`/`name` are deliberately hostile. */
const LINE = (over: any = {}) => ({
    id: 'oi-1',
    bundle_id: 'b-1',
    quantity: 1,
    variant_size: 'serves_2',
    item_name: 'Comfort Foods',
    bundle: {
        id: 'b-1',
        name: 'Comfort Foods',
        // The MUTABLE tier, left at the schema default that used to decide everything.
        serving_tier: 'family',
        contents: [{ quantity: 1, recipe: { name: 'Lasagna', container_type: 'tray' } }],
    },
    ...over,
});
const ORDER = (items: any[], over: any = {}) => ({
    id: 'ord-1',
    first_name: 'Wyatt',
    last_name: 'Williamson',
    customer_name: 'Wyatt Williamson',
    delivery_date: null,
    delivery_sequence: null,
    campaign: null,
    items,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: 'biz-a' } });
});

// ═════════════════════════════════════════════════════════════════════════════
// BOX AUTHORITY (8)
// ═════════════════════════════════════════════════════════════════════════════
describe('BOX AUTHORITY', () => {
    const boxesFor = async (items: any[]) => {
        useMock(createPrismaMock({ results: { 'order.findMany': [ORDER(items)] } }));
        const { body } = await callStats();
        return body;
    };

    it('B1. 1 x Serves-5 -> 1 large', async () => {
        const b = await boxesFor([LINE({ variant_size: 'serves_5' })]);
        expect(b.physicalBoxCount).toBe(1);
        expect(b.largeBoxCount).toBe(1);
        expect(b.smallBoxCount).toBe(0);
    });

    it('B2. 2 x Serves-2 on one order -> 1 large', async () => {
        const b = await boxesFor([LINE({ quantity: 2 })]);
        expect(b.physicalBoxCount).toBe(1);
        expect(b.largeBoxCount).toBe(1);
        expect(b.smallBoxCount).toBe(0);
    });

    it('B3. 3 x Serves-2 -> 1 large + 1 small', async () => {
        const b = await boxesFor([LINE({ quantity: 3 })]);
        expect(b.largeBoxCount).toBe(1);
        expect(b.smallBoxCount).toBe(1);
    });

    it('B4. 4 x Serves-2 -> 2 large (the failing-first case: was 4)', async () => {
        const b = await boxesFor([LINE({ quantity: 4 })]);
        expect(b.physicalBoxCount).toBe(2);
        expect(b.largeBoxCount).toBe(2);
        expect(b.smallBoxCount).toBe(0);
    });

    it('B5. 1 x Serves-5 + 2 x Serves-2 -> 2 large', async () => {
        const b = await boxesFor([
            LINE({ id: 'oi-1', variant_size: 'serves_5' }),
            LINE({ id: 'oi-2', quantity: 2 }),
        ]);
        expect(b.physicalBoxCount).toBe(2);
        expect(b.largeBoxCount).toBe(2);
    });

    it('B6. separate orders never pair — 1 x S2 each stays 2 boxes', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [
            ORDER([LINE({ id: 'oi-1' })], { id: 'ord-1' }),
            ORDER([LINE({ id: 'oi-2' })], { id: 'ord-2' }),
        ] } }));
        const { body } = await callStats();
        expect(body.physicalBoxCount).toBe(2);
        expect(body.smallBoxCount).toBe(2);
    });

    it('B7. mutating Bundle.serving_tier cannot change the sold box truth', async () => {
        const sold = [LINE({ quantity: 2, variant_size: 'serves_2' })];
        const asFamily = await boxesFor(JSON.parse(JSON.stringify(sold)));

        const retiered = JSON.parse(JSON.stringify(sold));
        retiered[0].bundle.serving_tier = 'serves_2';
        const asSmall = await boxesFor(retiered);

        // Same sale, opposite mutable tier, IDENTICAL answer.
        expect(asFamily.largeBoxCount).toBe(asSmall.largeBoxCount);
        expect(asFamily.smallBoxCount).toBe(asSmall.smallBoxCount);
        expect(asFamily.physicalBoxCount).toBe(1);
    });

    it('B8. a bundle-name substring cannot change the sold box truth', async () => {
        const plain = await boxesFor([LINE({ quantity: 2 })]);
        const named = await boxesFor([LINE({
            quantity: 2,
            item_name: 'Fall Family Favorites (Serves 2)',
            bundle: { id: 'b-1', name: 'Fall Family Favorites (Serves 2)', serving_tier: 'serves_2', contents: [] },
        })]);
        expect(named.largeBoxCount).toBe(plain.largeBoxCount);
        expect(named.smallBoxCount).toBe(plain.smallBoxCount);
    });

    it('B9. NO delivery file — page, route OR shared lib — classifies by tier or name', () => {
        const offenders: string[] = [];
        const check = (full: string) => {
            const src = strip(readFileSync(full, 'utf8'));
            // A doc comment may NAME the retired heuristic while explaining it;
            // strip() has already removed comments, so any hit here is live code.
            if (/serving_tier/.test(src)) offenders.push(`${full} (serving_tier)`);
            if (/includes\(['"]family['"]\)/.test(src)) offenders.push(`${full} (name heuristic)`);
            if (/includes\(['"]serves 2['"]\)/i.test(src)) offenders.push(`${full} (name heuristic)`);
        };
        const walk = (dir: string) => {
            let entries: any[];
            try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const full = join(dir, e.name);
                if (e.isDirectory()) { walk(full); continue; }
                if (/\.(ts|tsx)$/.test(e.name)) check(full);
            }
        };
        walk(join(ROOT, 'app/delivery'));
        walk(join(ROOT, 'app/api/delivery'));
        // ADDED AFTER MUTATION TESTING: the sweep originally covered only the
        // app/ trees, so a mutant that put `bundle.serving_tier` or a
        // bundle-name substring back into the SHARED lib survived it. The
        // packaging authority is exactly where such a rule would do the most
        // damage, because both the "need" display and the real inventory
        // decrement read it.
        check(join(ROOT, 'lib/deliveryPackaging.ts'));
        expect(offenders).toEqual([]);
    });

    it('B10. CONTAINER sizing is immune to bundle name and mutable tier, not just box sizing', () => {
        // ADDED AFTER MUTATION TESTING. B7/B8 proved the CARTON counts are
        // immune, but a mutant that re-keyed only the tray/lid/bag walk off the
        // bundle name survived: box counts stayed right while every container
        // silently changed size. Trays are what the kitchen actually runs out of.
        const line = (bundleName: string, servingTier: string) => ([{
            id: 'o', items: [{
                id: 'i', bundle_id: 'b', quantity: 2, variant_size: 'serves_2',
                bundle: { name: bundleName, serving_tier: servingTier, contents: [{ quantity: 1, recipe: { container_type: 'tray' } }] },
            }],
        }]);

        const honest = computePackagingNeed(line('Comfort Foods', 'serves_2') as any);
        const namedFamily = computePackagingNeed(line('Fall Family Favorites (Serves 2)', 'serves_2') as any);
        const tieredFamily = computePackagingNeed(line('Comfort Foods', 'family') as any);

        // A Serves-2 sale takes SMALL containers, whatever the bundle is called
        // today and whatever its mutable tier column says.
        for (const need of [honest, namedFamily, tieredFamily]) {
            expect(need.smallTrays).toBe(2);
            expect(need.smallLids).toBe(2);
            expect(need.largeTrays).toBe(0);
            expect(need.largeLids).toBe(0);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// DASHBOARD (6)
// ═════════════════════════════════════════════════════════════════════════════
describe('DASHBOARD', () => {
    it('D1. the Print Queue count is the canonical physical box count', () => {
        const s = read(DELIVERY_PAGE);
        expect(s).toMatch(/\{stats\?\.physicalBoxCount \?\? 0\}/);
        expect(s).not.toMatch(/largeBoxesNeeded \|\| 0\) \+ \(stats\?\.smallBoxesNeeded/);
    });

    it('D2. the Large count is canonical', () => {
        expect(read(DELIVERY_PAGE)).toMatch(/\{stats\?\.largeBoxCount \?\? 0\}/);
    });

    it('D3. the Small count is canonical', () => {
        expect(read(DELIVERY_PAGE)).toMatch(/\{stats\?\.smallBoxCount \?\? 0\}/);
    });

    it('D4. the Slips badge comes from the packing-slip route itself, not a parallel rule', () => {
        const s = read(DELIVERY_PAGE);
        expect(s).toMatch(/api\/delivery\/packing-slips/);
        expect(s).toMatch(/\{slipCount \?\? stats\?\.physicalBoxCount \?\? 0\}/);
    });

    it('D5. dashboard and Packing Slip page agree on the SAME fixture (the 49-vs-2 killer)', async () => {
        const fixture = [ORDER([LINE({ quantity: 4 })])];

        useMock(createPrismaMock({ results: { 'order.findMany': fixture } }));
        const stats = (await callStats()).body;

        useMock(createPrismaMock({ results: { 'order.findMany': fixture } }));
        const slips = (await callSlips()).body;

        // One physical box = one packing slip. Both sides, same number.
        expect(stats.largeBoxCount + stats.smallBoxCount).toBe(slips.boxes.length);
        expect(stats.physicalBoxCount).toBe(slips.physicalBoxCount);
        expect(stats.physicalBoxCount).toBe(2);
    });

    it('D6. the BoxCounter "needed" props are canonical, so the stockout warning is truthful', () => {
        const s = read(DELIVERY_PAGE);
        expect(s).toMatch(/needed=\{stats\?\.largeBoxCount \?\? 0\}/);
        expect(s).toMatch(/needed=\{stats\?\.smallBoxCount \?\? 0\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// MANIFEST (5)
// ═════════════════════════════════════════════════════════════════════════════
describe('MANIFEST', () => {
    it('M1. the manifest consumes canonical PhysicalBox[], not its own heuristic', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/from '@\/lib\/physicalBoxPacking'/);
        expect(s).toMatch(/api\/delivery\/packing-slips/);
    });

    it('M2. BOTH former heuristics are gone', () => {
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/const isLargeBox/);
        expect(s).not.toMatch(/serving_tier/);
        expect(s).not.toMatch(/includes\('family'\)/);
        expect(s).not.toMatch(/includes\('serves 2'\)/);
    });

    it('M3. the totals row is the sum of the printed rows — no second population', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/const totalLarge = stops\.reduce/);
        expect(s).toMatch(/const totalSmall = stops\.reduce/);
        expect(s).not.toMatch(/stats\?\.largeBoxesNeeded \?\?/);
    });

    it('M4. route order is preserved — the page never re-sorts the boxes', () => {
        const s = strip(read(MANIFEST));
        // Grouping preserves first-appearance order; nothing sorts.
        expect(s).toMatch(/preserving the order|stops\.push\(stop\)/);
        expect(s).not.toMatch(/\.sort\(/);
    });

    it('M5. an order the authority could not prove is NAMED, not silently dropped', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/blocked/);
        expect(s).toMatch(/not on this manifest/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRINT LABELS (3)
// ═════════════════════════════════════════════════════════════════════════════
describe('PRINT LABELS', () => {
    it('L1. the Delivery label sheet is laid out from canonical box counts', () => {
        const s = strip(read(BATCH));
        expect(s).toMatch(/s\.largeBoxCount/);
        expect(s).toMatch(/s\.smallBoxCount/);
        expect(s).not.toMatch(/largeBoxesNeeded|smallBoxesNeeded/);
    });

    it('L2. it can no longer drive inventory from its own box math', () => {
        const s = strip(read(BATCH));
        expect(s).not.toMatch(/largeBoxes:|smallBoxes:|packaging: pack/);
        expect(s).toMatch(/sheetsUsed: pages,/);
    });

    it('L3. it does not import the OL600 sticker geometry — that stays the Production label system', () => {
        const s = strip(read(BATCH));
        expect(s).not.toMatch(/labelSheetLayout|OL600_SHEET|labelTypography/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// REGRESSION (9)
// ═════════════════════════════════════════════════════════════════════════════
describe('REGRESSION', () => {
    it('R1. the stats population is BYTE-IDENTICAL to the packing-slip population', async () => {
        // STRENGTHENED BY OPS-6B.1. This originally asserted the two where
        // clauses were structurally SIMILAR — same canceled_at, same number of
        // OR branches, both escape hatches bounded. That similarity was not
        // enough: neither route filtered on the handoff, so both described a
        // population the stop list did not share, and in Production a supporter
        // who had never been sent to Delivery printed a packing slip.
        //
        // Both now build their WHERE from one authority, so the correct
        // assertion is equality, not resemblance.
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callStats('?delivery_week_start=2026-09-07');
        const statsWhere = mock.firstCall('order.findMany')?.args?.where;

        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callSlips('?delivery_week_start=2026-09-07');
        const slipsWhere = mock.firstCall('order.findMany')?.args?.where;

        expect(statsWhere).toEqual(slipsWhere);
        expect(statsWhere.canceled_at).toBeNull();
        // And both now honour the handoff boundary, which is the whole point.
        expect(statsWhere.released_to_delivery_at).toEqual({ not: null });
    });

    it('R2. stats rejects an unparseable week rather than silently dropping the filter', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callStats('?delivery_week_start=not-a-date');
        expect(mock.firstCall('order.findMany')?.args?.where?.OR).toBeUndefined();
    });

    it('R3. stats is READ-ONLY — it reports need and never decrements', () => {
        const s = strip(read(STATS));
        expect(s).not.toMatch(/\.update\(|\.updateMany\(|\.create\(|\$transaction|decrement/);
    });

    it('R4. the driver run page uses the canonical authority and the released queue', () => {
        const s = strip(read(RUN));
        expect(s).toMatch(/summarizeItemPacking/);
        expect(s).toMatch(/api\/delivery\/queue/);
        expect(s).not.toMatch(/serving_tier|includes\('family'\)/);
    });

    it('R5. lib/physicalBoxPacking.ts and lib/supporterBoxManifest.ts are UNCHANGED by this phase', () => {
        // Behavioural re-proof of the packing rules this phase depends on but
        // must never edit.
        const four = summarizeItemPacking([{ id: 'o', items: [
            { id: 'i', bundle_id: 'b', quantity: 4, variant_size: 'serves_2' },
        ] }] as any);
        expect(four.physicalBoxCount).toBe(2);
        expect(four.largeBoxCount).toBe(2);

        const three = summarizeItemPacking([{ id: 'o', items: [
            { id: 'i', bundle_id: 'b', quantity: 3, variant_size: 'serves_2' },
        ] }] as any);
        expect(three.largeBoxCount).toBe(1);
        expect(three.smallBoxCount).toBe(1);

        // And neither authority knows anything about packaging or delivery.
        for (const f of ['lib/physicalBoxPacking.ts', 'lib/supporterBoxManifest.ts']) {
            expect(strip(read(f))).not.toMatch(/packagingItem|released_to_delivery|deliveryPackaging/);
        }
    });

    it('R6. containers scale with MEALS while boxes scale with CARTONS — they are not the same rule', () => {
        const need = computePackagingNeed([{ id: 'o', items: [{
            id: 'i', bundle_id: 'b', quantity: 4, variant_size: 'serves_2',
            bundle: { contents: [{ quantity: 1, recipe: { container_type: 'tray' } }] },
        }] }] as any);
        // 4 bundles pair into 2 cartons, but still hold 4 trays.
        expect(need.physicalBoxCount).toBe(2);
        expect(need.smallTrays).toBe(4);
        expect(need.smallLids).toBe(4);
    });

    it('R7. an unprovable sold tier consumes nothing and is reported, never guessed', () => {
        const need = computePackagingNeed([{ id: 'o', items: [{
            id: 'i', bundle_id: 'b', quantity: 2, variant_size: 'family',
            bundle: { contents: [{ quantity: 1, recipe: { container_type: 'tray' } }] },
        }] }] as any);
        expect(need.largeTrays).toBe(0);
        expect(need.smallTrays).toBe(0);
        expect(need.unpackable).toBe(2);
    });

    it('R8. no Delivered and no Archive behaviour was added anywhere in this phase', () => {
        for (const f of [STATS, 'app/api/delivery/handoff/route.ts', 'app/api/delivery/queue/route.ts', 'lib/deliveryPackaging.ts']) {
            const s = strip(read(f));
            expect(s).not.toMatch(/archive/i);
            expect(s).not.toMatch(/status:\s*'delivered'/);
        }
    });

    it('R9. invoice, payment and storefront behaviour is untouched by this phase', () => {
        for (const f of [
            STATS, 'app/api/delivery/handoff/route.ts', 'app/api/delivery/queue/route.ts',
            'lib/deliveryPackaging.ts', 'app/api/delivery/record-print-job/route.ts',
        ]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/invoice|stripe|square|payment/i);
        }
    });
});
