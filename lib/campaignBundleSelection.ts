/**
 * CB-2: Coordinator Bundle Selection — Shared Helpers
 *
 * Tenant-aware helpers shared between the GET and POST handlers of
 * /api/coordinator/[token]/bundle-selection.
 *
 * RULES:
 *  - All pairing uses family_id + normalized serving tier ONLY.
 *  - No runtime SKU or name matching.
 *  - Every public function is tenant-scoped.
 *  - No as any, no @ts-ignore, no fuzzy matching.
 *  - Decimal and Date values are serialized to JSON-safe primitives.
 */

import { prisma } from '@/lib/db';
import { resolveVariantSize } from '@/lib/serving_multipliers';

// ── Canonical tier constants ─────────────────────────────────────────────────

/** The canonical serves_5 / family tier string stored in Bundle.serving_tier */
export const TIER_SERVES_5 = 'serves_5' as const;
/** The canonical serves_2 tier string stored in Bundle.serving_tier */
export const TIER_SERVES_2 = 'serves_2' as const;

// ── Domain types ─────────────────────────────────────────────────────────────

export interface BundleVariantInfo {
  id: string;
  name: string;
  sku: string | null;
  price: number | null;
  imageUrl: string | null;
}

export interface BundleSelectionCandidate {
  familyId: string;
  serves5: BundleVariantInfo;
  serves2: BundleVariantInfo | null;
  available: boolean;
  unavailableReason?: string;
}

export interface SelectionCampaignInfo {
  id: string;
  name: string;
  selectionStatus: 'pending' | 'selected';
  selectionLimit: number;
  selectedAt: string | null;
}

export interface BundleSelectionGetResponse {
  selectionRequired: true;
  campaign: SelectionCampaignInfo;
  candidateFamilies: BundleSelectionCandidate[];
  selectedFamilyIds: string[];
}

export interface BundleSelectionNotRequired {
  selectionRequired: false;
  message: string;
}

/**
 * Shape of a resolved coordinator campaign, including the tenant business chain.
 * Used by both GET and POST before any transaction.
 */
export interface ResolvedCoordinatorCampaign {
  id: string;
  name: string;
  status: string;
  closed_at: Date | null;
  bundle_selection_status: string;
  bundle_selection_at: Date | null;
  bundle_selection_limit: number;
  businessId: string;
}

// ── Tier helpers ─────────────────────────────────────────────────────────────

/**
 * Returns true when the serving_tier normalizes to the canonical family/Serves-5 tier.
 * Uses resolveVariantSize() from serving_multipliers — single source of truth.
 */
export function isCanonicalFamilyTier(servingTier: string | null | undefined): boolean {
  return resolveVariantSize(servingTier) === TIER_SERVES_5;
}

/**
 * Returns true when the serving_tier normalizes to the canonical Serves-2 tier.
 */
export function isCanonicalServes2Tier(servingTier: string | null | undefined): boolean {
  return resolveVariantSize(servingTier) === TIER_SERVES_2;
}

// ── Campaign resolution ───────────────────────────────────────────────────────

/**
 * Resolves a coordinator portal_token to a campaign with its business chain.
 *
 * Trusted ownership path:
 *   portal_token → FundraiserCampaign → Customer → Business
 *
 * Returns null when no campaign matches the token.
 */
export async function resolveCoordinatorCampaign(
  token: string
): Promise<ResolvedCoordinatorCampaign | null> {
  const campaign = await prisma.fundraiserCampaign.findFirst({
    where: { portal_token: token },
    select: {
      id: true,
      name: true,
      status: true,
      closed_at: true,
      bundle_selection_status: true,
      bundle_selection_at: true,
      bundle_selection_limit: true,
      customer: {
        select: {
          business_id: true,
        },
      },
    },
  });

  if (!campaign || !campaign.customer.business_id) {
    return null;
  }

  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    closed_at: campaign.closed_at,
    bundle_selection_status: campaign.bundle_selection_status,
    bundle_selection_at: campaign.bundle_selection_at,
    bundle_selection_limit: campaign.bundle_selection_limit,
    businessId: campaign.customer.business_id,
  };
}

// ── Closed-campaign predicate ─────────────────────────────────────────────────

/**
 * Statuses that already mean "financially closed".
 *
 * Exported (INV-A) because the closeout claim needs the same list as a Prisma
 * `notIn` filter, and the campaign PATCH needs it to lock org_share_percent. A
 * second hand-written copy in either route could drift, which would let the
 * organization share change after settlement_total was frozen against it.
 */
export const CLOSED_STATUSES = ['Closed', 'Settled', 'Completed', 'Archived'] as const;

/**
 * Returns true when the campaign is server-closed per the existing coordinator contract.
 * Mirrors the isCampaignClosed() pattern from app/api/coordinator/[token]/route.ts.
 */
export function isCampaignClosed(campaign: {
  closed_at: Date | null;
  status: string;
}): boolean {
  return (
    Boolean(campaign.closed_at) ||
    (CLOSED_STATUSES as readonly string[]).includes(campaign.status)
  );
}

// ── Candidate-family resolution ───────────────────────────────────────────────

/**
 * Loads all candidate CampaignBundle rows for a campaign and resolves each one
 * into a BundleSelectionCandidate with the Serves-5 bundle and its Serves-2 sibling.
 *
 * Each candidate row must:
 *   - Reference a bundle belonging to the campaign's business
 *   - Have a non-null family_id
 *   - Normalize to the canonical Serves-5/family tier
 *   - Have exactly one active Serves-2 sibling with the same family_id in the same business
 *
 * Broken candidates are returned with available: false and a safe unavailableReason.
 * No fuzzy runtime matching — pairing uses family_id + normalized tier only.
 */
export async function loadCandidateFamilies(
  campaignId: string,
  businessId: string
): Promise<BundleSelectionCandidate[]> {
  // Load all candidate CampaignBundle rows with their bundle data
  const candidateRows = await prisma.campaignBundle.findMany({
    where: {
      campaign_id: campaignId,
      state: 'candidate',
    },
    orderBy: { position: 'asc' },
    select: {
      bundle: {
        select: {
          id: true,
          name: true,
          sku: true,
          price: true,
          image_url: true,
          serving_tier: true,
          family_id: true,
          business_id: true,
          is_active: true,
        },
      },
    },
  });

  // Collect all family_ids from valid candidate rows so we can batch-load siblings
  const familyIds: string[] = [];
  for (const row of candidateRows) {
    const b = row.bundle;
    if (
      b.family_id &&
      b.business_id === businessId &&
      isCanonicalFamilyTier(b.serving_tier)
    ) {
      familyIds.push(b.family_id);
    }
  }

  // Batch-load all active Serves-2 siblings for those family_ids
  const serves2Siblings =
    familyIds.length > 0
      ? await prisma.bundle.findMany({
          where: {
            business_id: businessId,
            family_id: { in: familyIds },
            is_active: true,
          },
          select: {
            id: true,
            name: true,
            sku: true,
            price: true,
            image_url: true,
            serving_tier: true,
            family_id: true,
            business_id: true,
          },
        })
      : [];

  // Group siblings by family_id — only keep actual serves_2 tier ones
  const siblingsByFamily = new Map<string, typeof serves2Siblings>();
  for (const sibling of serves2Siblings) {
    if (!isCanonicalServes2Tier(sibling.serving_tier)) continue;
    if (!sibling.family_id) continue;
    const list = siblingsByFamily.get(sibling.family_id) ?? [];
    list.push(sibling);
    siblingsByFamily.set(sibling.family_id, list);
  }

  // Track seen family_ids so duplicate candidate rows don't produce duplicates
  const seenFamilyIds = new Set<string>();
  const results: BundleSelectionCandidate[] = [];

  for (const row of candidateRows) {
    const b = row.bundle;

    // Guard: bundle must belong to the campaign's tenant
    if (b.business_id !== businessId) {
      // Cross-tenant candidate — silently skip to avoid leaking existence
      continue;
    }

    // Guard: bundle must have a family_id
    if (!b.family_id) {
      results.push({
        familyId: b.id, // fallback identifier — not a real family_id
        serves5: bundleToVariantInfo(b),
        serves2: null,
        available: false,
        unavailableReason: 'Bundle is not linked to a family. Contact your administrator.',
      });
      continue;
    }

    // Guard: bundle must normalize to the canonical Serves-5/family tier
    if (!isCanonicalFamilyTier(b.serving_tier)) {
      // Candidate row points to a Serves-2 — structural misconfiguration
      results.push({
        familyId: b.family_id,
        serves5: bundleToVariantInfo(b),
        serves2: null,
        available: false,
        unavailableReason: 'Bundle family structure is invalid. Contact your administrator.',
      });
      continue;
    }

    // Deduplicate family_ids (multiple candidate rows for same family)
    if (seenFamilyIds.has(b.family_id)) {
      continue;
    }
    seenFamilyIds.add(b.family_id);

    const siblings = siblingsByFamily.get(b.family_id) ?? [];

    // Exactly one active Serves-2 sibling required
    if (siblings.length === 0) {
      results.push({
        familyId: b.family_id,
        serves5: bundleToVariantInfo(b),
        serves2: null,
        available: false,
        unavailableReason: 'Serves 2 variant is not available for this bundle family.',
      });
      continue;
    }

    if (siblings.length > 1) {
      results.push({
        familyId: b.family_id,
        serves5: bundleToVariantInfo(b),
        serves2: null,
        available: false,
        unavailableReason: 'Bundle family structure is ambiguous. Contact your administrator.',
      });
      continue;
    }

    const sibling = siblings[0];

    results.push({
      familyId: b.family_id,
      serves5: bundleToVariantInfo(b),
      serves2: bundleToVariantInfo(sibling),
      available: true,
    });
  }

  return results;
}

// ── Selected-family extraction ────────────────────────────────────────────────

/**
 * Returns the distinct family_id values from active CampaignBundle rows for the campaign.
 * Only considers bundles that normalize to the Serves-5/family tier to avoid double-counting.
 *
 * Returns an empty array for campaigns that have no active selections yet.
 */
export async function extractSelectedFamilyIds(campaignId: string): Promise<string[]> {
  const activeRows = await prisma.campaignBundle.findMany({
    where: {
      campaign_id: campaignId,
      state: 'active',
    },
    select: {
      bundle: {
        select: {
          family_id: true,
          serving_tier: true,
        },
      },
    },
  });

  const familyIds: string[] = [];
  const seen = new Set<string>();

  for (const row of activeRows) {
    const fid = row.bundle.family_id;
    // Count only the family/serves_5 representative, not the serves_2 sibling
    if (fid && !seen.has(fid) && isCanonicalFamilyTier(row.bundle.serving_tier)) {
      seen.add(fid);
      familyIds.push(fid);
    }
  }

  return familyIds;
}

// ── Family-set comparison ─────────────────────────────────────────────────────

/**
 * Order-insensitive comparison of two family ID arrays.
 * Returns true when both sets contain exactly the same IDs regardless of order.
 */
export function familySetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

// ── Safe serialization helpers ────────────────────────────────────────────────

/**
 * Converts a Prisma Decimal or numeric value to a plain JS number, or null.
 * Prevents Decimal objects appearing in JSON responses.
 */
export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Serializes a Date to an ISO string, or returns null.
 */
export function dateToIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString();
}

// ── CB-4 eligible bundle families (shared resolver) ──────────────────────────

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

/**
 * The single source of truth for "which bundle families may a coordinator be
 * offered". A family is eligible when the tenant has exactly one active
 * canonical Serves-5 variant and exactly one active canonical Serves-2 sibling.
 *
 * Pairing uses family_id + normalized serving tier ONLY — no SKU or name
 * matching. Malformed families (missing sibling, ambiguous duplicates) are
 * silently excluded rather than guessed at.
 *
 * Extracted from /api/campaigns/bundle-families so the Seasonal Lineup can
 * validate family selections against exactly the same rule the coordinator
 * wizard uses. Both callers share this implementation; neither reimplements it.
 */
export async function resolveEligibleBundleFamilies(
  businessId: string,
): Promise<EligibleBundleFamily[]> {
  const allBundles = await prisma.bundle.findMany({
    where: { business_id: businessId, is_active: true, family_id: { not: null } },
    select: { id: true, name: true, sku: true, price: true, serving_tier: true, family_id: true },
  });

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

  const families: EligibleBundleFamily[] = [];
  for (const [familyId, entry] of familyMap) {
    if (entry.s5Count === 1 && entry.s2Count === 1 && entry.s5 !== null && entry.s2 !== null) {
      families.push({
        familyId,
        serves5: { id: entry.s5.id, name: entry.s5.name, sku: entry.s5.sku, price: decimalToNumber(entry.s5.price) },
        serves2: { id: entry.s2.id, name: entry.s2.name, sku: entry.s2.sku, price: decimalToNumber(entry.s2.price) },
      });
    }
  }

  families.sort((a, b) => a.serves5.name.localeCompare(b.serves5.name));
  return families;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function bundleToVariantInfo(b: {
  id: string;
  name: string;
  sku: string | null;
  price: unknown;
  image_url: string | null;
}): BundleVariantInfo {
  return {
    id: b.id,
    name: b.name,
    sku: b.sku,
    price: decimalToNumber(b.price),
    imageUrl: b.image_url,
  };
}
