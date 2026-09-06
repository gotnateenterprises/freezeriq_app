/**
 * PACKING-SLIP-1 — projecting a canonical PhysicalBox onto what a customer
 * packing slip prints.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (reuse the canonical
 * authorities, never re-derive them). This module adds NOTHING to the
 * physical-box question — it holds no packing rule, no tier logic, no
 * eligibility check. Every one of those is already answered by
 * lib/physicalBoxPacking.ts and lib/supporterBoxManifest.ts, and this module
 * imports them rather than re-implementing anything.
 *
 * WHAT THIS MODULE ADDS: THE MEAL LIST
 *
 * A packing slip has one piece of content the outer-box sticker does not:
 * which MEALS are inside each bundle. That comes from a place neither
 * canonical authority touches — `BundleContent`, the join between a Bundle
 * and its Recipes — and it is LIVE, mutable data.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * KNOWN, DELIBERATE LIMITATION — READ BEFORE CHANGING THIS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `buildMealsByOrderItemId` reads `Bundle.contents` AS IT EXISTS RIGHT NOW,
 * not as it existed at sale time. Unlike `bundleName` (frozen at
 * `OrderItem.item_name`) and `servingTier` (frozen at
 * `OrderItem.variant_size`), there is no order-time snapshot of which meals a
 * bundle contained — the schema has never captured one, and this phase does
 * not add one (no schema change is authorized here).
 *
 * The practical consequence: if a tenant edits a Bundle's contents AFTER an
 * order was placed, a PACKING SLIP FOR THAT HISTORICAL ORDER, printed today,
 * will show the CURRENT meal list, not the one actually purchased. This is a
 * real, currently-accepted risk, not an oversight — it is the same behaviour
 * the packing slip already had before this phase, and fixing it would mean
 * either a schema change (an order-time BundleContent snapshot) or accepting
 * live data, which is a PRE-LAUNCH decision explicitly deferred to a later
 * phase per the PACKING-SLIP-FACT-FINDING-1 audit. Do not describe this
 * function's output as frozen or historical truth anywhere it is used.
 *
 * WHY MEALS ARE LOOKED UP ONCE PER MERGED CONTENT LINE, NOT PER INSTANCE
 *
 * `boxContentLines` (physicalBoxPacking.ts) already merges two purchased
 * instances of the identical (bundleName, servingTier) into one line with a
 * count — "Comfort Foods — Serves 2 x2". Those two instances are, by
 * definition, the SAME bundle, so they have the SAME meal list. Looking the
 * meals up once per merged line and reusing them for the `x2` line is
 * therefore not a shortcut that risks losing information — it is the correct
 * answer, because a second lookup would return an identical list. What must
 * never happen, and does not here, is merging the meal lists of two
 * DIFFERENT bundles into one ambiguous table — `boxContentLines` never merges
 * different bundles, so this module never receives a line that mixes them.
 */

import { boxContentLines, buildPhysicalBoxManifest, type PhysicalBox } from './physicalBoxPacking';
import { type BoxManifestOrder } from './supporterBoxManifest';

/** One meal row on a packing slip. */
export interface PackingSlipMeal {
    recipeName: string;
    quantity: number;
}

/** One bundle section on a packing slip: its identity, plus every meal in it. */
export interface PackingSlipBundleSection {
    bundleName: string;
    /** Presentation-ready: "Serves 2" / "Serves 5". Frozen sale-time truth. */
    servingTier: string;
    /** How many identical (bundle, tier) purchases this section represents. */
    count: number;
    /**
     * The bundle's current meal contents. LIVE data — see the module-level
     * limitation above. Empty when no contents are on record, which the
     * caller should render as "Contents not listed" rather than an empty
     * table implying zero meals.
     */
    meals: PackingSlipMeal[];
}

/** The shape a fetched OrderItem needs for meal lookup. Nothing else is read. */
export interface OrderItemWithLiveBundleContents {
    id: string;
    bundle_id: string | null;
    bundle?: {
        contents?: readonly {
            quantity?: number | null;
            recipe?: { name?: string | null } | null;
        }[] | null;
    } | null;
}

export interface OrderWithLiveBundleContents {
    items?: readonly OrderItemWithLiveBundleContents[] | null;
}

/**
 * Build a lookup from OrderItem id to its bundle's current meal list.
 *
 * Keyed by `OrderItem.id` — the same stable identity
 * `PurchasedBundleInstance.orderItemId` already carries — so a caller holding
 * a `PhysicalBox` can look up meals for any of its contents without needing
 * the original Order rows again.
 *
 * A non-bundle line (`bundle_id` null/empty) is skipped: it was never
 * eligible to become a physical box in the first place
 * (`supporterBoxManifest.isBoxEligibleItem`), so it has no meals to report.
 */
export function buildMealsByOrderItemId(
    orders: readonly OrderWithLiveBundleContents[],
): Record<string, PackingSlipMeal[]> {
    const map: Record<string, PackingSlipMeal[]> = {};

    for (const order of orders || []) {
        for (const item of order?.items || []) {
            if (!item || typeof item.bundle_id !== 'string' || item.bundle_id.trim() === '') continue;

            map[item.id] = (item.bundle?.contents || []).map((c) => ({
                recipeName: (c?.recipe?.name ?? '').trim() || 'Mystery Meal',
                quantity: typeof c?.quantity === 'number' && c.quantity > 0 ? c.quantity : 1,
            }));
        }
    }

    return map;
}

/**
 * Project one PhysicalBox into the sections a packing slip prints: one
 * section per DISTINCT purchased bundle in the box (never merging two
 * different bundles), each carrying its own meal list.
 *
 * For a paired box holding two DIFFERENT Serves-2 bundles, this returns TWO
 * sections — satisfying "do not collapse two separate Bundles into one
 * ambiguous meal table." For a paired box holding two IDENTICAL Serves-2
 * purchases, this returns ONE section with `count: 2`, matching the box
 * sticker's own "x2" treatment exactly (both read `boxContentLines`).
 *
 * Never drops a bundle: every line `boxContentLines` returns becomes exactly
 * one section here.
 */
export function buildSlipBundleSections(
    box: PhysicalBox,
    mealsByOrderItemId: Readonly<Record<string, PackingSlipMeal[]>>,
): PackingSlipBundleSection[] {
    const lines = boxContentLines(box);

    return lines.map((line) => {
        // Any instance matching this merged line's (bundleName, servingTier)
        // is a representative of the same bundle purchase, so its meal list
        // is authoritative for the whole line — see the module doc above.
        const representative = box.contents.find(
            (instance) => instance.bundleName === line.bundleName && instance.servingTier === line.servingTier,
        );

        return {
            bundleName: line.bundleName,
            servingTier: line.servingTier,
            count: line.count,
            meals: representative ? (mealsByOrderItemId[representative.orderItemId] || []) : [],
        };
    });
}

/**
 * Which delivery date a slip shows: Campaign > Order > (caller's "today").
 *
 * This is a straight extraction of the precedence the packing slip has always
 * used — PACKING-SLIP-1 does not change it, only relocates it so it can run
 * once per order server-side instead of once per (pre-fix) slip client-side.
 * Returning `null` when neither is set is deliberate: "today" is a
 * render-time concept (the moment the page is opened/printed), so it is
 * still the caller's job to default a `null` to `new Date()`, exactly as
 * before.
 */
export function resolveSlipDeliveryDate(
    order:
        | { delivery_date?: string | Date | null; campaign?: { delivery_date?: string | Date | null } | null }
        | null
        | undefined,
): string | Date | null {
    if (!order) return null;
    if (order.campaign?.delivery_date) return order.campaign.delivery_date;
    if (order.delivery_date) return order.delivery_date;
    return null;
}

/**
 * Put a finished PhysicalBox[] into PRINT order: grouped by source Order in
 * that order's delivery run sequence, boxes within an order kept in their own
 * canonical Box N/M order.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A SECOND PACKING AUTHORITY
 *
 * `buildPhysicalBoxManifest` sorts the orders it packs by `order.id` — a
 * deterministic key, but not a meaningful one to a volunteer driving a
 * delivery route. The packing slip has always printed in the OPERATOR'S
 * delivery sequence (`Order.delivery_sequence`), and this function is the
 * one place that ordering is restored, AFTER packing, by re-sorting the
 * finished box list. It changes nothing about which boxes exist, what is in
 * them, or their boxNumber/boxTotal — every field on every `PhysicalBox` it
 * returns is identical to what was passed in; only the array's order differs.
 *
 * `delivery_sequence` is `Int? @default(0)`. The pre-fix page's own ordering
 * used `(a.delivery_sequence || 999)` — treating a real, on-record `0` the
 * same as a missing value. That is a faithful preservation of existing
 * behaviour (`|| 999`, not `?? 999`), not a new decision: reordering print
 * output for orders sequenced at `0` is outside this phase's identity/
 * physical-box/tenant-safety scope.
 */
export function orderBoxesByDeliverySequence(
    boxes: readonly PhysicalBox[],
    deliverySequenceByOrderId: Readonly<Record<string, number | null | undefined>>,
): PhysicalBox[] {
    const sequenceFor = (orderId: string) => deliverySequenceByOrderId[orderId] || 999;

    return [...(boxes || [])].sort((a, z) => {
        const bySequence = sequenceFor(a.orderId) - sequenceFor(z.orderId);
        if (bySequence !== 0) return bySequence;

        // Tie-break (including two orders that share a sequence) the same
        // deterministic way buildPhysicalBoxManifest itself orders orders, so
        // this can never disagree with the canonical authority about order.
        const byOrderId = a.orderId.localeCompare(z.orderId);
        if (byOrderId !== 0) return byOrderId;

        return a.boxNumber - z.boxNumber;
    });
}

/**
 * OPS-6B.2 — the ONE Prisma select every packing-slip context fetches with.
 *
 * There are now two legitimate ACCESS CONTEXTS for a packing slip:
 *
 *   PRIMARY (pre-handoff)  Production -> Packed & Ready. The slip is printed
 *                          and physically placed INSIDE the box before the
 *                          order leaves Production. This is the normal path.
 *   REPRINT (post-handoff) Delivery -> Slips, for the active Delivery
 *                          population, to recover a lost or damaged slip.
 *
 * Two workflow POPULATIONS are legitimate. Two physical-box authorities are
 * not, and neither are two renderings: a slip reprinted from Delivery must be
 * the same piece of paper the packer put in the box. This constant and
 * buildPackingSlipPayload below are what make that true by construction — the
 * two routes differ ONLY in their WHERE clause.
 */
export const PACKING_SLIP_ORDER_SELECT = {
    id: true,
    first_name: true,
    last_name: true,
    customer_name: true,
    delivery_date: true,
    delivery_sequence: true,
    campaign: { select: { delivery_date: true } },
    items: {
        select: {
            id: true,
            bundle_id: true,
            quantity: true,
            variant_size: true,
            item_name: true,
            bundle: {
                select: {
                    id: true,
                    name: true,
                    contents: {
                        select: {
                            quantity: true,
                            recipe: { select: { name: true } },
                        },
                    },
                },
            },
        },
        // The same deterministic key lib/supporterBoxManifest.ts sorts by, so
        // the two can never disagree about instance sequence — and therefore
        // never about Box N/M.
        orderBy: { id: 'asc' as const },
    },
} as const;

export interface PackingSlipPayload {
    boxes: PhysicalBox[];
    blocked: { orderId: string; reason: string }[];
    purchasedBundleCount: number;
    physicalBoxCount: number;
    largeBoxCount: number;
    smallBoxCount: number;
    deliveryDateByOrderId: Record<string, string | null>;
    mealsByOrderItemId: Record<string, PackingSlipMeal[]>;
}

/**
 * Turn fetched orders into the packing-slip response, identically for both
 * access contexts.
 *
 * Every question this answers is delegated: cartons and Box N/M to
 * lib/physicalBoxPacking.ts, supporter identity to lib/supporterBoxManifest.ts,
 * the printed date to resolveSlipDeliveryDate, print order to
 * orderBoxesByDeliverySequence. Nothing is re-derived here, which is precisely
 * why a pre-handoff slip and its later Delivery reprint are the same document.
 */
export function buildPackingSlipPayload(
    orders: readonly any[],
): PackingSlipPayload {
    const manifest = buildPhysicalBoxManifest(orders as unknown as BoxManifestOrder[]);

    const deliverySequenceByOrderId: Record<string, number | null> = {};
    const deliveryDateByOrderId: Record<string, string | null> = {};
    for (const order of orders) {
        deliverySequenceByOrderId[order.id] = order.delivery_sequence ?? null;
        const resolved = resolveSlipDeliveryDate(order as any);
        deliveryDateByOrderId[order.id] = resolved ? new Date(resolved).toISOString() : null;
    }

    return {
        boxes: orderBoxesByDeliverySequence(manifest.boxes, deliverySequenceByOrderId),
        blocked: manifest.blocked,
        purchasedBundleCount: manifest.purchasedBundleCount,
        physicalBoxCount: manifest.physicalBoxCount,
        largeBoxCount: manifest.largeBoxCount,
        smallBoxCount: manifest.smallBoxCount,
        deliveryDateByOrderId,
        mealsByOrderItemId: buildMealsByOrderItemId(orders as any),
    };
}
