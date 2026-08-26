/**
 * FR-REBOOK-1 — letting an organization you already know run another fundraiser.
 *
 * THE GAP THIS CLOSES
 *
 * A FundraiserOpportunity is created in exactly one place in the product:
 * app/api/public/fundraiser-request/route.ts, the PUBLIC website inquiry form.
 * Everything downstream of it — the date conversation, the confirm step, the
 * launch route, coordinator setup — is organization-agnostic and works perfectly
 * for a returning group. The only thing missing was a door the owner could open
 * from the inside.
 *
 * So an owner who knew Edgar County Farm Bureau wanted another fundraiser had two
 * options: wait for Edgar's coordinator to fill in the public form as though they
 * were strangers, or run the seasonal-outreach machinery (a SeasonalOffering, an
 * outreach list, a send, and a coordinator clicking a tokenised link) — which in
 * this Production database has zero rows of any kind. Both amount to pretending a
 * known organization is a new lead.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
 *
 * It is NOT a second launch pipeline. It decides one thing: may this organization
 * begin another fundraiser cycle, and which opportunity should carry it. The
 * campaign itself is still created by POST /api/opportunities/[id]/launch, from a
 * date-confirmed opportunity, exactly as it is for a brand-new lead. There is one
 * fundraiser workflow and this is a second entrance to it.
 *
 * ── HISTORY NEVER BLOCKS ────────────────────────────────────────────────────
 *
 * The funnel was designed for return business. lib/fundraiserFunnel.ts calls
 * `converted` and `lost` terminal because "reaching one frees the organization for
 * a future cycle", and the public route's own comment says a converted or lost
 * prior opportunity "does NOT block a new one; that is what lets an organization
 * come back next season". This module keeps that promise and extends it to
 * campaigns: a Closed, Archived, Completed or awaiting-payment prior fundraiser is
 * history, and history is never a reason to refuse new business.
 *
 * That matters concretely. Edgar's prior campaign is Archived, carries $2,065 of
 * real orders, has no invoice, and is not yet marked settled externally — so
 * FR-HISTORY-1 shows it as "Closed — awaiting payment". Requiring that financial
 * record to be tidied before Edgar can sell again would hold a real fundraiser
 * hostage to bookkeeping.
 */

import { classifyCampaignLifecycle, type CampaignLifecycleInput } from './growth/campaignLifecycle';
import { OPEN_OPPORTUNITY_STATUSES } from './fundraiserFunnel';

/** A campaign, as much of it as this decision needs. */
export type RebookingCampaign = CampaignLifecycleInput & { id?: string | null };

export interface RebookingEligibilityInput {
    /** Every campaign this organization has ever had. */
    campaigns?: readonly RebookingCampaign[] | null;
    /** The organization's open FundraiserOpportunity, if one is already running. */
    openOpportunityId?: string | null;
    /** Soft-deleted organizations cannot start anything. */
    archived?: boolean | null;
}

export type RebookingRefusalCode =
    /** The organization record is archived. */
    | 'organization_archived';

export type RebookingEligibility =
    | {
        ok: true;
        /**
         * 'resume' — an open opportunity already exists and will be reused.
         * 'start'  — no open cycle; a new opportunity should be created.
         */
        action: 'resume' | 'start';
        opportunityId: string | null;
        /**
         * Advisory, never a refusal: a fundraiser is operationally live right now.
         * The owner is told so they can plan deliberately, not stopped.
         */
        hasOpenCampaign: boolean;
    }
    | { ok: false; code: RebookingRefusalCode; error: string };

/**
 * Is this campaign operationally live right now?
 *
 * Derived from FR-HISTORY-1's classifier rather than re-implemented, so
 * "currently running" cannot drift between the dashboard and this decision.
 * Only the `open` bucket counts. `closed_awaiting_payment` is explicitly NOT
 * open — money outstanding is a bookkeeping fact, not an operational one, and
 * conflating them is what would block Edgar.
 */
export function isOperationallyOpen(c: RebookingCampaign): boolean {
    return classifyCampaignLifecycle(c) === 'open';
}

/**
 * May this organization begin another fundraiser, and how?
 *
 * ── WHY AN OPEN CAMPAIGN DOES NOT REFUSE ────────────────────────────────────
 *
 * An earlier draft of this module refused when the organization had a live
 * fundraiser, reasoning that a second cycle was probably a double-click. That was
 * an invented restriction, and the evidence is against it on every axis:
 *
 *   - THE EXISTING PRODUCT ALREADY ALLOWS IT. The public inquiry route creates an
 *     opportunity with no campaign precondition whatsoever — its only reference to
 *     FundraiserCampaign is identity disambiguation between candidate customers.
 *     So a returning organization filling in the public form mid-campaign gets an
 *     opportunity today. Refusing here would have made the owner's own entrance
 *     STRICTER than the anonymous one, which is its own bug.
 *   - THE LAUNCH ROUTE DOES NOT CARE EITHER. Its six guards — launchable, order
 *     deadline, selection limit, candidate families, primary coordinator, campaign
 *     name — contain no reference to another campaign.
 *   - THE DATABASE DOES NOT CARE. The only unique indexes on fundraiser_campaigns
 *     are portal_token, public_token and the (customer_id, id) FK target.
 *     Production already holds organizations with five and three campaigns.
 *   - AND THE REAL CASE WANTS IT. A group that runs spring and autumn fundraisers
 *     starts planning the autumn one while the spring one is still selling.
 *     Planning a date is not launching a campaign.
 *
 * The double-click worry it was invented to solve is already solved, better and
 * lower down: the partial unique index fundraiser_opportunities_one_open_per_org
 * makes a duplicate planning cycle impossible at the database level.
 *
 * So a live campaign is reported, not refused. The only refusal left is the one
 * that was never in doubt: you cannot do business with an archived organization.
 */
export function evaluateRebookingEligibility(
    input: RebookingEligibilityInput,
): RebookingEligibility {
    if (input?.archived === true) {
        return {
            ok: false,
            code: 'organization_archived',
            error: 'This organization is archived. Restore it before starting a new fundraiser.',
        };
    }

    const campaigns = Array.isArray(input?.campaigns) ? input.campaigns : [];
    const hasOpenCampaign = campaigns.some(isOperationallyOpen);

    // An open cycle is RESUMED, never duplicated. This mirrors the public inquiry
    // route, which reuses an open opportunity rather than creating a second one,
    // so the two entrances cannot produce different funnel shapes.
    if (typeof input?.openOpportunityId === 'string' && input.openOpportunityId.length > 0) {
        return { ok: true, action: 'resume', opportunityId: input.openOpportunityId, hasOpenCampaign };
    }

    return { ok: true, action: 'start', opportunityId: null, hasOpenCampaign };
}

/**
 * A neutral sentence about a fundraiser that is still running, for the owner to
 * read before planning the next one. Advisory only — it never gates the action.
 */
export function openCampaignNotice(input: RebookingEligibilityInput): string | null {
    const campaigns = Array.isArray(input?.campaigns) ? input.campaigns : [];
    const open = campaigns.filter(isOperationallyOpen).length;
    if (open === 0) return null;
    return open === 1
        ? 'This organization already has a fundraiser running. You can still plan the next one.'
        : `This organization has ${open} fundraisers running. You can still plan the next one.`;
}

/**
 * Should the organization be offered "Start Next Fundraiser" at all?
 *
 * True whenever it could actually begin one. Deliberately independent of whether
 * the organization has history: a group with no campaigns yet is equally
 * startable, and gating on history would only add a rule nobody asked for.
 */
export function canStartNextFundraiser(input: RebookingEligibilityInput): boolean {
    return evaluateRebookingEligibility(input).ok;
}

/**
 * Has this organization run a fundraiser before? Presentation only — it chooses
 * between "Start Next Fundraiser" and "Start Fundraiser", and never gates access.
 */
export function hasFundraiserHistory(input: RebookingEligibilityInput): boolean {
    return (input?.campaigns ?? []).length > 0;
}

/** The action's label, so every surface offering it says the same thing. */
export function rebookingActionLabel(input: RebookingEligibilityInput): string {
    return hasFundraiserHistory(input) ? 'Start Next Fundraiser' : 'Start Fundraiser';
}

/**
 * The Prisma `where` fragment for an organization's open opportunity.
 * Shared so the route and any caller cannot disagree about what "open" means.
 */
export function openOpportunityWhere(businessId: string, customerId: string) {
    return {
        business_id: businessId,
        customer_id: customerId,
        status: { in: [...OPEN_OPPORTUNITY_STATUSES] as any },
    };
}
