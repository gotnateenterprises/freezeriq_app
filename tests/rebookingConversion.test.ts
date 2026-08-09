/**
 * FR-RETENTION-5 — conversion gate and prefill tests.
 *
 * These cover the decisions that would cause real harm if wrong: converting an
 * organization the tenant never approved, converting one that belongs to another
 * tenant, converting the same one twice, or opening the wizard in a state its
 * own rules would reject.
 */

import {
    buildConversionPrefill,
    describeCoordinatorIntent,
    evaluateConversion,
    isPastCalendarDate,
    refusalHttpStatus,
    toDateInputValue,
    type ConvertibleOpportunity,
} from '@/lib/rebookingConversion';

const BIZ = 'biz-1';
const OTHER_BIZ = 'biz-2';
const CUST = 'cust-1';

function opp(over: Partial<ConvertibleOpportunity> = {}): ConvertibleOpportunity {
    return { id: 'opp-1', businessId: BIZ, customerId: CUST, status: 'approved', campaignId: null, ...over };
}

// ── 1. Only approved converts ────────────────────────────────────────────────

describe('1. only an approved opportunity may become a fundraiser', () => {
    it('approved passes', () => {
        expect(evaluateConversion(opp(), BIZ).ok).toBe(true);
    });

    it('interested (pending) is refused, and says to approve it first', () => {
        const v = evaluateConversion(opp({ status: 'interested' }), BIZ);
        expect(v.ok).toBe(false);
        expect(v.refusal).toBe('not_approved');
        expect(v.message).toMatch(/approve this organization/i);
    });

    it('needs_review is refused', () => {
        const v = evaluateConversion(opp({ status: 'needs_review' }), BIZ);
        expect(v.ok).toBe(false);
        expect(v.refusal).toBe('not_approved');
    });

    it('canceled is refused with its own distinct reason', () => {
        const v = evaluateConversion(opp({ status: 'canceled' }), BIZ);
        expect(v.ok).toBe(false);
        expect(v.refusal).toBe('canceled');
        expect(v.message).toMatch(/closed for the season/i);
    });

    it('converted cannot create a second campaign, and surfaces the first', () => {
        const v = evaluateConversion(opp({ status: 'converted', campaignId: 'camp-9' }), BIZ);
        expect(v.ok).toBe(false);
        expect(v.refusal).toBe('already_converted');
        expect(v.existingCampaignId).toBe('camp-9');
    });

    it('an approved row that somehow already carries a campaign is treated as converted', () => {
        // The LINK is the fact that matters, not the status label.
        const v = evaluateConversion(opp({ status: 'approved', campaignId: 'camp-9' }), BIZ);
        expect(v.refusal).toBe('already_converted');
        expect(v.existingCampaignId).toBe('camp-9');
    });
});

// ── 2. Tenant and organization isolation ─────────────────────────────────────

describe('2. isolation', () => {
    it("another tenant's opportunity is not found, not forbidden", () => {
        const v = evaluateConversion(opp({ businessId: OTHER_BIZ }), BIZ);
        expect(v.refusal).toBe('not_found');
        // 404 rather than 403 — a tenant must not be able to probe for the
        // existence of another tenant's rows.
        expect(refusalHttpStatus(v.refusal!)).toBe(404);
    });

    it('a missing opportunity is indistinguishable from a foreign one', () => {
        expect(evaluateConversion(null, BIZ).refusal).toBe('not_found');
        expect(evaluateConversion(null, BIZ).message)
            .toBe(evaluateConversion(opp({ businessId: OTHER_BIZ }), BIZ).message);
    });

    it('a campaign for a DIFFERENT organization cannot be attached to this request', () => {
        const v = evaluateConversion(opp(), BIZ, 'some-other-customer');
        expect(v.ok).toBe(false);
        expect(v.refusal).toBe('organization_mismatch');
    });

    it('the matching organization passes', () => {
        expect(evaluateConversion(opp(), BIZ, CUST).ok).toBe(true);
    });

    it('never leaks a column, table or id in a refusal message', () => {
        for (const s of ['interested', 'needs_review', 'canceled', 'converted'] as const) {
            const v = evaluateConversion(opp({ status: s, campaignId: 'camp-9' }), BIZ);
            expect(v.message).not.toMatch(/business_id|customer_id|campaign_id|rebooking_|prisma|opp-1/i);
        }
    });
});

describe('3. refusal status codes', () => {
    it('maps each refusal to a defensible code', () => {
        expect(refusalHttpStatus('not_found')).toBe(404);
        expect(refusalHttpStatus('not_approved')).toBe(409);
        expect(refusalHttpStatus('canceled')).toBe(409);
        expect(refusalHttpStatus('already_converted')).toBe(409);
        expect(refusalHttpStatus('organization_mismatch')).toBe(400);
    });
});

// ── 4. Prefill ───────────────────────────────────────────────────────────────

const BASE = {
    organizationName: 'Pine Valley PTO',
    lineupName: 'Fall 2026 Lineup',
    preferredStartDate: new Date('2026-10-06T00:00:00.000Z'),
    alternateStartDate: new Date('2026-10-13T00:00:00.000Z'),
    requestedEndDate: new Date('2026-10-24T00:00:00.000Z'),
    participantEstimate: 45,
    coordinatorIntent: 'yes' as const,
    coordinatorName: null,
    respondentName: 'Riley Marsh',
    lineupFamilyIds: ['f1', 'f2', 'f3'],
    eligibleFamilyIds: ['f1', 'f2', 'f3'],
    coordinatorBundleLimit: 2,
};

describe('4. what the wizard opens with', () => {
    it('names the campaign after the organization and the season, not the year', () => {
        expect(buildConversionPrefill(BASE).campaignName).toBe('Pine Valley PTO Fall 2026 Lineup');
    });

    it('carries the requested end date through as a date-input value', () => {
        expect(buildConversionPrefill(BASE).endDate).toBe('2026-10-24');
    });

    it('leaves the deadline blank when none was requested', () => {
        expect(buildConversionPrefill({ ...BASE, requestedEndDate: null }).endDate).toBeNull();
    });

    it('preselects the lineup families in lineup order', () => {
        expect(buildConversionPrefill(BASE).candidateFamilyIds).toEqual(['f1', 'f2', 'f3']);
    });

    it('DROPS a lineup family that is no longer sellable, and reports it', () => {
        const p = buildConversionPrefill({ ...BASE, eligibleFamilyIds: ['f1', 'f3'] });
        expect(p.candidateFamilyIds).toEqual(['f1', 'f3']);
        expect(p.droppedFamilyIds).toEqual(['f2']);
    });

    it('clamps the selection limit to the surviving pool', () => {
        // The campaign API refuses a limit larger than the pool, so opening the
        // wizard that way would hand the tenant an unsubmittable form.
        const p = buildConversionPrefill({
            ...BASE, coordinatorBundleLimit: 3, eligibleFamilyIds: ['f1'],
        });
        expect(p.candidateFamilyIds).toEqual(['f1']);
        expect(p.selectionLimit).toBe(1);
    });

    it('keeps the lineup limit when the pool is big enough', () => {
        expect(buildConversionPrefill({ ...BASE, coordinatorBundleLimit: 2 }).selectionLimit).toBe(2);
    });

    it('never produces a limit below 1', () => {
        expect(buildConversionPrefill({ ...BASE, coordinatorBundleLimit: 0 }).selectionLimit).toBeGreaterThanOrEqual(1);
    });

    it('survives a lineup whose families are all gone', () => {
        const p = buildConversionPrefill({ ...BASE, eligibleFamilyIds: [] });
        expect(p.candidateFamilyIds).toEqual([]);
        expect(p.droppedFamilyIds).toEqual(['f1', 'f2', 'f3']);
    });
});

// ── 5. Coordinator intent is evidence, never authority ───────────────────────

describe('5. coordinator intent stays reported speech', () => {
    it('yes reads as something the person SAID', () => {
        const s = describeCoordinatorIntent({ coordinatorIntent: 'yes', coordinatorName: null, respondentName: 'Riley Marsh' });
        expect(s).toBe('Riley Marsh said they can coordinate this one.');
        expect(s).toMatch(/said/);
    });

    it('no with a name credits the named person without granting them anything', () => {
        const s = describeCoordinatorIntent({ coordinatorIntent: 'no', coordinatorName: 'Dana Whitcomb', respondentName: 'Riley Marsh' });
        expect(s).toMatch(/Dana Whitcomb will coordinate/);
        expect(s).toMatch(/Nothing has been set up for them yet/);
    });

    it('no without a name says so plainly', () => {
        const s = describeCoordinatorIntent({ coordinatorIntent: 'no', coordinatorName: null, respondentName: 'Riley Marsh' });
        expect(s).toMatch(/didn't say who/);
    });

    it('not_sure never implies anyone was chosen', () => {
        const s = describeCoordinatorIntent({ coordinatorIntent: 'not_sure', coordinatorName: null, respondentName: 'Riley Marsh' });
        expect(s).toBe('Nobody has been named as coordinator yet.');
    });

    it('no wording ever claims access, login or an invitation was created', () => {
        for (const intent of ['yes', 'no', 'not_sure'] as const) {
            const s = describeCoordinatorIntent({ coordinatorIntent: intent, coordinatorName: 'Dana', respondentName: 'Riley' });
            expect(s).not.toMatch(/invit|login|access|portal|account/i);
        }
    });

    it('marks the coordinator as unknown when nobody said yes and nobody was named', () => {
        expect(buildConversionPrefill({ ...BASE, coordinatorIntent: 'not_sure' }).coordinatorKnown).toBe(false);
        expect(buildConversionPrefill({ ...BASE, coordinatorIntent: 'no', coordinatorName: null }).coordinatorKnown).toBe(false);
        expect(buildConversionPrefill({ ...BASE, coordinatorIntent: 'yes' }).coordinatorKnown).toBe(true);
        expect(buildConversionPrefill({ ...BASE, coordinatorIntent: 'no', coordinatorName: 'Dana' }).coordinatorKnown).toBe(true);
    });
});

// ── 6. Dates ─────────────────────────────────────────────────────────────────

describe('6. stale requested dates are surfaced, not swallowed', () => {
    const NOW = new Date('2026-11-15T12:00:00.000Z');

    it('flags a deadline that has already passed', () => {
        expect(isPastCalendarDate('2026-10-24', NOW)).toBe(true);
    });

    it('does not flag today', () => {
        expect(isPastCalendarDate('2026-11-15', NOW)).toBe(false);
    });

    it('does not flag a future date', () => {
        expect(isPastCalendarDate('2026-12-01', NOW)).toBe(false);
    });

    it('treats a blank or malformed value as nothing to warn about', () => {
        expect(isPastCalendarDate(null, NOW)).toBe(false);
        expect(isPastCalendarDate('', NOW)).toBe(false);
        expect(isPastCalendarDate('not-a-date', NOW)).toBe(false);
    });

    it('renders a stored calendar date without shifting the day', () => {
        // The bug FR-RETENTION-3C fixed: Sep 1 must not become Aug 31.
        expect(toDateInputValue(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-09-01');
        expect(toDateInputValue(null)).toBeNull();
    });
});
