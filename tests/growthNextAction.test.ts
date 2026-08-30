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
        // Asserted as ORDER, not as literal integers. FR-HISTORY-1 inserted
        // `awaiting_payment` between needs_attention and worth_a_look, which
        // shifted every number below it without changing the property this test
        // exists to protect. Ordering is the contract; the integers are an
        // implementation detail that should not break on every insertion.
        //
        // CRM-ACTIVE-STATUS-UX-1: on_pace ("Active") now ranks ahead of
        // worth_a_look ("Worth a look") -- see PRIORITY_RANK's own comment in
        // lib/growth/nextAction.ts. needs_attention/awaiting_payment stay
        // pinned first, unconditionally.
        const order = (Object.keys(PRIORITY_RANK) as (keyof typeof PRIORITY_RANK)[])
            .sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]);
        expect(order).toEqual([
            'needs_attention',
            'awaiting_payment',
            'on_pace',
            'worth_a_look',
            'upcoming',
            'completed',
        ]);
        // Ranks are unique and contiguous from zero.
        expect(Object.values(PRIORITY_RANK).sort((a, b) => a - b))
            .toEqual(order.map((_, i) => i));
    });

    it('FR-HISTORY-1: money owed outranks every non-alarming state', () => {
        // The whole point: a closed-but-unpaid fundraiser must sort above active
        // work that has no warning sign, and far above finished records.
        expect(PRIORITY_RANK.awaiting_payment).toBeGreaterThan(PRIORITY_RANK.needs_attention);
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.on_pace);
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.upcoming);
        expect(PRIORITY_RANK.awaiting_payment).toBeLessThan(PRIORITY_RANK.completed);
    });

    it('rank on the result always equals the rank of its priority', () => {
        const t = triageCampaign(active(), NOW);
        expect(t.rank).toBe(PRIORITY_RANK[t.priority]);
    });
});

describe('2. finished campaigns are records, never tasks', () => {
    /**
     * FR-HISTORY-1: "finished" now means FINANCIALLY finished, and the row can
     * finally say so — /api/campaigns sends invoice_statuses and
     * settled_externally, which is what this module's header used to call
     * UNKNOWABLE. These fixtures state their finishedness explicitly rather than
     * relying on absent fields, because absence now means "we were not told" and
     * fails conservatively into awaiting-payment.
     */
    const FINISHED = { invoice_statuses: [] as string[], settlement_total: 0, held_order_count: 0 };

    // CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1: 'Archived' is no longer part of this
    // parametrization -- archiving now outranks the closed-family check
    // entirely and is excluded from every bucket, not filed as 'completed'.
    // See tests/crmArchivedCampaignVisibility1.test.ts for that behavior;
    // the other three CLOSED_FAMILY members are unaffected and still finish
    // as ordinary records.
    it.each(CLOSED_FAMILY.filter((s) => s !== 'Archived'))('status %s owing nothing is completed with no action', (status) => {
        const t = triageCampaign(active({ status, ...FINISHED }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('a PAID campaign-linked invoice is completed with no action', () => {
        const t = triageCampaign(active({ status: 'Closed', invoice_statuses: ['PAID'], settlement_total: 250 }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('settled_externally is completed with no action', () => {
        const t = triageCampaign(active({ status: 'Closed', settled_externally: true, invoice_statuses: [], settlement_total: 250 }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('closed_at wins even when status still says Active', () => {
        const t = triageCampaign(active({ closed_at: days(-1), ...FINISHED }), NOW);
        expect(t.priority).toBe('completed');
        expect(t.action).toBeNull();
    });

    it('but a closed campaign that is still OWED is work, not a record', () => {
        // The defect this phase exists to remove: closing a fundraiser used to
        // file it as a finished record while the money was still outstanding.
        const t = triageCampaign(active({ status: 'Closed', invoice_statuses: ['SENT'], settlement_total: 250 }), NOW);
        expect(t.priority).toBe('awaiting_payment');
        expect(t.action?.kind).toBe('invoice');
    });

    it('invoice state is no longer unknowable — but absence still is', () => {
        // A row that carries no linkage tells us nothing, so it stays visible
        // rather than claiming to be finished.
        const t = triageCampaign(active({ status: 'Settled' }), NOW);
        expect(t.priority).toBe('awaiting_payment');
        // And it never offers to CREATE an invoice off a guess.
        expect(t.action?.label).not.toBe('Create invoice');
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

    it('CRM-CC-5: no action reason leaks an internal checkpoint code to the owner', () => {
        // The reason strings render verbatim in the drawer and as tooltips —
        // "GE-3" once shipped in the review_campaign reason.
        const t = triageCampaign(active({ health: 'watch', health_reasons: [reason('no_recent_orders')] }), NOW);
        expect(t.action?.reason).not.toMatch(/\b(GE|CRM|FR|SF|CP)-\w*\d/);
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
