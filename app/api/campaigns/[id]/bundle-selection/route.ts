/**
 * CB-6: Tenant Bundle Selection Status — Read Endpoint
 *
 * GET /api/campaigns/[id]/bundle-selection
 *
 * Returns the bundle-selection status for a campaign, including candidate
 * families, selected families with their Serves 5/Serves 2 variants,
 * order count, and available administrative actions.
 *
 * ACCESS MODEL: Authenticated tenant session (not coordinator token).
 * The campaign must belong to the authenticated tenant's business.
 *
 * @module api/campaigns/[id]/bundle-selection
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  isCampaignClosed,
  loadCandidateFamilies,
  dateToIso,
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
} from '@/lib/campaignBundleSelection';

// ── Response types ───────────────────────────────────────────────────────────

interface SelectedFamilyInfo {
  familyId: string;
  name: string;
  serves5BundleId: string;
  serves5BundleName: string;
  serves2BundleId: string;
  serves2BundleName: string;
}

interface TenantBundleSelectionResponse {
  campaign: {
    id: string;
    name: string;
    selectionStatus: string;
    selectionLimit: number;
    selectedAt: string | null;
  };
  candidateFamilies: Array<{
    familyId: string;
    name: string;
    available: boolean;
  }>;
  selectedFamilies: SelectedFamilyInfo[];
  activeBundleIds: string[];
  orderCount: number;
  canReset: boolean;
  requiresOverride: boolean;
  isClosed: boolean;
}

// ── GET handler ──────────────────────────────────────────────────────────────

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { auth } = await import('@/auth');
    const session = await auth();

    if (!session?.user?.businessId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const businessId = session.user.businessId;

    // Load campaign with selection fields
    const campaign = await prisma.fundraiserCampaign.findUnique({
      where: { id },
      include: { customer: { select: { business_id: true } } },
    });

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    if (campaign.customer.business_id !== businessId) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    const selectionStatus = campaign.bundle_selection_status;
    const closed = isCampaignClosed(campaign);

    // Count all historical campaign orders (including canceled)
    // Any persisted order row counts as historical order existence.
    // Canceled orders still preserve bundle IDs, quantities, prices, and audit history.
    const orderCount = await prisma.order.count({
      where: { campaign_id: id },
    });

    // Load candidate families (uses existing CB-2 helper)
    const candidates = selectionStatus !== 'not_required'
      ? await loadCandidateFamilies(id, businessId)
      : [];

    // Build selected families info from active CampaignBundle rows
    const selectedFamilies: SelectedFamilyInfo[] = [];
    const activeBundleIds: string[] = [];

    if (selectionStatus === 'selected') {
      const activeRows = await prisma.campaignBundle.findMany({
        where: { campaign_id: id, state: 'active' },
        orderBy: { position: 'asc' },
        select: {
          bundle_id: true,
          bundle: {
            select: {
              id: true,
              name: true,
              family_id: true,
              serving_tier: true,
            },
          },
        },
      });

      // Group active bundles by family_id
      const familyMap = new Map<string, { s5Id: string; s5Name: string; s2Id: string; s2Name: string }>();

      for (const row of activeRows) {
        activeBundleIds.push(row.bundle_id);
        const b = row.bundle;
        if (!b.family_id) continue;

        const existing = familyMap.get(b.family_id) ?? { s5Id: '', s5Name: '', s2Id: '', s2Name: '' };

        if (isCanonicalFamilyTier(b.serving_tier)) {
          existing.s5Id = b.id;
          existing.s5Name = b.name;
        } else if (isCanonicalServes2Tier(b.serving_tier)) {
          existing.s2Id = b.id;
          existing.s2Name = b.name;
        }

        familyMap.set(b.family_id, existing);
      }

      for (const [familyId, info] of familyMap) {
        if (info.s5Id && info.s2Id) {
          selectedFamilies.push({
            familyId,
            name: info.s5Name, // Family name = Serves 5 name
            serves5BundleId: info.s5Id,
            serves5BundleName: info.s5Name,
            serves2BundleId: info.s2Id,
            serves2BundleName: info.s2Name,
          });
        }
      }
    }

    // Determine available actions
    const canReset = selectionStatus === 'selected' && orderCount === 0 && !closed;
    const requiresOverride = selectionStatus === 'selected' && orderCount > 0 && !closed;

    const response: TenantBundleSelectionResponse = {
      campaign: {
        id: campaign.id,
        name: campaign.name,
        selectionStatus,
        selectionLimit: campaign.bundle_selection_limit,
        selectedAt: dateToIso(campaign.bundle_selection_at),
      },
      candidateFamilies: candidates.map((c) => ({
        familyId: c.familyId,
        name: c.serves5.name,
        available: c.available,
      })),
      selectedFamilies,
      activeBundleIds,
      orderCount,
      canReset,
      requiresOverride,
      isClosed: closed,
    };

    return NextResponse.json(response);
  } catch (e) {
    console.error('Tenant Bundle Selection GET Error:', e);
    return NextResponse.json({ error: 'Server Error' }, { status: 500 });
  }
}
