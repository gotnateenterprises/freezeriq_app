/**
 * OPS-5A — the PHYSICAL MEAL MANIFEST authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (meal/recipe labels
 * are a system distinct from customer outer-box labels) and §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PROTECT
 *
 *   INGREDIENT DEMAND  and  PHYSICAL MEAL COUNT  are not the same number.
 *
 *   3 x Serves-2 Chicken Alfredo
 *     ingredient demand : 3 x 0.5 = 1.5 base-equivalent recipe quantities
 *     physical packages : 3 meals, in 3 trays, needing 3 labels
 *
 * The serving multiplier scales how much FOOD goes in a package. It never
 * changes how many PACKAGES there are. Before OPS-5A the label path had no
 * package count at all, so it fell back to `copies || 1` and printed exactly
 * one label per recipe no matter how many meals were being made. The obvious
 * "fix" -- reach for the prep quantity instead -- is the trap this module
 * exists to close: that number is 1.5 for the example above, and rounding it
 * would print 2 labels for 3 meals. A decimal ingredient quantity must NEVER
 * become a label count.
 *
 * WHERE THE COUNT ACTUALLY COMES FROM
 *
 * lib/kitchen_engine.ts already computes it, in the assemblyTasks loop:
 *
 *     assemblyTasks[key].qty += order.quantity * (item.quantity || 1);
 *
 * Note what is absent: `servingMultiplier`. That loop is already the physical
 * manifest -- its unit is literally 'meals'. It was simply never consumed by
 * the label path, and it derived its TIER from the wrong place (see below).
 * OPS-5A repairs it in place rather than adding a second meal-count authority.
 *
 * BundleContent.quantity is "how many of this recipe are in one bundle"
 * (prisma/schema.prisma `model BundleContent { quantity Float @default(1.0) }`),
 * which is exactly how the ingredient chain uses it too -- kitchen_engine's own
 * LAW 2 comment spells the chain out as
 * `order.quantity x bundleContent.quantity x servingMultiplier`. So the package
 * count is that same chain with the multiplier left off.
 *
 * THE TIER IS NOT RESOLVED HERE
 *
 * This module does not parse tier strings and does not consult a Bundle. It
 * consumes the authority OPS-4/OPS-4A already established: a sold line's frozen
 * OrderItem.variant_size snapshot, or a manual line's tenant-scoped
 * Bundle.serving_tier, both resolved upstream. The one normalisation it does
 * perform delegates to lib/serving_multipliers.ts, the sensitive core file that
 * owns the tier vocabulary. Adding a third resolver is exactly the defect class
 * OPS-4 through OPS-5 have been closing.
 */

import { normalizeStrictServingTier, type DbVariantSize } from './serving_multipliers';

/** Physical meal packages are counted in meals, never in recipe yield units. */
export const MEAL_UNIT = 'meals' as const;

/**
 * The number of PHYSICAL MEAL PACKAGES one production line contributes.
 *
 *     order.quantity  x  BundleContent.quantity
 *
 * and deliberately NOT the serving multiplier. A Serves-2 order of 3 bundles
 * still yields 3 packages; only the food inside each is halved.
 *
 * A missing bundle-content quantity defaults to 1, matching kitchen_engine's
 * existing `item.quantity || 1` and prisma's `@default(1.0)`.
 */
export function physicalMealCount(
    orderQuantity: number | null | undefined,
    bundleContentQuantity?: number | null,
): number {
    const orders = Number(orderQuantity);
    if (!Number.isFinite(orders) || orders <= 0) return 0;
    const perBundle = bundleContentQuantity == null ? 1 : Number(bundleContentQuantity);
    if (!Number.isFinite(perBundle) || perBundle <= 0) return 0;
    return orders * perBundle;
}

/**
 * Whether a count may be turned into physical labels.
 *
 * A label count must be a positive WHOLE number. Anything else -- a fraction
 * from odd bundle-content data, a NaN, a negative -- is refused rather than
 * rounded, because rounding is precisely how 1.5 becomes 2 labels for 3 meals.
 * Callers fail closed on false, exactly as OPS-5 does for missing ingredients.
 */
export function isPrintableMealCount(count: unknown): boolean {
    return typeof count === 'number' && Number.isFinite(count) && count > 0 && Number.isInteger(count);
}

/**
 * The manifest grouping key: RECIPE IDENTITY + AUTHORITATIVE TIER.
 *
 * Recipe ID, not recipe NAME. A name is a display string and is not unique --
 * a tenant may duplicate "Chicken Alfredo" -- and merging two different recipes
 * that happen to share a name would merge their ALLERGENS onto one physical
 * food label while keeping only the first recipe's id. Bundle identity is
 * deliberately NOT in the key: the same recipe from two different bundles at
 * the same tier is the same physical meal and SHOULD sum.
 */
export function manifestKey(recipeId: string, variantSize: DbVariantSize | null): string {
    return `${recipeId}::${variantSize ?? 'unknown'}`;
}

/**
 * The tier a manifest row is built at.
 *
 * PRECEDENCE, and why:
 *   1. `orderVariantSize` -- for a SOLD line this is the frozen
 *      OrderItem.variant_size snapshot; for a MANUAL line /api/production/plan
 *      already resolved it from the tenant-scoped Bundle (OPS-4A). Either way
 *      it is the authority, and a later edit to Bundle.serving_tier must never
 *      retroactively re-tier it.
 *   2. `bundleServingTier` -- consulted ONLY when the line carries no tier at
 *      all, which is the genuine legacy case. This preserves the pre-OPS-5A
 *      fallback rather than inventing a new one.
 *
 * Returns null when neither source is recognisable, so the caller omits the
 * tier instead of guessing.
 */
export function resolveManifestVariantSize(
    orderVariantSize: string | null | undefined,
    bundleServingTier?: string | null,
): DbVariantSize | null {
    const fromOrder = normalizeStrictServingTier(orderVariantSize);
    if (fromOrder) return fromOrder;
    return normalizeStrictServingTier(bundleServingTier);
}

/** One physical-meal manifest row. */
export interface MealManifestRow {
    /** Recipe identity — never the display name. */
    recipeId: string;
    recipeName: string;
    /** Canonical tier, or null when it could not be proven. */
    variantSize: DbVariantSize | null;
    /** Discrete package count. Never an ingredient quantity. */
    physicalMealCount: number;
    unit: typeof MEAL_UNIT;
}
