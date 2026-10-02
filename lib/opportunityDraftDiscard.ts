/**
 * FR-ORG-DASHBOARD-1A — may this planning opportunity be DISCARDED?
 *
 * ── WHY THIS IS NOT mark_lost ───────────────────────────────────────────────
 *
 * PATCH /api/opportunities/[id] `mark_lost` keeps the row forever, on purpose:
 * "The lead is never deleted. Understanding why prospects disappear is the
 * entire point of recording a disposition." That is right for a real prospect.
 *
 * It is wrong for an accidental, empty draft — the owner clicked Start Next
 * Fundraiser by mistake, nothing was ever said to anyone, and recording that
 * click as a lost prospect would put a false event into the organization's
 * funnel history. So this is a separate, narrowly-authorized capability: a
 * HARD delete, allowed only when every fact below is proven.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * An opportunity is an empty tenant-created draft when ALL of these hold:
 *
 *   status `new`          the earliest open state. `in_conversation` means a
 *                         reply was recorded or dates were discussed;
 *                         `date_confirmed`, `converted` and `lost` are further on.
 *   no inquiry            a FundraiserOpportunity is created in exactly two
 *                         places: the public request form, which creates its
 *                         FundraiserInquiry in the SAME transaction, and the
 *                         tenant's POST /api/opportunities, which never creates
 *                         one. Zero inquiries is therefore the proof that the
 *                         tenant opened it AND that no public inquiry history
 *                         would be destroyed.
 *   no response           first_response_at null — nobody replied to anyone.
 *   no dates              preferred, alternate and confirmed all null.
 *   no campaign           campaign_id and converted_at null.
 *   no disposition        lost_at and lost_reason null.
 *   no planning content   notes empty and no participant estimate. "Empty" is
 *                         what the confirmation dialog promises, so it must be
 *                         literally true.
 *
 * Nothing else in the schema references an opportunity: fundraiser_inquiries
 * is the only foreign key into this table (ON DELETE RESTRICT), and rebooking,
 * automation and outreach rows never point at it. Tenant ownership is proven by
 * the caller's session business id, inside the delete's own WHERE.
 *
 * Every fact is checked TWICE: once here, to decide whether the button exists
 * and to explain a refusal, and again by the database as the WHERE clause of the
 * delete itself (draftDiscardWhere), so nothing that changed in between can be
 * swept away by a stale read.
 */

/** The opportunity fields the rule reads. Dates may arrive as Date or ISO string. */
export interface DraftDiscardOpportunity {
    status: string;
    first_response_at: Date | string | null;
    preferred_delivery_date: Date | string | null;
    alternate_delivery_date: Date | string | null;
    confirmed_delivery_date: Date | string | null;
    campaign_id: string | null;
    converted_at: Date | string | null;
    lost_at: Date | string | null;
    lost_reason: string | null;
    notes: string | null;
    participant_estimate: number | null;
    /** How many FundraiserInquiry rows belong to this opportunity. */
    inquiry_count: number;
}

export type DraftDiscardBlocker =
    | 'not_new'
    | 'has_inquiry'
    | 'responded'
    | 'has_dates'
    | 'has_campaign'
    | 'has_disposition'
    | 'has_planning_details';

export interface DraftDiscardVerdict {
    eligible: boolean;
    blockers: DraftDiscardBlocker[];
}

const present = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

/** The rule above, as a pure function. Order of blockers is stable for tests and copy. */
export function evaluateDraftDiscard(o: DraftDiscardOpportunity | null | undefined): DraftDiscardVerdict {
    if (!o) return { eligible: false, blockers: ['not_new'] };
    const blockers: DraftDiscardBlocker[] = [];
    if (o.status !== 'new') blockers.push('not_new');
    if (!(Number(o.inquiry_count) === 0)) blockers.push('has_inquiry');
    if (present(o.first_response_at)) blockers.push('responded');
    if (present(o.preferred_delivery_date) || present(o.alternate_delivery_date) || present(o.confirmed_delivery_date)) {
        blockers.push('has_dates');
    }
    if (present(o.campaign_id) || present(o.converted_at)) blockers.push('has_campaign');
    if (present(o.lost_at) || present(o.lost_reason)) blockers.push('has_disposition');
    if ((typeof o.notes === 'string' && o.notes.trim() !== '') || present(o.participant_estimate)) {
        blockers.push('has_planning_details');
    }
    return { eligible: blockers.length === 0, blockers };
}

/**
 * The same rule as a Prisma WHERE, for the delete itself. Every predicate the
 * pure rule checks is re-asserted here, so the database refuses a row that
 * changed after it was read. `business_id` is the session's, never the client's.
 */
export function draftDiscardWhere(opportunityId: string, businessId: string) {
    return {
        id: opportunityId,
        business_id: businessId,
        status: 'new',
        first_response_at: null,
        preferred_delivery_date: null,
        alternate_delivery_date: null,
        confirmed_delivery_date: null,
        campaign_id: null,
        converted_at: null,
        lost_at: null,
        lost_reason: null,
        participant_estimate: null,
        OR: [{ notes: null }, { notes: '' }],
        inquiries: { none: {} },
    };
}

/** Owner-facing reason a draft cannot be discarded, for the refusal response. */
export function draftDiscardRefusal(blockers: readonly DraftDiscardBlocker[]): string {
    if (blockers.includes('has_inquiry')) {
        return 'This fundraiser came from a real inquiry, so it can’t be discarded. Use “Not proceeding” in Leads instead.';
    }
    if (blockers.includes('has_campaign')) {
        return 'A fundraiser has already been created from this plan, so it can’t be discarded.';
    }
    if (blockers.includes('has_disposition')) {
        return 'This plan is already closed and can’t be discarded.';
    }
    return 'This plan already has activity — a reply, dates or notes — so it can’t be discarded. Use “Not proceeding” in Leads instead.';
}
