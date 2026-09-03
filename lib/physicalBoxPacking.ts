/**
 * OPS-6A — LAYER 2: the ONE physical box packing authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7. Box numbering is a
 * RENDER-TIME computation only — "No persisted box-number schema is
 * authorized at this time." Nothing here is stored, and nothing here writes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT CHANGED, AND WHY IT MATTERS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OPS-6 shipped assuming:
 *
 *     one purchased bundle instance = one physical box = one label
 *
 * Owner acceptance found that is not the operation. A Serves-5 bundle fills a
 * large outer box. A Serves-2 bundle fills about HALF of one. So two Serves-2
 * bundles bought on the same order travel together in a single large box:
 *
 *     Jane buys Comfort Foods (S2) + Fall Keto (S2)
 *     -> 2 purchased bundles, 1 large box, 1 label listing BOTH
 *
 * Physical box count is therefore routinely LOWER than purchased bundle count,
 * and "Box N of M" counts BOXES, not purchases.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE 0.5 TRAP
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three different 0.5s exist in this codebase and they are NOT the same number
 * wearing different hats. Sharing a helper between them would be a defect
 * waiting to happen, so they are kept apart deliberately:
 *
 *   1. lib/serving_multipliers.ts SERVING_MULTIPLIERS.serves_2 = 0.5
 *      INGREDIENT scaling. A Serves-2 meal uses half the food.
 *
 *   2. lib/fundraiserMetrics.ts — Serves 2 counts 0.5 toward a fundraising
 *      GOAL. A sales-credit weighting.
 *
 *   3. PACKING_CAPACITY.serves_2 = 0.5 (here)
 *      How much of a physical carton the bundle occupies.
 *
 * They coincide numerically today by accident of the product's shape, not by
 * derivation. If the tenant ever switches to a carton that fits three Serves-2
 * bundles, only (3) changes. Nothing here imports (1) or (2), and a test pins
 * that.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY NOT A BIN-PACKING SOLVER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Because the owner specified a closed set of legal combinations, not an
 * optimization target:
 *
 *     S5              -> one LARGE box, alone
 *     S2 + S2         -> one LARGE box
 *     leftover S2     -> one SMALL box
 *
 * An S5 never shares with an S2. Two S5s never share. A general solver with
 * float capacities would happily produce an S5+S2 box at 1.5 capacity, or fill
 * to 1.0 with fractional drift, and would make the output depend on a
 * heuristic rather than on a rule the kitchen can verify by eye. This is a
 * deterministic domain rule, expressed as one, with no floating-point
 * arithmetic anywhere in the packing path — PACKING_CAPACITY is documentation
 * of the physical fact, not an input to a sum.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SCOPE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Packing NEVER crosses a source Order. Two orders from the same supporter —
 * same name, same email, same Customer row — are packed separately, because
 * merging them would require deciding that two rows are the same person, and
 * the fulfillment contract disqualifies exactly that inference (§1.3).
 *
 * This module is pure: no Prisma, no React, no I/O, no clock, no randomness.
 * That is what lets a server route, a client component and a future Delivery
 * phase all consume the SAME box counts instead of each re-deriving pairing.
 */

import {
    buildPurchasedInstances,
    type BoxManifestOrder,
    type BoxManifestOrderItem,
    type BlockedBoxOrder,
    type PurchasedBundleInstance,
} from './supporterBoxManifest';

/**
 * The physical carton a box needs.
 *
 * A narrow domain vocabulary rather than a schema enum: contract §15.2 does not
 * authorize schema for physical packing, and nothing here is persisted.
 */
export type PhysicalBoxType = 'large' | 'small';

/**
 * How much of ONE LARGE carton each sold tier occupies.
 *
 * Documentation of a physical fact, deliberately NOT an input to arithmetic —
 * see "THE 0.5 TRAP" above. Exported so a future phase can read the rule
 * rather than rediscover it, and so a test can pin that packing does not
 * import the ingredient multiplier or the fundraising weight instead.
 */
export const PACKING_CAPACITY: Readonly<Record<string, number>> = Object.freeze({
    serves_5: 1.0,
    serves_2: 0.5,
});

/** How many Serves-2 bundles share one large carton. */
export const SERVES_2_PER_LARGE_BOX = 2;

/** ONE physical outer box, and everything in it. */
export interface PhysicalBox {
    orderId: string;
    /** Which carton to use. */
    boxType: PhysicalBoxType;
    /** 1-based, within the SOURCE ORDER. Counts BOXES, never purchases. */
    boxNumber: number;
    /** Total physical boxes for the SOURCE ORDER. */
    boxTotal: number;
    supporterName: string;
    /** The purchased instances travelling in this box. Never empty. */
    contents: PurchasedBundleInstance[];
}

/** One printed line of a box's contents, after identical lines are merged. */
export interface BoxContentLine {
    bundleName: string;
    servingTier: string;
    /** How many identical (bundle, tier) instances this line represents. */
    count: number;
}

export interface OrderPackingResult {
    orderId: string;
    supporterName: string;
    boxes: PhysicalBox[];
    purchasedBundleCount: number;
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
}

export interface PhysicalBoxManifest {
    boxes: PhysicalBox[];
    blocked: BlockedBoxOrder[];
    orders: OrderPackingResult[];
    /** Totals across every successfully packed order in this manifest. */
    purchasedBundleCount: number;
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
}

/** True for the tier that fills a whole carton on its own. */
function isFullBoxTier(variantSize: string): boolean {
    return variantSize === 'serves_5';
}

/** True for the tier that fills half a carton. */
function isHalfBoxTier(variantSize: string): boolean {
    return variantSize === 'serves_2';
}

/**
 * Pack ONE order's purchased instances into physical boxes.
 *
 * ORDERING, which is the whole determinism story:
 *
 *   1. Instances arrive already in their deterministic `sequence` (Layer 1
 *      sorts by OrderItem id, then fans quantity out in index order). This
 *      function re-sorts by that sequence rather than trusting arrival order,
 *      so a shuffled array cannot reshuffle the boxes.
 *   2. Full-box (S5) instances become boxes first, in sequence.
 *   3. Half-box (S2) instances are then paired two at a time, in sequence.
 *   4. A single leftover S2 becomes the final, small box.
 *
 * That produces the owner's documented expectation for a mixed order:
 *
 *   1 x S5, 3 x S2  ->  Box 1 LARGE (S5)
 *                       Box 2 LARGE (S2 + S2)
 *                       Box 3 SMALL (S2)
 *
 * Box numbers are assigned last, over the finished list, so they always run
 * 1..M with no gaps regardless of how the boxes were formed.
 */
export function packInstancesIntoBoxes(
    instances: readonly PurchasedBundleInstance[],
): PhysicalBox[] {
    const ordered = [...(instances || [])].sort((a, z) => a.sequence - z.sequence);
    if (ordered.length === 0) return [];

    const orderId = ordered[0].orderId;
    const supporterName = ordered[0].supporterName;

    const groups: { boxType: PhysicalBoxType; contents: PurchasedBundleInstance[] }[] = [];

    // 1. Every full-box tier travels alone, in a large carton.
    for (const instance of ordered) {
        if (isFullBoxTier(instance.variantSize)) {
            groups.push({ boxType: 'large', contents: [instance] });
        }
    }

    // 2. Half-box tiers pair up, two to a large carton, in sequence.
    const halves = ordered.filter((i) => isHalfBoxTier(i.variantSize));
    for (let i = 0; i < halves.length; i += SERVES_2_PER_LARGE_BOX) {
        const chunk = halves.slice(i, i + SERVES_2_PER_LARGE_BOX);
        groups.push({
            // A full pair fills a large carton; a lone leftover gets the small
            // one. This is the ONLY place a small box is ever produced.
            boxType: chunk.length === SERVES_2_PER_LARGE_BOX ? 'large' : 'small',
            contents: chunk,
        });
    }

    const boxTotal = groups.length;
    return groups.map((g, index) => ({
        orderId,
        boxType: g.boxType,
        boxNumber: index + 1,
        boxTotal,
        supporterName,
        contents: g.contents,
    }));
}

/**
 * Pack ONE source Order, from raw order rows.
 *
 * Blocks — producing zero boxes and a named reason — whenever Layer 1 cannot
 * prove the order's purchase truth. A partially-truthful order is never
 * partially packed.
 */
export function packOrder(
    order: BoxManifestOrder,
): { ok: true; result: OrderPackingResult } | { ok: false; reason: string } {
    const purchased = buildPurchasedInstances(order);
    if (!purchased.ok) return { ok: false, reason: purchased.reason };

    const boxes = packInstancesIntoBoxes(purchased.instances);

    return {
        ok: true,
        result: {
            orderId: order.id,
            supporterName: purchased.instances[0].supporterName,
            boxes,
            purchasedBundleCount: purchased.instances.length,
            physicalBoxCount: boxes.length,
            largeBoxCount: boxes.filter((b) => b.boxType === 'large').length,
            smallBoxCount: boxes.filter((b) => b.boxType === 'small').length,
        },
    };
}

/**
 * Pack a SET of source Orders into physical boxes.
 *
 * Orders are packed independently and each keeps its own Box N/M — nothing is
 * ever combined across orders. A blocked order does not stop the others; it is
 * reported by id so the operator can fix it, and contributes no boxes, so
 * nothing printed is ever a guess. Orders are processed in a deterministic id
 * order for the same reason the instances are.
 */
export function buildPhysicalBoxManifest(orders: BoxManifestOrder[]): PhysicalBoxManifest {
    const sorted = [...(orders || [])].sort((a, z) =>
        String(a?.id ?? '').localeCompare(String(z?.id ?? '')),
    );

    const boxes: PhysicalBox[] = [];
    const blocked: BlockedBoxOrder[] = [];
    const results: OrderPackingResult[] = [];

    for (const order of sorted) {
        const packed = packOrder(order);
        if (packed.ok) {
            results.push(packed.result);
            boxes.push(...packed.result.boxes);
        } else {
            blocked.push({ orderId: order?.id ?? '(unknown)', reason: packed.reason });
        }
    }

    return {
        boxes,
        blocked,
        orders: results,
        purchasedBundleCount: results.reduce((s, r) => s + r.purchasedBundleCount, 0),
        physicalBoxCount: results.reduce((s, r) => s + r.physicalBoxCount, 0),
        largeBoxCount: results.reduce((s, r) => s + r.largeBoxCount, 0),
        smallBoxCount: results.reduce((s, r) => s + r.smallBoxCount, 0),
    };
}

/**
 * The printed content lines for one box, with identical purchases merged.
 *
 * A qty-2 Serves-2 line packs into ONE large box holding two instances of the
 * same bundle. Printing
 *
 *     Comfort Foods — Serves 2
 *     Comfort Foods — Serves 2
 *
 * reads at a glance like a mistake; the owner asked for the clearer
 *
 *     Comfort Foods — Serves 2 x2
 *
 * Merging is by (bundleName, servingTier) ONLY, and first-appearance order is
 * preserved so the sequence still matches the deterministic packing order.
 * Two DIFFERENT bundles never merge, even at the same tier — that would hide
 * what is physically in the box, which is the one thing this label exists to
 * say.
 */
export function boxContentLines(box: PhysicalBox): BoxContentLine[] {
    const lines: BoxContentLine[] = [];
    for (const instance of box?.contents || []) {
        const existing = lines.find(
            (l) => l.bundleName === instance.bundleName && l.servingTier === instance.servingTier,
        );
        if (existing) {
            existing.count += 1;
        } else {
            lines.push({
                bundleName: instance.bundleName,
                servingTier: instance.servingTier,
                count: 1,
            });
        }
    }
    return lines;
}

/** One content line as printed, e.g. `Comfort Foods — Serves 2 x2`. */
export function formatBoxContentLine(line: BoxContentLine): string {
    const base = `${line.bundleName} — ${line.servingTier}`;
    return line.count > 1 ? `${base} ×${line.count}` : base;
}

/**
 * Physical box counts for a raw set of order-item rows, with no supporter
 * identity required.
 *
 * WHY THIS EXISTS: an operator lane needs a truthful "N physical boxes"
 * header, but it has no business blocking that count on whether every order
 * has a printable supporter name — a count is not a label. It routes through
 * the SAME packInstancesIntoBoxes as the label path, so the header and the
 * printed sheets can never disagree about how many boxes there are.
 *
 * Lines whose sold tier cannot be proven are counted in `unpackable` rather
 * than silently dropped: a count that quietly ignores rows is how an operator
 * ends up short a carton.
 */
export function summarizeItemPacking(
    orders: readonly { id?: string | null; items?: readonly BoxManifestOrderItem[] | null }[],
): { purchasedBundleCount: number; physicalBoxCount: number; largeBoxCount: number; smallBoxCount: number; unpackable: number } {
    let purchasedBundleCount = 0;
    let physicalBoxCount = 0;
    let largeBoxCount = 0;
    let smallBoxCount = 0;
    let unpackable = 0;

    for (const order of orders || []) {
        // A synthetic, identity-free instance list for THIS order only, so
        // pairing still never crosses an order boundary.
        const instances: PurchasedBundleInstance[] = [];
        let sequence = 0;

        const ordered = [...(order?.items || [])].sort((a, z) =>
            String(a?.id ?? '').localeCompare(String(z?.id ?? '')),
        );

        for (const item of ordered) {
            if (!item || typeof item.bundle_id !== 'string' || item.bundle_id.trim() === '') continue;

            const quantity = item.quantity;
            if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
                unpackable += 1;
                continue;
            }

            const variantSize = item.variant_size;
            if (variantSize !== 'serves_2' && variantSize !== 'serves_5') {
                unpackable += quantity;
                continue;
            }

            for (let instanceIndex = 0; instanceIndex < quantity; instanceIndex++) {
                instances.push({
                    orderId: String(order?.id ?? ''),
                    orderItemId: String(item.id ?? ''),
                    instanceIndex,
                    supporterName: '',
                    bundleName: '',
                    servingTier: '',
                    variantSize,
                    sequence: sequence++,
                });
            }
        }

        purchasedBundleCount += instances.length;
        const boxes = packInstancesIntoBoxes(instances);
        physicalBoxCount += boxes.length;
        largeBoxCount += boxes.filter((b) => b.boxType === 'large').length;
        smallBoxCount += boxes.filter((b) => b.boxType === 'small').length;
    }

    return { purchasedBundleCount, physicalBoxCount, largeBoxCount, smallBoxCount, unpackable };
}
