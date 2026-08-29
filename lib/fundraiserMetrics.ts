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

import { organizationShareAmount } from './fundraiserOrgShare';

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

/**
 * ESTIMATED share of gross sales a fundraising organization keeps.
 *
 * The name carries "ESTIMATED" on purpose. This is not a settled rate, not a
 * payout, and not anything a tenant has agreed to in the system: it is the
 * tenant-facing marketing promise on the raise-funds page ("Your organization
 * keeps 20% of the proceeds"), reproduced as a number. A bare
 * `FUNDRAISER_ORG_SHARE` reads like configuration someone set; this does not.
 *
 * Exported so callers reuse this single definition instead of re-typing 0.2 —
 * a second copy is how two screens start quoting a group different numbers.
 *
 * CAVEAT worth knowing before leaning on it: a single global rate with no
 * per-tenant field behind it anywhere in the schema, never reconciled against
 * a real payout. If a tenant ever negotiates a different split, this constant —
 * not a new one — is what has to become configurable.
 */
export const ESTIMATED_FUNDRAISER_ORG_SHARE = 0.2;

export interface OrderForMetrics {
    items?: OrderItemForMetrics[];
    total_amount?: number | string | null;
}

// ── FR-GOAL-CONFIG-1: tenant-controlled weighted bundle goal ────────────────

/**
 * The bundle goal every campaign gets when the tenant has not set one.
 *
 * Was 100 — an arbitrary number that happened to be the old display value,
 * unreachable for a small organization's real fundraising capacity. 20 is
 * the new owner-set default; there is deliberately no configurable upper
 * bound, since inventing one here would repeat the exact mistake this
 * constant replaces for a large organization instead of a small one.
 *
 * This is the ONE place that number lives. Every surface that resolves a
 * missing/invalid goal — display or validation, server or client — imports
 * this constant or one of the functions below instead of re-typing a number.
 */
export const DEFAULT_BUNDLE_GOAL = 20;

/**
 * Resolves a STORED value (campaign.bundle_goal, possibly null, 0, negative,
 * or otherwise malformed from legacy data) to a positive display goal.
 *
 * Use this everywhere a goal is DISPLAYED or fed into progress math. It never
 * rejects — there is no user to hand an error to at display time — it just
 * refuses to show something nonsensical.
 */
export function resolveBundleGoal(value: number | string | null | undefined): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUNDLE_GOAL;
}

export type BundleGoalParseResult =
    | { ok: true; goal: number }
    | { ok: false; error: string };

/**
 * Server-authoritative parse + validate of a tenant-supplied bundle goal at
 * CREATE time. Blank/absent resolves to the default — never rejected, since
 * "I didn't set one" is the ordinary case at launch. A PRESENT value must be
 * a positive finite number; malformed strings, zero, negative numbers, NaN
 * and Infinity are all rejected outright rather than silently coerced to
 * something safe, so a fat-fingered goal can never accidentally save as the
 * default or as 1.
 *
 * No upper bound: FR-GOAL-CONFIG-1 exists specifically because 100 turned
 * out to be an arbitrary ceiling for a small organization — inventing a new
 * arbitrary ceiling here would repeat the same mistake for a large one.
 */
export function parseBundleGoal(input: unknown): BundleGoalParseResult {
    if (input === null || input === undefined) {
        return { ok: true, goal: DEFAULT_BUNDLE_GOAL };
    }

    // Booleans and arrays coerce to numbers in JS; refuse them explicitly.
    if (typeof input !== 'number' && typeof input !== 'string') {
        return { ok: false, error: 'Bundle goal must be a number.' };
    }

    if (typeof input === 'string' && input.trim() === '') {
        return { ok: true, goal: DEFAULT_BUNDLE_GOAL };
    }

    const n = Number(input);
    if (!Number.isFinite(n)) {
        return { ok: false, error: 'Bundle goal must be a number.' };
    }

    if (n <= 0) {
        return { ok: false, error: 'Bundle goal must be greater than 0.' };
    }

    // Prefer whole numbers — round rather than reject a value like 20.5.
    return { ok: true, goal: Math.round(n) };
}

export type BundleGoalChangeDecision =
    | { change: false }
    | { change: true; goal: number }
    | { change: false; rejected: true; status: 409 | 400; error: string };

/**
 * The complete decision for one client-supplied bundle-goal EDIT on an
 * existing campaign. Unlike parseBundleGoal (used at creation, where blank
 * legitimately means "use the default"), omission here means "leave the
 * stored goal alone" — a PATCH that only touches unrelated fields must never
 * reset an already-configured goal back to the default.
 *
 * campaignClosed mirrors the org-share closeout gate (decideOrgShareChange
 * in lib/fundraiserOrgShare.ts): once a fundraiser is financially closed,
 * changing the denominator would retroactively rewrite what "on track" meant
 * during a campaign that has already ended.
 *
 * Changing the goal can NEVER alter the numerator — totalBundlesSold is
 * always derived independently from order items, never from bundle_goal —
 * so this function only ever decides the denominator.
 */
export function decideBundleGoalChange(input: {
    requested: unknown;
    campaignClosed: boolean;
}): BundleGoalChangeDecision {
    const { requested, campaignClosed } = input;

    // Omission is not a change — the existing goal (or default) stands.
    if (requested === undefined || requested === null || requested === '') {
        return { change: false };
    }

    if (campaignClosed) {
        return {
            change: false,
            rejected: true,
            status: 409,
            error: 'This fundraiser has been closed out. The bundle goal is locked and can no longer be changed.',
        };
    }

    const parsed = parseBundleGoal(requested);
    if (!parsed.ok) {
        return { change: false, rejected: true, status: 400, error: parsed.error };
    }

    return { change: true, goal: parsed.goal };
}

/** Narrowing helper so route code reads plainly. */
export function isBundleGoalRejected(
    d: BundleGoalChangeDecision
): d is { change: false; rejected: true; status: 409 | 400; error: string } {
    return (d as any).rejected === true;
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
    /**
     * FR-SHARE-COPY-1 addendum: the organization's ACTUAL money raised —
     * totalSales × THIS CAMPAIGN'S configured org_share_percent (INV-A,
     * lib/fundraiserOrgShare.organizationShareAmount), never the
     * ESTIMATED_FUNDRAISER_ORG_SHARE guess above. Null when the caller did
     * not supply orgSharePercent — those callers get no fabricated number
     * rather than a silently wrong one.
     */
    raisedAmount: number | null;
}

/**
 * Computes the full fundraiser progress from campaign data.
 *
 * @param bundleGoalInput  - campaign.bundle_goal (target number of bundles)
 * @param totalSales       - campaign.total_sales (dollar value, for earnings calc)
 * @param orders           - orders with nested items[] for weighted bundle math
 * @param orgSharePercent  - campaign.org_share_percent (INV-A), for the REAL
 *                           raisedAmount. Omit only when the caller genuinely
 *                           has no campaign-specific rate to hand in.
 */
export function computeFundraiserProgress(
    bundleGoalInput: number | string | null | undefined,
    totalSales: number | string | null | undefined,
    orders: OrderForMetrics[] = [],
    orgSharePercent?: number | string | null
): FundraiserProgressResult {
    const bundleGoal = resolveBundleGoal(bundleGoalInput);
    const dollarSales = Number(totalSales) || 0;

    // Sum weighted bundles across all order items
    const totalBundlesSold = orders.reduce((acc, order) => {
        return acc + computeBundleUnitsFromItems(order.items || []);
    }, 0);

    const progressPercent = Math.min((totalBundlesSold / bundleGoal) * 100, 100);

    // Fundraiser earnings: 20% of total dollar sales
    // (from raise-funds page: "Your organization keeps 20% of the proceeds")
    const estimatedEarnings = dollarSales * ESTIMATED_FUNDRAISER_ORG_SHARE;

    const raisedAmount = orgSharePercent === undefined || orgSharePercent === null
        ? null
        : organizationShareAmount(dollarSales, Number(orgSharePercent));

    return {
        totalBundlesSold,
        bundleGoal,
        progressPercent,
        estimatedEarnings,
        totalSales: dollarSales,
        raisedAmount,
    };
}

/**
 * Formats a bundle count for display (e.g., 5 → "5", 5.5 → "5.5")
 */
export function formatBundleCount(count: number): string {
    return count % 1 === 0 ? count.toFixed(0) : count.toFixed(1);
}
