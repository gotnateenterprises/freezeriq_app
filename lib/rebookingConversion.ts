/**
 * FR-RETENTION-5 — approved rebooking opportunity → fundraiser campaign.
 *
 * This module holds the RULES. The route holds the plumbing, and the database
 * holds the guarantee. Keeping the rules pure means the interesting cases —
 * "can this state convert?", "what may we prefill?" — are testable without a
 * database, which is where the mistakes would otherwise hide.
 *
 * WHAT CHECKPOINT 5 IS, precisely:
 *   Approved → Start Fundraiser → the EXISTING StartFundraiserWizard →
 *   exactly one FundraiserCampaign → opportunity converted and linked.
 *
 * WHAT IT IS NOT: a second fundraiser-creation engine. Campaigns are still
 * created by POST /api/campaigns with all of its existing validation, defaults,
 * bundle rules and tenant checks untouched. Conversion adds a gate in front and
 * a link behind, nothing else.
 *
 * PROVENANCE: FundraiserCampaign has no source/origin column, and this
 * checkpoint does not add one. RebookingOpportunity.campaign_id is the link, and
 * it answers the only question anyone actually asks — "did this fundraiser come
 * from a rebooking response, and which one?" — without inventing a campaign
 * taxonomy nothing else needs yet.
 */

export type OpportunityStatus =
    | 'interested'
    | 'approved'
    | 'needs_review'
    | 'canceled'
    | 'converted';

export type CoordinatorIntent = 'yes' | 'no' | 'not_sure';

/** Everything the conversion gate needs to judge an opportunity. */
export interface ConvertibleOpportunity {
    id: string;
    businessId: string;
    customerId: string;
    status: OpportunityStatus;
    campaignId: string | null;
}

export type ConversionRefusal =
    | 'not_found'
    | 'not_approved'
    | 'canceled'
    | 'already_converted'
    | 'organization_mismatch';

export interface ConversionVerdict {
    ok: boolean;
    refusal: ConversionRefusal | null;
    /** Plain tenant-facing sentence. Never names a column or a constraint. */
    message: string | null;
    /** Present when the refusal is `already_converted` and a campaign is linked. */
    existingCampaignId: string | null;
}

const OK: ConversionVerdict = { ok: true, refusal: null, message: null, existingCampaignId: null };

function refuse(refusal: ConversionRefusal, message: string, existingCampaignId: string | null = null): ConversionVerdict {
    return { ok: false, refusal, message, existingCampaignId };
}

/**
 * May this opportunity become a fundraiser?
 *
 * Only `approved` may convert. The other states are refused for different
 * reasons and say so differently, because "you haven't approved this yet" and
 * "this one is already a fundraiser" need completely different next actions from
 * the tenant.
 *
 * `expectedCustomerId`, when supplied, is the organization the CLIENT claims to
 * be creating for. It is compared here and again in the database WHERE clause —
 * a browser must never be able to attach an opportunity for one organization to
 * a campaign for another.
 */
export function evaluateConversion(
    opportunity: ConvertibleOpportunity | null,
    expectedBusinessId: string,
    expectedCustomerId?: string,
): ConversionVerdict {
    // Indistinguishable from "belongs to another tenant" on purpose: a tenant
    // must not be able to probe for the existence of another tenant's rows.
    if (!opportunity || opportunity.businessId !== expectedBusinessId) {
        return refuse('not_found', 'That rebooking request could not be found.');
    }

    if (opportunity.status === 'converted') {
        return refuse(
            'already_converted',
            'A fundraiser has already been created for this organization.',
            opportunity.campaignId,
        );
    }

    if (opportunity.status === 'canceled') {
        return refuse('canceled', 'This organization was closed for the season, so a fundraiser cannot be started from it.');
    }

    if (opportunity.status !== 'approved') {
        return refuse('not_approved', 'Approve this organization before starting its fundraiser.');
    }

    if (expectedCustomerId !== undefined && opportunity.customerId !== expectedCustomerId) {
        return refuse('organization_mismatch', 'That fundraiser is for a different organization than this request.');
    }

    // An approved opportunity that somehow already carries a campaign link is
    // treated as converted rather than allowed through — the link is the thing
    // that actually matters, not the status label.
    if (opportunity.campaignId) {
        return refuse(
            'already_converted',
            'A fundraiser has already been created for this organization.',
            opportunity.campaignId,
        );
    }

    return OK;
}

/** HTTP status for each refusal. Kept next to the rule it belongs to. */
export function refusalHttpStatus(refusal: ConversionRefusal): number {
    switch (refusal) {
        case 'not_found': return 404;
        // Conflict, not forbidden: the request was legitimate, the state was not.
        case 'not_approved':
        case 'canceled':
        case 'already_converted':
            return 409;
        case 'organization_mismatch': return 400;
    }
}

// ── Prefill ──────────────────────────────────────────────────────────────────

/**
 * The rebooking evidence a wizard may start from.
 *
 * "Evidence" is the operative word. Everything here is what somebody TOLD us in
 * a response. None of it is authoritative, none of it edits the CRM, and the
 * tenant confirms all of it in the wizard before a fundraiser exists.
 */
export interface ConversionPrefillInput {
    organizationName: string;
    lineupName: string;
    /** Calendar dates as stored: UTC midnight, or null. */
    preferredStartDate: Date | null;
    alternateStartDate: Date | null;
    requestedEndDate: Date | null;
    participantEstimate: number | null;
    coordinatorIntent: CoordinatorIntent;
    coordinatorName: string | null;
    respondentName: string;
    /** Bundle families on the Seasonal Lineup, in lineup order. */
    lineupFamilyIds: string[];
    /** Families the tenant can actually sell right now (CB-4 resolver). */
    eligibleFamilyIds: string[];
    /** The lineup's coordinator bundle limit. */
    coordinatorBundleLimit: number;
}

export interface ConversionPrefill {
    campaignName: string;
    /** yyyy-mm-dd, matching what a <input type="date"> expects. */
    endDate: string | null;
    participantEstimate: number | null;
    /** Lineup families that are still sellable, in lineup order. */
    candidateFamilyIds: string[];
    /** Clamped so the wizard never opens in a state its own rules reject. */
    selectionLimit: number;
    /** Lineup families that are no longer sellable, so the tenant is told. */
    droppedFamilyIds: string[];
    coordinatorNote: string;
    coordinatorKnown: boolean;
}

/** A stored calendar date rendered as yyyy-mm-dd without a timezone shift. */
export function toDateInputValue(date: Date | null): string | null {
    if (!date) return null;
    const t = date.getTime();
    if (Number.isNaN(t)) return null;
    return date.toISOString().slice(0, 10);
}

/**
 * What the wizard should open with.
 *
 * The two things worth understanding here:
 *
 *  1. Lineup families are INTERSECTED with what is currently sellable. A season
 *     planned in August may contain a bundle that was retired in September, and
 *     silently carrying it forward would produce a campaign whose candidate pool
 *     the coordinator cannot actually order from. Dropped families are returned
 *     so the tenant sees the gap rather than discovering it later.
 *
 *  2. selectionLimit is clamped to the surviving pool. The campaign API refuses
 *     a limit larger than the pool, so opening the wizard in that state would be
 *     handing the tenant a form that cannot be submitted.
 */
export function buildConversionPrefill(input: ConversionPrefillInput): ConversionPrefill {
    const eligible = new Set(input.eligibleFamilyIds);
    const candidateFamilyIds = input.lineupFamilyIds.filter((id) => eligible.has(id));
    const droppedFamilyIds = input.lineupFamilyIds.filter((id) => !eligible.has(id));

    const limit = Number.isInteger(input.coordinatorBundleLimit) && input.coordinatorBundleLimit >= 1
        ? input.coordinatorBundleLimit
        : 1;
    const selectionLimit = candidateFamilyIds.length > 0
        ? Math.min(limit, candidateFamilyIds.length)
        : limit;

    return {
        // Names the season, not the current year: this fundraiser belongs to the
        // lineup the organization was invited to.
        campaignName: `${input.organizationName} ${input.lineupName}`.trim(),
        endDate: toDateInputValue(input.requestedEndDate),
        participantEstimate: input.participantEstimate,
        candidateFamilyIds,
        selectionLimit,
        droppedFamilyIds,
        coordinatorNote: describeCoordinatorIntent(input),
        coordinatorKnown: input.coordinatorIntent === 'yes' || Boolean(input.coordinatorName),
    };
}

/**
 * How the coordinator situation is described to the tenant.
 *
 * This is deliberately worded as reported speech. Nobody becomes a coordinator
 * by answering a form — not the respondent, not a named replacement — and the
 * copy must not let a tenant believe otherwise. Checkpoint 5 creates no
 * CampaignContact and grants no portal access to any person.
 */
export function describeCoordinatorIntent(input: {
    coordinatorIntent: CoordinatorIntent;
    coordinatorName: string | null;
    respondentName: string;
}): string {
    switch (input.coordinatorIntent) {
        case 'yes':
            return `${input.respondentName} said they can coordinate this one.`;
        case 'no':
            return input.coordinatorName
                ? `${input.respondentName} said ${input.coordinatorName} will coordinate. Nothing has been set up for them yet.`
                : `${input.respondentName} said someone else will coordinate, but didn't say who.`;
        case 'not_sure':
            return 'Nobody has been named as coordinator yet.';
    }
}

/**
 * Is a prefilled date already in the past?
 *
 * A rebooking response can sit for weeks before a tenant reviews it, so a
 * requested date is genuinely likely to have gone stale. The existing wizard has
 * no date validation at all and this checkpoint does not add a block — it adds a
 * warning, so a stale date cannot pass unnoticed but a tenant who means it can
 * still proceed.
 */
export function isPastCalendarDate(value: string | null, now: Date = new Date()): boolean {
    if (!value) return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return target < today;
}
