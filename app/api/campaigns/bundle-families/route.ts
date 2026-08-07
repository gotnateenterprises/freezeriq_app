/**
 * CB-4: Eligible Coordinator Bundle Families
 *
 * GET /api/campaigns/bundle-families
 *
 * Returns the tenant's eligible bundle families for the coordinator-selection
 * candidate pool. A family is eligible when it has exactly one active canonical
 * Serves-5 variant and exactly one active canonical Serves-2 sibling, both
 * belonging to the authenticated tenant.
 *
 * Pairing uses family_id + normalized serving_tier only.
 * No fuzzy SKU or name matching.
 *
 * The resolution itself lives in
 * lib/campaignBundleSelection.resolveEligibleBundleFamilies so that the
 * Seasonal Lineup (FR-RETENTION-2) validates family selections against exactly
 * the same rule. Behavior is unchanged from the previous inline implementation.
 *
 * ACCESS MODEL: Authenticated tenant session.
 *
 * @module api/campaigns/bundle-families
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  resolveEligibleBundleFamilies,
  type EligibleBundleFamily,
} from '@/lib/campaignBundleSelection';

export type { EligibleFamilyVariant, EligibleBundleFamily } from '@/lib/campaignBundleSelection';

export interface BundleFamiliesResponse {
  families: EligibleBundleFamily[];
}

// ── GET handler ──────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    const session = await auth();

    if (!session?.user?.businessId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const families = await resolveEligibleBundleFamilies(session.user.businessId);

    return NextResponse.json({ families } satisfies BundleFamiliesResponse);
  } catch (e) {
    console.error('Bundle Families GET Error:', e);
    return NextResponse.json({ error: 'Server Error' }, { status: 500 });
  }
}
