/**
 * FR-RETENTION-6 — Rebooking row-state derivation.
 *
 * The bug this replaces was not a missing feature. Every branch below existed
 * somewhere in the launched system; the CP1 route simply never read the outreach
 * tables, so a contact who had been emailed, had responded, had been approved,
 * and had a fundraiser created still rendered as "Ready to invite · Included in
 * next update" — forever. These tests pin the ORDER, because the order is what
 * was wrong.
 */

import {
    deriveRebookingRowState,
    resolveActivePreference,
    bucketForStatus,
    type RowEvidence,
} from '@/lib/rebookingRowState';

const NOW = new Date('2026-08-09T12:00:00Z');

const opp = (over: Partial<RowEvidence['opportunities'][number]> = {}) => ({
    id: 'opp-1',
    submission_id: 'sub-1',
    status: 'interested' as const,
    coordinator_intent: 'yes',
    coordinator_name: null,
    campaign_id: null,
    ...over,
});

const evidence = (over: Partial<RowEvidence> = {}): RowEvidence => ({
    isArchived: false,
    hasEmail: true,
    wasSent: false,
    askedForFreshLink: false,
    opportunities: [],
    activePreference: null,
    ...over,
});

describe('1. the CP1 regression: outreach must move a contact off "Ready to invite"', () => {
    it('a contact with no outreach is Ready to invite and points at the Seasonal Update', () => {
        const s = deriveRebookingRowState(evidence());
        expect(s.status).toBe('ready_to_invite');
        expect(s.next_action).toBe('send_seasonal_update');
        expect(s.next_step).toBe('Include in your next Seasonal Update');
    });

    it('the old "Included in next update" wording is gone', () => {
        expect(deriveRebookingRowState(evidence()).next_step).not.toMatch(/included in next update/i);
    });

    it('an accepted delivery flips the row to Update sent', () => {
        const s = deriveRebookingRowState(evidence({ wasSent: true }));
        expect(s.status).toBe('update_sent');
        expect(bucketForStatus(s.status, false)).toBe('waiting');
    });

    it('a converted opportunity is Rebooked, never Ready to invite', () => {
        const s = deriveRebookingRowState(evidence({
            wasSent: true,
            opportunities: [opp({ status: 'converted', campaign_id: 'camp-9' })],
        }));
        expect(s.status).toBe('rebooked');
        expect(bucketForStatus(s.status, false)).toBe('done');
        expect(s.campaign_id).toBe('camp-9');
        expect(s.next_action).toBe('view_campaign');
    });
});

describe('2. precedence — later lifecycle stages outrank earlier ones', () => {
    it('rebooked beats approved, interested, and sent all at once', () => {
        const s = deriveRebookingRowState(evidence({
            wasSent: true,
            askedForFreshLink: true,
            opportunities: [opp({ status: 'converted', campaign_id: 'c1' }), opp({ id: 'o2', status: 'approved' })],
        }));
        expect(s.status).toBe('rebooked');
    });

    it('an opportunity carrying a campaign_id counts as rebooked even if its status lags', () => {
        const s = deriveRebookingRowState(evidence({ opportunities: [opp({ status: 'approved', campaign_id: 'c1' })] }));
        expect(s.status).toBe('rebooked');
    });

    it('approved beats interested', () => {
        const s = deriveRebookingRowState(evidence({
            opportunities: [opp({ id: 'o1', status: 'interested' }), opp({ id: 'o2', status: 'approved' })],
        }));
        expect(s.status).toBe('ready_to_create');
        expect(s.opportunity_id).toBe('o2');
        expect(s.next_action).toBe('start_fundraiser');
    });

    it('a post-approval change surfaces as Needs review rather than staying approved', () => {
        const s = deriveRebookingRowState(evidence({ opportunities: [opp({ status: 'needs_review' })] }));
        expect(s.status).toBe('needs_review');
        expect(s.next_action).toBe('review_request');
        expect(s.request_id).toBe('sub-1');
    });

    it('archived outranks everything, including a created fundraiser', () => {
        const s = deriveRebookingRowState(evidence({
            isArchived: true,
            opportunities: [opp({ status: 'converted', campaign_id: 'c1' })],
        }));
        expect(s.status).toBe('archived');
    });

    it('a live response outranks a later unsubscribe — the fundraiser still needs creating', () => {
        const s = deriveRebookingRowState(evidence({
            opportunities: [opp({ status: 'approved' })],
            activePreference: { status: 'unsubscribed', effective_at: NOW, effective_until: null },
        }));
        expect(s.status).toBe('ready_to_create');
    });

    it('suppression outranks "we sent it", because future sendability is the live fact', () => {
        const s = deriveRebookingRowState(evidence({
            wasSent: true,
            activePreference: { status: 'unsubscribed', effective_at: NOW, effective_until: null },
        }));
        expect(s.status).toBe('cant_email');
        expect(s.exclusion_reason).toBe('Unsubscribed');
    });
});

describe('3. coordinator evidence, reusing the CP5 semantic', () => {
    it('interested with nobody named needs a coordinator', () => {
        const s = deriveRebookingRowState(evidence({
            opportunities: [opp({ coordinator_intent: 'not_sure', coordinator_name: null })],
        }));
        expect(s.status).toBe('needs_coordinator');
    });

    it('"someone else will do it" plus a name is NOT missing a coordinator', () => {
        const s = deriveRebookingRowState(evidence({
            opportunities: [opp({ coordinator_intent: 'no', coordinator_name: 'Dana Reed' })],
        }));
        expect(s.status).toBe('interested');
    });

    it('"I will coordinate" is enough on its own', () => {
        const s = deriveRebookingRowState(evidence({ opportunities: [opp({ coordinator_intent: 'yes' })] }));
        expect(s.status).toBe('interested');
    });

    it('"someone else" with no name still needs a coordinator', () => {
        const s = deriveRebookingRowState(evidence({
            opportunities: [opp({ coordinator_intent: 'no', coordinator_name: null })],
        }));
        expect(s.status).toBe('needs_coordinator');
    });
});

describe('4. deliverability states', () => {
    it('no email is Can\'t email with a fixable next step', () => {
        const s = deriveRebookingRowState(evidence({ hasEmail: false }));
        expect(s.status).toBe('cant_email');
        expect(s.exclusion_reason).toBe('No email');
        expect(s.next_action).toBe('fix_contact');
    });

    it('a live pause reports the date it lifts', () => {
        const s = deriveRebookingRowState(evidence({
            activePreference: { status: 'paused', effective_at: NOW, effective_until: new Date('2026-12-01T00:00:00Z') },
        }));
        expect(s.status).toBe('paused_until');
        expect(s.status_label).toBe('Paused until Dec 1, 2026');
    });

    it('a request for a fresh link needs review but offers no drawer it cannot open', () => {
        const s = deriveRebookingRowState(evidence({ askedForFreshLink: true }));
        expect(s.status).toBe('needs_review');
        expect(s.next_action).toBeNull();
        expect(s.request_id).toBeNull();
    });
});

describe('5. resolveActivePreference — history is append-only, so the newest live row wins', () => {
    it('a lapsed pause stops suppressing', () => {
        const p = resolveActivePreference(
            [{ status: 'paused', effective_at: new Date('2026-01-01'), effective_until: new Date('2026-02-01') }],
            NOW,
        );
        expect(p).toBeNull();
    });

    it('an unexpired pause still applies', () => {
        const p = resolveActivePreference(
            [{ status: 'paused', effective_at: new Date('2026-01-01'), effective_until: new Date('2026-12-01') }],
            NOW,
        );
        expect(p?.status).toBe('paused');
    });

    it('a later resubscribe overrides an earlier unsubscribe', () => {
        const p = resolveActivePreference([
            { status: 'unsubscribed', effective_at: new Date('2026-01-01'), effective_until: null },
            { status: 'subscribed', effective_at: new Date('2026-06-01'), effective_until: null },
        ], NOW);
        expect(p?.status).toBe('subscribed');
    });

    it('a future-dated preference is not applied early', () => {
        const p = resolveActivePreference(
            [{ status: 'unsubscribed', effective_at: new Date('2027-01-01'), effective_until: null }],
            NOW,
        );
        expect(p).toBeNull();
    });
});

describe('6. buckets — a count can never disagree with the rows behind it', () => {
    it('resting states stay out of every work queue', () => {
        expect(bucketForStatus('archived', false)).toBe('none');
        expect(bucketForStatus('paused_until', false)).toBe('none');
    });

    it('a contact flagged for identity review is work, not an invite candidate', () => {
        expect(bucketForStatus('ready_to_invite', true)).toBe('needs_action');
        expect(bucketForStatus('ready_to_invite', false)).toBe('ready_to_invite');
    });

    it('every state the tenant must act on lands in needs_action', () => {
        for (const s of ['interested', 'needs_review', 'needs_coordinator', 'ready_to_create', 'cant_email'] as const) {
            expect(bucketForStatus(s, false)).toBe('needs_action');
        }
    });
});
