/**
 * FR-COORD-123 — "Easy as 1-2-3" launch-step truth.
 *
 * The dashboard card says three things to a coordinator:
 *
 *   1. Set Up Your Fundraiser      — done when setup is DURABLY complete
 *   2. Share Your Fundraiser       — "started" after a genuine share ACTION
 *   3. Get Your First Order        — done at one legitimate current-campaign order
 *
 * Every state here is derived from durable server truth the portal already
 * loads; nothing in this module invents client-only completion.
 *
 * ── STEP 1 ──────────────────────────────────────────────────────────────────
 * The canonical setup-complete condition is the campaign row itself:
 * bundle_selection_status === 'selected' (written once by the coordinator
 * setup submit, POST /api/coordinator/bundle-selection) — or 'not_required'
 * for legacy campaigns that never had a selection step. The portal only
 * renders phase content after the server confirms one of those, so the card
 * can trust the confirmation it is handed.
 *
 * ── STEP 2 ──────────────────────────────────────────────────────────────────
 * "Sharing started" is TRUE only when a share-classified CoordinatorActionEvent
 * exists for this campaign. Those rows are durable (they survive reload and
 * device changes) and are written only when the coordinator actually performs
 * a share action — opening the share UI writes nothing. Downloads are real
 * actions but not SHARING, so they do not count: printing a tracker for
 * yourself notifies nobody.
 *
 * ── STEP 3 ──────────────────────────────────────────────────────────────────
 * The order count the portal receives is already the durable truth: the
 * coordinator GET returns only this campaign's orders with canceled_at IS
 * NULL. A canceled-only campaign therefore counts zero, and another
 * campaign's orders can never appear — the session resolves to exactly one
 * campaign id server-side.
 */

/**
 * The action types that mean the coordinator actually SHARED something.
 * Copy-to-clipboard of share copy counts — the coordinator has the message in
 * hand to paste; that is how desktop text/facebook sharing works. Downloads
 * (flyer/tracker/qr/packet) deliberately do not.
 */
export const SHARE_ACTION_TYPES = [
    'share_fundraiser',
    'send_text_blast',
    'share_facebook',
    'share_email',
    'share_native',
    'copy_link',
    'copy_text_message',
    'copy_facebook_post',
    'copy_email_blurb',
] as const;

export type ShareActionType = (typeof SHARE_ACTION_TYPES)[number];

export function isShareAction(actionType: string): actionType is ShareActionType {
    return (SHARE_ACTION_TYPES as readonly string[]).includes(actionType);
}

/**
 * Durable "Sharing started" — true when any share-classified action count is
 * positive. Counts come from /api/coordinator-actions/summary, which
 * aggregates the CoordinatorActionEvent table for this campaign only.
 */
export function deriveSharingStarted(counts: Record<string, number> | null | undefined): boolean {
    if (!counts) return false;
    return SHARE_ACTION_TYPES.some((t) => (counts[t] ?? 0) > 0);
}

export interface LaunchStepState {
    setupComplete: boolean;
    sharingStarted: boolean;
    firstOrderReceived: boolean;
    /** 1-based index of the step needing attention, or null when all done. */
    currentStep: 1 | 2 | 3 | null;
    allComplete: boolean;
}

/**
 * The whole card's state from durable inputs.
 *
 * @param setupConfirmed     server-confirmed bundle_selection_status of
 *                           'selected' or 'not_required' (the portal's gate)
 * @param shareCounts        per-type action counts from the summary endpoint
 * @param activeOrderCount   length of the server-filtered non-canceled,
 *                           this-campaign order list
 */
export function deriveLaunchSteps(input: {
    setupConfirmed: boolean;
    shareCounts: Record<string, number> | null | undefined;
    activeOrderCount: number;
}): LaunchStepState {
    const setupComplete = input.setupConfirmed === true;
    const sharingStarted = deriveSharingStarted(input.shareCounts);
    const firstOrderReceived = input.activeOrderCount > 0;
    const currentStep = !setupComplete ? 1 : !sharingStarted ? 2 : !firstOrderReceived ? 3 : null;
    return {
        setupComplete,
        sharingStarted,
        firstOrderReceived,
        currentStep,
        allComplete: currentStep === null,
    };
}

// FR-SHARE-COPY-1: the generic share message that used to live here
// (buildShareMessage/buildShareSms) was replaced by the channel-specific,
// tenant-brand-aware templates in lib/fundraiserShareContent.ts — Email,
// Facebook and Native no longer share one generic message, Text/SMS no
// longer hardcodes "freezer meal fundraiser", and every channel now derives
// from the SAME normalized ShareFacts rather than each rebuilding its own.
