/**
 * Serving Multipliers — Centralized serving-size scaling for production calculations.
 *
 * This module is the SINGLE SOURCE OF TRUTH for how variant_size affects
 * ingredient quantities in the KitchenEngine pipeline.
 *
 * CALCULATION CONSTITUTION — LAW 2 compliance:
 *   Final quantity = Ingredient Qty × Recipe Yield Multiplier × Bundle Content Qty × Serving Multiplier × Order Qty
 *
 * MULTIPLIER RULES (LOCKED — Option B)
 * ─────────────────────────────────────
 *   serves_5   (Family)   → 1.0  (recipes are authored at this yield — BASELINE)
 *   serves_2   (Couple)   → 0.5  (half-portion of family yield)
 *   start_fresh           → 1.0  (identity — used for cost calculations only)
 *
 * These values align with the commercial weights in fundraiserMetrics.ts:
 *   getBundleUnitWeight("serves_5") = 1.0
 *   getBundleUnitWeight("serves_2") = 0.5
 *
 * LOCK STATUS: PERMANENT — DO NOT MODIFY WITHOUT CONSTITUTION REVIEW
 *
 * @module serving_multipliers
 */

/** Canonical serving sizes accepted by the system */
export type ServingSize = 'serves_2' | 'serves_5' | 'start_fresh';

/**
 * Database-safe variant size type.
 * Maps to the Prisma VariantSize enum which only contains serves_2 and serves_5.
 * start_fresh is a calculation-only concept and maps to serves_5 for storage.
 */
export type DbVariantSize = 'serves_2' | 'serves_5';

/**
 * Immutable, frozen map of serving size → ingredient quantity multiplier.
 *
 * Recipes are authored for the "serves_5" (family) yield.
 * "serves_2" scales ingredients to half.
 * "start_fresh" is an identity multiplier used only for cost calculations.
 *
 * LOCKED via Object.freeze — runtime mutation is impossible.
 */
const SERVING_MULTIPLIERS: Readonly<Record<ServingSize, number>> = Object.freeze({
    serves_5: 1.0,
    serves_2: 0.5,
    start_fresh: 1.0,
});

/** All valid serving size keys, frozen for runtime safety */
const VALID_SERVING_SIZES: ReadonlySet<string> = Object.freeze(
    new Set(Object.keys(SERVING_MULTIPLIERS))
);

/**
 * Returns the numeric serving multiplier for a given variant_size.
 *
 * CALCULATION CONSTITUTION — LAW 2:
 *   This multiplier MUST be applied exactly once per order in the
 *   multiplier chain. It MUST NOT be skipped or applied twice.
 *
 * @param variantSize - The serving size enum value
 * @returns The numeric multiplier (0.5 or 1.0)
 * @throws Error if variantSize is unknown (LAW 8 — fail loudly)
 */
export function getServingMultiplier(variantSize: string | null | undefined): number {
    // Default to serves_5 (family) when null/undefined — matches Prisma default
    const size = (variantSize || 'serves_5') as ServingSize;

    if (!VALID_SERVING_SIZES.has(size)) {
        throw new Error(
            `[CALCULATION INTEGRITY] Unknown serving size: "${variantSize}". ` +
            `Allowed values: ${Array.from(VALID_SERVING_SIZES).join(', ')}. ` +
            `Refusing to continue with unknown multiplier per LAW 2 / LAW 8.`
        );
    }

    const multiplier = SERVING_MULTIPLIERS[size];

    // Defensive: verify multiplier is positive and finite (LAW 3 — no NaN drift)
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
        throw new Error(
            `[CALCULATION INTEGRITY] Multiplier for "${size}" resolved to invalid value: ${multiplier}. ` +
            `Multipliers must be positive finite numbers.`
        );
    }

    return multiplier;
}

/**
 * Validates that a serving size string is a known value.
 * Does NOT throw — use for pre-validation or UI checks.
 */
export function isValidServingSize(value: string | null | undefined): boolean {
    if (!value) return true; // null/undefined defaults to serves_5
    return VALID_SERVING_SIZES.has(value);
}

/**
 * Resolves a freeform serving tier string into a canonical ServingSize.
 *
 * SINGLE SOURCE OF TRUTH for mapping storefront/coordinator/checkout
 * input strings to the Prisma VariantSize enum values stored in the database.
 *
 * Accepted inputs (case-insensitive):
 *   → serves_5: "family", "Family Size", "serves_5", "family_size", "start_fresh", null/undefined
 *   → serves_2: "couple", "couples", "single", "serves_2", "Serves 2"
 *
 * NOTE: start_fresh maps to serves_5 for DB storage (same 1.0 multiplier).
 * For calculation multiplier lookup, use getServingMultiplier() directly.
 *
 * All order intake routes MUST use this function instead of inline string comparisons.
 *
 * @param tierInput - Raw serving tier string from storefront/coordinator/checkout
 * @returns DbVariantSize value safe for Prisma VariantSize enum storage
 */
export function resolveVariantSize(tierInput: string | null | undefined): DbVariantSize {
    if (!tierInput) return 'serves_5'; // Default to family baseline

    const normalized = tierInput.toLowerCase().trim().replace(/[\s_-]+/g, '_');

    // Map to DB-safe values (only serves_2 or serves_5)
    const DB_MAP: Record<string, DbVariantSize> = {
        'serves_5': 'serves_5',
        'serves_2': 'serves_2',
        'start_fresh': 'serves_5', // Same 1.0 multiplier — safe for DB storage
        'family': 'serves_5',
        'family_size': 'serves_5',
        'couple': 'serves_2',
        'couples': 'serves_2',
        'single': 'serves_2',
    };

    const resolved = DB_MAP[normalized];
    if (resolved) return resolved;

    // Unknown input — default to family baseline (safe default)
    // Log for observability so we can catch new tier strings
    console.warn(
        `[SERVING RESOLUTION] Unknown tier input: "${tierInput}" → defaulting to serves_5. ` +
        `Add to DB_MAP if this is a valid tier.`
    );
    return 'serves_5';
}

/**
 * Returns a copy of the multiplier table for debug/logging purposes.
 * The original table remains frozen and immutable.
 */
export function getMultiplierTable(): Record<string, number> {
    return { ...SERVING_MULTIPLIERS };
}
