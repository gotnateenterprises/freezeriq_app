/**
 * GE-3 — campaign health rules.
 *
 * Health drives what a tenant chooses to worry about, so the danger here is not
 * a crash — it is a campaign that is quietly in trouble being shown as fine, or
 * a healthy one being called at risk. Every threshold and every boundary is
 * pinned, and the module is asserted to make no predictive claim.
 */

import {
    evaluateCampaignHealth,
    campaignHealthLabel,
    HEALTH_THRESHOLDS,
    CLOSED_CAMPAIGN_STATUSES,
    type CampaignHealthInput,
} from '@/lib/growth/health';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

/** A healthy baseline: 20-day window, half elapsed, half the goal sold. */
const campaign = (over: Partial<CampaignHealthInput> = {}): CampaignHealthInput => ({
    status: 'Active',
    closed_at: null,
    created_at: daysAgo(10),
    start_date: daysAgo(10),
    end_date: daysAhead(10),
    weightedBundlesSold: 50,
    bundle_goal: 100,
    orderCount: 12,
    lastOrderAt: daysAgo(1),
    coordinatorActionCount: 4,
    bundle_selection_status: 'not_required',
    bundle_selection_at: null,
    ...over,
});

const run = (over: Partial<CampaignHealthInput> = {}) => evaluateCampaignHealth(campaign(over), NOW);
const codes = (over: Partial<CampaignHealthInput> = {}) => run(over).reasons.map(r => r.code);

describe('1. applicability', () => {
    it.each(CLOSED_CAMPAIGN_STATUSES)('a %s campaign is not evaluated', (status) => {
        expect(run({ status }).health).toBe('not_applicable');
    });

    it('a campaign with closed_at is not evaluated even if status still says Active', () => {
        expect(run({ closed_at: daysAgo(1) }).health).toBe('not_applicable');
    });

    it('a Lead has not started, so it is not judged', () => {
        expect(run({ status: 'Lead' }).health).toBe('not_applicable');
    });

    it('a closed campaign reports no reasons at all', () => {
        expect(run({ status: 'Closed', orderCount: 0, coordinatorActionCount: 0 }).reasons).toEqual([]);
    });
});

describe('2. the healthy baseline', () => {
    it('is on pace with no reasons', () => {
        const r = run();
        expect(r.health).toBe('on_pace');
        expect(r.reasons).toEqual([]);
    });

    it('reports the factual metrics behind the verdict', () => {
        const m = run().metrics;
        expect(m.progressFraction).toBeCloseTo(0.5, 5);
        expect(m.elapsedFraction).toBeCloseTo(0.5, 5);
        expect(m.daysRemaining).toBe(10);
        expect(m.daysSinceLastOrder).toBe(1);
        expect(m.orderCount).toBe(12);
    });
});

describe('3. "on pace" is a positive claim and must be earned', () => {
    it('is NOT claimed merely because sales exist — a real goal is required', () => {
        expect(run({ bundle_goal: null }).health).toBe('no_signal');
        expect(run({ bundle_goal: 0 }).health).toBe('no_signal');
    });

    it('is NOT claimed without a usable timeline', () => {
        expect(run({ end_date: null }).health).toBe('no_signal');
    });

    it('is NOT claimed when there are no orders at all', () => {
        // Inside the grace period, so silence raises no reason yet.
        expect(run({ created_at: NOW, start_date: NOW, orderCount: 0, lastOrderAt: null }).health).toBe('no_signal');
    });
});

describe('4. each reason fires on its own', () => {
    it('no_orders_yet — past the grace period with nothing sold', () => {
        const r = run({
            orderCount: 0, lastOrderAt: null, weightedBundlesSold: 0,
            start_date: daysAgo(HEALTH_THRESHOLDS.quietStartDays), created_at: daysAgo(HEALTH_THRESHOLDS.quietStartDays),
        });
        expect(r.reasons.map(x => x.code)).toContain('no_orders_yet');
    });

    it('behind_pace — halfway through the window with far too little sold', () => {
        expect(codes({ weightedBundlesSold: 10 })).toContain('behind_pace');
    });

    it('no_recent_orders — sales happened, then stopped', () => {
        expect(codes({ lastOrderAt: daysAgo(HEALTH_THRESHOLDS.staleOrderDays) })).toContain('no_recent_orders');
    });

    it('no_coordinator_activity — nothing recorded from the coordinator', () => {
        expect(codes({ coordinatorActionCount: 0 })).toContain('no_coordinator_activity');
    });

    it('bundle_selection_pending — ordering is still locked', () => {
        expect(codes({
            bundle_selection_status: 'pending',
            // FR-FLOW-2B: null, exactly as a pending campaign really is.
            bundle_selection_at: null,
        })).toContain('bundle_selection_pending');
    });
});

describe('5. threshold boundaries', () => {
    it('stale orders fire exactly ON the threshold, not before', () => {
        expect(codes({ lastOrderAt: daysAgo(HEALTH_THRESHOLDS.staleOrderDays - 1) })).not.toContain('no_recent_orders');
        expect(codes({ lastOrderAt: daysAgo(HEALTH_THRESHOLDS.staleOrderDays) })).toContain('no_recent_orders');
    });

    it('the quiet-start grace period holds until its final day', () => {
        const quiet = { orderCount: 0, lastOrderAt: null, weightedBundlesSold: 0, coordinatorActionCount: 0 };
        const inGrace = HEALTH_THRESHOLDS.quietStartDays - 1;
        expect(codes({ ...quiet, created_at: daysAgo(inGrace), start_date: daysAgo(inGrace) })).not.toContain('no_orders_yet');
        expect(codes({
            ...quiet,
            created_at: daysAgo(HEALTH_THRESHOLDS.quietStartDays),
            start_date: daysAgo(HEALTH_THRESHOLDS.quietStartDays),
        })).toContain('no_orders_yet');
    });

    it('bundle selection is patient until its threshold', () => {
        // FR-FLOW-2B — the clock runs from created_at, not bundle_selection_at.
        // This test used to vary bundle_selection_at, which is null for exactly as
        // long as the status is 'pending' and only becomes a Date once the status
        // has moved to 'selected'. The pair it was constructing could not occur, so
        // the reason it pinned could never fire for a real campaign.
        const pending = { bundle_selection_status: 'pending' as const, bundle_selection_at: null };
        const justUnder = HEALTH_THRESHOLDS.bundleSelectionPendingDays - 1;
        expect(codes({ ...pending, created_at: daysAgo(justUnder), start_date: daysAgo(justUnder) }))
            .not.toContain('bundle_selection_pending');
        expect(codes({
            ...pending,
            created_at: daysAgo(HEALTH_THRESHOLDS.bundleSelectionPendingDays),
            start_date: daysAgo(HEALTH_THRESHOLDS.bundleSelectionPendingDays),
        })).toContain('bundle_selection_pending');
    });

    it('fires for a campaign awaiting coordinator setup, which never has a selection timestamp', () => {
        // Exactly the row FR-FLOW-2 writes: pending, and bundle_selection_at null.
        expect(codes({
            bundle_selection_status: 'pending',
            bundle_selection_at: null,
            created_at: daysAgo(HEALTH_THRESHOLDS.bundleSelectionPendingDays),
            start_date: daysAgo(HEALTH_THRESHOLDS.bundleSelectionPendingDays),
        })).toContain('bundle_selection_pending');
    });

    it('behind_pace fires just below the ratio and not just above it', () => {
        // Half the window elapsed → expected 0.5; the trigger is below 0.25.
        expect(codes({ weightedBundlesSold: 26 })).not.toContain('behind_pace');
        expect(codes({ weightedBundlesSold: 24 })).toContain('behind_pace');
    });
});

describe('6. status semantics — a warned campaign is never flattered', () => {
    // APPROVED PRODUCT RULING: `watch` is the truthful neutral state between
    // on_pace and at_risk. A campaign with one legitimate warning must never be
    // labelled on_pace. These pin all five supported states.
    it('supports exactly the five approved states', () => {
        const seen = new Set<string>();
        seen.add(run({ status: 'Closed' }).health);                                    // not_applicable
        seen.add(run({ bundle_goal: null }).health);                                   // no_signal
        seen.add(run().health);                                                        // on_pace
        seen.add(run({ coordinatorActionCount: 0 }).health);                           // watch
        seen.add(run({ coordinatorActionCount: 0, lastOrderAt: daysAgo(30) }).health); // at_risk
        expect([...seen].sort()).toEqual(['at_risk', 'no_signal', 'not_applicable', 'on_pace', 'watch']);
    });

    it('"watch" is a real, reachable state carrying its single reason', () => {
        const r = run({ coordinatorActionCount: 0 });
        expect(r.health).toBe('watch');
        expect(r.reasons).toHaveLength(1);
        expect(campaignHealthLabel('watch')).toBe('Worth a look');
    });

    it('one reason is "watch", not "on pace"', () => {
        const r = run({ coordinatorActionCount: 0 });
        expect(r.reasons).toHaveLength(1);
        expect(r.health).toBe('watch');
        expect(r.health).not.toBe('on_pace');
    });

    it('two or more reasons is "at risk"', () => {
        const r = run({ coordinatorActionCount: 0, lastOrderAt: daysAgo(30) });
        expect(r.reasons.length).toBeGreaterThanOrEqual(2);
        expect(r.health).toBe('at_risk');
    });

    it('every health state has a text label, so colour is never the only signal', () => {
        expect(campaignHealthLabel('at_risk')).toBe('Needs attention');
        expect(campaignHealthLabel('watch')).toBe('Worth a look');
        expect(campaignHealthLabel('on_pace')).toBe('On pace');
        expect(campaignHealthLabel('no_signal')).toBe('No signal yet');
    });
});

describe('7. pace math cannot break', () => {
    it('a same-day campaign does not divide by zero', () => {
        const r = run({ created_at: NOW, start_date: NOW, end_date: NOW });
        expect(r.metrics.elapsedFraction).toBeNull();
        expect(Number.isNaN(r.metrics.progressFraction as number)).toBe(false);
        expect(r.health).not.toBe('at_risk');
    });

    it('an end date before the start is treated as unusable, not as a finished campaign', () => {
        const r = run({ start_date: daysAgo(1), end_date: daysAgo(5) });
        expect(r.metrics.elapsedFraction).toBeNull();
        expect(codes({ start_date: daysAgo(1), end_date: daysAgo(5) })).not.toContain('behind_pace');
    });

    it('a zero or negative goal yields no progress fraction and no pace reason', () => {
        expect(run({ bundle_goal: 0 }).metrics.progressFraction).toBeNull();
        expect(run({ bundle_goal: -5 }).metrics.progressFraction).toBeNull();
        expect(codes({ bundle_goal: 0 })).not.toContain('behind_pace');
    });

    it('elapsed fraction is capped at 1 once the window has passed', () => {
        const r = run({ start_date: daysAgo(30), created_at: daysAgo(30), end_date: daysAgo(5) });
        expect(r.metrics.elapsedFraction).toBeLessThanOrEqual(1);
        expect(r.metrics.daysRemaining).toBeLessThan(0);
    });

    it('falls back to created_at when start_date is missing', () => {
        expect(run({ start_date: null }).metrics.elapsedFraction).toBeCloseTo(0.5, 5);
    });

    it('rejects a non-finite sold value outright rather than propagating NaN', () => {
        const r = run({ weightedBundlesSold: Number.NaN });
        // Guarded by Number.isFinite, so corrupt data yields "unknown", not NaN.
        expect(r.metrics.progressFraction).toBeNull();
        expect(r.reasons.map(x => x.code)).not.toContain('behind_pace');
    });
});

describe('8. determinism and honesty of output', () => {
    it('is a pure function of its inputs and the injected now', () => {
        const input = campaign();
        expect(evaluateCampaignHealth(input, NOW)).toEqual(evaluateCampaignHealth(input, NOW));
    });

    it('classifies EVERY reason as a heuristic, never as a bare fact', () => {
        // A threshold judgement is a choice, even when its inputs are facts.
        // Calling one "factual" would disguise our chosen cut-off as an
        // observation, so no reason may ever carry that label.
        const r = run({ weightedBundlesSold: 5, coordinatorActionCount: 0, lastOrderAt: daysAgo(30) });
        expect(r.reasons.length).toBeGreaterThan(0);
        for (const reason of r.reasons) {
            expect(reason.kind).toBe('heuristic');
        }
    });

    it('classifies each threshold reason individually as a heuristic', () => {
        const cases: [string, Partial<CampaignHealthInput>][] = [
            ['no_orders_yet', { orderCount: 0, lastOrderAt: null, weightedBundlesSold: 0 }],
            ['behind_pace', { weightedBundlesSold: 5 }],
            ['no_recent_orders', { lastOrderAt: daysAgo(30) }],
            ['no_coordinator_activity', { coordinatorActionCount: 0 }],
            ['bundle_selection_pending', { bundle_selection_status: 'pending', bundle_selection_at: null }],
        ];
        for (const [code, over] of cases) {
            const reason = run(over).reasons.find(x => x.code === code);
            expect(reason).toBeDefined();
            expect(reason!.kind).toBe('heuristic');
        }
    });

    it('keeps the FACTS in metrics, where no judgement is attached', () => {
        const m = run({ orderCount: 7, coordinatorActionCount: 2, lastOrderAt: daysAgo(4) }).metrics;
        // Plain observations — numbers, not verdicts.
        expect(m.orderCount).toBe(7);
        expect(m.coordinatorActionCount).toBe(2);
        expect(m.daysSinceLastOrder).toBe(4);
        expect(typeof m.elapsedFraction).toBe('number');
        expect(typeof m.progressFraction).toBe('number');
        expect(m).not.toHaveProperty('kind');
        expect(m).not.toHaveProperty('health');
    });

    it('makes no predictive claim in any reason text', () => {
        const r = run({ weightedBundlesSold: 1, coordinatorActionCount: 0, lastOrderAt: daysAgo(30), orderCount: 1 });
        const text = r.reasons.map(x => x.label).join(' ').toLowerCase();
        for (const forbidden of ['likely', 'will miss', 'predict', 'probability', 'forecast', 'expected to fail']) {
            expect(text).not.toContain(forbidden);
        }
    });

    it('does not emit an opaque numeric score', () => {
        expect(run()).not.toHaveProperty('score');
    });
});
