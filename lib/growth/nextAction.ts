/**
 * CRM-CC-1 — campaign triage: priority category + truthful next action.
 *
 * Pure derivation over the EXISTING /api/campaigns row shape. Nothing here is
 * persisted, fetched, or predicted — this module only arranges facts the
 * server already sent so the Fundraiser dashboard can answer "what needs me
 * today?" the same way lib/growth/health.ts answers "how is this campaign
 * doing?". Every mapping below is deterministic and explainable: same row,
 * same clock, same answer.
 *
 * WHAT A CATEGORY IS: a grouping for attention, not a new judgement. The only
 * health authority is GE-3's verdict, which arrives on the row; this module
 * never re-scores a campaign, it only files the verdict — plus two hard
 * lifecycle facts (closed family, ended-with-held-orders) — into one of five
 * buckets a person can act on.
 *
 * WHAT AN ACTION IS: something the product can actually do TODAY. Every
 * `kind` maps to a control that already exists (the closeout modal, the
 * organization profile). Nothing here suggests sending, scheduling, or any
 * GE-7 capability, because none exists.
 *
 * DELIBERATE OMISSION — "settled but not invoiced → Create invoice": the
 * campaigns response carries no settlement or invoice linkage (there is no
 * invoice_id on a campaign anywhere in the schema), so whether a settled
 * campaign has been invoiced is UNKNOWABLE from this data. Suggesting
 * "Create invoice" for every settled campaign would nag tenants about work
 * they may have finished. Completed campaigns therefore carry no action here;
 * the organization profile's settlement box remains the truthful home for
 * invoice state.
 */

import type { CampaignHealth, CampaignHealthReason } from './health';

/** Mirrors isCampaignClosed() in app/fundraisers/page.tsx — keep in sync. */
export const CLOSED_FAMILY = ['Closed', 'Settled', 'Completed', 'Archived'] as const;

export type CampaignPriority =
    /** Acting now would help: GE-3 says at_risk, or the window ended with orders still held. */
    | 'needs_attention'
    /** GE-3 found exactly one adverse signal — worth a look, not alarming. */
    | 'worth_a_look'
    /** Running with no adverse signal (includes "too early to say"). */
    | 'on_pace'
    /** Not started yet: a lead, or a placeholder for an organization with no campaign. */
    | 'upcoming'
    /** Finished. A record, not a task. */
    | 'completed';

/** Sort order for CRM-CC-2's grouped list: lower = shown first. */
export const PRIORITY_RANK: Record<CampaignPriority, number> = {
    needs_attention: 0,
    worth_a_look: 1,
    on_pace: 2,
    upcoming: 3,
    completed: 4,
};

/** The subset of the /api/campaigns row this module reads. All optional fields
 *  degrade safely — an older payload simply yields fewer signals, never a lie. */
export interface CampaignForTriage {
    status: string;
    is_placeholder?: boolean;
    closed_at?: string | null;
    end_date?: string | null;
    held_order_count?: number;
    portal_token?: string | null;
    health?: CampaignHealth;
    health_reasons?: CampaignHealthReason[];
}

export interface CampaignNextAction {
    /** Button text. Plain verbs, no internal vocabulary. */
    label: string;
    /** One sentence explaining WHY this action is suggested — shown, not hidden. */
    reason: string;
    /** Machine key for the UI to route on. Only capabilities that exist today. */
    kind: 'closeout' | 'bundle_selection' | 'contact_coordinator' | 'review_campaign' | 'follow_up';
    /** Where the control lives. The UI decides how to get there. */
    destination: 'closeout_modal' | 'organization_profile';
}

export interface CampaignTriage {
    priority: CampaignPriority;
    /** PRIORITY_RANK[priority], denormalized for cheap sorting. */
    rank: number;
    /** The single most useful next step, or null when nothing needs doing. */
    action: CampaignNextAction | null;
}

const isClosedFamily = (c: CampaignForTriage): boolean =>
    Boolean(c.closed_at) || (CLOSED_FAMILY as readonly string[]).includes(c.status);

/** The window has passed and orders are still held hostage to closeout. */
export function hasEndedWithHeldOrders(c: CampaignForTriage, now: Date): boolean {
    if (isClosedFamily(c) || c.status !== 'Active') return false;
    if (!c.end_date) return false;
    const end = new Date(c.end_date);
    if (Number.isNaN(end.getTime())) return false;
    return end.getTime() < now.getTime() && (c.held_order_count ?? 0) > 0;
}

const hasReason = (c: CampaignForTriage, code: CampaignHealthReason['code']): boolean =>
    (c.health_reasons ?? []).some((r) => r.code === code);

/**
 * One campaign → one category + at most one suggested action.
 *
 * Action precedence (first match wins), ordered by how directly the tenant can
 * unblock value: releasing held orders beats reviewing a warning; a locked
 * bundle selection beats a generic check-in.
 */
export function triageCampaign(c: CampaignForTriage, now: Date): CampaignTriage {
    // Finished campaigns are records. Invoice state is unknowable here (see
    // header), so no action is ever suggested for them.
    if (isClosedFamily(c)) {
        return { priority: 'completed', rank: PRIORITY_RANK.completed, action: null };
    }

    // A lead — placeholder or real — has not started. The only truthful step
    // is the human one the org profile supports.
    if (c.is_placeholder || c.status === 'Lead') {
        return {
            priority: 'upcoming',
            rank: PRIORITY_RANK.upcoming,
            action: {
                label: 'Follow up',
                reason: 'This organization does not have a running campaign yet.',
                kind: 'follow_up',
                destination: 'organization_profile',
            },
        };
    }

    // Anything else non-Active (defensive: the lifecycle vocabulary is
    // Lead/Active/closed-family, but data is data) is treated as not yet
    // running rather than invented into a judgement.
    if (c.status !== 'Active') {
        return { priority: 'upcoming', rank: PRIORITY_RANK.upcoming, action: null };
    }

    const endedHeld = hasEndedWithHeldOrders(c, now);

    // ── Action, by precedence ────────────────────────────────────────────────
    let action: CampaignNextAction | null = null;
    if (endedHeld) {
        action = {
            label: 'Close out fundraiser',
            reason: `The campaign window has ended and ${c.held_order_count} held order${(c.held_order_count ?? 0) === 1 ? ' is' : 's are'} waiting for closeout.`,
            kind: 'closeout',
            destination: 'closeout_modal',
        };
    } else if (hasReason(c, 'bundle_selection_pending')) {
        action = {
            label: 'Review bundle selection',
            reason: 'Ordering stays locked until the coordinator’s bundle choice is settled.',
            kind: 'bundle_selection',
            destination: 'organization_profile',
        };
    } else if (
        c.health === 'at_risk'
        && (hasReason(c, 'no_coordinator_activity') || hasReason(c, 'no_orders_yet'))
    ) {
        action = {
            label: 'Check in with coordinator',
            reason: 'The campaign shows several warning signs and the coordinator may need help getting started.',
            kind: 'contact_coordinator',
            destination: 'organization_profile',
        };
    } else if (c.health === 'at_risk' || c.health === 'watch') {
        action = {
            label: 'Review campaign',
            reason: 'FreezerIQ flagged this campaign — the reasons are listed on its health badge.',
            kind: 'review_campaign',
            destination: 'organization_profile',
        };
    }

    // ── Category ─────────────────────────────────────────────────────────────
    // Ended-with-held-orders is urgent regardless of what health said while it
    // was running: money is sitting in held orders until closeout releases it.
    if (endedHeld || c.health === 'at_risk') {
        return { priority: 'needs_attention', rank: PRIORITY_RANK.needs_attention, action };
    }
    if (c.health === 'watch') {
        return { priority: 'worth_a_look', rank: PRIORITY_RANK.worth_a_look, action };
    }
    // on_pace / no_signal / missing health all mean: running, nothing adverse
    // reported. The row's own health badge still shows the precise verdict.
    return { priority: 'on_pace', rank: PRIORITY_RANK.on_pace, action };
}

export interface AttentionSummary {
    /** Campaigns triaged needs_attention. */
    needsAttention: number;
    /** Held orders on campaigns that are not yet closed, and their value. */
    heldOrders: number;
    heldValue: number;
}

/** The campaign-derived numbers the attention strip shows. Pure aggregation. */
export function summarizeAttention(
    campaigns: (CampaignForTriage & { held_order_total?: number })[],
    now: Date,
): AttentionSummary {
    let needsAttention = 0;
    let heldOrders = 0;
    let heldValue = 0;
    for (const c of campaigns) {
        if (triageCampaign(c, now).priority === 'needs_attention') needsAttention += 1;
        if (!isClosedFamily(c) && !c.is_placeholder) {
            heldOrders += c.held_order_count ?? 0;
            heldValue += Number(c.held_order_total ?? 0);
        }
    }
    return { needsAttention, heldOrders, heldValue };
}
