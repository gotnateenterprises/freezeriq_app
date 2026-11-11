/**
 * LEGACY-WRITER-GUARDS-1 — when the old campaign bundle editor may still replace a menu.
 *
 * PUT /api/campaigns/[id]/bundles (the "Bundles" panel on the legacy organization page) deletes a
 * campaign's active CampaignBundle rows and writes new ones. It predates coordinator bundle
 * selection, and it is still the only menu editor for campaigns that never used that flow
 * (bundle_selection_status 'not_required': CSV imports and older campaigns), so it stays — but it
 * may no longer act where it would corrupt truth:
 *
 *  - a closed campaign: its menu is part of what was invoiced;
 *  - a campaign in the coordinator flow ('pending' / 'selected'): its menu belongs to the
 *    coordinator's selection, and the tenant's tools for it are "Reset selection" (no orders) and
 *    "Change future bundles" (orders, with a reason and an audit event) — this route bypassed both,
 *    and on a pending campaign put bundles on sale while the status still said pending;
 *  - any campaign with an order, canceled ones included: those orders were placed against the
 *    current menu. This matches the order count the controlled override uses.
 */
import { isCampaignClosed } from '@/lib/campaignBundleSelection';

export type LegacyBundleAssignmentRefusalCode =
    | 'CAMPAIGN_CLOSED'
    | 'COORDINATOR_SELECTION'
    | 'CAMPAIGN_HAS_ORDERS';

export interface LegacyBundleAssignmentRefusal {
    code: LegacyBundleAssignmentRefusalCode;
    error: string;
}

export function legacyBundleAssignmentRefusal(
    campaign: { closed_at: Date | null; status: string; bundle_selection_status: string | null },
    orderCount: number,
): LegacyBundleAssignmentRefusal | null {
    if (isCampaignClosed(campaign)) {
        return {
            code: 'CAMPAIGN_CLOSED',
            error: "This fundraiser is closed, so its bundles can't be changed.",
        };
    }
    if (campaign.bundle_selection_status === 'pending' || campaign.bundle_selection_status === 'selected') {
        return {
            code: 'COORDINATOR_SELECTION',
            error: 'This fundraiser\'s bundles are chosen by its coordinator. Use "Reset selection" or "Change future bundles" in the Fundraiser CRM instead.',
        };
    }
    if (orderCount > 0) {
        return {
            code: 'CAMPAIGN_HAS_ORDERS',
            error: "Orders have already been placed against this fundraiser's bundles, so they can't be changed here.",
        };
    }
    return null;
}
