/**
 * CRM-CC-2 — priority sections + progress formatting.
 *
 * The failure modes pinned here: a section order that buries urgent work, an
 * empty "Needs attention" container scaring a caught-up tenant, a second
 * priority model disagreeing with CRM-CC-1's triage, a progress meter with no
 * denominator, and "No bundle goal set" noise rendered like real data.
 */

import {
    groupCampaignsByPriority,
    formatBundleProgress,
    SECTION_META,
} from '@/lib/growth/campaignSections';
import { triageCampaign, PRIORITY_RANK, type CampaignForTriage, type CampaignPriority } from '@/lib/growth/nextAction';
import type { CampaignHealthReason } from '@/lib/growth/health';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const reason = (code: CampaignHealthReason['code']): CampaignHealthReason => ({
    code, label: `test: ${code}`, kind: 'heuristic',
});

const atRisk = (id: string): CampaignForTriage & { id: string } => ({
    id, status: 'Active', end_date: days(10), health: 'at_risk',
    health_reasons: [reason('no_orders_yet'), reason('no_coordinator_activity')],
});
const watch = (id: string): CampaignForTriage & { id: string } => ({
    id, status: 'Active', end_date: days(10), health: 'watch', health_reasons: [reason('behind_pace')],
});
const onPace = (id: string): CampaignForTriage & { id: string } => ({
    id, status: 'Active', end_date: days(10), health: 'on_pace', health_reasons: [],
});
const lead = (id: string): CampaignForTriage & { id: string } => ({
    id, status: 'Lead', is_placeholder: true,
});
// FR-HISTORY-1: these fixtures assert "a genuinely FINISHED campaign is a
// record". They now say so explicitly — no invoice, and a known-zero gross —
// instead of relying on absent fields. Absence now means "we were not told",
// which fails conservatively into awaiting-payment so a fundraiser can never
// hide itself while money may still be owed.
const FINISHED = { invoice_statuses: [] as string[], settlement_total: 0, held_order_count: 0 };

const closed = (id: string): CampaignForTriage & { id: string } => ({
    id, status: 'Settled', ...FINISHED,
});

describe('1. section metadata is complete and honestly worded', () => {
    it('covers every priority exactly once', () => {
        expect(Object.keys(SECTION_META).sort()).toEqual(Object.keys(PRIORITY_RANK).sort());
    });

    it('only Recently completed starts collapsed — live work stays visible', () => {
        for (const [p, meta] of Object.entries(SECTION_META)) {
            expect(meta.collapsedByDefault).toBe(p === 'completed');
        }
    });

    it('no title or description uses scores, danger words, or internal vocabulary', () => {
        for (const meta of Object.values(SECTION_META)) {
            expect(`${meta.title} ${meta.description}`).not.toMatch(/\b(score|critical|danger|risk %|at_risk|on_pace|triage)\b/i);
        }
    });
});

describe('2. grouping files campaigns without re-deciding priority', () => {
    it('every campaign lands in the section its triage says, with triage attached', () => {
        const all = [atRisk('a'), watch('w'), onPace('p'), lead('l'), closed('c')];
        const sections = groupCampaignsByPriority(all, NOW);
        for (const s of sections) {
            for (const c of s.campaigns) {
                expect(s.priority).toBe(triageCampaign(c, NOW).priority);
                expect(c.triage.priority).toBe(s.priority);
            }
        }
    });

    it('orders sections most-urgent first', () => {
        const sections = groupCampaignsByPriority(
            [closed('c'), lead('l'), onPace('p'), watch('w'), atRisk('a')], NOW,
        );
        // CRM-ACTIVE-STATUS-UX-1: on_pace ("Active") now ranks ahead of
        // worth_a_look ("Worth a look") -- see PRIORITY_RANK's own comment.
        expect(sections.map((s) => s.priority)).toEqual(
            ['needs_attention', 'on_pace', 'worth_a_look', 'upcoming', 'completed'],
        );
        const ranks = sections.map((s) => PRIORITY_RANK[s.priority]);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    });

    it('omits empty sections entirely', () => {
        const sections = groupCampaignsByPriority([onPace('p1'), onPace('p2')], NOW);
        expect(sections).toHaveLength(1);
        expect(sections[0].priority).toBe('on_pace');
    });

    it('a caught-up tenant gets NO needs-attention section, not an empty scary one', () => {
        const sections = groupCampaignsByPriority([onPace('p'), closed('c')], NOW);
        expect(sections.find((s) => s.priority === 'needs_attention')).toBeUndefined();
    });

    it('ended-with-held-orders campaigns join needs_attention even when health was fine', () => {
        const endedHeld: CampaignForTriage & { id: string } = {
            id: 'e', status: 'Active', end_date: days(-2), held_order_count: 4, health: 'on_pace',
        };
        const sections = groupCampaignsByPriority([endedHeld, onPace('p')], NOW);
        expect(sections[0].priority).toBe('needs_attention');
        expect(sections[0].campaigns.map((c) => c.id)).toEqual(['e']);
    });

    it('preserves input order inside a section — no invented ranking', () => {
        const sections = groupCampaignsByPriority([onPace('p1'), onPace('p2'), onPace('p3')], NOW);
        expect(sections[0].campaigns.map((c) => c.id)).toEqual(['p1', 'p2', 'p3']);
    });

    it('returns no sections for no campaigns', () => {
        expect(groupCampaignsByPriority([], NOW)).toEqual([]);
    });
});

describe('3. progress reads as words, and the meter never lies', () => {
    it('with a goal: "S of G bundles" plus a clamped percent', () => {
        expect(formatBundleProgress(14, 20, 70)).toEqual({ text: '14 of 20 bundles', percent: 70 });
    });

    it('clamps out-of-range server percents instead of drawing an impossible bar', () => {
        expect(formatBundleProgress(30, 20, 150)?.percent).toBe(100);
        expect(formatBundleProgress(0, 20, -5)?.percent).toBe(0);
    });

    it('derives the percent when the server did not send one', () => {
        expect(formatBundleProgress(5, 20)).toEqual({ text: '5 of 20 bundles', percent: 25 });
    });

    it('half-bundle weights keep one decimal, whole numbers stay whole', () => {
        expect(formatBundleProgress(14.5, 20, 72.5)?.text).toBe('14.5 of 20 bundles');
        expect(formatBundleProgress(14, 20, 70)?.text).toBe('14 of 20 bundles');
    });

    it('no goal but real sales: words only, NO meter', () => {
        expect(formatBundleProgress(7, 0)).toEqual({ text: '7 bundles', percent: null });
        expect(formatBundleProgress(7, null)).toEqual({ text: '7 bundles', percent: null });
    });

    it('no goal and no sales: nothing — silence beats "No bundle goal set" noise', () => {
        expect(formatBundleProgress(0, 0)).toBeNull();
        expect(formatBundleProgress(null, undefined)).toBeNull();
        expect(formatBundleProgress(undefined, 0, 50)).toBeNull();
    });

    it('negative sold never renders a negative count', () => {
        expect(formatBundleProgress(-3, 20)?.text).toBe('0 of 20 bundles');
    });
});

describe('4. section membership by lifecycle', () => {
    const cases: [string, CampaignForTriage, CampaignPriority][] = [
        ['at-risk active', atRisk('x'), 'needs_attention'],
        ['watch active', watch('x'), 'worth_a_look'],
        ['on-pace active', onPace('x'), 'on_pace'],
        ['no-signal active', { status: 'Active', health: 'no_signal' }, 'on_pace'],
        ['placeholder lead', lead('x'), 'upcoming'],
        ['settled', closed('x'), 'completed'],
        ['closed_at set, nothing owed', { status: 'Active', closed_at: days(-1), ...FINISHED }, 'completed'],
        // FR-HISTORY-1: the same row with money still outstanding does NOT go to
        // completed. This is the case that used to fold itself away.
        ['closed_at set, invoice SENT', { status: 'Active', closed_at: days(-1), invoice_statuses: ['SENT'], settlement_total: 250 }, 'awaiting_payment'],
        ['closed_at set, sales but no invoice', { status: 'Active', closed_at: days(-1), invoice_statuses: [], settlement_total: 250 }, 'awaiting_payment'],
        ['closed_at set, invoice PAID', { status: 'Active', closed_at: days(-1), invoice_statuses: ['PAID'], settlement_total: 250 }, 'completed'],
        // Nobody told us about invoices — stays visible rather than hiding.
        ['closed_at set, linkage unknown', { status: 'Active', closed_at: days(-1) }, 'awaiting_payment'],
    ];
    it.each(cases)('%s → its own section', (_label, campaign, expected) => {
        const sections = groupCampaignsByPriority([campaign], NOW);
        expect(sections).toHaveLength(1);
        expect(sections[0].priority).toBe(expected);
    });
});
