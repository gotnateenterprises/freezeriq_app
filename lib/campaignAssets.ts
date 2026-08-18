/**
 * Campaign Assets Utility
 *
 * Single source of truth for campaign asset metadata.
 * Returns normalized asset definitions (download URLs, availability)
 * for the coordinator portal Sales Toolkit.
 *
 * ACCESS: Called server-side from /api/campaign-assets/[token]
 * AUTH:   Token-based (portal_token) — no session required
 * SCOPE:  Single campaign resolved from token
 */

import { prisma } from '@/lib/db';

// ── Types ────────────────────────────────────────────────────────────

export type CampaignAsset = {
  key: 'flyer' | 'tracker' | 'packet' | 'qr';
  label: string;
  kind: 'download' | 'external';
  url: string;
  available: boolean;
};

export type CampaignAssetsResponse = {
  campaignName: string;
  organizationName: string;
  assets: CampaignAsset[];
};

// ── Main Function ────────────────────────────────────────────────────

/**
 * FR-COORD-SEC-1B — takes an authorised campaign id, not a portal_token.
 *
 * The download URLs this returns used to carry `?token=<credential>`, which put
 * the coordinator secret into the query string of four more logged requests.
 * They are now bare paths: the download routes authenticate from the same
 * session cookie as the rest of the portal.
 */
export async function getCampaignAssetsByCampaignId(
  campaignId: string
): Promise<CampaignAssetsResponse> {
  if (!campaignId || typeof campaignId !== 'string' || campaignId.trim().length === 0) {
    throw new Error('Missing or invalid campaign id');
  }

  const campaign = await prisma.fundraiserCampaign.findFirst({
    where: { id: campaignId.trim() },
    select: {
      id: true,
      name: true,
      customer: {
        select: { name: true },
      },
    },
  });

  if (!campaign) {
    return null as unknown as CampaignAssetsResponse;
  }

  const campaignName = campaign.name || 'Untitled Campaign';
  const organizationName = campaign.customer?.name || 'Organization';

  // 3. Assemble asset metadata
  const assets: CampaignAsset[] = [
    // A) Tracker — existing server-backed route, fully available
    {
      key: 'tracker',
      label: 'Download Printable Tracker',
      kind: 'download',
      url: `/api/tracker/download`,
      available: true,
    },

    // B) Flyer — server-backed PDF generation via jsPDF
    {
      key: 'flyer',
      label: 'Download Flyer',
      kind: 'download',
      url: `/api/flyer/download`,
      available: true,
    },

    // C) Packet — server-backed ZIP containing flyer + tracker + guide
    {
      key: 'packet',
      label: 'Download Full Packet (Optional)',
      kind: 'download',
      url: `/api/packet/download`,
      available: true,
    },

    // D) QR Code — standalone PNG for printing or sharing
    {
      key: 'qr',
      label: 'Download QR Code',
      kind: 'download',
      url: `/api/qr/download`,
      available: true,
    },
  ];

  return {
    campaignName,
    organizationName,
    assets,
  };
}
