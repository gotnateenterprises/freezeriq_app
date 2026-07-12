/**
 * CB-6: Tenant Bundle Selection Administration — Shared Helpers
 *
 * Provides transactional reset and controlled-override operations for
 * tenant administrators to manage coordinator bundle selections.
 *
 * SECURITY CONTEXT:
 *   Both operations require authenticated tenant session.
 *   Campaign ownership is validated inside the serializable transaction.
 *   Coordinator tokens never authorize reset or override.
 *
 * HISTORICAL ORDER SAFETY:
 *   Neither operation touches orders or order_items.
 *   Only CampaignBundle rows with state='active' are deleted/replaced.
 *   Order items retain their original bundle_id, unit_price, quantity, and item_name.
 *
 * @module campaignBundleOverride
 */

import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import {
  isCampaignClosed,
  isCanonicalFamilyTier,
  isCanonicalServes2Tier,
} from '@/lib/campaignBundleSelection';

// ── Domain types ─────────────────────────────────────────────────────────────

export type ResetResult =
  | { ok: true; previousActiveBundleIds: string[] }
  | { ok: false; status: number; error: string };

export type OverrideResult =
  | {
      ok: true;
      previousFamilyIds: string[];
      previousActiveBundleIds: string[];
      newFamilyIds: string[];
      newActiveBundleIds: string[];
      existingOrderCount: number;
    }
  | { ok: false; status: number; error: string };

// ── Max retries for Serializable P2034 conflicts ─────────────────────────────

const MAX_RETRIES = 3;

// ── Shared closed-campaign statuses ──────────────────────────────────────────

// Reused from campaignBundleSelection.ts via the imported isCampaignClosed function.

// ── Reset transaction ────────────────────────────────────────────────────────

/**
 * Resets a campaign's bundle selection to pending.
 *
 * Eligibility:
 *   - Campaign belongs to authenticated tenant (businessId).
 *   - Status is 'selected' (pending returns idempotent success; not_required rejected).
 *   - Campaign is not closed.
 *   - Zero non-canceled orders exist.
 *
 * Transaction (Serializable):
 *   1. Re-read campaign and tenant ownership.
 *   2. Re-check closed state.
 *   3. Count non-canceled campaign orders (require zero).
 *   4. Delete only CampaignBundle.state = 'active' rows.
 *   5. Preserve candidate rows.
 *   6. Set bundle_selection_status = 'pending', bundle_selection_at = null.
 *   7. Write CoordinatorActionEvent (action_type: bundle_selection_reset).
 *   8. Commit atomically.
 */
export async function resetBundleSelection(
  campaignId: string,
  businessId: string,
  actorId: string | null,
): Promise<ResetResult> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Step 1: Re-read campaign inside transaction
          const campaign = await tx.fundraiserCampaign.findUnique({
            where: { id: campaignId },
            include: { customer: { select: { business_id: true } } },
          });

          if (!campaign) {
            return { ok: false, status: 404, error: 'Campaign not found' };
          }

          // Step 2: Tenant ownership
          if (campaign.customer.business_id !== businessId) {
            return { ok: false, status: 404, error: 'Campaign not found' };
          }

          // Step 3: Closed check
          if (isCampaignClosed(campaign)) {
            return { ok: false, status: 410, error: 'This campaign can no longer be changed' };
          }

          // Step 4: Status check
          const selectionStatus = campaign.bundle_selection_status;

          if (selectionStatus === 'not_required') {
            return { ok: false, status: 400, error: 'Legacy campaigns do not use bundle selection' };
          }

          // Idempotent: already pending
          if (selectionStatus === 'pending') {
            return { ok: true, previousActiveBundleIds: [] };
          }

          if (selectionStatus !== 'selected') {
            return { ok: false, status: 409, error: 'Campaign bundle availability is not configured correctly' };
          }

          // Step 5: Count all historical campaign orders (including canceled)
          // Any persisted order row blocks normal reset — canceled orders preserve
          // historical bundle IDs, quantities, prices, and audit history.
          const orderCount = await tx.order.count({
            where: { campaign_id: campaignId },
          });

          if (orderCount > 0) {
            return {
              ok: false,
              status: 409,
              error: 'This campaign already has orders. Use the controlled override instead.',
            };
          }

          // Step 6: Capture current active bundle IDs before deletion
          const activeRows = await tx.campaignBundle.findMany({
            where: { campaign_id: campaignId, state: 'active' },
            select: { bundle_id: true },
          });
          const previousActiveBundleIds = activeRows.map((r) => r.bundle_id);

          // Step 7: Delete only active rows (preserve candidate rows)
          await tx.campaignBundle.deleteMany({
            where: { campaign_id: campaignId, state: 'active' },
          });

          // Step 8: Reset campaign status
          await tx.fundraiserCampaign.update({
            where: { id: campaignId },
            data: {
              bundle_selection_status: 'pending',
              bundle_selection_at: null,
            },
          });

          // Step 9: Write activity event
          const now = new Date();
          await tx.coordinatorActionEvent.create({
            data: {
              campaign_id: campaignId,
              action_type: 'bundle_selection_reset',
              source: null,
              metadata: {
                actorType: 'tenant_user',
                actorId: actorId,
                channel: 'tenant_crm',
                previousActiveBundleIds,
                resetAt: now.toISOString(),
              },
            },
          });

          return { ok: true, previousActiveBundleIds };
        },
        {
          isolationLevel: 'Serializable',
          timeout: 15000,
        },
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2034' &&
        attempt < MAX_RETRIES - 1
      ) {
        continue; // Retry on serialization conflict
      }
      throw err;
    }
  }

  // Exhausted retries
  return {
    ok: false,
    status: 409,
    error: 'The campaign changed while this request was being processed. Please try again.',
  };
}

// ── Controlled override transaction ──────────────────────────────────────────

/**
 * Performs a controlled override of a campaign's bundle selection.
 *
 * Eligibility:
 *   - Campaign belongs to authenticated tenant (businessId).
 *   - Status is 'selected'.
 *   - Campaign is not closed.
 *   - One or more non-canceled orders exist.
 *   - Reason is non-empty (≤500 chars).
 *   - Exactly bundle_selection_limit unique family IDs.
 *   - All family IDs come from candidate rows.
 *   - Each family resolves to one Serves 5 + one active Serves 2 bundle.
 *   - All resolved bundles belong to the campaign's tenant.
 *
 * Transaction (Serializable):
 *   1. Re-read campaign.
 *   2. Re-check tenant ownership, status, closed state.
 *   3. Count campaign orders (require ≥1).
 *   4. Revalidate selection limit and candidate membership.
 *   5. Resolve all family pairs.
 *   6. Capture current active bundle IDs.
 *   7. Delete current active assignment rows only.
 *   8. Preserve candidate rows.
 *   9. Insert new active rows (S5 + S2 per family).
 *  10. Keep bundle_selection_status = 'selected', update bundle_selection_at.
 *  11. Write CoordinatorActionEvent (action_type: bundle_selection_overridden).
 *  12. Commit.
 */
export async function overrideBundleSelection(
  campaignId: string,
  businessId: string,
  familyIds: string[],
  reason: string,
  actorId: string | null,
): Promise<OverrideResult> {
  // Pre-validate inputs outside transaction (fast-fail)
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, status: 400, error: 'A reason is required for this change' };
  }

  if (reason.length > 500) {
    return { ok: false, status: 400, error: 'Reason must be 500 characters or fewer' };
  }

  if (!Array.isArray(familyIds) || familyIds.length === 0) {
    return { ok: false, status: 400, error: 'At least one family must be selected' };
  }

  const uniqueFamilyIds = [...new Set(familyIds)];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Step 1: Re-read campaign
          const campaign = await tx.fundraiserCampaign.findUnique({
            where: { id: campaignId },
            include: { customer: { select: { business_id: true } } },
          });

          if (!campaign) {
            return { ok: false, status: 404, error: 'Campaign not found' };
          }

          // Step 2: Tenant ownership
          if (campaign.customer.business_id !== businessId) {
            return { ok: false, status: 404, error: 'Campaign not found' };
          }

          // Step 3: Closed check
          if (isCampaignClosed(campaign)) {
            return { ok: false, status: 410, error: 'This campaign can no longer be changed' };
          }

          // Step 4: Status check
          if (campaign.bundle_selection_status !== 'selected') {
            return {
              ok: false,
              status: 409,
              error: 'This campaign does not require a controlled override',
            };
          }

          // Step 5: Count all historical campaign orders (including canceled)
          // Controlled override is required when any order row exists — canceled orders
          // still preserve historical bundle IDs, quantities, prices, and audit history.
          const orderCount = await tx.order.count({
            where: { campaign_id: campaignId },
          });

          if (orderCount === 0) {
            return {
              ok: false,
              status: 409,
              error: 'This campaign does not require a controlled override',
            };
          }

          // Step 6: Validate selection limit
          const selectionLimit = campaign.bundle_selection_limit;
          if (uniqueFamilyIds.length !== selectionLimit) {
            return {
              ok: false,
              status: 400,
              error: `Choose exactly ${selectionLimit} bundle families`,
            };
          }

          // Step 7: Validate candidate membership
          // Load candidate CampaignBundle rows for this campaign
          const candidateRows = await tx.campaignBundle.findMany({
            where: { campaign_id: campaignId, state: 'candidate' },
            select: {
              bundle: {
                select: {
                  family_id: true,
                  serving_tier: true,
                  business_id: true,
                },
              },
            },
          });

          // Build set of candidate family IDs (from Serves 5 / family tier candidates)
          const candidateFamilyIds = new Set<string>();
          for (const row of candidateRows) {
            const b = row.bundle;
            if (
              b.family_id &&
              b.business_id === businessId &&
              isCanonicalFamilyTier(b.serving_tier)
            ) {
              candidateFamilyIds.add(b.family_id);
            }
          }

          for (const fid of uniqueFamilyIds) {
            if (!candidateFamilyIds.has(fid)) {
              return {
                ok: false,
                status: 400,
                error: 'One or more selected families are unavailable',
              };
            }
          }

          // Step 8: Resolve family pairs
          // For each family ID, load all active bundles, find exactly one S5 and one S2.
          const newActiveBundleIds: string[] = [];
          const newActiveRows: Array<{
            campaign_id: string;
            bundle_id: string;
            state: string;
            position: number;
          }> = [];

          for (let i = 0; i < uniqueFamilyIds.length; i++) {
            const familyId = uniqueFamilyIds[i];

            const familyBundles = await tx.bundle.findMany({
              where: {
                family_id: familyId,
                business_id: businessId,
                is_active: true,
              },
              select: {
                id: true,
                serving_tier: true,
              },
            });

            const s5Bundles = familyBundles.filter((b) => isCanonicalFamilyTier(b.serving_tier));
            const s2Bundles = familyBundles.filter((b) => isCanonicalServes2Tier(b.serving_tier));

            // Must have exactly one S5 and exactly one S2
            if (s5Bundles.length !== 1 || s2Bundles.length !== 1) {
              return {
                ok: false,
                status: 400,
                error: 'One or more selected families are unavailable',
              };
            }

            newActiveBundleIds.push(s5Bundles[0].id, s2Bundles[0].id);
            newActiveRows.push(
              { campaign_id: campaignId, bundle_id: s5Bundles[0].id, state: 'active', position: i * 2 },
              { campaign_id: campaignId, bundle_id: s2Bundles[0].id, state: 'active', position: i * 2 + 1 },
            );
          }

          // Step 9: Capture current active bundle IDs and family IDs
          const currentActiveRows = await tx.campaignBundle.findMany({
            where: { campaign_id: campaignId, state: 'active' },
            select: {
              bundle_id: true,
              bundle: {
                select: { family_id: true, serving_tier: true },
              },
            },
          });

          const previousActiveBundleIds = currentActiveRows.map((r) => r.bundle_id);
          const previousFamilyIdSet = new Set<string>();
          for (const r of currentActiveRows) {
            if (r.bundle.family_id && isCanonicalFamilyTier(r.bundle.serving_tier)) {
              previousFamilyIdSet.add(r.bundle.family_id);
            }
          }
          const previousFamilyIds = [...previousFamilyIdSet];

          // Step 10: Delete current active rows (preserve candidates)
          await tx.campaignBundle.deleteMany({
            where: { campaign_id: campaignId, state: 'active' },
          });

          // Step 11: Insert new active rows
          await tx.campaignBundle.createMany({
            data: newActiveRows,
          });

          // Step 12: Update campaign — keep 'selected', refresh timestamp
          const now = new Date();
          await tx.fundraiserCampaign.update({
            where: { id: campaignId },
            data: {
              bundle_selection_at: now,
            },
          });

          // Step 13: Write activity event
          await tx.coordinatorActionEvent.create({
            data: {
              campaign_id: campaignId,
              action_type: 'bundle_selection_overridden',
              source: null,
              metadata: {
                actorType: 'tenant_user',
                actorId: actorId,
                channel: 'tenant_crm',
                reason: reason.trim(),
                previousFamilyIds,
                previousActiveBundleIds,
                newFamilyIds: uniqueFamilyIds,
                newActiveBundleIds,
                existingOrderCount: orderCount,
                overriddenAt: now.toISOString(),
              },
            },
          });

          return {
            ok: true,
            previousFamilyIds,
            previousActiveBundleIds,
            newFamilyIds: uniqueFamilyIds,
            newActiveBundleIds,
            existingOrderCount: orderCount,
          };
        },
        {
          isolationLevel: 'Serializable',
          timeout: 15000,
        },
      );
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2034' &&
        attempt < MAX_RETRIES - 1
      ) {
        continue; // Retry on serialization conflict
      }
      throw err;
    }
  }

  // Exhausted retries
  return {
    ok: false,
    status: 409,
    error: 'The campaign changed while this request was being processed. Please try again.',
  };
}
