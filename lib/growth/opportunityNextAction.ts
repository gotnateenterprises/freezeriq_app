/**
 * FR-FUNNEL-1 — pre-campaign triage.
 *
 * The sibling of triageCampaign() in lib/growth/nextAction.ts, covering the part
 * of the journey that happens BEFORE a FundraiserCampaign exists. The two never
 * overlap: this module stops at `date_confirmed`, and triageCampaign takes over
 * once a campaign row exists. That boundary is why FR-FUNNEL-0 could reject a
 * second post-campaign status vocabulary — there is exactly one owner for each
 * stage of the journey.
 *
 * Nothing here is stored. A next action is a FUNCTION OF CURRENT STATE, so
 * persisting it would create a second source of truth that goes stale the
 * moment anyone edits a date. Same rule as campaign triage.
 */

import {
    resolveInquiryResponse,
    type InquiryAckFacts,
    type InquiryResponseFacts,
} from './inquiryResponseState';

/** Mirrors CampaignPriority's vocabulary so one CRM list can rank both. */
export type OpportunityPriority =
    /** A real person is waiting on a reply. */
    | 'needs_attention'
    /** Moving, but the tenant owes the next step. */
    | 'worth_a_look'
    /** Waiting on the organization, not on us. */
    | 'on_pace'
    /** Agreed and ready to become a campaign. */
    | 'upcoming'
    /** Terminal. A record, not a task. */
    | 'completed';

export const OPPORTUNITY_PRIORITY_RANK: Record<OpportunityPriority, number> = {
    needs_attention: 0,
    worth_a_look: 1,
    on_pace: 2,
    upcoming: 3,
    completed: 4,
};

/**
 * Hours a new inquiry may sit unanswered before it is called out.
 *
 * A THRESHOLD, not a fact. Lead-response research consistently finds that
 * qualification odds fall off within the first hour, but 24h is chosen here as
 * the point at which a small business with no dedicated sales desk has clearly
 * dropped the lead rather than simply been busy. Tunable; not authoritative.
 */
export const UNANSWERED_INQUIRY_HOURS = 24;

/** Days an in-conversation opportunity may stall before it is called out. */
export const STALLED_CONVERSATION_DAYS = 7;

/**
 * FR-ACCEPTANCE-2A.1 — hours after OUR outreach before a silent organization is
 * surfaced for a follow-up.
 *
 * This closes a real gap. Until now, an opportunity that had been answered but
 * had no preferred date came back `on_pace` — "Waiting for preferred dates" —
 * and stayed there forever. Answering an inquiry removed it from the CRM's
 * attention permanently, which is precisely backwards: a volunteer who asked
 * about a fundraiser, got a reply, and then went quiet is the single most
 * recoverable lead a tenant has, and the CRM was silent about it.
 *
 * WHAT THIS MEASURES, PRECISELY: hours since the tenant reached out, NOT hours
 * since the organization last made contact. The platform does not observe
 * inbound email — a reply that lands in the tenant's own inbox is invisible
 * here. So a tenant mid-conversation can still be told to follow up. The signal
 * is therefore worded as a prompt ("worth a nudge"), never as an assertion that
 * the organization has not replied, because the platform cannot know that.
 *
 * A THRESHOLD, not a fact. Tunable; not authoritative.
 */
export const FOLLOW_UP_SILENCE_HOURS = 48;

/** The subset of an opportunity row this module reads. Optional fields degrade
 *  safely — a thinner payload yields fewer signals, never a wrong one. */
export interface OpportunityForTriage {
    status: string;
    received_at?: string | Date | null;
    first_response_at?: string | Date | null;
    preferred_delivery_date?: string | Date | null;
    confirmed_delivery_date?: string | Date | null;
    updated_at?: string | Date | null;
    /**
     * FR-ACCEPTANCE-2A.1 — this opportunity's inquiries, newest included.
     *
     * Optional on purpose. Callers that do not load them get exactly the
     * behaviour this module had before acknowledgements existed, which is the
     * standing contract for a thin payload: fewer signals, never a wrong one.
     */
    inquiries?: readonly InquiryAckFacts[] | null;
}

export interface OpportunityNextAction {
    /** Button text. Plain verbs, no internal vocabulary. */
    label: string;
    /** One sentence explaining WHY — shown to the tenant, never hidden. */
    reason: string;
    /** Machine key. Only capabilities that exist today. */
    kind:
        | 'respond_to_inquiry'
        | 'await_preferred_dates'
        | 'send_follow_up'
        | 'check_date_availability'
        | 'confirm_delivery_date'
        | 'create_campaign';
    /** Where the control lives. The UI decides how to get there. */
    destination: 'opportunity_drawer' | 'organization_profile';
}

export interface OpportunityTriage {
    priority: OpportunityPriority;
    rank: number;
    action: OpportunityNextAction | null;
}

function toDate(value: string | Date | null | undefined): Date | null {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function hoursSince(value: Date | null, now: Date): number | null {
    if (!value) return null;
    return (now.getTime() - value.getTime()) / 36e5;
}

/**
 * The single most useful next step for one pre-campaign opportunity.
 *
 * Pure. Same inputs always produce the same output, so it is safe to call from
 * a server component, an API route, or a test with no database at all.
 */
export function triageOpportunity(o: OpportunityForTriage, now: Date): OpportunityTriage {
    const rank = (p: OpportunityPriority) => OPPORTUNITY_PRIORITY_RANK[p];

    // ── Terminal ─────────────────────────────────────────────────────────────
    if (o.status === 'lost' || o.status === 'converted') {
        return { priority: 'completed', rank: rank('completed'), action: null };
    }

    // ── Agreed: the only thing left is to launch it ──────────────────────────
    if (o.status === 'date_confirmed') {
        return {
            priority: 'upcoming',
            rank: rank('upcoming'),
            action: {
                label: 'Create fundraiser campaign',
                reason: 'The delivery date is agreed, so this organization is ready to become a fundraiser.',
                kind: 'create_campaign',
                destination: 'organization_profile',
            },
        };
    }

    // FR-ACCEPTANCE-2A.1 — everything below asks about the NEWEST inquiry.
    //
    // Neither an older inquiry's acknowledgement nor an older manual reply may
    // answer a newer inquiry. See lib/growth/inquiryResponseState.ts.
    const response = resolveInquiryResponse(o.first_response_at, o.inquiries);

    // ── Nobody and nothing has answered the newest inquiry ───────────────────
    //
    // Not gated on `status === 'new'` any more. An organization already in
    // conversation that sends a FRESH inquiry is owed a reply to it, and the old
    // status gate would have filed that under "waiting on the organization".
    //
    // FR-REBOOK-1A: `no_inquiry` is now its own state, decided by
    // resolveInquiryResponse from the inquiry rows themselves, so this branch
    // simply never matches for an owner-initiated opportunity.
    //
    // The first attempt at this guard lived here and read
    // `inquiries.length > 0 || toDate(o.received_at) !== null`. It passed every
    // unit test and still shipped the bug, because /api/opportunities sends
    // `received_at: firstInquiry?.received_at ?? o.created_at` — always a real
    // date — so the OR clause was permanently true against the only caller that
    // matters. The lesson is in the fix: absence is decided from the rows, once,
    // in the module that owns the question.
    if (response.state === 'needs_first_response') {
        const waitingFrom = response.latestInquiryAt ?? toDate(o.received_at);
        const waiting = hoursSince(waitingFrom, now);
        const overdue = waiting !== null && waiting >= UNANSWERED_INQUIRY_HOURS;
        return {
            priority: overdue ? 'needs_attention' : 'worth_a_look',
            rank: rank(overdue ? 'needs_attention' : 'worth_a_look'),
            action: {
                label: 'Respond to new inquiry',
                reason: overdue
                    ? `This inquiry has been waiting ${Math.floor(waiting!)} hours for a first reply.`
                    : 'A new fundraiser inquiry has not been answered yet.',
                kind: 'respond_to_inquiry',
                destination: 'opportunity_drawer',
            },
        };
    }

    // ── An acknowledgement was attempted and never confirmed ─────────────────
    //
    // Part N: this outranks a routine follow-up. Nobody can say whether this
    // person heard anything back, so a nudge about scheduling would be built on
    // an assumption the platform cannot support. The tenant is told the truth
    // and asked to make contact themselves.
    if (response.state === 'auto_ack_uncertain') {
        return {
            priority: 'needs_attention',
            rank: rank('needs_attention'),
            action: {
                label: 'Check on this inquiry',
                reason: 'An automatic acknowledgement was started for this inquiry but delivery was never confirmed. It may not have arrived.',
                kind: 'respond_to_inquiry',
                destination: 'opportunity_drawer',
            },
        };
    }

    // ── Talking, but no date on the table ────────────────────────────────────
    //
    // Both dates, not just the preferred one: a confirmed date with the status
    // not yet moved is still a date, and nudging about scheduling would be wrong.
    if (!o.preferred_delivery_date && !o.confirmed_delivery_date) {
        // FR-ACCEPTANCE-2A.1 — the 48-hour follow-up signal.
        //
        // Anchored on `response.outreachAt`: the last time contact was actually
        // MADE about the newest inquiry — the applicable manual reply, or the
        // acknowledgement the provider accepted.
        //
        // NOT updated_at, which any edit moves, so a typed note would silence a
        // cold lead. NOT received_at either: an inquiry nobody answered is a
        // "needs first response", handled above on its own faster clock, and
        // treating it as a follow-up would let the slower threshold hide it.
        const silent = hoursSince(response.outreachAt, now);
        if (silent !== null && silent >= FOLLOW_UP_SILENCE_HOURS) {
            const viaAck = response.state === 'auto_ack_sent';
            return {
                priority: 'worth_a_look',
                rank: rank('worth_a_look'),
                action: {
                    label: 'Follow up — no date selected yet',
                    // Deliberately never "they have not replied". Inbound mail
                    // lands in the tenant's own inbox and is invisible to the
                    // platform, so an organization that HAS replied would be
                    // defamed by the stronger wording. The two anchors are named
                    // distinctly so the tenant knows what the clock is measuring.
                    reason: viaAck
                        ? `It has been ${Math.floor(silent)}+ hours since the acknowledgement and no delivery date has been set.`
                        : `It has been ${Math.floor(silent / 24)}+ days since you replied and no delivery date has been set yet.`,
                    kind: 'send_follow_up',
                    destination: 'opportunity_drawer',
                },
            };
        }
        return {
            priority: 'on_pace',
            rank: rank('on_pace'),
            action: {
                label: 'Waiting for preferred dates',
                reason: 'The organization has not given a preferred delivery date yet.',
                kind: 'await_preferred_dates',
                destination: 'opportunity_drawer',
            },
        };
    }

    // ── A date exists; the tenant owes an answer on availability ─────────────
    const stalledDays = hoursSince(toDate(o.updated_at), now);
    const stalled = stalledDays !== null && stalledDays / 24 >= STALLED_CONVERSATION_DAYS;
    return {
        priority: stalled ? 'needs_attention' : 'worth_a_look',
        rank: rank(stalled ? 'needs_attention' : 'worth_a_look'),
        action: stalled
            ? {
                  label: 'Confirm fundraiser date',
                  reason: `A preferred delivery date has been on the table for ${STALLED_CONVERSATION_DAYS}+ days without being confirmed.`,
                  kind: 'confirm_delivery_date',
                  destination: 'opportunity_drawer',
              }
            : {
                  label: 'Check date availability',
                  reason: 'The organization has proposed a delivery date that needs checking against the schedule.',
                  kind: 'check_date_availability',
                  destination: 'opportunity_drawer',
              },
    };
}

/** CRM bucket for one opportunity. Derived, never stored. */
export type FunnelBucket =
    | 'new_leads'
    | 'needs_follow_up'
    | 'waiting_on_date'
    | 'ready_to_create_campaign'
    | 'closed';

export function funnelBucket(o: OpportunityForTriage, now: Date): FunnelBucket {
    if (o.status === 'converted' || o.status === 'lost') return 'closed';
    if (o.status === 'date_confirmed') return 'ready_to_create_campaign';
    // FR-ACCEPTANCE-2A.1 — kept in lockstep with triageOpportunity, on the same
    // derivation, the same anchors and the same thresholds. If these two ever
    // disagree the CRM files a lead under one heading and the drawer tells the
    // tenant to do something else.
    const response = resolveInquiryResponse(o.first_response_at, o.inquiries);

    if (response.state === 'needs_first_response') {
        const waiting = hoursSince(response.latestInquiryAt ?? toDate(o.received_at), now);
        return waiting !== null && waiting >= UNANSWERED_INQUIRY_HOURS ? 'needs_follow_up' : 'new_leads';
    }

    // An unconfirmed acknowledgement is an attention state, not a scheduling one.
    if (response.state === 'auto_ack_uncertain') return 'needs_follow_up';

    if (!o.preferred_delivery_date && !o.confirmed_delivery_date) {
        const silent = hoursSince(response.outreachAt, now);
        if (silent !== null && silent >= FOLLOW_UP_SILENCE_HOURS) return 'needs_follow_up';
    }
    return 'waiting_on_date';
}
