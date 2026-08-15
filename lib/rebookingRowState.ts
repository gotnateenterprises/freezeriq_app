/**
 * FR-RETENTION-6 — Rebooking row lifecycle: the pure rules.
 *
 * Lives beside the other retention rule modules (`rebookingToken`,
 * `rebookingConversion`, `outreachMessage`) for the same reason they do: the
 * decision logic has to be testable without a database, a session, or Next's
 * request pipeline. The route stays a thin reader that fetches evidence and
 * calls in here.
 *
 * WHAT WENT WRONG BEFORE: the CP1 contacts route derived only the three states
 * that exist before any outreach — archived, cant_email, ready_to_invite — and
 * was never revisited once Checkpoints 2–5 shipped the real send, response, and
 * conversion engine. Every emailable contact therefore stayed "Ready to invite"
 * permanently, and the Waiting/Done counts were hardcoded to zero. Nothing was
 * broken in the engine; the CRM simply could not see it.
 */

import { formatCalendarDateShort } from '@/lib/calendarDate';

export type RebookingStatus =
    | 'ready_to_invite'
    | 'update_sent'
    | 'interested'
    | 'needs_review'
    | 'needs_coordinator'
    | 'ready_to_create'
    | 'rebooked'
    | 'paused_until'
    | 'cant_email'
    | 'archived';

/**
 * Which filter chip a row answers to. Derived from the single row status, so a
 * chip's count can never disagree with the rows behind it — CP1 counted with one
 * definition and filtered with another, which is exactly how "Waiting" and
 * "Done" could sit at zero while real work existed.
 */
export type RebookingBucket = 'ready_to_invite' | 'waiting' | 'needs_action' | 'done' | 'none';

export function bucketForStatus(status: RebookingStatus, needsReviewFlag: boolean): RebookingBucket {
    switch (status) {
        case 'ready_to_invite':
            // A contact flagged for identity review still needs a human first.
            return needsReviewFlag ? 'needs_action' : 'ready_to_invite';
        case 'update_sent':
            return 'waiting';
        case 'interested':
        case 'needs_review':
        case 'needs_coordinator':
        case 'ready_to_create':
        case 'cant_email':
            return 'needs_action';
        case 'rebooked':
            return 'done';
        // Archived and paused are deliberately reachable only from "All": they
        // are resting states, not work queues.
        case 'archived':
        case 'paused_until':
            return 'none';
    }
}

export interface PreferenceRow {
    status: 'subscribed' | 'unsubscribed' | 'paused' | 'not_interested';
    effective_at: Date;
    effective_until: Date | null;
}

/**
 * The one preference actually in force right now.
 *
 * Rows are append-only history, so the newest row that has taken effect and has
 * not lapsed wins. A `paused` whose `effective_until` has passed is simply over
 * — it must not keep suppressing someone forever.
 */
export function resolveActivePreference(prefs: PreferenceRow[], now: Date): PreferenceRow | null {
    const live = prefs
        .filter((p) => p.effective_at <= now)
        .filter((p) => {
            if (p.status !== 'paused' && p.status !== 'not_interested') return true;
            return p.effective_until === null || p.effective_until > now;
        })
        .sort((a, b) => b.effective_at.getTime() - a.effective_at.getTime());
    return live[0] ?? null;
}

export type RebookingNextAction =
    | 'send_seasonal_update'
    | 'review_request'
    | 'start_fundraiser'
    | 'view_campaign'
    | 'fix_contact'
    | null;

export interface RowEvidence {
    isArchived: boolean;
    hasEmail: boolean;
    /** A non-test delivery attempt the provider accepted. */
    wasSent: boolean;
    /** Respondent asked for a replacement link from an expired page. */
    askedForFreshLink: boolean;
    /** Opportunities for THIS contact's own organizations only. */
    opportunities: {
        id: string;
        submission_id: string;
        status: 'interested' | 'approved' | 'needs_review' | 'canceled' | 'converted';
        coordinator_intent: string;
        coordinator_name: string | null;
        campaign_id: string | null;
        /** The organization this opportunity belongs to — already selected
         *  alongside campaign_id by the route; carried through here so a
         *  converted opportunity's campaign can be navigated to correctly. */
        customer_id: string;
    }[];
    activePreference: PreferenceRow | null;
}

export interface RowState {
    status: RebookingStatus;
    status_label: string;
    exclusion_reason: string | null;
    next_step: string;
    next_action: RebookingNextAction;
    /** Set only for rebooked rows. Identifies WHICH campaign, but is not
     *  itself a navigable route param — see campaign_customer_id. */
    campaign_id: string | null;
    /** CRM-CC-5 fix: /fundraisers/[id] is the organization profile route and
     *  takes a CUSTOMER id (it fetches /api/customers/[id]), never a campaign
     *  id. This is that customer id, set only alongside campaign_id, so the
     *  UI can build a truthful href without guessing which of a multi-org
     *  contact's organizations actually converted. */
    campaign_customer_id: string | null;
    /** Submission id — opens the EXISTING ReviewRequestDrawer. */
    request_id: string | null;
    /** Opportunity id — feeds the EXISTING StartFundraiserWizard handoff. */
    opportunity_id: string | null;
}

/**
 * The single source of truth for a row's lifecycle state.
 *
 * PRECEDENCE IS ORDERED MOST-SETTLED FIRST, and that ordering is the whole point
 * of this function. The CP1 bug was not a missing branch — it was that a contact
 * who had already rebooked still satisfied "has an email address" and therefore
 * fell back to "Ready to invite" forever. Anything added here must keep the
 * later stages of the lifecycle winning over the earlier ones.
 */
export function deriveRebookingRowState(e: RowEvidence): RowState {
    const base = { exclusion_reason: null, next_action: null, campaign_id: null, campaign_customer_id: null, request_id: null, opportunity_id: null } as const;

    // Reuses the existing CP5 semantic verbatim: answering a form makes nobody a
    // coordinator, so "known" means they said yes, or they named someone.
    const coordinatorKnown = (o: RowEvidence['opportunities'][number]) =>
        o.coordinator_intent === 'yes' || Boolean(o.coordinator_name);

    const converted = e.opportunities.find((o) => o.status === 'converted' || o.campaign_id !== null) ?? null;
    const approved = e.opportunities.find((o) => o.status === 'approved') ?? null;
    const changedAfterApproval = e.opportunities.find((o) => o.status === 'needs_review') ?? null;
    const interested = e.opportunities.find((o) => o.status === 'interested') ?? null;

    const pref = e.activePreference;
    const suppressed = pref?.status === 'unsubscribed';
    const paused = (pref?.status === 'paused' || pref?.status === 'not_interested') ? pref : null;

    if (e.isArchived) {
        return { ...base, status: 'archived', status_label: 'Archived', next_step: 'View history' };
    }
    if (converted) {
        return {
            ...base,
            status: 'rebooked',
            status_label: 'Rebooked',
            campaign_id: converted.campaign_id,
            // Same gate as campaign_id: only a converted opportunity that
            // actually produced a campaign gets a navigable destination.
            campaign_customer_id: converted.campaign_id ? converted.customer_id : null,
            next_step: converted.campaign_id ? 'View campaign' : 'Fundraiser created',
            next_action: converted.campaign_id ? 'view_campaign' : null,
        };
    }
    if (approved) {
        return {
            ...base,
            status: 'ready_to_create',
            status_label: 'Ready to create',
            next_step: 'Start their fundraiser',
            next_action: 'start_fundraiser',
            opportunity_id: approved.id,
            request_id: approved.submission_id,
        };
    }
    if (changedAfterApproval) {
        return {
            ...base,
            status: 'needs_review',
            status_label: 'Needs review',
            next_step: 'Review what changed',
            next_action: 'review_request',
            request_id: changedAfterApproval.submission_id,
        };
    }
    if (interested && !coordinatorKnown(interested)) {
        // Ranked above plain "Interested" deliberately: a fundraiser nobody is
        // coordinating cannot proceed, so that is the honest next step even
        // though the response itself was positive.
        return {
            ...base,
            status: 'needs_coordinator',
            status_label: 'Needs a coordinator',
            next_step: 'Nobody named yet — review',
            next_action: 'review_request',
            request_id: interested.submission_id,
        };
    }
    if (interested) {
        return {
            ...base,
            status: 'interested',
            status_label: 'Interested',
            next_step: 'Review their request',
            next_action: 'review_request',
            request_id: interested.submission_id,
        };
    }
    if (e.askedForFreshLink) {
        // No opportunity exists yet, so there is no request drawer to open. The
        // row states the fact and offers nothing it cannot deliver.
        return { ...base, status: 'needs_review', status_label: 'Needs review', next_step: 'Asked for a new link' };
    }
    if (!e.hasEmail) {
        return {
            ...base,
            status: 'cant_email',
            status_label: "Can't email",
            exclusion_reason: 'No email',
            next_step: 'Fix contact info',
            next_action: 'fix_contact',
        };
    }
    if (suppressed) {
        return {
            ...base,
            status: 'cant_email',
            status_label: "Can't email",
            exclusion_reason: 'Unsubscribed',
            next_step: 'Unsubscribed — no email will be sent',
        };
    }
    if (paused) {
        return {
            ...base,
            status: 'paused_until',
            // Timezone-independent on purpose: a pause that lifts on Dec 1 must
            // not read as "Nov 30" to anyone west of UTC.
            status_label: paused.effective_until
                ? `Paused until ${formatCalendarDateShort(paused.effective_until)}`
                : 'Paused',
            next_step: 'Paused — not in the next send',
        };
    }
    if (e.wasSent) {
        return { ...base, status: 'update_sent', status_label: 'Update sent', next_step: 'Waiting for their reply' };
    }
    return {
        ...base,
        status: 'ready_to_invite',
        status_label: 'Ready to invite',
        // CP6 wording fix: "Included in next update" read in Production as a
        // software-release placeholder. This names the email instead.
        next_step: 'Include in your next Seasonal Update',
        next_action: 'send_seasonal_update',
    };
}
