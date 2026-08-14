/**
 * CRM-CC-1 — campaign triage: priority category + truthful next action.
 *
 * The dangerous failure here is a wrong instruction: telling a tenant to act
 * on a finished campaign, nagging "Create invoice" about work that may be
 * done, surfacing a GE-7 capability that does not exist, or burying an ended
 * campaign whose held orders are waiting on closeout. Each of those is pinned
 * below. The triage must never re-score health — GE-3's verdict arrives on
 * the row and is only FILED, not judged again.
 */

import {
    triageCampaign,
    summarizeAttention,
    hasEndedWithHeldOrders,
    PRIORITY_RANK,
    CLOSED_FAMILY,
    type CampaignForTriage,
} from '@/lib/growth/nextAction';
import type { CampaignHealthReason } from '@/lib/growth/health';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const reason = (code: CampaignHealthReason['code']): CampaignHealthReason => ({
    code,
    label: `test: ${code}`,
    kind: 'heuristic',
});

const active = (over: Partial<CampaignForTriage> = {}): CampaignForTriage => ({
    status: 'Active',
    end_date: days(10),
    held_order_count: 0,
    health: 'on_pace',
    health_reasons: [],
    ...over,
});

describe('1. the priority order is fixed and complete', () => {
    it('ranks needs_attention first and completed last', () => {
        expect(PRIORITY_RANK.needs_attention).toBe(0);
        expect(PRIORITY_RANK.worth_a_look).toBe(1);
        expect(PRIORITY_RANK.on_pace).toBe(2);
        expect(PRIORITY_RANK.upcoming).toBe(3);
        expect(PRIORITY_RANK.completed).toBe(4);
    });

    it('rank on the result always equals the rank of its priority', () => {
        const t = triageCampaign(active(), NOW);
        expect(t.rank).toBe(PRIORITY_RANK[t.priority]);
    });
});

describe('2. finished campaigns are records, never tasks', () => {
    it.each(CLOSED_FAMILY)('status %s is completed with no action', (status) => {
        const t = triageCampaign(active({ status }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('closed_at wins even when status still says Active', () => {
        const t = triageCampaign(active({ closed_at: days(-1) }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('never suggests Create invoice — invoice state is unknowable from this data', () => {
        // A settled campaign may already be invoiced; the row cannot tell us.
        const t = triageCampaign(active({ status: 'Settled' }), NOW);
        expect(t.action).toBeNull();
    });
});

describe('3. leads and placeholders are upcoming with a human next step', () => {
    it('placeholder rows get Follow up at the organization profile', () => {
        const t = triageCampaign({ status: 'Lead', is_placeholder: true }, NOW);
        expect(t.priority).toBe('upcoming');
        expect(t.action).toEqual(expect.objectContaining({
            label: 'Follow up',
            kind: 'follow_up',
            destination: 'organization_profile',
        }));
    });

    it('a real Lead campaign is also upcoming', () => {
        const t = triageCampaign({ status: 'Lead' }, NOW);
        expect(t.priority).toBe('upcoming');
        expect(t.action?.kind).toBe('follow_up');
    });

    it('an unknown status is filed as upcoming with no invented action', () => {
        const t = triageCampaign({ status: 'Onboarding' }, NOW);
        expect(t.priority).toBe('upcoming');
        expect(t.action).toBeNull();
    });
});

describe('4. ended-with-held-orders is urgent regardless of prior health', () => {
    it('detects an Active campaign past its end date with held orders', () => {
        expect(hasEndedWithHeldOrders(active({ end_date: days(-2), held_order_count: 5 }), NOW)).toBe(true);
    });

    it('does not fire while the window is still open', () => {
        expect(hasEndedWithHeldOrders(active({ end_date: days(2), held_order_count: 5 }), NOW)).toBe(false);
    });

    it('does not fire with zero held orders', () => {
        expect(hasEndedWithHeldOrders(active({ end_date: days(-2), held_order_count: 0 }), NOW)).toBe(false);
    });

    it('does not fire on closed or missing/invalid end dates', () => {
        expect(hasEndedWithHeldOrders(active({ status: 'Closed', end_date: days(-2), held_order_count: 5 }), NOW)).toBe(false);
        expect(hasEndedWithHeldOrders(active({ end_date: null, held_order_count: 5 }), NOW)).toBe(false);
        expect(hasEndedWithHeldOrders(active({ end_date: 'not-a-date', held_order_count: 5 }), NOW)).toBe(false);
    });

    it('escalates to needs_attention with a Close out action even if health said on_pace', () => {
        const t = triageCampaign(active({ end_date: days(-2), held_order_count: 3, health: 'on_pace' }), NOW);
        expect(t.priority).toBe('needs_attention');
        expect(t.action).toEqual(expect.objectContaining({
            label: 'Close out fundraiser',
            kind: 'closeout',
            destination: 'closeout_modal',
        }));
        expect(t.action?.reason).toContain('3 held orders are');
    });

    it('uses singular grammar for exactly one held order', () => {
        const t = triageCampaign(active({ end_date: days(-2), held_order_count: 1 }), NOW);
        expect(t.action?.reason).toContain('1 held order is');
    });
});

describe('5. health verdicts file into categories without being re-scored', () => {
    it('at_risk → needs_attention', () => {
        const t = triageCampaign(active({ health: 'at_risk', health_reasons: [reason('behind_pace'), reason('no_recent_orders')] }), NOW);
        expect(t.priority).toBe('needs_attention');
    });

    it('watch → worth_a_look', () => {
        const t = triageCampaign(active({ health: 'watch', health_reasons: [reason('behind_pace')] }), NOW);
        expect(t.priority).toBe('worth_a_look');
    });

    it('on_pace → on_pace', () => {
        expect(triageCampaign(active({ health: 'on_pace' }), NOW).priority).toBe('on_pace');
    });

    it('no_signal → on_pace category (nothing adverse; the badge still shows the precise verdict)', () => {
        expect(triageCampaign(active({ health: 'no_signal' }), NOW).priority).toBe('on_pace');
    });

    it('missing health degrades to on_pace, never to a warning', () => {
        expect(triageCampaign(active({ health: undefined, health_reasons: undefined }), NOW).priority).toBe('on_pace');
    });
});

describe('6. action precedence is deterministic', () => {
    it('closeout beats bundle selection when both apply', () => {
        const t = triageCampaign(active({
            end_date: days(-1),
            held_order_count: 2,
            health: 'watch',
            health_reasons: [reason('bundle_selection_pending')],
        }), NOW);
        expect(t.action?.kind).toBe('closeout');
    });

    it('bundle selection pending gets its specific action', () => {
        const t = triageCampaign(active({ health: 'watch', health_reasons: [reason('bundle_selection_pending')] }), NOW);
        expect(t.action).toEqual(expect.objectContaining({
            label: 'Review bundle selection',
            kind: 'bundle_selection',
            destination: 'organization_profile',
        }));
    });

    it('at_risk with a silent coordinator suggests checking in', () => {
        const t = triageCampaign(active({
            health: 'at_risk',
            health_reasons: [reason('no_orders_yet'), reason('no_coordinator_activity')],
        }), NOW);
        expect(t.action?.kind).toBe('contact_coordinator');
    });

    it('at_risk without coordinator/no-orders signals falls back to Review campaign', () => {
        const t = triageCampaign(active({
            health: 'at_risk',
            health_reasons: [reason('behind_pace'), reason('no_recent_orders')],
        }), NOW);
        expect(t.action?.kind).toBe('review_campaign');
    });

    it('watch gets Review campaign', () => {
        const t = triageCampaign(active({ health: 'watch', health_reasons: [reason('no_recent_orders')] }), NOW);
        expect(t.action?.kind).toBe('review_campaign');
    });

    it('a healthy running campaign has NO action — no busywork', () => {
        expect(triageCampaign(active({ health: 'on_pace' }), NOW).action).toBeNull();
        expect(triageCampaign(active({ health: 'no_signal' }), NOW).action).toBeNull();
    });

    it('no action ever names a send/schedule/GE-7 capability', () => {
        const all = [
            triageCampaign(active({ end_date: days(-1), held_order_count: 2 }), NOW),
            triageCampaign(active({ health: 'at_risk', health_reasons: [reason('no_orders_yet')] }), NOW),
            triageCampaign(active({ health: 'watch', health_reasons: [reason('bundle_selection_pending')] }), NOW),
            triageCampaign({ status: 'Lead', is_placeholder: true }, NOW),
        ];
        for (const t of all) {
            expect(t.action).not.toBeNull();
            expect(`${t.action!.label} ${t.action!.reason}`).not.toMatch(/\b(send|sent|schedule|boost|blast|email)\b/i);
        }
    });
});

describe('7. summarizeAttention counts only what is true', () => {
    it('returns zeros for an empty list', () => {
        expect(summarizeAttention([], NOW)).toEqual({ needsAttention: 0, heldOrders: 0, heldValue: 0 });
    });

    it('counts needs_attention campaigns from both triggers', () => {
        const s = summarizeAttention([
            active({ health: 'at_risk', health_reasons: [reason('no_orders_yet'), reason('no_recent_orders')] }),
            active({ end_date: days(-3), held_order_count: 4, held_order_total: 500 }),
            active({ health: 'on_pace' }),
        ], NOW);
        expect(s.needsAttention).toBe(2);
    });

    it('sums held orders and value only from open, real campaigns', () => {
        const s = summarizeAttention([
            active({ held_order_count: 3, held_order_total: 300 }),
            active({ status: 'Closed', held_order_count: 9, held_order_total: 900 }),
            { status: 'Lead', is_placeholder: true, held_order_count: 7, held_order_total: 700 },
        ], NOW);
        expect(s.heldOrders).toBe(3);
        expect(s.heldValue).toBe(300);
    });

    it('a caught-up tenant reads all zeros, never a fabricated signal', () => {
        const s = summarizeAttention([
            active({ health: 'on_pace' }),
            active({ status: 'Settled' }),
        ], NOW);
        expect(s).toEqual({ needsAttention: 0, heldOrders: 0, heldValue: 0 });
    });
});
