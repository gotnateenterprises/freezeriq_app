/**
 * GE-5A-2 — pure display logic for the Seasonal Rebooking Recommendations panel.
 *
 * Split out from the component so the actual decisions — which empty state to
 * show, how a result count becomes a sentence, which statuses are still
 * actionable — are unit-testable the way the rest of this codebase tests
 * logic: no React renderer, no jsdom, no new test infrastructure. The
 * component itself stays thin glue around these functions.
 */

export type AutomationStatus = 'candidate' | 'approved' | 'dismissed' | 'suppressed' | 'expired';

/** Still open for tenant action. Deliberately excludes every terminal status. */
export const ACTIVE_STATUSES: readonly AutomationStatus[] = ['candidate', 'approved'];

/** Settled — history, not something the tenant needs to act on again. */
export const TERMINAL_STATUSES: readonly AutomationStatus[] = ['dismissed', 'suppressed', 'expired'];

export interface StatusPresentation {
    label: string;
    tone: 'candidate' | 'approved' | 'neutral' | 'suppressed';
}

/**
 * One label per backend status. None of these may say or imply that anything
 * was sent, scheduled, or executed — GE-5A cannot do any of those, so a label
 * that suggested otherwise would be describing a capability that does not
 * exist.
 */
export const STATUS_PRESENTATION: Record<AutomationStatus, StatusPresentation> = {
    candidate: { label: 'Recommended', tone: 'candidate' },
    approved: { label: 'Approved for future outreach', tone: 'approved' },
    dismissed: { label: 'Dismissed', tone: 'neutral' },
    suppressed: { label: "Can't be included right now", tone: 'suppressed' },
    expired: { label: 'No longer active', tone: 'neutral' },
};

const SEND_IMPLYING_WORDS = /\b(sent|sending|scheduled|schedule|executed|executing|dispatched|delivered|mailed)\b/i;

/** True if a status label could be misread as "this was sent." Used by tests. */
export function labelImpliesSend(label: string): boolean {
    return SEND_IMPLYING_WORDS.test(label);
}

export function classifyActions<T extends { status: AutomationStatus }>(
    actions: T[],
): { active: T[]; history: T[] } {
    return {
        active: actions.filter((a) => (ACTIVE_STATUSES as AutomationStatus[]).includes(a.status)),
        history: actions.filter((a) => (TERMINAL_STATUSES as AutomationStatus[]).includes(a.status)),
    };
}

export type EmptyStateKey =
    | 'policy_off'
    | 'never_evaluated'
    | 'no_new_recommendations'
    | 'only_history'
    | null;

/**
 * Which empty-state message applies, given only facts the caller already has.
 * Returns null when there is nothing to explain — real cards exist.
 *
 * The distinction that matters most: "never evaluated" (nothing has been
 * tried yet) must never be presented identically to "evaluated and found
 * nothing" — those are different facts and deserve different sentences.
 */
export function selectEmptyState(input: {
    policyEnabled: boolean;
    activeCount: number;
    historyCount: number;
    hasEvaluated: boolean;
}): EmptyStateKey {
    if (!input.policyEnabled) return 'policy_off';
    if (input.activeCount > 0) return null;
    if (!input.hasEvaluated && input.historyCount === 0) return 'never_evaluated';
    if (input.hasEvaluated && input.historyCount === 0) return 'no_new_recommendations';
    return 'only_history';
}

/**
 * "Find Recommendations" result copy.
 *
 * Uses `createdCount` specifically — the number of rows the evaluator
 * actually inserted this call. An organization that already had a live
 * recommendation for this season is reused under the unique constraint, not
 * recreated, so it must never inflate this number: reporting it as "found"
 * again would claim work happened when the database did nothing.
 */
export function formatEvaluateResult(createdCount: number): string {
    if (createdCount <= 0) return 'No new recommendations right now.';
    return `${createdCount} new recommendation${createdCount === 1 ? '' : 's'} found.`;
}

/**
 * Disable copy. Must be truthful about whether anything was actually retired
 * — disabling an already-disabled policy retires nothing, and the sentence
 * must not claim otherwise.
 */
export function formatDisableMessage(retiredCount: number): string {
    if (retiredCount <= 0) return 'Recommendations are off. Nothing was sent.';
    return `Recommendations are off. ${retiredCount} active recommendation${retiredCount === 1 ? '' : 's'} ${retiredCount === 1 ? 'was' : 'were'} retired. Nothing was sent.`;
}

export const ENABLE_MESSAGE =
    'FreezerIQ can now look for seasonal rebooking opportunities. Nothing will be sent automatically.';

/**
 * Picks which of the tenant's Seasonal Lineups the evaluator can be pointed
 * at. Mirrors `isOfferingEligible` in lib/growth/automation.ts exactly — a
 * draft lineup that has never been used for a real Seasonal Update is not yet
 * a season FreezerIQ can recommend against.
 */
export function selectEligibleOffering<T extends { status: string; updatedAt: string }>(
    lineups: T[],
): T | null {
    const eligible = lineups.filter((l) => l.status === 'ready' || l.status === 'in_use');
    if (eligible.length === 0) return null;
    return [...eligible].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}
