/**
 * OPS-6A — TENANT-BRANDED PHYSICAL BOX PACKING + SERVES-2 PAIRING.
 *
 * Covers the required 62-item matrix (Part T). Behavioural wherever the
 * behaviour is expressible: the packing authority is a pure function, so every
 * packing, pairing, counting and numbering rule is proven by CALLING it. The
 * route's tenant scope is proven against a recording Prisma double that
 * captures the real WHERE clause. Only print CSS and the rendered label DOM
 * are asserted on source text, because Jest here is node-only (no jsdom) and
 * cannot count browser-generated sheets — the sheet count is owner visual
 * acceptance, and what IS provable is the exact CSS mechanism behind it.
 *
 * FAILING-FIRST: a temporary probe ran against HEAD 84d9fc6 (OPS-6) before any
 * implementation and failed 11/11 — Fixture A produced 2 labels where the
 * owner requires 1; 4 x Serves-2 produced 4 boxes where the rule requires 2;
 * same-bundle qty-2 produced 2 where the rule requires 1; Fixture B produced 4
 * where the rule requires 3; no boxType existed; no physical manifest existed;
 * 'Guest' was accepted; no branding appeared on the label. Those probes are
 * folded into section 0 below and the probe file was deleted.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    buildPurchasedInstances,
    resolveSupporterName,
    resolveBundleName,
    resolveSoldTier,
    countPurchasedInstances,
    type BoxManifestOrder,
} from '@/lib/supporterBoxManifest';
import {
    packOrder,
    packInstancesIntoBoxes,
    buildPhysicalBoxManifest,
    boxContentLines,
    formatBoxContentLine,
    summarizeItemPacking,
    PACKING_CAPACITY,
    SERVES_2_PER_LARGE_BOX,
} from '@/lib/physicalBoxPacking';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** Strip comments so a doc comment can never satisfy (or fail) an assertion. */
const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PACKING = 'lib/physicalBoxPacking.ts';
const MANIFEST = 'lib/supporterBoxManifest.ts';
const ROUTE = 'app/api/production/box-labels/route.ts';
const PAGE = 'app/production/box-labels/page.tsx';
const QUEUE = 'components/production/DeliveryQueue.tsx';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const ITEM = (over: any = {}) => ({
    id: 'oi-x',
    bundle_id: 'b-1',
    quantity: 1,
    variant_size: 'serves_2',
    item_name: 'Bundle One',
    bundle: { id: 'b-1', name: 'Bundle One' },
    ...over,
});

const ORDER = (items: any[], over: Partial<BoxManifestOrder> = {}): BoxManifestOrder => ({
    id: 'ord-1',
    first_name: 'Jane',
    last_name: 'Smith',
    customer_name: 'Jane Smith',
    items,
    ...over,
} as BoxManifestOrder);

const S5 = (id: string, name: string, quantity = 1) =>
    ITEM({ id, bundle_id: `b-${name}-5`, item_name: name, variant_size: 'serves_5', quantity, bundle: { id: `b-${name}-5`, name } });
const S2 = (id: string, name: string, quantity = 1) =>
    ITEM({ id, bundle_id: `b-${name}-2`, item_name: name, variant_size: 'serves_2', quantity, bundle: { id: `b-${name}-2`, name } });

/** Part U Fixture A — two different Serves-2 bundles. */
const FIXTURE_A = () => ORDER([S2('oi-1', 'Comfort Foods'), S2('oi-2', 'Fall Keto')]);

/** Part U Fixture B — one Serves-5 and three Serves-2 bundles. */
const FIXTURE_B = () => ORDER([
    S5('oi-1', 'Comfort Foods'),
    S2('oi-2', 'Fall Keto'),
    S2('oi-3', 'Gluten-Free'),
    S2('oi-4', 'Clean Eating'),
]);

const packed = (order: BoxManifestOrder) => {
    const r = packOrder(order);
    if (!r.ok) throw new Error(`expected packing, got block: ${r.reason}`);
    return r.result;
};

/** Compact shape of a box for assertion: type + number/total + content lines. */
const shape = (b: any) => ({
    type: b.boxType,
    box: `Box ${b.boxNumber} of ${b.boxTotal}`,
    contents: boxContentLines(b).map(formatBoxContentLine),
});

// ═════════════════════════════════════════════════════════════════════════════
// 0. FAILING-FIRST — the OPS-6 assumption this phase supersedes.
// ═════════════════════════════════════════════════════════════════════════════
describe('0. failing-first: OPS-6 packed one box per purchased bundle', () => {
    it('0a. FIXTURE A: 2 purchased Serves-2 bundles now make ONE large box, not two', () => {
        const r = packed(FIXTURE_A());
        expect(r.purchasedBundleCount).toBe(2);
        expect(r.physicalBoxCount).toBe(1);
        expect(r.boxes[0].boxType).toBe('large');
    });

    it('0b. FIXTURE A: the one label lists BOTH purchased bundles', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        expect(boxContentLines(box).map(formatBoxContentLine)).toEqual([
            'Comfort Foods — Serves 2',
            'Fall Keto — Serves 2',
        ]);
        expect(box.boxNumber).toBe(1);
        expect(box.boxTotal).toBe(1);
    });

    it('0c. FIXTURE B: 4 purchased bundles now make THREE physical boxes, not four', () => {
        const r = packed(FIXTURE_B());
        expect(r.purchasedBundleCount).toBe(4);
        expect(r.physicalBoxCount).toBe(3);
        expect(r.boxes.map(shape)).toEqual([
            { type: 'large', box: 'Box 1 of 3', contents: ['Comfort Foods — Serves 5'] },
            { type: 'large', box: 'Box 2 of 3', contents: ['Fall Keto — Serves 2', 'Gluten-Free — Serves 2'] },
            { type: 'small', box: 'Box 3 of 3', contents: ['Clean Eating — Serves 2'] },
        ]);
    });

    it('0d. the physical box layer is a separate authority from the purchase layer', () => {
        // Part A: a future reader must not be able to confuse them.
        const purchaseLayer = strip(read(MANIFEST));
        expect(purchaseLayer).not.toMatch(/boxType|boxNumber|boxTotal|physicalBoxCount/);
        expect(purchaseLayer).toMatch(/PurchasedBundleInstance/);
        const packingLayer = strip(read(PACKING));
        expect(packingLayer).toMatch(/PhysicalBox/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-10. PACKING.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-10. packing', () => {
    it('1. S5 qty1 -> 1 large', () => {
        const r = packed(ORDER([S5('oi-1', 'Comfort')]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([1, 1, 0]);
    });

    it('2. S2 qty1 -> 1 small', () => {
        const r = packed(ORDER([S2('oi-1', 'Keto')]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([1, 0, 1]);
        expect(r.boxes[0].boxType).toBe('small');
    });

    it('3. S2 qty2 -> 1 large', () => {
        const r = packed(ORDER([S2('oi-1', 'Keto', 2)]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([1, 1, 0]);
    });

    it('4. S2 qty3 -> 1 large + 1 small', () => {
        const r = packed(ORDER([S2('oi-1', 'Keto', 3)]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([2, 1, 1]);
        expect(r.boxes.map(b => b.boxType)).toEqual(['large', 'small']);
        expect(r.boxes[0].contents).toHaveLength(2);
        expect(r.boxes[1].contents).toHaveLength(1);
    });

    it('5. S2 qty4 -> 2 large', () => {
        const r = packed(ORDER([S2('oi-1', 'Keto', 4)]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([2, 2, 0]);
    });

    it('6. 1 S5 + 2 S2 -> 2 large', () => {
        const r = packed(ORDER([S5('oi-1', 'Comfort'), S2('oi-2', 'Keto', 2)]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([2, 2, 0]);
        expect(r.boxes.map(shape)).toEqual([
            { type: 'large', box: 'Box 1 of 2', contents: ['Comfort — Serves 5'] },
            { type: 'large', box: 'Box 2 of 2', contents: ['Keto — Serves 2 ×2'] },
        ]);
    });

    it('7. 2 S5 + 3 S2 -> 3 large + 1 small (Part E case 7)', () => {
        const r = packed(ORDER([S5('oi-1', 'A', 2), S2('oi-2', 'B', 3)]));
        expect([r.physicalBoxCount, r.largeBoxCount, r.smallBoxCount]).toEqual([4, 3, 1]);
        expect(r.boxes.map(b => b.boxType)).toEqual(['large', 'large', 'large', 'small']);
    });

    it('8. two DIFFERENT Serves-2 bundle types pair into one large box', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        expect(box.boxType).toBe('large');
        expect(box.contents.map((c: any) => c.bundleName)).toEqual(['Comfort Foods', 'Fall Keto']);
    });

    it('9. two instances of the SAME Serves-2 bundle pair into one large box', () => {
        const r = packed(ORDER([S2('oi-1', 'Comfort Foods', 2)]));
        expect(r.physicalBoxCount).toBe(1);
        expect(r.boxes[0].boxType).toBe('large');
        expect(r.boxes[0].contents).toHaveLength(2);
    });

    it('10. separate Orders NEVER share a physical box', () => {
        const a = ORDER([S2('oi-a', 'Comfort Foods')], { id: 'ord-a' });
        const b = ORDER([S2('oi-b', 'Fall Keto')], { id: 'ord-b' });
        const m = buildPhysicalBoxManifest([a, b]);
        // Two lone Serves-2 bundles, but on different orders: two SMALL boxes,
        // never one shared large one.
        expect(m.physicalBoxCount).toBe(2);
        expect(m.smallBoxCount).toBe(2);
        expect(m.largeBoxCount).toBe(0);
        expect(m.boxes.every(x => x.contents.every((c: any) => c.orderId === x.orderId))).toBe(true);
        expect(m.boxes.map(x => x.boxTotal)).toEqual([1, 1]);
    });

    it('10b. same supporter NAME on two orders still never shares a box', () => {
        const a = ORDER([S2('oi-a', 'X')], { id: 'ord-a' });
        const b = ORDER([S2('oi-b', 'Y')], { id: 'ord-b' });
        const m = buildPhysicalBoxManifest([a, b]);
        expect(m.boxes.every(x => x.supporterName === 'Jane Smith')).toBe(true);
        expect(m.physicalBoxCount).toBe(2);
        expect(m.largeBoxCount).toBe(0);
    });

    it('10c. an S5 is never paired with anything', () => {
        // 1 S5 + 1 S2: the S5 is alone in a large box, the S2 alone in a small.
        const r = packed(ORDER([S5('oi-1', 'Comfort'), S2('oi-2', 'Keto')]));
        expect(r.physicalBoxCount).toBe(2);
        expect(r.boxes.map(shape)).toEqual([
            { type: 'large', box: 'Box 1 of 2', contents: ['Comfort — Serves 5'] },
            { type: 'small', box: 'Box 2 of 2', contents: ['Keto — Serves 2'] },
        ]);
        expect(r.boxes.every(b => b.contents.length === 1)).toBe(true);
    });

    it('10d. two S5 never share, and no box ever holds 3+ Serves-2', () => {
        expect(packed(ORDER([S5('oi-1', 'A', 2)])).physicalBoxCount).toBe(2);
        for (const qty of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
            const r = packed(ORDER([S2('oi-1', 'B', qty)]));
            expect(r.boxes.every(b => b.contents.length <= SERVES_2_PER_LARGE_BOX)).toBe(true);
            // Large boxes hold exactly 2; a small box holds exactly 1.
            expect(r.boxes.filter(b => b.boxType === 'large').every(b => b.contents.length === 2)).toBe(true);
            expect(r.boxes.filter(b => b.boxType === 'small').every(b => b.contents.length === 1)).toBe(true);
            expect(r.physicalBoxCount).toBe(Math.ceil(qty / 2));
            expect(r.smallBoxCount).toBe(qty % 2);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11-15. CONTENTS.
// ═════════════════════════════════════════════════════════════════════════════
describe('11-15. box contents', () => {
    it('11. a paired box contains BOTH bundle identities', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        const names = box.contents.map((c: any) => c.bundleName);
        expect(names).toContain('Comfort Foods');
        expect(names).toContain('Fall Keto');
        expect(box.contents.map((c: any) => c.orderItemId)).toEqual(['oi-1', 'oi-2']);
    });

    it('12. both retain their frozen sold tier', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        expect(box.contents.map((c: any) => c.servingTier)).toEqual(['Serves 2', 'Serves 2']);
        // ...and a mixed-tier order keeps each tier with its own bundle.
        const r = packed(ORDER([S5('oi-1', 'Big'), S2('oi-2', 'Small', 2)]));
        expect(r.boxes[0].contents[0].servingTier).toBe('Serves 5');
        expect(r.boxes[1].contents.every((c: any) => c.servingTier === 'Serves 2')).toBe(true);
    });

    it('13. a same-Bundle pair displays as a single "×2" line', () => {
        const [box] = packed(ORDER([S2('oi-1', 'Comfort Foods', 2)])).boxes;
        expect(boxContentLines(box).map(formatBoxContentLine)).toEqual(['Comfort Foods — Serves 2 ×2']);
        // The underlying instances are still two — display merged, data not.
        expect(box.contents).toHaveLength(2);
    });

    it('14. DIFFERENT bundles remain separate label lines, never merged', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        const lines = boxContentLines(box);
        expect(lines).toHaveLength(2);
        expect(lines.every(l => l.count === 1)).toBe(true);
        expect(lines.map(formatBoxContentLine).join('|')).not.toMatch(/×2/);
    });

    it('14b. same bundle NAME at DIFFERENT tiers never merges', () => {
        // Impossible in one box today (an S5 is never paired), but the merge
        // rule itself must be keyed on tier as well as name.
        const lines = boxContentLines({
            orderId: 'o', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'J',
            contents: [
                { bundleName: 'Keto', servingTier: 'Serves 2' },
                { bundleName: 'Keto', servingTier: 'Serves 5' },
            ],
        } as any);
        expect(lines).toHaveLength(2);
    });

    it('15. NO purchased instance disappears during pairing', () => {
        for (const order of [FIXTURE_A(), FIXTURE_B(), ORDER([S5('oi-1', 'A', 3), S2('oi-2', 'B', 5)])]) {
            const r = packed(order);
            const packedIds = r.boxes.flatMap(b => b.contents.map((c: any) => `${c.orderItemId}#${c.instanceIndex}`));
            const purchased = buildPurchasedInstances(order);
            expect(purchased.ok).toBe(true);
            if (purchased.ok) {
                const sourceIds = purchased.instances.map(i => `${i.orderItemId}#${i.instanceIndex}`);
                expect(packedIds.sort()).toEqual(sourceIds.sort());
                // No duplication either.
                expect(new Set(packedIds).size).toBe(packedIds.length);
            }
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16-20. BOX N / M.
// ═════════════════════════════════════════════════════════════════════════════
describe('16-20. box numbering', () => {
    it('16. PHYSICAL boxes control M, not purchased bundles', () => {
        const r = packed(FIXTURE_B());
        expect(r.purchasedBundleCount).toBe(4);
        expect(r.boxes.every(b => b.boxTotal === 3)).toBe(true);
        expect(r.boxes.every(b => b.boxTotal !== r.purchasedBundleCount)).toBe(true);
    });

    it('17. two Serves-2 bundles -> "Box 1 of 1"', () => {
        const [box] = packed(FIXTURE_A()).boxes;
        expect(`Box ${box.boxNumber} of ${box.boxTotal}`).toBe('Box 1 of 1');
    });

    it('18. three Serves-2 -> "Box 1 of 2" and "Box 2 of 2"', () => {
        const r = packed(ORDER([S2('oi-1', 'K', 3)]));
        expect(r.boxes.map(b => `Box ${b.boxNumber} of ${b.boxTotal}`))
            .toEqual(['Box 1 of 2', 'Box 2 of 2']);
    });

    it('19. S5 + paired S2 -> 1/2 then 2/2', () => {
        const r = packed(ORDER([S5('oi-1', 'Big'), S2('oi-2', 'Small', 2)]));
        expect(r.boxes.map(b => `Box ${b.boxNumber} of ${b.boxTotal}`))
            .toEqual(['Box 1 of 2', 'Box 2 of 2']);
    });

    it('19b. numbering always runs 1..M with no gaps or repeats', () => {
        for (const order of [FIXTURE_A(), FIXTURE_B(), ORDER([S5('oi-1', 'A', 2), S2('oi-2', 'B', 5)])]) {
            const r = packed(order);
            expect(r.boxes.map(b => b.boxNumber)).toEqual(
                Array.from({ length: r.physicalBoxCount }, (_, i) => i + 1),
            );
            expect(new Set(r.boxes.map(b => b.boxTotal))).toEqual(new Set([r.physicalBoxCount]));
        }
    });

    it('20. numbering is deterministic across repeat runs AND shuffled input', () => {
        const a = packed(FIXTURE_B()).boxes.map(shape);
        expect(packed(FIXTURE_B()).boxes.map(shape)).toEqual(a);

        // Part C: never database default row order. Reversing the items array
        // must not reshuffle the boxes, because the authority sorts by its own
        // stable key rather than trusting arrival order.
        const shuffled = FIXTURE_B();
        shuffled.items = [...shuffled.items].reverse();
        expect(packed(shuffled).boxes.map(shape)).toEqual(a);

        // ...and the pairing sequence itself is stable, not just the counts.
        const seq = ORDER([S2('oi-1', 'A'), S2('oi-2', 'B'), S2('oi-3', 'C'), S2('oi-4', 'D'), S2('oi-5', 'E')]);
        const expectedPairs = [['A', 'B'], ['C', 'D'], ['E']];
        const runPairs = () => packed(seq).boxes.map(b => b.contents.map((c: any) => c.bundleName));
        expect(runPairs()).toEqual(expectedPairs);
        seq.items = [...seq.items].reverse();
        expect(runPairs()).toEqual(expectedPairs);
    });

    it('20b. packInstancesIntoBoxes sorts by `sequence` itself — it does not trust arrival order', () => {
        // Part Q: this function is exported for a future Delivery phase to
        // reuse, and such a caller may hold instances in any order (a re-fetch,
        // a map, a merge). Going through packOrder() alone would never prove
        // this, because Layer 1 always hands over an already-sorted list — so
        // the guarantee is asserted directly, on shuffled input.
        const purchased = buildPurchasedInstances(
            ORDER([S2('oi-1', 'A'), S2('oi-2', 'B'), S2('oi-3', 'C'), S2('oi-4', 'D'), S2('oi-5', 'E')]),
        );
        expect(purchased.ok).toBe(true);
        if (!purchased.ok) return;

        const canonical = packInstancesIntoBoxes(purchased.instances)
            .map(b => b.contents.map((c: any) => c.bundleName));
        expect(canonical).toEqual([['A', 'B'], ['C', 'D'], ['E']]);

        // Every rotation and the full reversal must pack identically.
        const shuffles = [
            [...purchased.instances].reverse(),
            [...purchased.instances].slice(2).concat([...purchased.instances].slice(0, 2)),
            [purchased.instances[3], purchased.instances[0], purchased.instances[4], purchased.instances[1], purchased.instances[2]],
        ];
        for (const shuffled of shuffles) {
            expect(packInstancesIntoBoxes(shuffled).map(b => b.contents.map((c: any) => c.bundleName)))
                .toEqual(canonical);
        }
    });

    it('20c. a mixed order packs identically however its instances arrive', () => {
        const purchased = buildPurchasedInstances(FIXTURE_B());
        expect(purchased.ok).toBe(true);
        if (!purchased.ok) return;
        const canonical = packInstancesIntoBoxes(purchased.instances).map(shape);
        expect(packInstancesIntoBoxes([...purchased.instances].reverse()).map(shape)).toEqual(canonical);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21-26. COUNTS.
// ═════════════════════════════════════════════════════════════════════════════
describe('21-26. counts', () => {
    it('21. purchased count remains truthful (and is NOT the box count)', () => {
        expect(packed(FIXTURE_A()).purchasedBundleCount).toBe(2);
        expect(packed(FIXTURE_B()).purchasedBundleCount).toBe(4);
        expect(countPurchasedInstances(FIXTURE_B())).toBe(4);
    });

    it('22/23/24. physical, large and small counts are truthful', () => {
        const r = packed(FIXTURE_B());
        expect(r.physicalBoxCount).toBe(3);
        expect(r.largeBoxCount).toBe(2);
        expect(r.smallBoxCount).toBe(1);
        expect(r.largeBoxCount + r.smallBoxCount).toBe(r.physicalBoxCount);
    });

    it('25. outer-label count EQUALS physical box count', () => {
        for (const order of [FIXTURE_A(), FIXTURE_B(), ORDER([S2('oi-1', 'K', 7)])]) {
            const r = packed(order);
            expect(r.boxes).toHaveLength(r.physicalBoxCount);
        }
    });

    it('26. label count may be LOWER than purchased bundle count', () => {
        const a = packed(FIXTURE_A());
        expect(a.boxes.length).toBeLessThan(a.purchasedBundleCount);
        const b = packed(FIXTURE_B());
        expect(b.boxes.length).toBeLessThan(b.purchasedBundleCount);
        // 4 purchased Serves-2 -> 2 boxes -> 2 labels, not 4.
        const four = packed(ORDER([S2('oi-1', 'K', 4)]));
        expect([four.purchasedBundleCount, four.boxes.length]).toEqual([4, 2]);
    });

    it('26b. manifest-level totals sum the per-order results', () => {
        const m = buildPhysicalBoxManifest([
            ORDER([S2('oi-1', 'A', 2)], { id: 'ord-a' }),
            ORDER([S5('oi-2', 'B'), S2('oi-3', 'C', 3)], { id: 'ord-b' }),
        ]);
        expect(m.purchasedBundleCount).toBe(6);
        expect(m.physicalBoxCount).toBe(4);   // 1 + (1 S5 + 1 pair + 1 leftover)
        expect(m.largeBoxCount).toBe(3);
        expect(m.smallBoxCount).toBe(1);
        expect(m.boxes).toHaveLength(4);
    });

    it('26c. the lane summary agrees with the label manifest, box for box', () => {
        // Part M: the header count and the printed sheets must come from the
        // same authority. Same orders through both paths => same numbers.
        const orders = [
            ORDER([S2('oi-1', 'A', 2)], { id: 'ord-a' }),
            ORDER([S5('oi-2', 'B'), S2('oi-3', 'C', 3)], { id: 'ord-b' }),
        ];
        const m = buildPhysicalBoxManifest(orders);
        const s = summarizeItemPacking(orders as any);
        expect(s.physicalBoxCount).toBe(m.physicalBoxCount);
        expect(s.largeBoxCount).toBe(m.largeBoxCount);
        expect(s.smallBoxCount).toBe(m.smallBoxCount);
        expect(s.purchasedBundleCount).toBe(m.purchasedBundleCount);
    });

    it('26d. the lane summary never silently drops an unpackable line', () => {
        const s = summarizeItemPacking([
            { id: 'o1', items: [ITEM({ id: 'i1', variant_size: 'family', quantity: 3 })] },
        ] as any);
        expect(s.unpackable).toBe(3);
        expect(s.physicalBoxCount).toBe(0);
        // Non-bundle lines are skipped, not counted as unpackable.
        const s2 = summarizeItemPacking([
            { id: 'o1', items: [ITEM({ id: 'i1', bundle_id: null, bundle: null })] },
        ] as any);
        expect(s2.unpackable).toBe(0);
        expect(s2.purchasedBundleCount).toBe(0);
    });

    it('26e. the lane summary never pairs across orders', () => {
        // Two orders each with one lone Serves-2: two SMALL boxes, not one large.
        const s = summarizeItemPacking([
            { id: 'o1', items: [ITEM({ id: 'i1' })] },
            { id: 'o2', items: [ITEM({ id: 'i2' })] },
        ] as any);
        expect(s.physicalBoxCount).toBe(2);
        expect(s.smallBoxCount).toBe(2);
        expect(s.largeBoxCount).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 27-30. SERVING TIER.
// ═════════════════════════════════════════════════════════════════════════════
describe('27-30. serving tier', () => {
    it('27. Serves-2 pairing derives ONLY from OrderItem.variant_size', () => {
        // The live Bundle row claims a different tier; packing must ignore it.
        const order = ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-1', item_name: 'A', variant_size: 'serves_2', bundle: { id: 'b-1', name: 'A', serving_tier: 'family' } }),
            ITEM({ id: 'oi-2', bundle_id: 'b-2', item_name: 'B', variant_size: 'serves_2', bundle: { id: 'b-2', name: 'B', serving_tier: 'family' } }),
        ]);
        const r = packed(order);
        expect(r.physicalBoxCount).toBe(1);
        expect(r.boxes[0].boxType).toBe('large');
    });

    it('28. an S5 remains alone even when Serves-2 bundles are present', () => {
        const r = packed(ORDER([S5('oi-1', 'Big'), S2('oi-2', 'A'), S2('oi-3', 'B')]));
        expect(r.boxes[0].contents).toHaveLength(1);
        expect(r.boxes[0].contents[0].servingTier).toBe('Serves 5');
        expect(r.physicalBoxCount).toBe(2);
    });

    it('29. current Bundle.serving_tier CANNOT alter physical packing', () => {
        // A single Serves-2 whose live bundle says 'family' must still be a
        // SMALL box, not a large one.
        const r = packed(ORDER([
            ITEM({ id: 'oi-1', bundle_id: 'b-1', item_name: 'A', variant_size: 'serves_2', bundle: { id: 'b-1', name: 'A', serving_tier: 'family' } }),
        ]));
        expect(r.boxes[0].boxType).toBe('small');
        // Structural: neither layer reads serving_tier at all.
        expect(strip(read(PACKING))).not.toMatch(/serving_tier/);
        expect(strip(read(MANIFEST))).not.toMatch(/serving_tier/);
        expect(strip(read(ROUTE))).not.toMatch(/serving_tier/);
    });

    it('30. invalid or missing sold tier BLOCKS packing — never guessed', () => {
        for (const bad of [null, undefined, '', '  ', 'family', 'small', 'large', '2', 'SERVES_2']) {
            const r = packOrder(ORDER([ITEM({ variant_size: bad as any })]));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/serving size/i);
        }
        expect(resolveSoldTier(ITEM({ variant_size: 'family' }))).toBeNull();
        expect(resolveSoldTier(ITEM({ variant_size: 'serves_2' }))).toBe('Serves 2');
    });

    it('30b. the fundraiser 0.5 goal weight and the ingredient 0.5 multiplier are NOT the packing rule', () => {
        const s = strip(read(PACKING));
        expect(s).not.toMatch(/fundraiserMetrics|SERVING_MULTIPLIERS|getServingMultiplier|serving_multipliers/);
        expect(s).not.toMatch(/kitchen_engine|mealManifest|prepTasks|assemblyTasks/);
        // Packing capacity is its own declared domain fact.
        expect(PACKING_CAPACITY.serves_5).toBe(1.0);
        expect(PACKING_CAPACITY.serves_2).toBe(0.5);
        // And it is documentation, not arithmetic: 3 Serves-2 is 2 boxes, not
        // ceil(1.5) computed by summing capacities into a float.
        expect(packed(ORDER([S2('oi-1', 'K', 3)])).physicalBoxCount).toBe(2);
    });

    it('30c. a Serves-2 goal multiplier of 0.5 cannot reduce the box count', () => {
        // 3 Serves-2 weighted for a goal would be 1.5. Physically it is 2 boxes.
        expect(packed(ORDER([S2('oi-1', 'K', 3)])).physicalBoxCount).toBe(2);
        // And 2 Serves-2 weighted would be 1.0 — which coincidentally matches,
        // so prove the case where they differ instead.
        expect(packed(ORDER([S2('oi-1', 'K', 5)])).physicalBoxCount).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 31-35. SUPPORTER.
// ═════════════════════════════════════════════════════════════════════════════
describe('31-35. supporter', () => {
    it('31. a real supporter name prints on every box of the order', () => {
        const r = packed(FIXTURE_B());
        expect(r.boxes.every(b => b.supporterName === 'Jane Smith')).toBe(true);
    });

    it('32. "Guest" BLOCKS outer-box generation (OPS-6A owner ruling)', () => {
        for (const guest of ['Guest', 'guest', '  GUEST  ']) {
            expect(resolveSupporterName(ORDER([], { first_name: null, last_name: null, customer_name: guest }))).toBeNull();
            const r = packOrder(ORDER([S2('oi-1', 'K')], { first_name: null, last_name: null, customer_name: guest }));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/supporter name/i);
        }
    });

    it('33. "Unknown" and the other machine placeholders block', () => {
        for (const bad of ['', '   ', 'undefined', 'null', 'Unknown', 'UNKNOWN CUSTOMER',
            'Customer', 'N/A', 'na', '-', 'A supporter']) {
            expect(resolveSupporterName(ORDER([], { first_name: null, last_name: null, customer_name: bad }))).toBeNull();
        }
    });

    it('34. a missing supporter name blocks, naming the Order without leaking PII', () => {
        const r = packOrder(ORDER([S2('oi-1', 'K')], { id: 'ord-77', first_name: null, last_name: null, customer_name: null }));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toContain('ord-77');
            expect(r.reason).not.toMatch(/@|phone|address/i);
        }
    });

    it('34b. order-time identity is preserved and still beats the mutable scalar', () => {
        expect(resolveSupporterName(ORDER([], { first_name: 'Jane', last_name: 'Smith', customer_name: 'STALE ORG' })))
            .toBe('Jane Smith');
        expect(resolveSupporterName(ORDER([], { first_name: null, last_name: null, customer_name: 'Historical' })))
            .toBe('Historical');
    });

    it('35. two same-name separate Orders stay separate', () => {
        const m = buildPhysicalBoxManifest([
            ORDER([S2('oi-a', 'A', 2)], { id: 'ord-a' }),
            ORDER([S2('oi-b', 'B', 2)], { id: 'ord-b' }),
        ]);
        expect(m.physicalBoxCount).toBe(2);
        expect(m.boxes.every(b => b.boxTotal === 1)).toBe(true);
        expect(new Set(m.boxes.map(b => b.orderId))).toEqual(new Set(['ord-a', 'ord-b']));
    });

    it('35b. a blocked order contributes ZERO boxes but does not stop the others', () => {
        const m = buildPhysicalBoxManifest([
            ORDER([S2('oi-1', 'A', 2)], { id: 'ord-good' }),
            ORDER([S2('oi-2', 'B')], { id: 'ord-bad', first_name: null, last_name: null, customer_name: 'Guest' }),
        ]);
        expect(m.boxes.every(b => b.orderId === 'ord-good')).toBe(true);
        expect(m.physicalBoxCount).toBe(1);
        expect(m.blocked).toHaveLength(1);
        expect(m.blocked[0].orderId).toBe('ord-bad');
    });

    it('35c. bundle name still comes from the frozen snapshot first', () => {
        expect(resolveBundleName(ITEM({ item_name: 'Sold As', bundle: { id: 'b', name: 'Renamed Since' } })))
            .toBe('Sold As');
        expect(resolveBundleName(ITEM({ item_name: null, bundle: { id: 'b', name: 'Live Fallback' } })))
            .toBe('Live Fallback');
        const r = packOrder(ORDER([ITEM({ item_name: null, bundle: { id: 'b', name: null } })]));
        expect(r.ok).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 36-40. BRANDING.
// ═════════════════════════════════════════════════════════════════════════════
describe('36-40. tenant branding', () => {
    it('36. a configured tenant logo renders on the label', () => {
        // REVISED BY OPS-6A.2: the <img> src cast is `branding.logoUrl as
        // string`, because the render branch is now reached only via
        // chooseBrandHeader() confirming BOTH a URL and a loaded image.
        const s = strip(read(PAGE));
        expect(s).toMatch(/branding\.logoUrl/);
        expect(s).toMatch(/<img/);
        expect(s).toMatch(/src=\{branding\.logoUrl as string\}/);
    });

    it('37. no logo -> the tenant BUSINESS NAME fallback', () => {
        const s = strip(read(PAGE));
        const header = s.slice(s.indexOf('const renderBrandHeader'), s.indexOf('if (!boxes && batchError)'));
        expect(header).toMatch(/branding\.logoUrl/);
        expect(header).toMatch(/branding\.businessName/);
        // ...and nothing at all when neither is configured.
        expect(header).toMatch(/return null/);
    });

    it('37b. a logo that FAILS TO LOAD falls back to the name', () => {
        // SUPERSEDED BY OPS-6A.2, and now STRICTER. The old assertion pinned
        // `branding.logoUrl && !logoBroken`, which was the defect itself: a
        // URL alone took the image branch, so an image that was merely still
        // LOADING (never erroring, so onError never fired) printed a blank
        // header. The rule is now load-proven, asserted behaviourally.
        const { chooseBrandHeader } = require('@/lib/tenantLogo');
        expect(chooseBrandHeader('https://cdn/logo.png', 'Freezer Chef', 'failed')).toBe('name');
        expect(chooseBrandHeader('https://cdn/logo.png', 'Freezer Chef', 'pending')).toBe('name');
        expect(chooseBrandHeader('https://cdn/logo.png', 'Freezer Chef', 'ok')).toBe('logo');
        const s = strip(read(PAGE));
        expect(s).toMatch(/onError=\{\(\) => setLogoStatus\('failed'\)\}/);
        expect(s).toMatch(/chooseBrandHeader\(branding\.logoUrl, branding\.businessName, logoStatus\)/);
    });

    it('38. another tenant\'s branding can never appear — no hardcoded identity', () => {
        for (const f of [PAGE, PACKING, MANIFEST, ROUTE]) {
            const s = read(f);
            expect(s).not.toMatch(/Freezer Chef|My Freezer Chef|freezerchef/i);
        }
        // Branding comes from the ONE canonical tenant-scoped authority.
        expect(strip(read(PAGE))).toMatch(/fetch\('\/api\/tenant\/branding'\)/);
        // ...and NOT from the retired TenantBranding.business_name column,
        // which carries a schema DEFAULT of a literal tenant name.
        expect(strip(read(PAGE))).not.toMatch(/tenantBranding|TenantBranding/);
    });

    it('38b. no second outer-label branding configuration was introduced', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/labelLogo|boxLabelLogo|outerLabelLogo|logoConfig/i);
        // The route does not serve branding either — one authority, not two.
        expect(strip(read(ROUTE))).not.toMatch(/logo|branding/i);
    });

    it('39. branding failure does NOT block packing or printing', () => {
        const s = strip(read(PAGE));
        // The branding fetch is never awaited before the boxes render, and its
        // rejection is swallowed.
        expect(s).toMatch(/fetch\('\/api\/tenant\/branding'\)\s*\n?\s*\.then/);
        expect(s).not.toMatch(/await fetch\('\/api\/tenant\/branding'\)/);
        expect(s).toMatch(/\.catch\(\(\) => \{[^}]*\}\)/);
        // Print is gated on `blocked`, never on branding.
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
        expect(s).not.toMatch(/disabled=\{[^}]*branding/);
        expect(s).not.toMatch(/if \(!branding\).*return/);
    });

    it('40. branding does not alter the box count', () => {
        // Structural: the packing authority knows nothing about branding.
        const s = strip(read(PACKING));
        expect(s).not.toMatch(/logo|branding|business_name/i);
        // Behavioural: packing is a pure function of the order alone.
        expect(packed(FIXTURE_B()).physicalBoxCount).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 41-45. PRIVACY.
// ═════════════════════════════════════════════════════════════════════════════
describe('41-45. privacy', () => {
    it('41. no supporter NAME in any generated URL', () => {
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/URLSearchParams/);
        expect(q).not.toMatch(/customer:\s*order\.customer\?\.name/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });

    it('42/43. no address, phone or email in any generated URL', () => {
        const q = strip(read(QUEUE));
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/address|phone|email/i);
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|URLSearchParams|window\.location\.search/);
    });

    it('44. no address, phone or email on the physical label or its data path', () => {
        for (const f of [PACKING, MANIFEST, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/delivery_address|contact_email|customer_email|contact_phone|customer_phone/);
            expect(s).not.toMatch(/\bemail\b/i);
            expect(s).not.toMatch(/\bphone\b/i);
        }
        // The emitted box carries exactly the printable facts plus traceability.
        const [box] = packed(FIXTURE_A()).boxes;
        expect(Object.keys(box).sort()).toEqual([
            'boxNumber', 'boxTotal', 'boxType', 'contents', 'orderId', 'supporterName',
        ]);
        expect(JSON.stringify(box)).not.toMatch(/@|address|phone/i);
    });

    it('44b. no allergens or ingredients on the outer box', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).not.toMatch(/allergen/i);
        expect(printBlock).not.toMatch(/ingredient/i);
        expect(strip(read(PACKING))).not.toMatch(/allergen|ingredient/i);
    });

    it('45. new logs do not expose supporter PII', () => {
        for (const f of [PACKING, MANIFEST, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            for (const line of s.match(/console\.\w+\([^)]*\)/g) || []) {
                expect(line).not.toMatch(/supporterName|customer_name|first_name|last_name|bundleName/);
                expect(line).not.toMatch(/\$\{|JSON\.stringify|,\s*(body|order|orders|box|boxes)\s*\)/);
            }
        }
        expect(strip(read(ROUTE))).toMatch(/console\.error\('Box label manifest failed'\)/);
    });

    it('45b. only opaque Order IDs cross into browser storage', () => {
        const s = strip(read('lib/printBatchStorage.ts'));
        const block = s.slice(s.indexOf('BOX_LABEL_STORAGE_KEY'));
        expect(block).toMatch(/orderIds/);
        expect(block).not.toMatch(/supporterName|first_name|last_name|customer_name|address|phone|email/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 46-49. TENANT SECURITY.
// ═════════════════════════════════════════════════════════════════════════════
let mockAuth: () => any;
const findManyCalls: any[] = [];
const orderRows: Record<string, any[]> = { rows: [] };

const prismaDouble: any = {
    order: {
        findMany: (args: any) => {
            findManyCalls.push(args);
            const where = args?.where || {};
            const ids: string[] = where.id?.in || [];
            // Emulate the DB honestly: a row comes back only when BOTH the id
            // and the tenant match, which is what the WHERE clause asks for.
            return Promise.resolve(
                orderRows.rows.filter(o => ids.includes(o.id) && o.business_id === where.business_id),
            );
        },
    },
};

jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));

const postBoxLabels = async (body: any) => {
    const { POST } = require('@/app/api/production/box-labels/route');
    return POST(new Request('https://x/api/production/box-labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }));
};

describe('46-49. tenant security', () => {
    beforeEach(() => {
        findManyCalls.length = 0;
        mockAuth = () => ({ user: { businessId: 'biz-a' } });
        orderRows.rows = [
            { ...FIXTURE_B(), id: 'ord-a', business_id: 'biz-a' },
            { ...FIXTURE_B(), id: 'ord-b', business_id: 'biz-b' },
        ];
    });

    it('46. Tenant A can pack and print its own Order', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a'] });
        expect(res.status).toBe(200);
        const body = await res.json();
        // Fixture B: 4 purchased bundles -> 3 physical boxes -> 3 labels.
        expect(body.purchasedBundleCount).toBe(4);
        expect(body.physicalBoxCount).toBe(3);
        expect(body.largeBoxCount).toBe(2);
        expect(body.smallBoxCount).toBe(1);
        expect(body.boxes).toHaveLength(3);
        expect(body.boxes[0].supporterName).toBe('Jane Smith');
    });

    it('47. Tenant A CANNOT pack or print Tenant B\'s Order', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-b'] });
        const body = await res.json();
        expect(body.boxes).toHaveLength(0);
        expect(body.physicalBoxCount).toBe(0);
        expect(body.unavailableCount).toBe(1);
        expect(JSON.stringify(body)).not.toMatch(/Jane|Comfort|Keto|Gluten/);
    });

    it('47b. a tampered Order ID cannot cross a tenant boundary', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a', 'ord-b', 'ord-nope'] });
        const body = await res.json();
        expect(new Set(body.boxes.map((b: any) => b.orderId))).toEqual(new Set(['ord-a']));
        expect(body.unavailableCount).toBe(2);
        expect(findManyCalls[0].where.business_id).toBe('biz-a');
    });

    it('48. a client-supplied businessId is ignored for authority', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-b'], businessId: 'biz-b', business_id: 'biz-b' });
        const body = await res.json();
        expect(body.boxes).toHaveLength(0);
        expect(findManyCalls[0].where.business_id).toBe('biz-a');
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/body\??\.businessId|body\??\.business_id/);
    });

    it('49. a missing server tenant fails closed with 401 before any DB read', async () => {
        for (const session of [null, {}, { user: {} }, { user: { businessId: '' } }]) {
            findManyCalls.length = 0;
            mockAuth = () => session;
            const res = await postBoxLabels({ orderIds: ['ord-a'] });
            expect(res.status).toBe(401);
            expect(findManyCalls).toHaveLength(0);
        }
    });

    it('49b. the route is self-defending — middleware does not cover /api/', () => {
        const s = strip(read(ROUTE));
        expect(s).toMatch(/await auth\(\)/);
        expect(s).toMatch(/status:\s*401/);
        expect(s.indexOf('401')).toBeLessThan(s.indexOf('prisma.order.findMany'));
        expect(s).toMatch(/canceled_at: null/);
    });

    it('49c. the localStorage handoff still refuses an unprovable batch', () => {
        const store: Record<string, string> = {};
        (global as any).localStorage = {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => { store[k] = v; },
            removeItem: (k: string) => { delete store[k]; },
        };
        const { writeBoxLabelBatch, readBoxLabelBatch, BOX_LABEL_STORAGE_KEY } = require('@/lib/printBatchStorage');

        expect(writeBoxLabelBatch({ orderIds: ['ord-a'], businessId: 'biz-a' }).ok).toBe(true);
        expect(readBoxLabelBatch('biz-a').ok).toBe(true);
        expect(readBoxLabelBatch('biz-b').ok).toBe(false);
        for (const missing of [null, undefined, '']) {
            expect(readBoxLabelBatch(missing as any).ok).toBe(false);
        }
        store[BOX_LABEL_STORAGE_KEY] = JSON.stringify({ orderIds: ['ord-a'] });
        expect(readBoxLabelBatch('biz-a').ok).toBe(false);
        expect((readBoxLabelBatch('biz-b') as any).batch).toBeUndefined();
        delete (global as any).localStorage;
    });

    it('49d. the page proves ownership from the SERVER, never useSession()', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(s).not.toMatch(/useSession/);
        const q = strip(read(QUEUE));
        expect(q).toMatch(/await fetchAuthenticatedBusinessId\(\)/);
        expect(q).not.toMatch(/useSession/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 50-54. PRINT.
// ═════════════════════════════════════════════════════════════════════════════
describe('50-54. print', () => {
    it('50/51. one printed STICKER per PHYSICAL box', () => {
        // SUPERSEDED BY BOX-LABEL-SHEET-1: the printed unit is now a slot on
        // an OL600WX sheet, not a whole page. The invariant is unchanged and
        // is now proven BEHAVIOURALLY as well as structurally — one box
        // occupies exactly one slot, never two, and two boxes never share one.
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/sheets\.map\(\(sheet\) =>/);
        expect(printBlock).toMatch(/sheet\.slots\.map\(\(slot\) =>/);
        expect(printBlock).toMatch(/className="label-slot"/);
        // A slot renders at most ONE box, and a blank slot renders nothing.
        expect(printBlock).toMatch(/if \(!slot\.label\) return null;/);

        // Behavioural counterpart: boxes.length IS the physical box count,
        // and pagination places exactly that many stickers.
        const { paginateLabelSheets, placedLabels } = require('@/lib/labelSheetLayout');
        const a = packed(FIXTURE_A()).boxes;
        const b = packed(FIXTURE_B()).boxes;
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(3);
        expect(placedLabels(paginateLabelSheets(a, 1))).toHaveLength(1);
        expect(placedLabels(paginateLabelSheets(b, 1))).toHaveLength(3);
    });

    it('52. no trailing blank sheet after the final label', () => {
        // REVISED BY BOX-LABEL-SHEET-1: exemption moved to .label-sheet.
        const s = read(PAGE);
        expect(s).toMatch(/\.label-sheet\s*\{[^}]*break-after:\s*always/);
        expect(s).toMatch(/\.label-sheet:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        expect(s).toMatch(/\.label-sheet:last-child\s*\{[\s\S]*?page-break-after:\s*auto/);
        const exemption = s.slice(
            s.indexOf('.label-sheet:last-child'),
            s.indexOf('}', s.indexOf('.label-sheet:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0|content-visibility/);
    });

    it('52b. the printed sticker size is exact — OL600WX 4 x 2.5', () => {
        // SUPERSEDED BY BOX-LABEL-SHEET-1: was a 4x6 page per box.
        const s = read(PAGE);
        expect(s).toMatch(/size:\s*8\.5in 11in/);
        expect(s).toMatch(/width:\s*\$\{OL600_SHEET\.labelWidthIn\}in/);
        expect(s).toMatch(/height:\s*\$\{OL600_SHEET\.labelHeightIn\}in/);
    });

    it('53. a paired Serves-2 box gets ONE sheet, not two', () => {
        const r = packed(FIXTURE_A());
        expect(r.purchasedBundleCount).toBe(2);
        expect(r.boxes).toHaveLength(1);
        // ...and that single sheet carries both bundle lines.
        expect(boxContentLines(r.boxes[0])).toHaveLength(2);
    });

    it('54. Ctrl+P fail-closed behaviour is preserved', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/hidden print:block/);
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/blocked\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
        expect(s).toMatch(/if \(blocked\.length > 0\)/);
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
        // No mock direct-printer success path was revived.
        expect(s).not.toMatch(/printMethod|api.*[Pp]rinting|DateCodeGenie/);
    });

    it('54b. the label renders the locked content, in the locked hierarchy', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/renderBrandHeader\(\)/);
        expect(printBlock).toMatch(/box\.supporterName/);
        expect(printBlock).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
        expect(printBlock).toMatch(/formatBoxContentLine\(line\)/);
        // Supporter name is the largest element; box type is subordinate.
        // REVISED BY BOX-LABEL-SHEET-1: point sizes were re-proportioned for
        // the 4 x 2.5 sticker and the box-type size is now fractional
        // (6.5pt), so the sizes are parsed as decimals. The HIERARCHY being
        // asserted is unchanged and is the actual guarantee.
        const nameSize = Number((printBlock.match(/fontSize: '([\d.]+)pt', fontWeight: 900, lineHeight: 1\.05/) || [])[1]);
        const typeSize = Number((printBlock.match(/fontSize: '([\d.]+)pt'[^}]*textTransform: 'uppercase'/) || [])[1]);
        expect(nameSize).toBeGreaterThan(0);
        expect(typeSize).toBeGreaterThan(0);
        expect(nameSize).toBeGreaterThan(typeSize);
        // No internal identifiers are PRINTED. React `key` props are stripped
        // first: a key is reconciliation metadata, never rendered text, and
        // matching it would fail this assertion on something no one can read
        // off a box.
        const rendered = printBlock.replace(/key=\{[^}]*\}/g, '');
        expect(rendered).not.toMatch(/box\.orderId|orderItemId|bundle_id|business_id/);
        expect(rendered).not.toMatch(/\{box\.contents\[/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 55-62. REGRESSIONS.
// ═════════════════════════════════════════════════════════════════════════════
describe('55-62. regressions', () => {
    it('55. the frozen item_name authority is preserved', () => {
        expect(resolveBundleName(ITEM({ item_name: 'Sold As', bundle: { id: 'b', name: 'Renamed' } })))
            .toBe('Sold As');
    });

    it('56. order-time supporter identity is preserved', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/first_name/);
        expect(s).toMatch(/last_name/);
        expect(s).toMatch(/purchaserDisplayName/);
        // The mutable CRM record is still not even accepted.
        expect(s).not.toMatch(/customer\?\.\s*name|contact_name/);
    });

    it('57. the OPS-6 privacy fix is preserved', () => {
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/\/labels\?/);
        expect(q).not.toMatch(/recipeId:\s*item\.bundle\.id/);
        expect(q).not.toMatch(/order\.items\[0\]/);
    });

    it('58. OPS-5 meal-label counts are unchanged', () => {
        const { physicalMealCount, isPrintableMealCount } = require('@/lib/mealManifest');
        const perRecipe = physicalMealCount(3, 1);
        expect(perRecipe).toBe(3);
        expect(isPrintableMealCount(perRecipe)).toBe(true);
        expect(perRecipe * 5).toBe(15);
        // The meal print page still carries no outer-box concept.
        expect(strip(read('app/production/print-batch/page.tsx')))
            .not.toMatch(/Box \d+ of|boxNumber|box_number/i);
    });

    it('58b. 15 MEAL labels and 2 OUTER boxes coexist for the same purchase', () => {
        // 3 x Serves-2 bundles of a 5-meal bundle: 15 meal labels INSIDE,
        // 2 physical outer boxes (1 pair + 1 leftover) OUTSIDE.
        const { physicalMealCount } = require('@/lib/mealManifest');
        expect(physicalMealCount(3, 1) * 5).toBe(15);
        expect(packed(ORDER([S2('oi-1', 'Clean Eating/Paleo', 3)])).physicalBoxCount).toBe(2);
    });

    it('59. ingredient / kitchen math is unchanged', () => {
        expect(read('lib/kitchen_engine.ts'))
            .toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
        for (const f of [PACKING, MANIFEST, ROUTE, PAGE, QUEUE]) {
            expect(strip(read(f))).not.toMatch(/kitchen_engine/);
        }
    });

    it('60. fundraiser goal weighting is unchanged and unimported', () => {
        const s = read('lib/fundraiserProductionBatch.ts');
        expect(s).toMatch(/export function buildFundraiserBatches/);
        expect(s).toMatch(/sourceOrderIds/);
        for (const f of [PACKING, MANIFEST]) {
            expect(strip(read(f))).not.toMatch(/fundraiserProductionBatch|fundraiserMetrics/);
        }
    });

    it('61. no Production DB mutation on any new path', () => {
        for (const f of [PACKING, MANIFEST, ROUTE, PAGE, QUEUE]) {
            expect(strip(read(f)))
                .not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw/);
        }
    });

    it('62. no schema change, and no persisted box state', () => {
        const schema = read('prisma/schema.prisma');
        expect(schema).not.toMatch(/box_number|box_total|boxNumber|box_type|physical_box/);
        // Contract section 7: render-time computation only.
        for (const f of [PACKING, MANIFEST]) {
            expect(strip(read(f))).not.toMatch(/prisma|PrismaClient|@\/lib\/db/);
        }
    });

    it('62b. printing a box label is NOT a lifecycle transition (Part P)', () => {
        for (const f of [PACKING, MANIFEST, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/status:\s*['"](packed|delivered|ready_to_ship|completed)/i);
            expect(s).not.toMatch(/markPacked|markDelivered|setStatus/);
        }
    });

    it('62c. the packing authority is pure and reusable by a future Delivery phase', () => {
        const s = strip(read(PACKING));
        expect(s).not.toMatch(/from '@\/lib\/db'|from 'react'|fetch\(|Date\.now|Math\.random/);
        // Exactly one import: the purchase layer it consumes.
        const imports = s.match(/^import [\s\S]*?from '[^']+';/gm) || [];
        expect(imports).toHaveLength(1);
        expect(imports[0]).toMatch(/supporterBoxManifest/);
        // Part Q: the counts a future Delivery phase needs are all exposed.
        const m = buildPhysicalBoxManifest([FIXTURE_B()]);
        for (const k of ['physicalBoxCount', 'largeBoxCount', 'smallBoxCount', 'purchasedBundleCount', 'boxes', 'orders']) {
            expect(m).toHaveProperty(k);
        }
    });

    it('62d. packInstancesIntoBoxes is safe on empty and single input', () => {
        expect(packInstancesIntoBoxes([])).toEqual([]);
        expect(packInstancesIntoBoxes(null as any)).toEqual([]);
        expect(buildPhysicalBoxManifest([])).toMatchObject({ physicalBoxCount: 0, boxes: [], blocked: [] });
    });
});
