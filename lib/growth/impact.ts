/**
 * GE-4 — Fundraiser impact & organization lifetime value.
 *
 * Answers "how much fundraiser business has this group generated for us?" from
 * data that already exists. Pure, deterministic, no database access, no schema,
 * no prediction.
 *
 * ── TWO DIFFERENT NUMBERS, NEVER INTERCHANGED ────────────────────────────────
 * GE-4 reports two separate factual amounts, because collapsing them is how a
 * screen ends up lying:
 *
 *   lifetimeFundraiserSales — eligible campaign-linked gross sales this group
 *       has generated TO DATE, including campaigns that are still running. An
 *       order that has been placed and not canceled is real revenue activity
 *       whether or not an admin has gotten around to closing the campaign.
 *
 *   settledSales — the subset that has passed through formal closeout and been
 *       frozen into `FundraiserCampaign.settlement_total`.
 *
 * Both are GROSS — what buyers paid — never what the group kept and never
 * tenant profit. Hence "sales" everywhere, never "raised".
 *
 * ── WHY LIFETIME IS NOT SETTLED-ONLY ─────────────────────────────────────────
 * An earlier revision counted settled campaigns only. Against real Production
 * data that rendered EVERY organization as $0 while ~$9.2k of eligible orders
 * sat on campaigns nobody had closed yet — arithmetically defensible and
 * commercially useless. Closeout does not create value; it freezes value that
 * already exists. So live campaigns contribute to lifetime sales, and closeout
 * moves that same money into `settledSales` without changing the lifetime
 * figure.
 *
 * ── ELIGIBILITY IS BORROWED, NOT INVENTED ────────────────────────────────────
 * The closeout route computes a settlement as the sum of `Order.total_amount`
 * over `{ campaign_id, canceled_at: null }` — no status filter, because
 * `OrderStatus` has no canceled member; cancellation is the soft-delete
 * `canceled_at`, and no refund column exists anywhere on `Order`. GE-4 applies
 * that identical rule to open campaigns. That is deliberate: it makes a
 * campaign's contribution CONTINUOUS across closeout, so a number never jumps
 * on the day someone happens to click Close.
 *
 * ── THE ORGANIZATION'S OWN TAKE ──────────────────────────────────────────────
 * An ESTIMATE at the single global rate in `ESTIMATED_FUNDRAISER_ORG_SHARE`,
 * reused rather than redefined here. That rate comes from tenant-facing
 * marketing copy, is not per-tenant configurable, and has never been reconciled
 * against a real payout — which is exactly why everything built on it stays
 * labelled "estimated".
 *
 * ── IDENTITY ─────────────────────────────────────────────────────────────────
 * An organization is a `Customer` row. Contacts relate to organizations
 * many-to-many, so one person can represent several groups and one shared inbox
 * several people — aggregating by contact or email would silently merge
 * unrelated fundraisers. Aggregation happens by customer id, and tenant
 * ownership rides on `Customer.business_id`, never on client input.
 */

import { ESTIMATED_FUNDRAISER_ORG_SHARE } from '@/lib/fundraiserMetrics';

/**
 * One campaign-linked order, reduced to the only two things that decide whether
 * its money counts.
 */
export interface ImpactOrderInput {
    total_amount: number | string | null;
    /** Soft-delete marker. Non-null means canceled and therefore ineligible. */
    canceled_at: Date | null;
}

/**
 * A campaign as GE-4 needs it. Deliberately narrow: whatever is not here cannot
 * accidentally influence a lifetime figure.
 */
export interface ImpactCampaignInput {
    id: string;
    status: string;
    closed_at: Date | null;
    created_at: Date;
    /** Frozen gross sales; null until the campaign has been closed out. */
    settlement_total: number | null;
    /**
     * CRM-CC-3 — display only. Lets the Organizations tab say WHICH fundraiser
     * was last, not just when. Optional so existing callers keep compiling; it
     * never influences any money figure.
     */
    name?: string | null;
    /** Eligible + ineligible orders on this campaign; GE-4 does the filtering. */
    orders?: ImpactOrderInput[];
}

export interface ImpactOrganizationInput {
    organizationId: string;
    organizationName: string;
    campaigns: ImpactCampaignInput[];
}

export interface OrganizationImpact {
    organizationId: string;
    organizationName: string;
    /** Real campaigns, excluding never-started Lead placeholders. */
    campaignCount: number;
    /** Campaigns whose money has been frozen by closeout. */
    settledCampaignCount: number;
    /** Campaigns still running. */
    activeCampaignCount: number;
    /**
     * Eligible campaign-linked GROSS sales to date, open campaigns included.
     * The primary answer to "what is this group worth to us?".
     */
    lifetimeFundraiserSales: number;
    /** The subset of the above that closeout has already frozen. */
    settledSales: number;
    /**
     * Estimated organization share of `lifetimeFundraiserSales`. An estimate at
     * a global rate — never a payout, never a settled amount.
     */
    estimatedGroupEarnings: number;
    /** Mean eligible gross per real campaign; null when there are none. */
    averageCampaignSales: number | null;
    /** Largest single campaign by eligible gross; null when there are none. */
    bestCampaignSales: number | null;
    firstCampaignAt: Date | null;
    lastCampaignAt: Date | null;
    /** Name of the most recent real campaign, when the caller supplied names. */
    lastCampaignName: string | null;
    daysSinceLastCampaign: number | null;
    /** True once a group has more than one real campaign — a fact, not a forecast. */
    isRepeatOrganization: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Statuses that mean "this was never a real campaign".
 *
 * `Lead` is a placeholder the campaigns list invents for an organization with no
 * campaign yet, so counting it would credit groups with fundraisers that never
 * happened.
 */
export const NON_CAMPAIGN_STATUSES = ['Lead'] as const;

/** Statuses the rest of the app already treats as finished. */
export const HISTORICAL_CAMPAIGN_STATUSES = ['Closed', 'Settled', 'Completed', 'Archived'] as const;

/**
 * THE single inclusion rule for GE-4 history, so no screen can quietly disagree
 * with another about what counts.
 */
export function isRealCampaign(c: Pick<ImpactCampaignInput, 'status'>): boolean {
    return !NON_CAMPAIGN_STATUSES.includes(c.status as never);
}

/**
 * Whether an order's money counts.
 *
 * Mirrors the closeout route exactly: not canceled, and a usable amount. There
 * is intentionally NO status test — `OrderStatus` has no canceled member, so a
 * status filter here would silently drop legitimate revenue.
 */
export function isEligibleOrder(o: ImpactOrderInput): boolean {
    if (o.canceled_at !== null && o.canceled_at !== undefined) return false;
    const amount = Number(o.total_amount ?? 0);
    return Number.isFinite(amount) && amount >= 0;
}

/** Eligible gross for one campaign, computed the way closeout computes it. */
export function computeCampaignGross(c: ImpactCampaignInput): number {
    return (c.orders ?? [])
        .filter(isEligibleOrder)
        .reduce((sum, o) => sum + Number(o.total_amount ?? 0), 0);
}

/**
 * Whether closeout has frozen this campaign's money.
 *
 * Keyed on the frozen settlement rather than on status: status strings drift and
 * are hand-edited, but a non-null `settlement_total` means closeout actually ran
 * and the figure will not move again.
 */
export function hasCountableValue(c: Pick<ImpactCampaignInput, 'settlement_total'>): boolean {
    return c.settlement_total !== null
        && Number.isFinite(Number(c.settlement_total))
        && Number(c.settlement_total) >= 0;
}

/** A campaign that is still running and taking orders. */
export function isActiveCampaign(c: Pick<ImpactCampaignInput, 'status' | 'closed_at'>): boolean {
    return c.status === 'Active' && !c.closed_at;
}

/**
 * The eligible gross a single campaign contributes to lifetime sales.
 *
 * Settled campaigns report their FROZEN figure, not a recount of their orders.
 * Two reasons: the frozen number is the one the tenant was shown at closeout and
 * may have already acted on, and recounting would let a later order edit
 * retroactively rewrite settled history. Open campaigns have nothing frozen, so
 * their live orders are summed with the same rule closeout will use.
 */
export function campaignLifetimeContribution(c: ImpactCampaignInput): number {
    return hasCountableValue(c) ? Number(c.settlement_total) : computeCampaignGross(c);
}

const wholeDaysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/**
 * Lifetime impact for ONE organization.
 *
 * `now` is injected so "days since" is reproducible and testable rather than
 * dependent on when the suite happens to run.
 */
export function computeOrganizationImpact(org: ImpactOrganizationInput, now: Date): OrganizationImpact {
    const real = (org.campaigns ?? []).filter(isRealCampaign);
    const settled = real.filter(hasCountableValue);

    // Per-campaign contributions, each counted exactly once: a settled campaign
    // supplies its frozen settlement OR its live orders, never both.
    const contributions = real.map(campaignLifetimeContribution);

    const lifetimeFundraiserSales = contributions.reduce((sum, v) => sum + v, 0);
    const settledSales = settled.reduce((sum, c) => sum + Number(c.settlement_total), 0);

    // Dated campaigns, oldest → newest. Kept as whole campaigns (not bare
    // dates) so the newest one can also supply its NAME for display.
    const dated = real
        .filter((c): c is typeof c & { created_at: Date } =>
            c.created_at instanceof Date && !Number.isNaN(c.created_at.getTime()))
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    const newest = dated.length ? dated[dated.length - 1] : null;
    const lastCampaignAt = newest ? newest.created_at : null;

    return {
        organizationId: org.organizationId,
        organizationName: org.organizationName,
        campaignCount: real.length,
        settledCampaignCount: settled.length,
        activeCampaignCount: real.filter(isActiveCampaign).length,
        lifetimeFundraiserSales,
        settledSales,
        estimatedGroupEarnings: lifetimeFundraiserSales * ESTIMATED_FUNDRAISER_ORG_SHARE,
        // Averaged over every REAL campaign now that open campaigns carry value.
        // Averaging over settled-only would divide a group's full lifetime by a
        // smaller denominator and overstate its typical campaign.
        averageCampaignSales: real.length ? lifetimeFundraiserSales / real.length : null,
        bestCampaignSales: contributions.length ? Math.max(...contributions) : null,
        firstCampaignAt: dated.length ? dated[0].created_at : null,
        lastCampaignAt,
        lastCampaignName: newest?.name?.trim() ? newest.name.trim() : null,
        daysSinceLastCampaign: lastCampaignAt ? wholeDaysBetween(lastCampaignAt, now) : null,
        isRepeatOrganization: real.length > 1,
    };
}

/**
 * Rank organizations by a single FACTUAL measure.
 *
 * No weighted composite and no "most likely to rebook" — a blended score would
 * read as insight while hiding the arithmetic, and a likelihood claim is a
 * prediction GE-4 has no basis to make. Ties break on name so the order is
 * stable between requests.
 */
export type ImpactSort = 'lifetime_sales' | 'most_recent' | 'campaign_count';

export function sortOrganizationImpacts(rows: OrganizationImpact[], sort: ImpactSort): OrganizationImpact[] {
    const byName = (a: OrganizationImpact, b: OrganizationImpact) =>
        a.organizationName.localeCompare(b.organizationName);

    return [...rows].sort((a, b) => {
        if (sort === 'campaign_count') return (b.campaignCount - a.campaignCount) || byName(a, b);
        if (sort === 'most_recent') {
            // Organizations that have never run a campaign sort last, not first.
            const at = a.lastCampaignAt?.getTime() ?? -Infinity;
            const bt = b.lastCampaignAt?.getTime() ?? -Infinity;
            return (bt - at) || byName(a, b);
        }
        // 'lifetime_sales' sorts on the PRIMARY metric — eligible gross to date,
        // not the settled-only subset.
        return (b.lifetimeFundraiserSales - a.lifetimeFundraiserSales) || byName(a, b);
    });
}
