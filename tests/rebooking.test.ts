/**
 * FR-RETENTION-4 — rebooking credential and submission-reconciliation tests.
 *
 * These cover the properties that would cause real harm if wrong: a replayable
 * credential, a link that outlives its purpose, a duplicate fundraiser, a
 * silently overwritten approval, and a public form reaching into a fundraiser
 * that already exists.
 */

import {
    REBOOKING_TOKEN_TTL_DAYS,
    classifyRebookingCredential,
    digestsMatch,
    hashRebookingToken,
    maskRebookingUrl,
    mintRebookingToken,
} from '@/lib/rebookingToken';
import {
    planOpportunityReconciliation,
    validateSubmission,
    type ExistingOpportunity,
    type SubmittedDetails,
    type SubmittedOrg,
} from '@/lib/rebookingSubmission';
import { resolveRequestOrigin, buildRebookingUrl } from '@/lib/fundraiserUrls';

const NOW = new Date('2026-08-10T00:00:00.000Z');

// ── 1. The credential ────────────────────────────────────────────────────────

describe('1. the rebooking credential', () => {
    it('never stores anything that equals the raw token', () => {
        const t = mintRebookingToken(NOW);
        expect(t.hash).not.toBe(t.raw);
        expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
        // A digest that merely contained the token would be just as bad.
        expect(t.hash).not.toContain(t.raw);
    });

    it('is unguessable — 32 bytes of CSPRNG, base64url', () => {
        const t = mintRebookingToken(NOW);
        expect(t.raw).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(Buffer.from(t.raw, 'base64url')).toHaveLength(32);
    });

    it('produces a distinct token every time', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) seen.add(mintRebookingToken(NOW).raw);
        expect(seen.size).toBe(500);
    });

    it('hashes deterministically, so a link can be looked up by digest', () => {
        const t = mintRebookingToken(NOW);
        expect(hashRebookingToken(t.raw)).toBe(t.hash);
    });

    it('gives different tokens different digests', () => {
        expect(hashRebookingToken('a')).not.toBe(hashRebookingToken('b'));
    });

    it('expires exactly one TTL after issue', () => {
        const t = mintRebookingToken(NOW);
        const days = (t.expiresAt.getTime() - t.issuedAt.getTime()) / 86_400_000;
        expect(days).toBe(REBOOKING_TOKEN_TTL_DAYS);
    });

    it('compares digests without leaking length or content through timing', () => {
        const h = hashRebookingToken('x');
        expect(digestsMatch(h, h)).toBe(true);
        expect(digestsMatch(h, hashRebookingToken('y'))).toBe(false);
        expect(digestsMatch(h, 'short')).toBe(false);
    });
});

// ── 2. Link state classification ─────────────────────────────────────────────

describe('2. what state a link is in', () => {
    const base = { issuedAt: NOW, expiresAt: new Date('2026-09-24T00:00:00.000Z'), revokedAt: null, hasSubmission: false };

    it('a fresh, unanswered link is valid', () => {
        expect(classifyRebookingCredential(base, NOW)).toBe('valid');
    });

    it('an elapsed link is expired', () => {
        expect(classifyRebookingCredential(base, new Date('2026-10-01T00:00:00.000Z'))).toBe('expired');
    });

    it('expiry is inclusive — the exact instant is already expired', () => {
        expect(classifyRebookingCredential(base, base.expiresAt)).toBe('expired');
    });

    it('revocation beats expiry, so a withdrawn link never reads as merely stale', () => {
        const revoked = { ...base, revokedAt: NOW };
        expect(classifyRebookingCredential(revoked, new Date('2026-10-01T00:00:00.000Z'))).toBe('revoked');
    });

    it('an answered link says so instead of saying it expired', () => {
        const answered = { ...base, hasSubmission: true };
        expect(classifyRebookingCredential(answered, new Date('2026-10-01T00:00:00.000Z'))).toBe('already_submitted');
    });

    it('a link with no expiry set stays valid', () => {
        expect(classifyRebookingCredential({ ...base, expiresAt: null }, new Date('2030-01-01'))).toBe('valid');
    });
});

// ── 3. URLs ──────────────────────────────────────────────────────────────────

describe('3. link building', () => {
    it('builds /rebook/{token} on the request origin', () => {
        expect(buildRebookingUrl('https://app.example.com', 'tok')).toBe('https://app.example.com/rebook/tok');
    });

    it('takes the origin from a Request when it has one', () => {
        const req = new Request('https://tenant.example.com/api/whatever?x=1');
        expect(resolveRequestOrigin(req)).toBe('https://tenant.example.com');
    });

    it('refuses to invent an origin it cannot resolve', () => {
        expect(resolveRequestOrigin('nonsense')).toBeNull();
    });

    it('masks a URL without revealing any part of a credential', () => {
        const masked = maskRebookingUrl('https://app.example.com/');
        expect(masked).toBe('https://app.example.com/rebook/•••');
        expect(masked).not.toMatch(/[A-Za-z0-9_-]{20,}/);
    });
});

// ── 4. Validation ────────────────────────────────────────────────────────────

const DETAILS: SubmittedDetails = {
    preferredStartDate: new Date('2026-10-06T00:00:00.000Z'),
    alternateStartDate: null,
    preferredEndDate: new Date('2026-10-24T00:00:00.000Z'),
    participantEstimate: 45,
    notes: null,
};

function org(over: Partial<SubmittedOrg> & { customerId: string }): SubmittedOrg {
    return {
        organizationName: `Org ${over.customerId}`,
        selected: true,
        coordinatorIntent: 'yes',
        coordinatorName: null,
        coordinatorEmail: null,
        orgNotes: null,
        ...over,
    };
}

describe('4. what a submission must satisfy', () => {
    it('accepts an ordinary request', () => {
        expect(validateSubmission([org({ customerId: 'c1' })], DETAILS, ['c1']).ok).toBe(true);
    });

    it('refuses an organization this link does not represent', () => {
        const r = validateSubmission([org({ customerId: 'other' })], DETAILS, ['c1']);
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/cannot book for one of the organizations/i);
    });

    it('refuses a request that selects nothing', () => {
        const r = validateSubmission([org({ customerId: 'c1', selected: false })], DETAILS, ['c1']);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/at least one group/i);
    });

    it('allows a blank coordinator email — "someone else, name unknown" is a real answer', () => {
        const r = validateSubmission(
            [org({ customerId: 'c1', coordinatorIntent: 'no', coordinatorName: 'Dana', coordinatorEmail: null })],
            DETAILS, ['c1'],
        );
        expect(r.ok).toBe(true);
    });

    it('catches a mistyped coordinator email and names the organization', () => {
        const r = validateSubmission(
            [org({ customerId: 'c1', coordinatorIntent: 'no', coordinatorEmail: 'dana@' })],
            DETAILS, ['c1'],
        );
        expect(r.ok).toBe(false);
        expect(r.errors[0]).toMatch(/Org c1/);
    });

    it('refuses a negative or non-integer participant count', () => {
        for (const bad of [-1, 4.5, Number.NaN]) {
            const r = validateSubmission([org({ customerId: 'c1' })], { ...DETAILS, participantEstimate: bad }, ['c1']);
            expect(r.ok).toBe(false);
        }
    });

    it('accepts no participant count at all', () => {
        expect(validateSubmission([org({ customerId: 'c1' })], { ...DETAILS, participantEstimate: null }, ['c1']).ok).toBe(true);
    });

    it('refuses an end date before the start date', () => {
        const r = validateSubmission([org({ customerId: 'c1' })], {
            ...DETAILS,
            preferredStartDate: new Date('2026-10-24T00:00:00.000Z'),
            preferredEndDate: new Date('2026-10-06T00:00:00.000Z'),
        }, ['c1']);
        expect(r.ok).toBe(false);
        expect(r.errors.join(' ')).toMatch(/end date is before the start date/i);
    });

    it('never exposes a column, table or constraint name to a respondent', () => {
        const r = validateSubmission([org({ customerId: 'other' })], { ...DETAILS, participantEstimate: -5 }, ['c1']);
        expect(r.errors.join(' ')).not.toMatch(/customer_id|rebooking_|constraint|prisma|postgres/i);
    });
});

// ── 5. Reconciliation — the heart of it ──────────────────────────────────────

function existing(over: Partial<ExistingOpportunity> & { customerId: string }): ExistingOpportunity {
    return {
        id: `opp-${over.customerId}`,
        status: 'interested',
        coordinatorIntent: 'yes',
        coordinatorName: null,
        coordinatorEmail: null,
        preferredStartDate: DETAILS.preferredStartDate,
        alternateStartDate: null,
        participantEstimate: 45,
        ...over,
    };
}

describe('5. one organization = one future fundraiser', () => {
    it('three selected organizations become three opportunities, not one', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' }), org({ customerId: 'b' }), org({ customerId: 'c' })],
            DETAILS, [],
        );
        expect(plan.actions.filter((a) => a.kind === 'create')).toHaveLength(3);
        expect(plan.addedCustomerIds).toEqual(['a', 'b', 'c']);
    });

    it('re-submitting the same answers creates nothing new', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })], DETAILS, [existing({ customerId: 'a' })],
        );
        expect(plan.actions.filter((a) => a.kind === 'create')).toHaveLength(0);
        expect(plan.actions[0].kind).toBe('update');
    });
});

describe('6. deselecting and reselecting', () => {
    it('deselecting cancels the opportunity', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a', selected: false })], DETAILS, [existing({ customerId: 'a' })],
        );
        expect(plan.actions[0]).toMatchObject({ kind: 'cancel', id: 'opp-a' });
        expect(plan.removedCustomerIds).toEqual(['a']);
    });

    it('reselecting REOPENS the same record rather than minting a twin', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })], DETAILS, [existing({ customerId: 'a', status: 'canceled' })],
        );
        expect(plan.actions[0]).toMatchObject({ kind: 'reopen', id: 'opp-a', status: 'interested' });
        expect(plan.actions.some((a) => a.kind === 'create')).toBe(false);
    });

    it('cancelling an already-cancelled organization is a no-op, not a second cancel', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a', selected: false })], DETAILS, [existing({ customerId: 'a', status: 'canceled' })],
        );
        expect(plan.actions).toHaveLength(0);
        expect(plan.removedCustomerIds).toEqual([]);
    });

    it('an organization that was never selected and never existed does nothing', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a', selected: false })], DETAILS, [],
        );
        expect(plan.actions).toHaveLength(0);
    });
});

describe('7. changes after the tenant approved', () => {
    it('an unchanged re-submit leaves the approval intact', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })], DETAILS, [existing({ customerId: 'a', status: 'approved' })],
        );
        expect(plan.actions[0]).toMatchObject({ kind: 'update', status: 'approved' });
        expect(plan.changedAfterApprovalCustomerIds).toEqual([]);
    });

    it('a MOVED date drops the approval back to needs_review instead of overwriting it', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })],
            { ...DETAILS, preferredStartDate: new Date('2026-11-02T00:00:00.000Z') },
            [existing({ customerId: 'a', status: 'approved' })],
        );
        expect(plan.actions[0]).toMatchObject({ kind: 'update', status: 'needs_review' });
        expect(plan.changedAfterApprovalCustomerIds).toEqual(['a']);
    });

    it('a changed coordinator answer also needs a second look', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a', coordinatorIntent: 'no', coordinatorName: 'Dana' })],
            DETAILS, [existing({ customerId: 'a', status: 'approved' })],
        );
        expect(plan.changedAfterApprovalCustomerIds).toEqual(['a']);
    });

    it('a changed participant count needs a second look', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })],
            { ...DETAILS, participantEstimate: 120 },
            [existing({ customerId: 'a', status: 'approved' })],
        );
        expect(plan.changedAfterApprovalCustomerIds).toEqual(['a']);
    });

    it('a notes-only edit does NOT reopen an approval', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })],
            { ...DETAILS, notes: 'we might need an extra week' },
            [existing({ customerId: 'a', status: 'approved' })],
        );
        expect(plan.actions[0]).toMatchObject({ status: 'approved' });
        expect(plan.changedAfterApprovalCustomerIds).toEqual([]);
    });

    it('a pending organization keeps its status when re-submitted', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })],
            { ...DETAILS, participantEstimate: 99 },
            [existing({ customerId: 'a', status: 'needs_review' })],
        );
        expect(plan.actions[0]).toMatchObject({ kind: 'update', status: 'needs_review' });
    });
});

describe('8. a fundraiser that already exists is untouchable from the form', () => {
    it('deselecting a converted organization cancels nothing', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a', selected: false })], DETAILS, [existing({ customerId: 'a', status: 'converted' })],
        );
        expect(plan.actions).toEqual([{ kind: 'leave_converted', id: 'opp-a', customerId: 'a', deselected: true }]);
        expect(plan.untouchedConvertedCustomerIds).toEqual(['a']);
        expect(plan.removedCustomerIds).toEqual([]);
    });

    it('changing a converted organization changes nothing, and says so', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })],
            { ...DETAILS, preferredStartDate: new Date('2026-12-01T00:00:00.000Z') },
            [existing({ customerId: 'a', status: 'converted' })],
        );
        expect(plan.actions.every((a) => a.kind === 'leave_converted')).toBe(true);
        expect(plan.untouchedConvertedCustomerIds).toEqual(['a']);
    });

    it('an unchanged converted organization is not reported as a conflict', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' })], DETAILS, [existing({ customerId: 'a', status: 'converted' })],
        );
        expect(plan.untouchedConvertedCustomerIds).toEqual([]);
    });
});

describe('9. mixed revisions behave as a whole', () => {
    it('adds one, keeps one and drops one in a single pass', () => {
        const plan = planOpportunityReconciliation(
            [
                org({ customerId: 'keep' }),
                org({ customerId: 'drop', selected: false }),
                org({ customerId: 'add' }),
            ],
            DETAILS,
            [existing({ customerId: 'keep' }), existing({ customerId: 'drop' })],
        );
        expect(plan.addedCustomerIds).toEqual(['add']);
        expect(plan.removedCustomerIds).toEqual(['drop']);
        expect(plan.actions.map((a) => a.kind)).toEqual(['update', 'cancel', 'create']);
    });

    it('never emits two actions for the same organization', () => {
        const plan = planOpportunityReconciliation(
            [org({ customerId: 'a' }), org({ customerId: 'b', selected: false })],
            DETAILS,
            [existing({ customerId: 'a', status: 'canceled' }), existing({ customerId: 'b', status: 'approved' })],
        );
        const ids = plan.actions.map((a) => a.customerId);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
