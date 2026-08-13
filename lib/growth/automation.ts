/**
 * GE-5A — safe automation foundation.
 *
 * This module can propose work and nothing else. It has no send path, no
 * scheduler, and no write access to any FR-RETENTION table: the only rows GE-5A
 * creates are its own policy and action records. Turning an approved
 * recommendation into a real OutreachBatch is GE-7's job, which is why there is
 * no `executed` state here — a status this phase cannot reach would be a claim
 * the code cannot honour.
 *
 * ── WHAT KEEPS IT SAFE ───────────────────────────────────────────────────────
 * · Defaults OFF. No policy row means disabled, and so does `enabled = false`.
 *   Nothing creates that row implicitly — least of all the evaluator.
 * · Approval is structural, not advisory. `candidate → approved` is the only
 *   way forward and only a tenant user can cause it.
 * · Idempotency is a database constraint, not a code convention. See
 *   `AutomationAction @@unique([business_id, action_type, seasonal_offering_id,
 *   customer_id])`; this module never does SELECT-then-INSERT.
 * · Suppression is borrowed, never reimplemented. `lib/seasonalAudience.ts`
 *   remains the single authority, including its shared-inbox rule.
 */

import { normalizeEmail } from '@/lib/seasonalAudience';

/** The one action family GE-5A ships. */
export const AUTOMATION_ACTION_TYPE = 'seasonal_rebooking_recommendation' as const;
export type AutomationActionTypeValue = typeof AUTOMATION_ACTION_TYPE;

export type AutomationStatus =
    | 'candidate'
    | 'approved'
    | 'dismissed'
    | 'suppressed'
    | 'expired';

/** Statuses no transition may leave. */
export const TERMINAL_STATUSES = ['dismissed', 'suppressed', 'expired'] as const;

export function isTerminal(status: AutomationStatus): boolean {
    return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Why a recommendation expired.
 *
 * A controlled union rather than free text: this is a state-machine reason that
 * code and tests read, so it must stay machine-comparable. It is deliberately
 * NOT a database enum — the values are an application concern and adding a
 * Postgres type would mean a migration every time the list grows.
 */
export type AutomationExpiredReason =
    | 'policy_disabled'
    | 'offering_ineligible'
    | 'target_ineligible'
    | 'expires_at_reached';

export const EXPIRED_REASONS: readonly AutomationExpiredReason[] = [
    'policy_disabled',
    'offering_ineligible',
    'target_ineligible',
    'expires_at_reached',
];

/**
 * One piece of evidence behind a recommendation.
 *
 * `kind` is the whole point. A campaign closing on a date is a FACT; GE-3
 * deciding that a quiet stretch deserves attention is a HEURISTIC. Collapsing
 * the two is how a threshold starts being read as an observation, so the type
 * forces the caller to say which it is.
 */
export interface AutomationReason {
    kind: 'fact' | 'heuristic';
    code: string;
    detail: string;
}

export function factReason(code: string, detail: string): AutomationReason {
    return { kind: 'fact', code, detail };
}

export function heuristicReason(code: string, detail: string): AutomationReason {
    return { kind: 'heuristic', code, detail };
}

// ── State machine ───────────────────────────────────────────────────────────

export type TransitionActor = 'system' | 'tenant_user';

export interface TransitionRequest {
    from: AutomationStatus;
    to: AutomationStatus;
    actor: TransitionActor;
}

/**
 * The complete set of legal moves. Anything absent is illegal — the table is
 * the specification, so a new transition cannot appear by accident somewhere in
 * a route handler.
 */
const LEGAL_TRANSITIONS: ReadonlyArray<{ from: AutomationStatus; to: AutomationStatus; actor: TransitionActor }> = [
    { from: 'candidate', to: 'approved', actor: 'tenant_user' },
    { from: 'candidate', to: 'dismissed', actor: 'tenant_user' },
    { from: 'approved', to: 'dismissed', actor: 'tenant_user' },
    { from: 'candidate', to: 'suppressed', actor: 'system' },
    { from: 'approved', to: 'suppressed', actor: 'system' },
    { from: 'candidate', to: 'expired', actor: 'system' },
    { from: 'approved', to: 'expired', actor: 'system' },
];

export function isLegalTransition(req: TransitionRequest): boolean {
    if (isTerminal(req.from)) return false; // terminal is terminal; nothing revives it
    return LEGAL_TRANSITIONS.some(
        t => t.from === req.from && t.to === req.to && t.actor === req.actor,
    );
}

export function assertLegalTransition(req: TransitionRequest): void {
    if (!isLegalTransition(req)) {
        throw new Error(
            `Illegal automation transition: ${req.from} -> ${req.to} by ${req.actor}`,
        );
    }
}

/** Every status an action may hold the moment it is created. Exactly one. */
export const INITIAL_STATUS: AutomationStatus = 'candidate';

// ── Eligibility ─────────────────────────────────────────────────────────────

export interface OfferingEligibilityInput {
    status: string;
    archived_at: Date | null;
    ends_at: Date;
}

/**
 * An offering worth recommending against.
 *
 * `ready` and `in_use` are the live states in `SeasonalOfferingStatus`; `draft`
 * is not finished and `archived` is over. An offering whose window has already
 * closed cannot be rebooked into.
 */
export function isOfferingEligible(o: OfferingEligibilityInput, now: Date): boolean {
    if (o.archived_at !== null) return false;
    if (o.status !== 'ready' && o.status !== 'in_use') return false;
    return o.ends_at.getTime() > now.getTime();
}

export interface TargetEligibilityInput {
    /** Real (non-Lead) campaigns this organization has run. */
    realCampaignCount: number;
    archived: boolean;
}

/**
 * An organization worth recommending.
 *
 * Prior fundraiser history is the qualification — this is a REbooking
 * recommendation, so a group that has never run a campaign is not a candidate.
 * "Real" follows GE-4's existing definition, which excludes Lead placeholders.
 */
export function isTargetEligible(t: TargetEligibilityInput): boolean {
    return !t.archived && t.realCampaignCount > 0;
}

// ── Suppression ─────────────────────────────────────────────────────────────

export interface SuppressionCheckInput {
    /** Addresses reachable for this organization, already normalized upstream. */
    normalizedEmails: string[];
    /** Address- or contact-scoped suppressions currently in force, normalized. */
    suppressedEmails: Set<string>;
}

export interface SuppressionVerdict {
    suppressed: boolean;
    reason: string | null;
}

/**
 * Whether an organization is currently unreachable.
 *
 * The rule is intentionally strict and matches FR-RETENTION's shared-inbox
 * treatment: if EVERY reachable address is suppressed there is nobody left to
 * contact, and an organization with no address at all is not reachable either.
 * The suppression facts themselves come from `lib/seasonalAudience.ts` — this
 * function decides only what an empty reachable set means for a recommendation.
 */
export function evaluateSuppression(input: SuppressionCheckInput): SuppressionVerdict {
    const emails = input.normalizedEmails.map(normalizeEmail).filter(e => e.length > 0);
    if (emails.length === 0) {
        return { suppressed: true, reason: 'No reachable email address on file.' };
    }
    const reachable = emails.filter(e => !input.suppressedEmails.has(e));
    if (reachable.length === 0) {
        return { suppressed: true, reason: 'Every address for this organization is suppressed.' };
    }
    return { suppressed: false, reason: null };
}

// ── Candidate composition ───────────────────────────────────────────────────

export interface CandidateEvaluationInput {
    policyEnabled: boolean;
    offering: OfferingEligibilityInput;
    target: TargetEligibilityInput;
    /** True when this organization is already in the reviewed audience. */
    alreadyInReviewedAudience: boolean;
    suppression: SuppressionVerdict;
    now: Date;
}

export type CandidateRefusal =
    | 'policy_disabled'
    | 'offering_ineligible'
    | 'target_ineligible'
    | 'already_in_audience'
    | 'suppressed';

export interface CandidateDecision {
    create: boolean;
    refusal: CandidateRefusal | null;
}

/**
 * Whether one organization should get a candidate for one offering.
 *
 * Ordered cheapest-and-most-authoritative first, and it fails closed: any
 * unmet condition refuses with a named reason rather than falling through to a
 * default "yes".
 */
export function decideCandidate(input: CandidateEvaluationInput): CandidateDecision {
    if (!input.policyEnabled) return { create: false, refusal: 'policy_disabled' };
    if (!isOfferingEligible(input.offering, input.now)) return { create: false, refusal: 'offering_ineligible' };
    if (!isTargetEligible(input.target)) return { create: false, refusal: 'target_ineligible' };
    if (input.alreadyInReviewedAudience) return { create: false, refusal: 'already_in_audience' };
    if (input.suppression.suppressed) return { create: false, refusal: 'suppressed' };
    return { create: true, refusal: null };
}

/**
 * Re-validation at approval.
 *
 * The same conditions are checked again because time passes between proposing
 * and approving — an offering can close, a coordinator can unsubscribe. The
 * result maps to a state rather than a boolean so the caller cannot approve
 * something that should have been retired instead.
 */
export type ApprovalOutcome =
    | { outcome: 'approve' }
    | { outcome: 'suppress'; reason: string }
    | { outcome: 'expire'; reason: AutomationExpiredReason };

export function decideApproval(input: {
    policyEnabled: boolean;
    offering: OfferingEligibilityInput;
    target: TargetEligibilityInput;
    suppression: SuppressionVerdict;
    expiresAt: Date | null;
    now: Date;
}): ApprovalOutcome {
    if (!input.policyEnabled) return { outcome: 'expire', reason: 'policy_disabled' };
    if (input.expiresAt && input.expiresAt.getTime() <= input.now.getTime()) {
        return { outcome: 'expire', reason: 'expires_at_reached' };
    }
    if (!isOfferingEligible(input.offering, input.now)) {
        return { outcome: 'expire', reason: 'offering_ineligible' };
    }
    if (!isTargetEligible(input.target)) {
        return { outcome: 'expire', reason: 'target_ineligible' };
    }
    if (input.suppression.suppressed) {
        return { outcome: 'suppress', reason: input.suppression.reason ?? 'Suppressed.' };
    }
    return { outcome: 'approve' };
}

/**
 * Reasons for a seasonal rebooking recommendation.
 *
 * Facts describe what happened; heuristics describe what this system chose to
 * find interesting. GE-3's health signal is always a heuristic — it is a
 * threshold, not an observation — while GE-4's counts and totals are facts,
 * carried with their honest labels ("lifetime fundraiser sales", never
 * "raised").
 */
export function buildRebookingReasons(input: {
    realCampaignCount: number;
    lifetimeFundraiserSales: number;
    daysSinceLastCampaign: number | null;
    offeringName: string;
    campaignHealth?: string | null;
}): AutomationReason[] {
    const reasons: AutomationReason[] = [
        factReason(
            'prior_campaigns',
            `This group has run ${input.realCampaignCount} fundraiser${input.realCampaignCount === 1 ? '' : 's'}.`,
        ),
        factReason(
            'lifetime_fundraiser_sales',
            `Lifetime fundraiser sales of $${Math.round(input.lifetimeFundraiserSales).toLocaleString()} (gross).`,
        ),
        factReason('offering_open', `${input.offeringName} is open for booking.`),
    ];

    if (input.daysSinceLastCampaign !== null) {
        reasons.push(factReason(
            'days_since_last_campaign',
            `Last fundraiser was ${input.daysSinceLastCampaign} days ago.`,
        ));
    }

    // GE-3 may colour the list. It may never be the reason the list exists.
    if (input.campaignHealth === 'at_risk' || input.campaignHealth === 'watch') {
        reasons.push(heuristicReason(
            'campaign_health',
            `A current campaign is flagged "${input.campaignHealth}" by campaign health.`,
        ));
    }

    return reasons;
}

/** Actions a disable sweep must retire. */
export const ACTIVE_STATUSES: readonly AutomationStatus[] = ['candidate', 'approved'];
