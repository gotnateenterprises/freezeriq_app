/**
 * OPS-6B — the ONE packaging-consumption authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 Rule 8 (reuse, do
 * not re-derive) and Rule 5 (the menu owns the tier: `Bundle.serving_tier` at
 * WRITE time, `OrderItem.variant_size` frozen thereafter).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * app/api/delivery/stats/route.ts used to decide every packaging question from
 * a single local flag:
 *
 *     const tier = bundle.serving_tier?.toLowerCase() || '';
 *     const isFamily = tier === 'family' || bundle.name?.toLowerCase().includes('family');
 *
 * Both halves are wrong for a SOLD order, in opposite directions:
 *
 *   - `Bundle.serving_tier` is a MUTABLE free-text column whose schema default
 *     is the literal "family", so every bundle a tenant never explicitly
 *     re-tiered counted as large regardless of what was actually sold — and
 *     editing a bundle today retroactively changed what a past week consumed.
 *   - the name substring made "Fall Family Favorites (Serves 2)" — a genuine
 *     Serves-2 clone — count as large, while a real Serves-5 bundle with no
 *     "family" in its name counted as small.
 *
 * The frozen sale-time tier, `OrderItem.variant_size`, was never consulted.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY BOXES AND CONTAINERS ARE ANSWERED BY DIFFERENT THINGS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * They are genuinely different questions and must not share a rule:
 *
 *   BOXES      — how many CARTONS leave the building. Answered ONLY by
 *                lib/physicalBoxPacking.ts, because two Serves-2 bundles from
 *                one order share a single large carton. Never recomputed here.
 *   CONTAINERS — how many trays, lids and bags the MEALS occupy. That scales
 *                with meals, not cartons: pairing two Serves-2 bundles into one
 *                box does not merge their trays.
 *
 * So this module DELEGATES the carton question and only owns the container
 * walk — re-keyed off the frozen sold tier.
 *
 * This module is pure: no Prisma, no React, no I/O, no clock. That is what
 * lets the "need" figure the Delivery dashboard displays and the "decrement"
 * the handoff writes come from one function instead of two that drift.
 */

import { summarizeItemPacking } from './physicalBoxPacking';

/** How many physical cartons one unit of tape seals. */
export const BOXES_PER_TAPE_UNIT = 30;

/** The frozen sold tier that fills a whole carton on its own. */
const FULL_TIER = 'serves_5';

export interface PackagingOrderItem {
    id?: string | null;
    bundle_id?: string | null;
    quantity?: number | null;
    /** The FROZEN sale-time tier. The authority — never Bundle.serving_tier. */
    variant_size?: string | null;
    bundle?: {
        contents?: readonly {
            quantity?: number | null;
            recipe?: { container_type?: string | null } | null;
        }[] | null;
    } | null;
}

export interface PackagingOrder {
    id?: string | null;
    items?: readonly PackagingOrderItem[] | null;
}

export interface PackagingNeed {
    /** Canonical physical cartons — from lib/physicalBoxPacking.ts, not from here. */
    largeBoxCount: number;
    smallBoxCount: number;
    physicalBoxCount: number;
    purchasedBundleCount: number;
    /** Lines whose sold tier could not be proven. Reported, never silently dropped. */
    unpackable: number;
    /** Sealing tape, one unit per BOXES_PER_TAPE_UNIT cartons. */
    tape: number;
    largeTrays: number;
    largeLids: number;
    smallTrays: number;
    smallLids: number;
    gallonBags: number;
    quartBags: number;
}

/**
 * Everything a set of orders consumes, computed from frozen sale-time truth.
 *
 * Cartons come from the canonical packing authority. Containers are walked per
 * purchased line, keyed off `OrderItem.variant_size` only. A line whose tier is
 * neither `serves_5` nor `serves_2` contributes NO containers and is counted by
 * `summarizeItemPacking` as `unpackable` — guessing a container for an
 * unprovable tier is how a kitchen ends up short a lid.
 */
export function computePackagingNeed(orders: readonly PackagingOrder[]): PackagingNeed {
    const packing = summarizeItemPacking(orders as any);

    let largeTrays = 0;
    let largeLids = 0;
    let smallTrays = 0;
    let smallLids = 0;
    let gallonBags = 0;
    let quartBags = 0;

    for (const order of orders || []) {
        for (const item of order?.items || []) {
            if (!item) continue;
            // Non-bundle lines (a fee, a manual upsell) hold no meals.
            if (typeof item.bundle_id !== 'string' || item.bundle_id.trim() === '') continue;

            const quantity = item.quantity;
            if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) continue;

            // The FROZEN sold tier, and nothing else. An unrecognised value
            // consumes nothing rather than defaulting to a size.
            const variantSize = item.variant_size;
            if (variantSize !== 'serves_5' && variantSize !== 'serves_2') continue;
            const isFull = variantSize === FULL_TIER;

            for (const content of item.bundle?.contents || []) {
                const perBundle = typeof content?.quantity === 'number' && content.quantity > 0 ? content.quantity : 1;
                const needed = quantity * perBundle;

                if (content?.recipe?.container_type === 'bag') {
                    if (isFull) gallonBags += needed;
                    else quartBags += needed;
                } else {
                    // Default container is a tray, which always takes a lid.
                    if (isFull) {
                        largeTrays += needed;
                        largeLids += needed;
                    } else {
                        smallTrays += needed;
                        smallLids += needed;
                    }
                }
            }
        }
    }

    return {
        largeBoxCount: packing.largeBoxCount,
        smallBoxCount: packing.smallBoxCount,
        physicalBoxCount: packing.physicalBoxCount,
        purchasedBundleCount: packing.purchasedBundleCount,
        unpackable: packing.unpackable,
        tape: Math.ceil(packing.physicalBoxCount / BOXES_PER_TAPE_UNIT),
        largeTrays,
        largeLids,
        smallTrays,
        smallLids,
        gallonBags,
        quartBags,
    };
}

/**
 * The packaging rows a successful handoff draws down, as
 * `[partialPackagingItemName, quantity]` pairs.
 *
 * The partial names match the ones app/api/delivery/record-print-job/route.ts
 * has always used, so no tenant's PackagingItem rows need renaming for the
 * consumption event to move.
 *
 * Deliberately EXCLUDES 'Avery' (print sheets — a genuine printing consumable
 * that stays with the print route, where being non-idempotent is honest) and
 * the large_box/small_box carton rows, which no code path has ever decremented;
 * starting to would be new behaviour rather than a repair, and belongs to its
 * own owner decision.
 */
export function packagingDrawdown(need: PackagingNeed): [string, number][] {
    return [
        ['Tape', need.tape],
        ['Large Tray', need.largeTrays],
        ['Large Lid', need.largeLids],
        ['Small Container', need.smallTrays],
        ['Small Lid', need.smallLids],
        ['Gallon Ziplock', need.gallonBags],
        ['Quart Ziplock', need.quartBags],
    ];
}
