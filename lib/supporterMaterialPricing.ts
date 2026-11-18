/**
 * FLYER-TAX-TOTAL-1 — the supporter-facing price printed on fundraiser materials.
 *
 * The printable flyer, the CRM flyer, the coordinator packet and the promo scripts printed the
 * raw, pre-tax `bundles.price`. Supporter checkout adds the campaign's frozen food tax
 * (FR-TAX-CORRECTNESS-1), so on a 1% taxable campaign the flyer said $125.00 and checkout
 * charged $126.25 for the same bundle. Paper cannot be hotfixed, and a flyer is the price the
 * supporter remembers.
 *
 * NO SECOND TAX FORMULA. Every number here comes from computeSupporterOrderTax — the exact
 * function both supporter order writers charge with — fed the campaign's FROZEN snapshot
 * (tax_status + tax_rate_percent), never the organization's live status and never a constant.
 * So the legacy rules are inherited, not restated:
 *
 *   no snapshot (tax_status NULL)  → base price, no note
 *   TAX_EXEMPT                     → base price, no note
 *   TAXABLE with rate ≤ 0 / unset  → base price, no note
 *   TAXABLE with rate > 0          → base + roundCents(base × rate), plus the note
 *
 * ONE BUNDLE AT A TIME. Checkout rounds once per ORDER, on the subtotal. A per-bundle price is
 * that same calculation for a one-bundle order, which is what a flyer line advertises. At
 * fractional rates a multi-bundle order can differ from the sum of the printed lines by a cent;
 * at whole-dollar prices and 1% it cannot.
 *
 * The supporter order page's bundle cards are deliberately NOT routed through this: they keep
 * the base price, with the tax disclosed in the order summary before submit (owner decision).
 */

import { computeSupporterOrderTax, formatTaxRate, type OrgTaxStatus } from '@/lib/fundraiserTax';

/** The campaign columns that carry its frozen tax treatment. Prisma Decimal, number or string. */
export interface CampaignTaxFields {
    tax_status?: string | null;
    tax_rate_percent?: unknown;
}

function snapshotOf(campaign: CampaignTaxFields | null | undefined) {
    return {
        status: (campaign?.tax_status ?? null) as OrgTaxStatus | null,
        ratePercent: (campaign?.tax_rate_percent ?? null) as number | string | null,
    };
}

/** What one supporter pays for one bundle at this campaign: base price plus the frozen tax. */
export function supporterBundlePrice(basePrice: number, campaign: CampaignTaxFields | null | undefined): number {
    return computeSupporterOrderTax({ subtotal: basePrice, snapshot: snapshotOf(campaign) }).total;
}

/** The frozen rate checkout applies to this campaign, as a percent; 0 when no tax applies. */
export function supporterTaxRatePercent(campaign: CampaignTaxFields | null | undefined): number {
    return computeSupporterOrderTax({ subtotal: 0, snapshot: snapshotOf(campaign) }).ratePercent;
}

/** "Prices include 1% sales tax." — or null when no tax applies (nothing printed). */
export function salesTaxIncludedNote(ratePercent: number | null | undefined): string | null {
    const rate = Number(ratePercent);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return `Prices include ${formatTaxRate(rate)} sales tax.`;
}

/**
 * Re-price validated material bundles (lib/coordinatorMaterialBundles.resolveMaterialBundles
 * output) at the supporter-facing price, and report the rate so the renderer can print the note.
 * Every material route calls this one function; none prices on its own.
 */
export function priceMaterialBundlesForSupporters<T extends { price: number }>(
    bundles: readonly T[],
    campaign: CampaignTaxFields | null | undefined,
): { bundles: T[]; taxRatePercent: number } {
    return {
        bundles: bundles.map((b) => ({ ...b, price: supporterBundlePrice(b.price, campaign) })),
        taxRatePercent: supporterTaxRatePercent(campaign),
    };
}
