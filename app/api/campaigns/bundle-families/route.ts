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
 * ACCESS MODEL: Authenticated tenant session.
 *
 * @module api/campaigns/bundle-families
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import {
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
  decimalToNumber,
} from '@/lib/campaignBundleSelection';

// ── Response types ───────────────────────────────────────────────────────────

export interface EligibleFamilyVariant {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
}

export interface EligibleBundleFamily {
  familyId: string;
  serves5: EligibleFamilyVariant;
  serves2: EligibleFamilyVariant;
}

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

    const businessId = session.user.businessId;

    // Load all active bundles for this tenant that have a non-null family_id
    const allBundles = await prisma.bundle.findMany({
      where: {
        business_id: businessId,
        is_active: true,
        family_id: { not: null },
      },
      select: {
        id: true,
        name: true,
        sku: true,
        price: true,
        serving_tier: true,
        family_id: true,
      },
    });

    // Group by family_id
    const familyMap = new Map<
      string,
      { s5: typeof allBundles[number] | null; s5Count: number; s2: typeof allBundles[number] | null; s2Count: number }
    >();

    for (const b of allBundles) {
      if (!b.family_id) continue;

      const entry = familyMap.get(b.family_id) ?? { s5: null, s5Count: 0, s2: null, s2Count: 0 };

      if (isCanonicalFamilyTier(b.serving_tier)) {
        entry.s5 = b;
        entry.s5Count += 1;
      } else if (isCanonicalServes2Tier(b.serving_tier)) {
        entry.s2 = b;
        entry.s2Count += 1;
      }

      familyMap.set(b.family_id, entry);
    }

    // A family is eligible only when it has exactly one S5 and exactly one S2
    const families: EligibleBundleFamily[] = [];

    for (const [familyId, entry] of familyMap) {
      if (
        entry.s5Count === 1 &&
        entry.s2Count === 1 &&
        entry.s5 !== null &&
        entry.s2 !== null
      ) {
        families.push({
          familyId,
          serves5: {
            id: entry.s5.id,
            name: entry.s5.name,
            sku: entry.s5.sku,
            price: decimalToNumber(entry.s5.price),
          },
          serves2: {
            id: entry.s2.id,
            name: entry.s2.name,
            sku: entry.s2.sku,
            price: decimalToNumber(entry.s2.price),
          },
        });
      }
      // Malformed families (missing tier, ambiguous, no family_id): silently excluded.
      // The wizard UI will not show them; the API re-validates submitted family IDs.
    }

    // Sort by serves5 name for deterministic display order
    families.sort((a, b) => a.serves5.name.localeCompare(b.serves5.name));

    return NextResponse.json({ families } satisfies BundleFamiliesResponse);
  } catch (e) {
    console.error('Bundle Families GET Error:', e);
    return NextResponse.json({ error: 'Server Error' }, { status: 500 });
  }
}
