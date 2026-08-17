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

/** The subset of an opportunity row this module reads. Optional fields degrade
 *  safely — a thinner payload yields fewer signals, never a wrong one. */
export interface OpportunityForTriage {
    status: string;
    received_at?: string | Date | null;
    first_response_at?: string | Date | null;
    preferred_delivery_date?: string | Date | null;
    confirmed_delivery_date?: string | Date | null;
    updated_at?: string | Date | null;
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

    // ── Nobody has replied yet ───────────────────────────────────────────────
    if (o.status === 'new' && !o.first_response_at) {
        const waiting = hoursSince(toDate(o.received_at), now);
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

    // ── Talking, but no date on the table ────────────────────────────────────
    if (!o.preferred_delivery_date) {
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
    if (o.status === 'new' && !o.first_response_at) {
        const waiting = hoursSince(toDate(o.received_at), now);
        return waiting !== null && waiting >= UNANSWERED_INQUIRY_HOURS ? 'needs_follow_up' : 'new_leads';
    }
    return 'waiting_on_date';
}
