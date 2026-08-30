/**
 * CRM-ACTIVE-STATUS-UX-1 — replaces the vague "No signal yet" badge on an
 * Active campaign card with the real reason nothing has happened yet.
 *
 * "No signal yet" (lib/growth/health.ts's `no_signal` CampaignHealth) fires
 * whenever a running campaign has neither a usable goal-with-elapsed-window
 * nor actual sales — which is exactly as true for a campaign still waiting on
 * the coordinator to pick bundles as it is for one that has been open for
 * orders for a week with nobody buying yet. Both are real, different
 * situations a tenant needs to tell apart, and neither is "no signal" — the
 * setup-pending one has a known blocker, and the open-but-quiet one has a
 * known, useful state ("Open for orders").
 *
 * This module derives that distinction from facts the product already
 * durably records — it invents nothing:
 *
 *   - campaignDisplayStage (lib/campaignDisplayStage.ts) is the EXISTING,
 *     already-correct authority for "is this campaign waiting on the
 *     coordinator's bundle selection" (status Active + bundle_selection_status
 *     'pending'). Reused here rather than re-deriving the same gate a second,
 *     competing way.
 *   - FundraiserCampaignCoordinator.setup_email_sent_at is the EXISTING,
 *     provider-confirmed timestamp for "the invite was actually sent" —
 *     written only after Resend accepts the send (see
 *     app/api/campaigns/[id]/coordinator-email/route.ts). Never inferred from
 *     a button click or a claim alone.
 *
 * DELIBERATELY OMITTED — "Coordinator changes pending" (a reselection after
 * initial submission): app/api/coordinator/bundle-selection/route.ts leaves
 * bundle_selection_status at 'selected' through a reselection — there is no
 * 4th status value, no separate reopened-flag, nothing reliable to derive
 * this from. Per CRM-ACTIVE-STATUS-UX-1 Part M, this is not invented and no
 * schema is added for it; a reselected campaign simply falls through to
 * "Open for orders" or the ordinary health badge, same as before this phase.
 */

import { campaignDisplayStage, isClosedFamily } from '@/lib/campaignDisplayStage';
import type { CampaignHealth } from './health';

export interface CoordinatorSetupStatusInput {
    status: string;
    closed_at?: string | Date | null;
    bundle_selection_status?: string | null;
    coordinator_invite_sent_at?: string | Date | null;
    health?: CampaignHealth | null;
}

export interface CoordinatorSetupStatus {
    label: string;
    /** Optional second line — only state B ("Waiting on coordinator") has one. */
    helper?: string;
    key: 'invite_not_sent' | 'waiting_on_coordinator' | 'open_for_orders';
}

/**
 * The Active-card workflow status, or null to fall through to the ordinary
 * health badge unchanged. Only ever overrides `no_signal` and the
 * setup-pending window — every other health value (at_risk, watch, on_pace)
 * already says something both true and specific, so this never touches them.
 */
export function resolveCoordinatorSetupStatus(
    input: CoordinatorSetupStatusInput,
): CoordinatorSetupStatus | null {
    // Closed outranks everything here, same as campaignDisplayStage itself —
    // a closed campaign never gets a workflow-setup label, regardless of what
    // health happens to hold (health is normally not_applicable once closed,
    // but this must not depend on that).
    if (isClosedFamily({ status: input.status, closed_at: input.closed_at })) return null;

    const stage = campaignDisplayStage({
        status: input.status,
        closed_at: input.closed_at,
        bundle_selection_status: input.bundle_selection_status,
    });

    // State A/B — coordinator setup is the actual blocker. This takes
    // precedence over whatever health computed, because it is the more
    // specific and more actionable truth for exactly this window.
    if (stage.awaitingCoordinatorSetup) {
        return input.coordinator_invite_sent_at
            ? { label: 'Waiting on coordinator', helper: 'Meal selection & setup pending', key: 'waiting_on_coordinator' }
            : { label: 'Coordinator invite not sent', key: 'invite_not_sent' };
    }

    // State C — setup is complete (or was never required) and the campaign
    // simply has no signal yet. That is not an alarm, it is "up and waiting."
    if (input.health === 'no_signal') {
        return { label: 'Open for orders', key: 'open_for_orders' };
    }

    // Every other health value (at_risk / watch / on_pace / not_applicable)
    // already says something specific and true -- leave it to the real badge.
    return null;
}
