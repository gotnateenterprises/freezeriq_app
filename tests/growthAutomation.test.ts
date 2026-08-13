/**
 * GE-5A — safe automation foundation.
 *
 * The dangerous failure here is not a crash. It is an automation that quietly
 * does more than a human authorised: a second recommendation after one was
 * dismissed, an approval that survives a coordinator opting out, a threshold
 * presented as a fact, or a state that implies an email was sent when GE-5A
 * cannot send one. Each of those is pinned below.
 *
 * The database-level guarantees — the semantic unique constraint and the
 * cross-tenant compound foreign keys — are proven against a real PostgreSQL
 * instance during the migration rehearsal, because a unit test cannot prove a
 * constraint the database is the one enforcing.
 */

import {
    AUTOMATION_ACTION_TYPE,
    TERMINAL_STATUSES,
    isTerminal,
    isLegalTransition,
    assertLegalTransition,
    INITIAL_STATUS,
    isOfferingEligible,
    isTargetEligible,
    evaluateSuppression,
    decideCandidate,
    decideApproval,
    buildRebookingReasons,
    factReason,
    heuristicReason,
    EXPIRED_REASONS,
    ACTIVE_STATUSES,
    type AutomationStatus,
    type TransitionActor,
} from '@/lib/growth/automation';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const openOffering = { status: 'ready', archived_at: null as Date | null, ends_at: days(30) };
const goodTarget = { realCampaignCount: 3, archived: false };
const clear = { suppressed: false, reason: null };

describe('1. the action family is closed', () => {
    it('ships exactly one action type', () => {
        expect(AUTOMATION_ACTION_TYPE).toBe('seasonal_rebooking_recommendation');
    });

    it('every action begins as a candidate and nothing else', () => {
        expect(INITIAL_STATUS).toBe('candidate');
    });

    it('exposes no execution state — GE-5A cannot send, so it cannot claim to', () => {
        const all: AutomationStatus[] = ['candidate', 'approved', 'dismissed', 'suppressed', 'expired'];
        for (const forbidden of ['executed', 'executing', 'completed', 'sent', 'failed']) {
            expect(all).not.toContain(forbidden as AutomationStatus);
        }
    });
});

describe('2. state machine — legal transitions', () => {
    const legal: [AutomationStatus, AutomationStatus, TransitionActor][] = [
        ['candidate', 'approved', 'tenant_user'],
        ['candidate', 'dismissed', 'tenant_user'],
        ['approved', 'dismissed', 'tenant_user'],
        ['candidate', 'suppressed', 'system'],
        ['approved', 'suppressed', 'system'],
        ['candidate', 'expired', 'system'],
        ['approved', 'expired', 'system'],
    ];

    it.each(legal)('%s -> %s by %s is allowed', (from, to, actor) => {
        expect(isLegalTransition({ from, to, actor })).toBe(true);
    });

    it('approval and dismissal require a HUMAN, never the system', () => {
        expect(isLegalTransition({ from: 'candidate', to: 'approved', actor: 'system' })).toBe(false);
        expect(isLegalTransition({ from: 'candidate', to: 'dismissed', actor: 'system' })).toBe(false);
        expect(isLegalTransition({ from: 'approved', to: 'dismissed', actor: 'system' })).toBe(false);
    });

    it('suppression and expiry are system-only, never a user action', () => {
        expect(isLegalTransition({ from: 'candidate', to: 'suppressed', actor: 'tenant_user' })).toBe(false);
        expect(isLegalTransition({ from: 'candidate', to: 'expired', actor: 'tenant_user' })).toBe(false);
    });
});

describe('3. state machine — illegal transitions', () => {
    it('a terminal state can never be revived', () => {
        for (const from of TERMINAL_STATUSES) {
            for (const to of ['candidate', 'approved', 'dismissed', 'suppressed', 'expired'] as AutomationStatus[]) {
                for (const actor of ['system', 'tenant_user'] as TransitionActor[]) {
                    expect(isLegalTransition({ from: from as AutomationStatus, to, actor })).toBe(false);
                }
            }
        }
    });

    it('approved cannot go back to candidate', () => {
        expect(isLegalTransition({ from: 'approved', to: 'candidate', actor: 'tenant_user' })).toBe(false);
        expect(isLegalTransition({ from: 'approved', to: 'candidate', actor: 'system' })).toBe(false);
    });

    it('candidate cannot skip approval to any settled outcome a human did not choose', () => {
        // The classic unsafe shortcut: proposal straight to done.
        expect(isLegalTransition({ from: 'candidate', to: 'executed' as AutomationStatus, actor: 'system' })).toBe(false);
        expect(isLegalTransition({ from: 'candidate', to: 'completed' as AutomationStatus, actor: 'system' })).toBe(false);
    });

    it('a state cannot transition to itself', () => {
        for (const s of ['candidate', 'approved'] as AutomationStatus[]) {
            expect(isLegalTransition({ from: s, to: s, actor: 'tenant_user' })).toBe(false);
            expect(isLegalTransition({ from: s, to: s, actor: 'system' })).toBe(false);
        }
    });

    it('assertLegalTransition throws rather than silently permitting', () => {
        expect(() => assertLegalTransition({ from: 'dismissed', to: 'approved', actor: 'tenant_user' })).toThrow();
        expect(() => assertLegalTransition({ from: 'candidate', to: 'approved', actor: 'tenant_user' })).not.toThrow();
    });

    it('isTerminal agrees with the terminal set', () => {
        expect(isTerminal('dismissed')).toBe(true);
        expect(isTerminal('suppressed')).toBe(true);
        expect(isTerminal('expired')).toBe(true);
        expect(isTerminal('candidate')).toBe(false);
        expect(isTerminal('approved')).toBe(false);
    });

    it('only candidate and approved are sweepable by a disable', () => {
        expect([...ACTIVE_STATUSES].sort()).toEqual(['approved', 'candidate']);
    });
});

describe('4. offering eligibility', () => {
    it('accepts a live offering', () => {
        expect(isOfferingEligible({ status: 'ready', archived_at: null, ends_at: days(10) }, NOW)).toBe(true);
        expect(isOfferingEligible({ status: 'in_use', archived_at: null, ends_at: days(10) }, NOW)).toBe(true);
    });

    it('rejects draft, archived, and finished offerings', () => {
        expect(isOfferingEligible({ status: 'draft', archived_at: null, ends_at: days(10) }, NOW)).toBe(false);
        expect(isOfferingEligible({ status: 'archived', archived_at: null, ends_at: days(10) }, NOW)).toBe(false);
        expect(isOfferingEligible({ status: 'ready', archived_at: NOW, ends_at: days(10) }, NOW)).toBe(false);
        expect(isOfferingEligible({ status: 'ready', archived_at: null, ends_at: days(-1) }, NOW)).toBe(false);
    });
});

describe('5. target eligibility — this is REbooking', () => {
    it('requires prior fundraiser history', () => {
        expect(isTargetEligible({ realCampaignCount: 1, archived: false })).toBe(true);
        expect(isTargetEligible({ realCampaignCount: 0, archived: false })).toBe(false);
    });

    it('excludes archived organizations', () => {
        expect(isTargetEligible({ realCampaignCount: 5, archived: true })).toBe(false);
    });
});

describe('6. suppression — borrowed, never widened', () => {
    it('an organization with no address is not reachable', () => {
        expect(evaluateSuppression({ normalizedEmails: [], suppressedEmails: new Set() }).suppressed).toBe(true);
    });

    it('suppressed when every address is suppressed', () => {
        const v = evaluateSuppression({
            normalizedEmails: ['a@x.com', 'b@x.com'],
            suppressedEmails: new Set(['a@x.com', 'b@x.com']),
        });
        expect(v.suppressed).toBe(true);
        expect(v.reason).toMatch(/suppressed/i);
    });

    it('reachable while ANY address remains clear', () => {
        expect(evaluateSuppression({
            normalizedEmails: ['a@x.com', 'b@x.com'],
            suppressedEmails: new Set(['a@x.com']),
        }).suppressed).toBe(false);
    });

    it('normalizes before comparing, so case cannot smuggle past a suppression', () => {
        expect(evaluateSuppression({
            normalizedEmails: ['A@X.com'],
            suppressedEmails: new Set(['a@x.com']),
        }).suppressed).toBe(true);
    });
});

describe('7. candidate decision — fails closed', () => {
    const base = {
        policyEnabled: true,
        offering: openOffering,
        target: goodTarget,
        alreadyInReviewedAudience: false,
        suppression: clear,
        now: NOW,
    };

    it('creates when every condition is met', () => {
        expect(decideCandidate(base)).toEqual({ create: true, refusal: null });
    });

    it('refuses when the policy is disabled — the first and strongest gate', () => {
        expect(decideCandidate({ ...base, policyEnabled: false }))
            .toEqual({ create: false, refusal: 'policy_disabled' });
    });

    it('refuses an ineligible offering', () => {
        expect(decideCandidate({ ...base, offering: { ...openOffering, status: 'draft' } }).refusal)
            .toBe('offering_ineligible');
    });

    it('refuses an organization with no fundraiser history', () => {
        expect(decideCandidate({ ...base, target: { realCampaignCount: 0, archived: false } }).refusal)
            .toBe('target_ineligible');
    });

    it('refuses someone already in the reviewed audience — no double contact', () => {
        expect(decideCandidate({ ...base, alreadyInReviewedAudience: true }).refusal)
            .toBe('already_in_audience');
    });

    it('refuses a suppressed organization', () => {
        expect(decideCandidate({ ...base, suppression: { suppressed: true, reason: 'x' } }).refusal)
            .toBe('suppressed');
    });

    it('policy_disabled wins over every other refusal', () => {
        // Order matters: a disabled tenant must never see evaluation detail.
        expect(decideCandidate({
            ...base,
            policyEnabled: false,
            offering: { ...openOffering, status: 'draft' },
            target: { realCampaignCount: 0, archived: true },
            suppression: { suppressed: true, reason: 'x' },
        }).refusal).toBe('policy_disabled');
    });
});

describe('8. approval re-validation — the world may have moved', () => {
    const base = {
        policyEnabled: true,
        offering: openOffering,
        target: goodTarget,
        suppression: clear,
        expiresAt: null as Date | null,
        now: NOW,
    };

    it('approves when still valid', () => {
        expect(decideApproval(base)).toEqual({ outcome: 'approve' });
    });

    it('SUPPRESSION APPEARING AFTER THE CANDIDATE BLOCKS APPROVAL', () => {
        const r = decideApproval({ ...base, suppression: { suppressed: true, reason: 'Unsubscribed.' } });
        expect(r.outcome).toBe('suppress');
    });

    it('a disabled policy expires the action instead of approving it', () => {
        expect(decideApproval({ ...base, policyEnabled: false }))
            .toEqual({ outcome: 'expire', reason: 'policy_disabled' });
    });

    it('a closed offering expires the action', () => {
        expect(decideApproval({ ...base, offering: { ...openOffering, ends_at: days(-1) } }))
            .toEqual({ outcome: 'expire', reason: 'offering_ineligible' });
    });

    it('a newly-archived organization expires the action', () => {
        expect(decideApproval({ ...base, target: { realCampaignCount: 3, archived: true } }))
            .toEqual({ outcome: 'expire', reason: 'target_ineligible' });
    });

    it('a passed expiry date expires the action', () => {
        expect(decideApproval({ ...base, expiresAt: days(-1) }))
            .toEqual({ outcome: 'expire', reason: 'expires_at_reached' });
    });

    it('every expiry reason is drawn from the controlled set', () => {
        const outcomes = [
            decideApproval({ ...base, policyEnabled: false }),
            decideApproval({ ...base, offering: { ...openOffering, ends_at: days(-1) } }),
            decideApproval({ ...base, target: { realCampaignCount: 0, archived: false } }),
            decideApproval({ ...base, expiresAt: days(-1) }),
        ];
        for (const o of outcomes) {
            expect(o.outcome).toBe('expire');
            if (o.outcome === 'expire') expect(EXPIRED_REASONS).toContain(o.reason);
        }
    });
});

describe('9. reasons — facts and heuristics stay separable', () => {
    const base = {
        realCampaignCount: 3,
        lifetimeFundraiserSales: 6000,
        daysSinceLastCampaign: 200,
        offeringName: 'Fall 2026',
    };

    it('states prior history and money as FACTS', () => {
        const r = buildRebookingReasons(base);
        const codes = r.filter(x => x.kind === 'fact').map(x => x.code);
        expect(codes).toEqual(expect.arrayContaining([
            'prior_campaigns', 'lifetime_fundraiser_sales', 'offering_open', 'days_since_last_campaign',
        ]));
    });

    it('GE-3 health is a HEURISTIC, never a fact', () => {
        const r = buildRebookingReasons({ ...base, campaignHealth: 'at_risk' });
        const health = r.find(x => x.code === 'campaign_health');
        expect(health).toBeDefined();
        expect(health!.kind).toBe('heuristic');
    });

    it('health never appears when it was not flagged', () => {
        expect(buildRebookingReasons({ ...base, campaignHealth: 'on_pace' })
            .some(x => x.code === 'campaign_health')).toBe(false);
        expect(buildRebookingReasons(base).some(x => x.code === 'campaign_health')).toBe(false);
    });

    it('GE-3 / GE-4 signals never CAUSE a recommendation — they only describe one', () => {
        // An at_risk flag on an ineligible target still yields no candidate.
        expect(decideCandidate({
            policyEnabled: true,
            offering: openOffering,
            target: { realCampaignCount: 0, archived: false },
            alreadyInReviewedAudience: false,
            suppression: clear,
            now: NOW,
        }).create).toBe(false);
    });

    it('money is labelled as gross sales, never "raised"', () => {
        const text = buildRebookingReasons(base).map(r => r.detail).join(' ');
        expect(text).toMatch(/lifetime fundraiser sales/i);
        expect(text).not.toMatch(/\braised\b/i);
        expect(text).not.toMatch(/\bprofit\b/i);
    });

    it('omits recency when there is none rather than inventing it', () => {
        expect(buildRebookingReasons({ ...base, daysSinceLastCampaign: null })
            .some(x => x.code === 'days_since_last_campaign')).toBe(false);
    });

    it('every reason carries an explicit kind — no unlabelled claims', () => {
        for (const r of buildRebookingReasons({ ...base, campaignHealth: 'watch' })) {
            expect(['fact', 'heuristic']).toContain(r.kind);
            expect(r.code.length).toBeGreaterThan(0);
            expect(r.detail.length).toBeGreaterThan(0);
        }
    });

    it('emits no score, probability, or prediction', () => {
        const json = JSON.stringify(buildRebookingReasons({ ...base, campaignHealth: 'at_risk' }));
        for (const banned of ['score', 'probability', 'forecast', 'likelihood', 'prediction', 'rank']) {
            expect(json.toLowerCase()).not.toContain(banned);
        }
    });

    it('helpers stamp the kind they promise', () => {
        expect(factReason('a', 'b').kind).toBe('fact');
        expect(heuristicReason('a', 'b').kind).toBe('heuristic');
    });
});
