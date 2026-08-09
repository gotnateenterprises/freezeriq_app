/**
 * FR-RETENTION-4 — what a submission DOES.
 *
 * Kept pure and free of Prisma on purpose: the rules below are the part that is
 * easy to get subtly wrong, and they deserve to be testable without a database.
 * The route applies the plan; this module decides it.
 *
 * THE RULES, in the order they matter:
 *
 *   1. One organization = one future fundraiser. Selecting three organizations
 *      produces three opportunities, never one merged booking.
 *
 *   2. Updating is not duplicating. A second submit appends a revision and
 *      RECONCILES the existing opportunities. It never creates a parallel set.
 *
 *   3. Deselecting cancels; reselecting REOPENS the same record. History stays
 *      attached to one row rather than scattering across abandoned twins.
 *
 *   4. A change to something the tenant already APPROVED is surfaced, never
 *      applied silently. A coordinator who moves their dates after approval must
 *      not be able to do so without the tenant seeing it.
 *
 *   5. A CONVERTED opportunity is never mutated by a form. A real fundraiser
 *      exists at that point; a public page must not cancel or rewrite it. The
 *      revision still records what was asked, so nothing is lost.
 */

export type CoordinatorIntent = 'yes' | 'no' | 'not_sure';

export type OpportunityStatus =
    | 'interested'
    | 'approved'
    | 'needs_review'
    | 'canceled'
    | 'converted';

/** One organization as the respondent just answered for it. */
export interface SubmittedOrg {
    customerId: string;
    organizationName: string;
    selected: boolean;
    coordinatorIntent: CoordinatorIntent;
    coordinatorName: string | null;
    coordinatorEmail: string | null;
    orgNotes: string | null;
}

/** The timing/scale answers, which are shared across all selected orgs. */
export interface SubmittedDetails {
    preferredStartDate: Date | null;
    alternateStartDate: Date | null;
    preferredEndDate: Date | null;
    participantEstimate: number | null;
    notes: string | null;
}

/** An opportunity as it exists right now, before this submission is applied. */
export interface ExistingOpportunity {
    id: string;
    customerId: string;
    status: OpportunityStatus;
    coordinatorIntent: CoordinatorIntent;
    coordinatorName: string | null;
    coordinatorEmail: string | null;
    preferredStartDate: Date | null;
    alternateStartDate: Date | null;
    participantEstimate: number | null;
}

export type OpportunityAction =
    | { kind: 'create'; customerId: string; organizationName: string; status: OpportunityStatus }
    | { kind: 'reopen'; id: string; customerId: string; status: OpportunityStatus }
    | { kind: 'update'; id: string; customerId: string; status: OpportunityStatus }
    | { kind: 'cancel'; id: string; customerId: string }
    | { kind: 'leave_converted'; id: string; customerId: string; deselected: boolean };

export interface ReconciliationPlan {
    actions: OpportunityAction[];
    /** Organizations newly added by this revision, for the confirmation copy. */
    addedCustomerIds: string[];
    /** Organizations dropped by this revision. */
    removedCustomerIds: string[];
    /**
     * Approved organizations whose details the respondent changed. These become
     * `needs_review` and are what the tenant is asked to look at again.
     */
    changedAfterApprovalCustomerIds: string[];
    /**
     * Converted organizations the respondent tried to change or drop. Nothing is
     * applied to them; they are reported so the tenant is not left guessing.
     */
    untouchedConvertedCustomerIds: string[];
}

/** Date equality that ignores the difference between null and undefined. */
function sameDate(a: Date | null, b: Date | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.getTime() === b.getTime();
}

/**
 * Did the respondent actually change anything material about this organization?
 *
 * Deliberately narrow: only the things a tenant would have scheduled against.
 * Free-text notes are excluded — a typo fix should not reopen an approval.
 */
function detailsChanged(
    existing: ExistingOpportunity,
    org: SubmittedOrg,
    details: SubmittedDetails,
): boolean {
    return (
        !sameDate(existing.preferredStartDate, details.preferredStartDate)
        || !sameDate(existing.alternateStartDate, details.alternateStartDate)
        || existing.participantEstimate !== details.participantEstimate
        || existing.coordinatorIntent !== org.coordinatorIntent
        || (existing.coordinatorEmail ?? null) !== (org.coordinatorEmail ?? null)
        || (existing.coordinatorName ?? null) !== (org.coordinatorName ?? null)
    );
}

/**
 * Decide what this submission does to the existing opportunities.
 *
 * `orgs` must cover EVERY organization the recipient represents, selected or
 * not — the unselected ones are how a deselection is expressed, and dropping
 * them from the payload would make removal indistinguishable from silence.
 */
export function planOpportunityReconciliation(
    orgs: SubmittedOrg[],
    details: SubmittedDetails,
    existing: ExistingOpportunity[],
): ReconciliationPlan {
    const byCustomer = new Map(existing.map((e) => [e.customerId, e]));

    const actions: OpportunityAction[] = [];
    const addedCustomerIds: string[] = [];
    const removedCustomerIds: string[] = [];
    const changedAfterApprovalCustomerIds: string[] = [];
    const untouchedConvertedCustomerIds: string[] = [];

    for (const org of orgs) {
        const prior = byCustomer.get(org.customerId);

        // Rule 5 — a real fundraiser exists; a public form does not touch it.
        if (prior?.status === 'converted') {
            const deselected = !org.selected;
            if (deselected || detailsChanged(prior, org, details)) {
                untouchedConvertedCustomerIds.push(org.customerId);
            }
            actions.push({ kind: 'leave_converted', id: prior.id, customerId: org.customerId, deselected });
            continue;
        }

        if (org.selected) {
            if (!prior) {
                actions.push({
                    kind: 'create',
                    customerId: org.customerId,
                    organizationName: org.organizationName,
                    status: 'interested',
                });
                addedCustomerIds.push(org.customerId);
                continue;
            }

            if (prior.status === 'canceled') {
                // Rule 3 — reopen THIS record, don't mint a twin.
                actions.push({ kind: 'reopen', id: prior.id, customerId: org.customerId, status: 'interested' });
                addedCustomerIds.push(org.customerId);
                continue;
            }

            // Rule 4 — a change to an approved booking is surfaced, not applied
            // quietly. An unchanged re-submit keeps the approval intact.
            if (prior.status === 'approved') {
                const changed = detailsChanged(prior, org, details);
                if (changed) changedAfterApprovalCustomerIds.push(org.customerId);
                actions.push({
                    kind: 'update',
                    id: prior.id,
                    customerId: org.customerId,
                    status: changed ? 'needs_review' : 'approved',
                });
                continue;
            }

            actions.push({ kind: 'update', id: prior.id, customerId: org.customerId, status: prior.status });
            continue;
        }

        // Not selected.
        if (prior && prior.status !== 'canceled') {
            actions.push({ kind: 'cancel', id: prior.id, customerId: org.customerId });
            removedCustomerIds.push(org.customerId);
        }
    }

    return {
        actions,
        addedCustomerIds,
        removedCustomerIds,
        changedAfterApprovalCustomerIds,
        untouchedConvertedCustomerIds,
    };
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface SubmissionValidationResult {
    ok: boolean;
    /** Plain, respondent-facing. Never mentions a column, table, or constraint. */
    errors: string[];
}

const MAX_NOTES = 2000;
const MAX_NAME = 200;
const MAX_PARTICIPANTS = 100_000;

function plausibleEmail(value: string): boolean {
    const v = value.trim();
    if (!v || /\s/.test(v)) return false;
    const at = v.indexOf('@');
    if (at <= 0 || at !== v.lastIndexOf('@')) return false;
    const domain = v.slice(at + 1);
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * Validate one submission.
 *
 * The bar is deliberately low. This is a volunteer filling in a form on a phone,
 * and the cost of rejecting a real request is much higher than the cost of
 * accepting a slightly untidy one. We refuse only what we genuinely cannot act
 * on, or what would be a lie if stored.
 */
export function validateSubmission(
    orgs: SubmittedOrg[],
    details: SubmittedDetails,
    representedCustomerIds: string[],
): SubmissionValidationResult {
    const errors: string[] = [];
    const represented = new Set(representedCustomerIds);

    if (orgs.length === 0) {
        errors.push('We could not tell which organizations this is for.');
    }

    for (const org of orgs) {
        // An organization the link does not represent is not a validation
        // nicety — it is someone trying to book for a group they were not
        // invited for.
        if (!represented.has(org.customerId)) {
            errors.push('This link cannot book for one of the organizations that was submitted.');
            break;
        }
    }

    if (orgs.length > 0 && !orgs.some((o) => o.selected)) {
        errors.push('Choose at least one group, or let us know you are sitting this season out.');
    }

    for (const org of orgs) {
        if (!org.selected) continue;
        if (org.coordinatorName && org.coordinatorName.length > MAX_NAME) {
            errors.push('That coordinator name is too long.');
        }
        // Blank is fine — "someone else will, and I don't know their email yet"
        // is a real answer the prototype explicitly allows.
        if (org.coordinatorEmail && !plausibleEmail(org.coordinatorEmail)) {
            errors.push(`Check the email address for ${org.organizationName}.`);
        }
    }

    if (details.participantEstimate !== null) {
        if (!Number.isInteger(details.participantEstimate) || details.participantEstimate < 0) {
            errors.push('Enter the number of participants as a whole number.');
        } else if (details.participantEstimate > MAX_PARTICIPANTS) {
            errors.push('That participant count looks too high — please check it.');
        }
    }

    if (details.preferredStartDate && details.preferredEndDate
        && details.preferredEndDate < details.preferredStartDate) {
        errors.push('The end date is before the start date.');
    }

    if (details.notes && details.notes.length > MAX_NOTES) {
        errors.push('That note is too long — please shorten it.');
    }

    return { ok: errors.length === 0, errors };
}
