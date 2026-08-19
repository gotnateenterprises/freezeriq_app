/**
 * GE-3 — Campaign health & at-risk signals.
 *
 * WHAT THIS IS: a pure, deterministic read-only rule set that answers one
 * question — "which active fundraiser needs attention, and why?" — from facts
 * the database already holds. No schema, no cron, no email, no mutation.
 *
 * THREE KINDS OF STATEMENT, kept strictly apart:
 *
 *   FACTUAL METRICS — `metrics`. Observations, nothing more: order count,
 *               campaign age, days since the last order, coordinator actions,
 *               elapsed fraction, progress fraction. No judgement attached.
 *   HEURISTIC REASONS — `reasons`. EVERY reason is a heuristic, including the
 *               ones whose inputs are hard facts. That a campaign has had no
 *               order for nine days is a fact; that nine days is worth the
 *               tenant's attention is a threshold WE chose. Marking such a
 *               reason "factual" would quietly lend our chosen threshold the
 *               authority of an observation, so `kind` admits only 'heuristic'.
 *   PREDICTION— a claim about the future ("likely to miss goal"). NOT MADE HERE.
 *               Linear pace is a rough yardstick, not a forecast: fundraisers
 *               routinely spike near the deadline, so extrapolating current
 *               pace into a predicted outcome would be dressed-up guessing.
 *
 * PROGRESS IS MEASURED IN WEIGHTED BUNDLE UNITS, NOT DOLLARS. FR-LAUNCH-1C-1
 * made weighted order items the single canonical progress source and explicitly
 * forbade deriving progress from denormalized dollars (`total_sales`) or
 * `goal_amount`. The GE handoff's pace formula (`bundle_goal × $125`) would
 * reintroduce a dollar conversion through a $125 constant that has no
 * authoritative home in this repository — the only occurrences are inline JSX
 * literals in StartFundraiserWizard and a default price suggestion in
 * BundleEditor, neither of which is a shared, tenant-independent business
 * constant. So pace here compares weighted bundles sold against `bundle_goal`,
 * which is unit-consistent and needs no invented constant.
 *
 * For the same reason the handoff's "trending below the $1,250 delivery
 * minimum" reason is NOT implemented: `$1,250` has no authoritative source
 * either. It can be added the moment a real, tenant-aware minimum exists.
 */

export type CampaignHealth =
    /** Not evaluated — closed, settled, or missing the timeline to judge. */
    | 'not_applicable'
    /** Too little information yet to say anything honest. */
    | 'no_signal'
    /** Tracking against goal with no adverse signal. */
    | 'on_pace'
    /** Exactly one adverse signal — worth a look, not yet alarming. */
    | 'watch'
    /** Several adverse signals at once. */
    | 'at_risk';

export interface CampaignHealthReason {
    /** Stable machine key, safe for tests and future filtering. */
    code:
        | 'no_orders_yet'
        | 'behind_pace'
        | 'no_recent_orders'
        | 'no_coordinator_activity'
        | 'bundle_selection_pending';
    /**
     * Plain sentence shown to the tenant. It reports the OBSERVATION
     * ("No orders in the last 9 days"), never an outcome.
     */
    label: string;
    /**
     * Always `'heuristic'`.
     *
     * Every reason is a threshold judgement, even when its inputs are hard
     * facts. "No orders for 9 days" is a fact; deciding that 7 days is the
     * point where it deserves the tenant's attention is a choice we made.
     * Calling such a reason "factual" would lend a chosen threshold the
     * authority of an observation — so the type permits only one value, and
     * the facts themselves live in `metrics` where they belong.
     */
    kind: 'heuristic';
}

export interface CampaignHealthMetrics {
    /** 0..1 of the campaign window that has passed. null when unknowable. */
    elapsedFraction: number | null;
    /** 0..1 of the bundle goal achieved. null when there is no usable goal. */
    progressFraction: number | null;
    /** Whole days until end_date; negative once the window has closed. */
    daysRemaining: number | null;
    /** Whole days since the most recent order; null when there are none. */
    daysSinceLastOrder: number | null;
    orderCount: number;
    coordinatorActionCount: number;
}

export interface CampaignHealthResult {
    health: CampaignHealth;
    reasons: CampaignHealthReason[];
    metrics: CampaignHealthMetrics;
}

export interface CampaignHealthInput {
    status: string;
    closed_at: Date | null;
    created_at: Date;
    start_date: Date | null;
    end_date: Date | null;
    /** Canonical weighted units sold — see computeBundleUnitsFromItems. */
    weightedBundlesSold: number;
    bundle_goal: number | null;
    orderCount: number;
    lastOrderAt: Date | null;
    coordinatorActionCount: number;
    bundle_selection_status: string | null;
    bundle_selection_at: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * Statuses that mean the campaign is finished. Taken from the existing
 * behaviour in `CampaignCard` and the fundraisers list, so GE-3 cannot disagree
 * with what the rest of the app already calls closed.
 */
export const CLOSED_CAMPAIGN_STATUSES = ['Closed', 'Settled', 'Completed', 'Archived'] as const;

/** Thresholds, in one place, so every heuristic is inspectable and testable. */
export const HEALTH_THRESHOLDS = {
    /** Grace period before silence counts against a campaign. GE handoff. */
    quietStartDays: 3,
    /** Days without an order before it is worth surfacing. GE handoff. */
    staleOrderDays: 7,
    /** Share of expected pace below which a campaign reads as behind. GE handoff. */
    behindPaceRatio: 0.5,
    /** Days a coordinator's bundle choice may sit pending. GE handoff CB hook. */
    bundleSelectionPendingDays: 5,
} as const;

const wholeDaysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/**
 * Health for one campaign at one instant.
 *
 * `now` is injected rather than read from the clock so results are reproducible
 * and every boundary is testable.
 */
export function evaluateCampaignHealth(c: CampaignHealthInput, now: Date): CampaignHealthResult {
    const emptyMetrics: CampaignHealthMetrics = {
        elapsedFraction: null,
        progressFraction: null,
        daysRemaining: null,
        daysSinceLastOrder: null,
        orderCount: c.orderCount ?? 0,
        coordinatorActionCount: c.coordinatorActionCount ?? 0,
    };

    // ── Applicability ────────────────────────────────────────────────────────
    // A finished campaign is a record, not a thing to worry about.
    if (c.closed_at || CLOSED_CAMPAIGN_STATUSES.includes(c.status as never)) {
        return { health: 'not_applicable', reasons: [], metrics: emptyMetrics };
    }
    // Only running campaigns are judged. A Lead has not started.
    if (c.status !== 'Active') {
        return { health: 'not_applicable', reasons: [], metrics: emptyMetrics };
    }

    // ── Timeline ─────────────────────────────────────────────────────────────
    // The window opens at start_date when present, else at creation.
    const windowStart = c.start_date ?? c.created_at;
    const hasUsableWindow =
        c.end_date instanceof Date
        && !Number.isNaN(c.end_date.getTime())
        && windowStart instanceof Date
        && !Number.isNaN(windowStart.getTime())
        // An end before the start is corrupt data, not a zero-length campaign.
        && c.end_date.getTime() > windowStart.getTime();

    const totalMs = hasUsableWindow ? c.end_date!.getTime() - windowStart.getTime() : 0;
    const elapsedMs = hasUsableWindow ? Math.max(now.getTime() - windowStart.getTime(), 0) : 0;
    // totalMs > 0 is guaranteed by hasUsableWindow, so this cannot divide by zero.
    const elapsedFraction = hasUsableWindow ? Math.min(elapsedMs / totalMs, 1) : null;
    const daysRemaining = hasUsableWindow ? wholeDaysBetween(now, c.end_date!) : null;

    // ── Progress, in weighted bundle units ───────────────────────────────────
    const goal = Number(c.bundle_goal ?? 0);
    const sold = Number(c.weightedBundlesSold ?? 0);
    const hasUsableGoal = Number.isFinite(goal) && goal > 0;
    const progressFraction = hasUsableGoal && Number.isFinite(sold)
        ? Math.max(sold, 0) / goal
        : null;

    const daysSinceCampaignStart = wholeDaysBetween(windowStart, now);
    const daysSinceLastOrder = c.lastOrderAt ? wholeDaysBetween(c.lastOrderAt, now) : null;

    const metrics: CampaignHealthMetrics = {
        elapsedFraction,
        progressFraction,
        daysRemaining,
        daysSinceLastOrder,
        orderCount: c.orderCount ?? 0,
        coordinatorActionCount: c.coordinatorActionCount ?? 0,
    };

    // ── Reasons ──────────────────────────────────────────────────────────────
    const reasons: CampaignHealthReason[] = [];
    const pastGrace = daysSinceCampaignStart >= HEALTH_THRESHOLDS.quietStartDays;

    // FACTUAL: nothing has sold, and the campaign is past its opening days.
    if (metrics.orderCount === 0 && pastGrace) {
        reasons.push({
            code: 'no_orders_yet',
            kind: 'heuristic',
            label: `No orders yet after ${daysSinceCampaignStart} days`,
        });
    }

    // HEURISTIC: linear expectation. A yardstick, never a forecast.
    if (metrics.orderCount > 0 && elapsedFraction !== null && progressFraction !== null) {
        const expected = elapsedFraction;
        if (expected > 0 && progressFraction < expected * HEALTH_THRESHOLDS.behindPaceRatio) {
            reasons.push({
                code: 'behind_pace',
                kind: 'heuristic',
                label: `Sales are behind the current campaign pace (${Math.round(progressFraction * 100)}% of goal at ${Math.round(expected * 100)}% of the campaign window)`,
            });
        }
    }

    // FACTUAL: there were orders, then they stopped.
    if (daysSinceLastOrder !== null && daysSinceLastOrder >= HEALTH_THRESHOLDS.staleOrderDays) {
        reasons.push({
            code: 'no_recent_orders',
            kind: 'heuristic',
            label: `No orders in the last ${daysSinceLastOrder} days`,
        });
    }

    // FACTUAL: the coordinator has taken no recorded action at all.
    if (metrics.coordinatorActionCount === 0 && pastGrace) {
        reasons.push({
            code: 'no_coordinator_activity',
            kind: 'heuristic',
            label: `No coordinator activity recorded in ${daysSinceCampaignStart} days`,
        });
    }

    // FACTUAL: ordering stays locked until the coordinator chooses bundles.
    //
    // FR-FLOW-2B — the clock runs from `created_at`, not from `bundle_selection_at`.
    // `bundle_selection_at` is the moment the coordinator SUBMITTED a selection, so
    // it is null for exactly as long as the status is 'pending' and only becomes a
    // Date once the status has moved to 'selected'. Requiring both at once asked for
    // a campaign that had submitted and not submitted simultaneously, so this reason
    // — and the "Review bundle selection" next action that depends on it — could
    // never fire for anybody. A campaign has been waiting on its coordinator since
    // the moment it was created, which is what `created_at` measures.
    if (c.bundle_selection_status === 'pending') {
        const pendingDays = wholeDaysBetween(c.created_at, now);
        if (pendingDays >= HEALTH_THRESHOLDS.bundleSelectionPendingDays) {
            reasons.push({
                code: 'bundle_selection_pending',
                kind: 'heuristic',
                label: `Bundle selection has been pending for ${pendingDays} days`,
            });
        }
    }

    // ── Status ───────────────────────────────────────────────────────────────
    // Ordered so a campaign is never flattered. `watch` exists because a single
    // adverse signal is neither "at risk" nor honestly "on pace" — without it,
    // a campaign with a real warning would be shown as healthy.
    if (reasons.length >= 2) return { health: 'at_risk', reasons, metrics };
    if (reasons.length === 1) return { health: 'watch', reasons, metrics };

    // "On pace" is a positive claim, so it requires the evidence to support one:
    // a real goal, a real window, and actual sales. Anything less is no_signal.
    if (hasUsableGoal && elapsedFraction !== null && metrics.orderCount > 0) {
        return { health: 'on_pace', reasons: [], metrics };
    }
    return { health: 'no_signal', reasons: [], metrics };
}

/** Short, colour-independent label. Health must never be conveyed by hue alone. */
export function campaignHealthLabel(health: CampaignHealth): string {
    switch (health) {
        case 'at_risk': return 'Needs attention';
        case 'watch': return 'Worth a look';
        case 'on_pace': return 'On pace';
        case 'no_signal': return 'No signal yet';
        case 'not_applicable': return '';
    }
}
