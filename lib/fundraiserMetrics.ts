/**
 * Fundraiser Metrics — shared weighted bundle logic
 *
 * WEIGHT RULES
 * ────────────
 *   Family Size  (variant_size = "serves_5", serving_tier = "family")  → 1.0
 *   Serves 2     (variant_size = "serves_2", serving_tier = "couple")  → 0.5
 *
 * This module is the SINGLE source of truth for weighted bundle calculations.
 * Import it from both API routes and UI components.
 */

// ── Weight Map ───────────────────────────────────────────────

/**
 * Returns the bundle-unit weight for a given variant_size or serving_tier.
 *
 * @param sizeOrTier  - VariantSize enum value ("serves_2" | "serves_5")
 *                      OR Bundle.serving_tier ("family" | "couple" | "couples" | "single" | ...)
 */
export function getBundleUnitWeight(sizeOrTier: string | null | undefined): number {
    const normalized = (sizeOrTier || '').toLowerCase().trim();

    // "serves_2", "couple", "couples" → 0.5
    if (
        normalized === 'serves_2' ||
        normalized === 'couple' ||
        normalized === 'couples' ||
        normalized === 'single'
    ) {
        return 0.5;
    }

    // "serves_5", "family", or anything else → 1.0 (safest default)
    return 1.0;
}

// ── Order Item → Bundle Units ────────────────────────────────

export interface OrderItemForMetrics {
    quantity: number;
    /** VariantSize enum from OrderItem ("serves_2" | "serves_5") */
    variant_size?: string | null;
    /** Fallback: Bundle.serving_tier if variant_size unavailable */
    serving_tier?: string | null;
}

/**
 * Computes weighted bundle units from an array of order items.
 *
 * @example
 *   items = [{ quantity: 3, variant_size: "serves_5" }, { quantity: 4, variant_size: "serves_2" }]
 *   → 3×1.0 + 4×0.5 = 5.0
 */
export function computeBundleUnitsFromItems(items: OrderItemForMetrics[]): number {
    return items.reduce((sum, item) => {
        const weight = getBundleUnitWeight(item.variant_size || item.serving_tier);
        return sum + (item.quantity || 0) * weight;
    }, 0);
}

// ── Full Campaign Progress ───────────────────────────────────

export interface OrderForMetrics {
    items?: OrderItemForMetrics[];
    total_amount?: number | string | null;
}

export interface FundraiserProgressResult {
    /** Total weighted bundle units sold across all orders */
    totalBundlesSold: number;
    /** Bundle goal (from campaign.bundle_goal) */
    bundleGoal: number;
    /** 0-100 percentage */
    progressPercent: number;
    /** Estimated fundraiser earnings (total_sales × 0.20) */
    estimatedEarnings: number;
    /** Total dollar sales (kept for backward compat / earnings calc) */
    totalSales: number;
}

/**
 * Computes the full fundraiser progress from campaign data.
 *
 * @param bundleGoalInput - campaign.bundle_goal (target number of bundles)
 * @param totalSales      - campaign.total_sales (dollar value, for earnings calc)
 * @param orders          - orders with nested items[] for weighted bundle math
 */
export function computeFundraiserProgress(
    bundleGoalInput: number | string | null | undefined,
    totalSales: number | string | null | undefined,
    orders: OrderForMetrics[] = []
): FundraiserProgressResult {
    const bundleGoal = Math.max(Number(bundleGoalInput) || 100, 1);
    const dollarSales = Number(totalSales) || 0;

    // Sum weighted bundles across all order items
    const totalBundlesSold = orders.reduce((acc, order) => {
        return acc + computeBundleUnitsFromItems(order.items || []);
    }, 0);

    const progressPercent = Math.min((totalBundlesSold / bundleGoal) * 100, 100);

    // Fundraiser earnings: 20% of total dollar sales
    // (from raise-funds page: "Your organization keeps 20% of the proceeds")
    const estimatedEarnings = dollarSales * 0.2;

    return {
        totalBundlesSold,
        bundleGoal,
        progressPercent,
        estimatedEarnings,
        totalSales: dollarSales,
    };
}

/**
 * Formats a bundle count for display (e.g., 5 → "5", 5.5 → "5.5")
 */
export function formatBundleCount(count: number): string {
    return count % 1 === 0 ? count.toFixed(0) : count.toFixed(1);
}
