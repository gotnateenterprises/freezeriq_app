/**
 * FR-FLOW-2B — the rules for turning a date-confirmed opportunity into a
 * fundraiser campaign.
 *
 * The decisions live here rather than inside the route handler so they can be
 * exercised for real instead of asserted against source text. The route is a
 * shell that resolves rows, calls these, and writes inside one transaction.
 *
 * Nothing in this file reads a clock, a global, or a timezone. Deadline
 * SEMANTICS — which calendar day an end_date is still open through — belong to
 * lib/tenantTimezone.ts and lib/campaignBundleSelection.ts and are not
 * reimplemented here. What this file decides is narrower: whether the dates a
 * tenant typed are a coherent fundraiser at all.
 */

import { calendarDateOfDateOnlyValue } from '@/lib/tenantTimezone';

/** The one opportunity status that may become a campaign. */
export const LAUNCHABLE_OPPORTUNITY_STATUS = 'date_confirmed' as const;

/** The bundle-selection state every FR-FLOW-2 campaign is born in. */
export const AWAITING_COORDINATOR_SETUP_SELECTION_STATUS = 'pending' as const;

/**
 * The lifecycle status a launched campaign is stored with.
 *
 * Deliberately 'Active', not a new value. The public listing matches
 * `fc.status = 'Active'` case-sensitively, and the thing that actually keeps a
 * freshly launched fundraiser off the storefront is
 * bundle_selection_status = 'pending', which the same query excludes. Inventing
 * a new status here would move the block from a tested predicate to an untested
 * one. The CRM shows "Awaiting Coordinator Setup" by DERIVING it — see
 * lib/campaignDisplayStage.ts.
 */
export const LAUNCHED_CAMPAIGN_STATUS = 'Active' as const;

export type LaunchRefusal = {
    ok: false;
    /** Stable machine code, safe to assert on. */
    code: string;
    /** Message intended for the tenant operating the CRM, never for a supporter. */
    error: string;
    status: 400 | 403 | 404 | 409;
};
export type LaunchOk<T> = { ok: true } & T;

/* ── Opportunity eligibility ─────────────────────────────────────────────── */

export interface LaunchableOpportunity {
    status: string;
    confirmed_delivery_date: Date | string | null;
    campaign_id: string | null;
}

/**
 * Whether this opportunity may become a campaign.
 *
 * A UI that hides the button is not a gate; this is the gate. All three
 * conditions are checked server-side because all three are forgeable from a
 * client: the status, the presence of a confirmed date, and the absence of an
 * existing campaign.
 */
export function checkOpportunityLaunchable(
    o: LaunchableOpportunity
): LaunchOk<{ confirmedDeliveryDate: string }> | LaunchRefusal {
    if (o.campaign_id) {
        return {
            ok: false,
            code: 'already_converted',
            error: 'This opportunity has already been launched as a fundraiser.',
            status: 409,
        };
    }

    if (o.status !== LAUNCHABLE_OPPORTUNITY_STATUS) {
        return {
            ok: false,
            code: 'not_date_confirmed',
            error: 'Confirm the fundraiser date before launching the campaign.',
            status: 409,
        };
    }

    // date_confirmed without a confirmed date would be a contradiction, but the
    // column is nullable, so it is proven rather than assumed.
    if (!o.confirmed_delivery_date) {
        return {
            ok: false,
            code: 'missing_confirmed_date',
            error: 'This opportunity has no confirmed delivery date.',
            status: 409,
        };
    }

    const confirmed = calendarDateOfDateOnlyValue(o.confirmed_delivery_date);
    if (!confirmed) {
        return {
            ok: false,
            code: 'unreadable_confirmed_date',
            error: 'This opportunity has no confirmed delivery date.',
            status: 409,
        };
    }

    // OPS-LAUNCH-HOTFIX-1: a structural sanity floor, not a business-logic
    // "is this a sensible date" check (this file reads no clock, on purpose).
    // calendarDateOfDateOnlyValue always zero-pads to at least 4 digits now, so
    // a year below 1000 can only mean the stored value never had a normal
    // 4-digit year to begin with — the exact shape that reached the database
    // for one opportunity through some path other than this app's own writes,
    // and that otherwise produced an unparseable Date at campaign-creation time.
    const year = Number(confirmed.slice(0, confirmed.indexOf('-')));
    if (year < 1000) {
        return {
            ok: false,
            code: 'implausible_confirmed_date',
            error: 'This opportunity\'s confirmed delivery date looks incorrect. Re-confirm the delivery date, then launch again.',
            status: 409,
        };
    }

    return { ok: true, confirmedDeliveryDate: confirmed };
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

/**
 * The supporter order deadline, checked against the delivery day.
 *
 * `end_date` is REQUIRED for every new digital campaign — the whole point of
 * FR-ORDERABILITY-1 was that a fundraiser with no deadline never stops taking
 * money. The only relationship enforced is that ordering cannot still be open
 * after the food has been handed over; equal dates are allowed, because "order
 * through the morning of delivery" is a real way to run a fundraiser. No minimum
 * lead time is invented here — that is a tenant's business decision.
 */
export function checkOrderDeadline(input: {
    endDate: unknown;
    confirmedDeliveryDate: string;
}): LaunchOk<{ endDate: string }> | LaunchRefusal {
    const { endDate, confirmedDeliveryDate } = input;

    if (endDate === null || endDate === undefined || endDate === '') {
        return {
            ok: false,
            code: 'end_date_required',
            error: 'Enter the last day supporters may place orders.',
            status: 400,
        };
    }
    if (typeof endDate !== 'string' && !(endDate instanceof Date)) {
        return {
            ok: false,
            code: 'end_date_invalid',
            error: 'Enter the last day supporters may place orders.',
            status: 400,
        };
    }

    const parsed = calendarDateOfDateOnlyValue(
        typeof endDate === 'string' ? `${endDate.slice(0, 10)}T00:00:00.000Z` : endDate
    );
    if (!parsed) {
        return {
            ok: false,
            code: 'end_date_invalid',
            error: 'Enter the last day supporters may place orders.',
            status: 400,
        };
    }

    // ISO 'YYYY-MM-DD' strings compare correctly as text.
    if (parsed > confirmedDeliveryDate) {
        return {
            ok: false,
            code: 'end_date_after_delivery',
            error: 'Supporter ordering must close on or before the delivery date.',
            status: 400,
        };
    }

    return { ok: true, endDate: parsed };
}

/* ── Coordinator selection count ─────────────────────────────────────────── */

/**
 * How many families the coordinator must choose.
 *
 * `bundle_selection_limit` is an EXACT count, not a maximum — the coordinator
 * flow compares with strict equality. Requiring more families than the tenant
 * offered would be unsatisfiable, so the upper bound is the candidate count.
 */
export function checkSelectionLimit(input: {
    selectionLimit: unknown;
    candidateFamilyCount: number;
}): LaunchOk<{ selectionLimit: number }> | LaunchRefusal {
    const { selectionLimit, candidateFamilyCount } = input;

    if (typeof selectionLimit !== 'number' || !Number.isInteger(selectionLimit)) {
        return {
            ok: false,
            code: 'selection_limit_invalid',
            error: 'Choose how many bundle options the coordinator must select.',
            status: 400,
        };
    }
    if (selectionLimit < 1) {
        return {
            ok: false,
            code: 'selection_limit_too_low',
            error: 'The coordinator must choose at least one bundle option.',
            status: 400,
        };
    }
    if (selectionLimit > candidateFamilyCount) {
        return {
            ok: false,
            code: 'selection_limit_exceeds_candidates',
            error: 'The coordinator cannot be asked to choose more options than you offered.',
            status: 400,
        };
    }
    return { ok: true, selectionLimit };
}

/* ── Candidate families ──────────────────────────────────────────────────── */

/**
 * The tenant's chosen candidate families, checked against what the tenant may
 * actually offer.
 *
 * `eligibleFamilyIds` must come from resolveEligibleBundleFamilies(businessId) —
 * already tenant-scoped, already requiring exactly one Serves-5 and one Serves-2
 * sibling per family. Passing anything else would make this validation a
 * formality. Serving variants are never counted separately: a family is one
 * entry here regardless of how many tiers it has.
 */
export function checkCandidateFamilies(input: {
    candidateFamilyIds: unknown;
    eligibleFamilyIds: string[];
}): LaunchOk<{ candidateFamilyIds: string[] }> | LaunchRefusal {
    const { candidateFamilyIds, eligibleFamilyIds } = input;

    if (!Array.isArray(candidateFamilyIds) || candidateFamilyIds.some((x) => typeof x !== 'string')) {
        return {
            ok: false,
            code: 'candidates_invalid',
            error: 'Select the bundle options this fundraiser may offer.',
            status: 400,
        };
    }

    const trimmed = (candidateFamilyIds as string[]).map((s) => s.trim()).filter((s) => s !== '');
    if (trimmed.length === 0) {
        return {
            ok: false,
            code: 'candidates_empty',
            error: 'Select at least one bundle option for the coordinator to choose from.',
            status: 400,
        };
    }
    if (new Set(trimmed).size !== trimmed.length) {
        return {
            ok: false,
            code: 'candidates_duplicated',
            error: 'The same bundle option was selected more than once.',
            status: 400,
        };
    }

    const eligible = new Set(eligibleFamilyIds);
    // Deliberately does NOT name which id failed. A tenant picking from their own
    // list does not need it, and an attacker probing ids should learn nothing.
    if (trimmed.some((id) => !eligible.has(id))) {
        return {
            ok: false,
            code: 'candidates_not_eligible',
            error: 'One or more selected bundle options are no longer available. Refresh and try again.',
            status: 400,
        };
    }

    return { ok: true, candidateFamilyIds: trimmed };
}

/* ── Primary coordinator ─────────────────────────────────────────────────── */

export interface CoordinatorRelationshipRow {
    id: string;
    business_id: string;
    customer_id: string;
    ended_at: Date | null;
}

/**
 * The organization-contact relationship the tenant nominated as coordinator.
 *
 * The database already makes a cross-organization assignment unwritable — both
 * foreign keys on fundraiser_campaign_coordinators are keyed on one customer_id.
 * This check exists so the tenant gets a clear refusal instead of a constraint
 * violation, and so the SAME-TENANT-WRONG-ORGANIZATION case is refused by name
 * rather than by accident. It is a second lock on a door the database already
 * bolts, which is the correct number of locks for tenant isolation.
 *
 * `row` must have been fetched with the caller's business_id in the WHERE
 * clause; passing an unscoped row would defeat the purpose.
 */
export function checkPrimaryCoordinator(input: {
    row: CoordinatorRelationshipRow | null;
    expectedBusinessId: string;
    expectedCustomerId: string;
}): LaunchOk<{ orgContactId: string }> | LaunchRefusal {
    const { row, expectedBusinessId, expectedCustomerId } = input;

    // Not found, wrong tenant and wrong organization all answer identically, so
    // the response cannot be used to probe another tenant's address book.
    if (!row || row.business_id !== expectedBusinessId || row.customer_id !== expectedCustomerId) {
        return {
            ok: false,
            code: 'coordinator_not_in_organization',
            error: 'Choose a coordinator from this organization.',
            status: 400,
        };
    }

    if (row.ended_at) {
        return {
            ok: false,
            code: 'coordinator_relationship_ended',
            error: 'That contact is no longer active for this organization.',
            status: 400,
        };
    }

    return { ok: true, orgContactId: row.id };
}

/* ── Campaign name ───────────────────────────────────────────────────────── */

export function checkCampaignName(name: unknown): LaunchOk<{ name: string }> | LaunchRefusal {
    if (typeof name !== 'string' || name.trim() === '') {
        return { ok: false, code: 'name_required', error: 'Enter a fundraiser name.', status: 400 };
    }
    if (name.trim().length > 200) {
        return { ok: false, code: 'name_too_long', error: 'Fundraiser name is too long.', status: 400 };
    }
    return { ok: true, name: name.trim() };
}

export function isRefusal(v: { ok: boolean }): v is LaunchRefusal {
    return v.ok === false;
}
