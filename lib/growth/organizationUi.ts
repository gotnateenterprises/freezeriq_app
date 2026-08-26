/**
 * CRM-CC-3 — pure display logic for the Organizations tab.
 *
 * Extracted from OrganizationImpactTab so the sentences the tenant reads are
 * unit-testable the way this repo tests logic: no renderer, no fetches. GE-4's
 * value SEMANTICS live in lib/growth/impact.ts and are not restated here —
 * these functions only turn already-computed facts into words.
 */

export const money = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * Closed-out subtext, shown only when it tells the reader something new.
 * Never promoted to the headline: a group whose campaign is still running is
 * not worth $0, so lifetime stays primary and this stays context.
 *
 * ── FR-HISTORY-1: THE WORD "SETTLED" MOVED ──────────────────────────────────
 *
 * `settledSales` sums `FundraiserCampaign.settlement_total`, which closeout
 * freezes. That is CLOSED OUT, not PAID — and it predates INV-D, which gave
 * "settled" a second and much stronger meaning: money actually received, with a
 * method and a date. Two meanings of one word on the same screen is how an owner
 * ends up believing they have been paid when they have not.
 *
 * The figure is unchanged — it is a real and useful number — but the words now
 * say which fact it is. Payment truth lives on the invoice, and the campaign
 * card states it there.
 *
 * "none settled yet" was also actively misleading for Edgar and Coles: both were
 * genuinely paid outside FreezerIQ, and both read as though nothing had ever
 * been collected because closeout never ran on them.
 */
export function settledNote(r: { lifetimeFundraiserSales: number; settledSales: number }): string | null {
    if (r.lifetimeFundraiserSales <= 0) return null;
    if (r.settledSales >= r.lifetimeFundraiserSales) return 'all closed out';
    if (r.settledSales <= 0) return 'none closed out yet';
    return `${money(r.settledSales)} closed out`;
}

/** "3 months ago" style, from a factual day count. */
export function sinceLabel(days: number | null): string {
    if (days === null) return 'No campaigns yet';
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 60) return `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 24) return `${months} months ago`;
    return `${Math.round(days / 365)} years ago`;
}

export interface LastFundraiserDisplay {
    /** Campaign name when known; null keeps the line quiet, never "No name". */
    name: string | null;
    /** Relative recency line, always present when any history exists. */
    when: string;
}

/**
 * WHAT was the last fundraiser, and WHEN. Name + date beats a bare dollar or
 * a vague activity label; a missing name degrades to the date alone rather
 * than a placeholder.
 */
export function lastFundraiserDisplay(r: {
    lastCampaignName?: string | null;
    daysSinceLastCampaign: number | null;
}): LastFundraiserDisplay | null {
    if (r.daysSinceLastCampaign === null) return null;
    return {
        name: r.lastCampaignName?.trim() ? r.lastCampaignName.trim() : null,
        when: sinceLabel(r.daysSinceLastCampaign),
    };
}
