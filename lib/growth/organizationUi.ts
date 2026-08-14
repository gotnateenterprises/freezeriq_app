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
 * Settled subtext, shown only when it tells the reader something new.
 * Never promoted to the headline: a group whose campaign is still running is
 * not worth $0, so lifetime stays primary and settled stays context.
 */
export function settledNote(r: { lifetimeFundraiserSales: number; settledSales: number }): string | null {
    if (r.lifetimeFundraiserSales <= 0) return null;
    if (r.settledSales >= r.lifetimeFundraiserSales) return 'all settled';
    if (r.settledSales <= 0) return 'none settled yet';
    return `${money(r.settledSales)} settled`;
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
