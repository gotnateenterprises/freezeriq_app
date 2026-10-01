/**
 * COORD-CLOSED-PORTAL-1 — what the coordinator portal renders ahead of its phase content.
 *
 * Bundle selection is setup for a LIVE campaign. The selection API refuses a closed campaign
 * (410) by design, so the portal must neither render the selection step for one nor wait for
 * it: a closed campaign goes straight to the read-only Complete phase, and stays available
 * through invoicing, payment and delivery.
 *
 * "Closed" is the server's verdict. The campaign row's closeout fields cover a normal closeout;
 * `orderMode.reasonCode === 'closed'` is the portal GET's answer from the same shared
 * isCampaignClosed (lib/campaignBundleSelection) the selection API uses, so the two can never
 * disagree about a campaign the API is refusing — Archived, Completed or Settled included.
 *
 * Pure and client-safe: no database import, so the client portal page can use it directly.
 */

export interface PortalGateCampaign {
    closed_at?: unknown;
    status?: unknown;
    orderMode?: { reasonCode?: unknown } | null;
}

export interface CoordinatorPortalGate {
    /** The campaign is server-closed: read-only Complete phase, no order mutations. */
    isClosed: boolean;
    /** Render the bundle-selection step (live campaigns only). */
    showBundleSelection: boolean;
    /** Render the portal's phase content and action bar. */
    contentReady: boolean;
}

export function isPortalCampaignClosed(campaign: PortalGateCampaign | null | undefined): boolean {
    if (!campaign) return false;
    return Boolean(campaign.closed_at)
        || campaign.status === 'Closed'
        || campaign.status === 'Settled'
        || campaign.orderMode?.reasonCode === 'closed';
}

/**
 * A live campaign waits for the selection step to confirm setup, exactly as before. A closed
 * one never shows the step and never waits for it.
 */
export function coordinatorPortalGate(
    campaign: PortalGateCampaign | null | undefined,
    bundleSelectionDone: boolean,
): CoordinatorPortalGate {
    const isClosed = isPortalCampaignClosed(campaign);
    return {
        isClosed,
        showBundleSelection: !isClosed,
        contentReady: isClosed || bundleSelectionDone,
    };
}
