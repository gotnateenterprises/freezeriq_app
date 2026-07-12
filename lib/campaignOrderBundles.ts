/**
 * CB-5: Campaign-Aware Bundle Order Eligibility
 *
 * Shared validation helper used by both coordinator and public order POST
 * handlers to enforce campaign-level bundle assignment before any order,
 * payment, or notification side effect occurs.
 *
 * SECURITY CONTEXT:
 *   Closes the pre-existing gap where submitted bundle IDs were validated
 *   only against the business-wide catalog (via buildBundlePriceMap), not
 *   against the specific campaign's active CampaignBundle assignments.
 *
 * CAMPAIGN ORDERING MODES:
 *   "not_required" → legacy fallback: business-wide validation preserved
 *   "pending"      → orders rejected (coordinator has not selected bundles)
 *   "selected"     → only active CampaignBundle-assigned bundle IDs accepted
 *   anything else  → orders rejected (fail-closed)
 *
 * PAYMENT BOUNDARY:
 *   This module performs NO payment operations. It is called before any
 *   payment session, provider call, or order creation.
 *
 * @module campaignOrderBundles
 */

import { prisma } from '@/lib/db';

// ── Domain types ─────────────────────────────────────────────────────────────

/**
 * Discriminated union describing how a campaign's ordering eligibility was
 * resolved. Callers branch on `kind` and never fall through silently.
 */
export type CampaignOrderBundleMode =
    | { kind: 'selected'; activeBundleIds: Set<string> }
    | { kind: 'legacy' }
    | { kind: 'rejected'; status: number; error: string };

/**
 * Result of validating submitted bundle IDs against the campaign's mode.
 * `ok: true` means all submitted IDs are eligible; `ok: false` carries
 * a safe HTTP status and error message.
 */
export type BundleEligibilityResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

// ── Mode resolution ──────────────────────────────────────────────────────────

/**
 * Determines the ordering mode for a campaign based on its bundle_selection_status.
 *
 * For `selected` campaigns, loads active CampaignBundle rows and resolves
 * each to a bundle that:
 *   - exists in the database
 *   - belongs to the expected business (tenant isolation)
 *   - has is_active = true (catalog status)
 *
 * Selected campaigns with zero valid active assignments fail closed.
 *
 * @param campaignId            The campaign to evaluate
 * @param businessId            The trusted business ID (derived server-side)
 * @param bundleSelectionStatus The campaign's bundle_selection_status field
 */
export async function resolveCampaignOrderMode(
    campaignId: string,
    businessId: string,
    bundleSelectionStatus: string,
): Promise<CampaignOrderBundleMode> {
    // ── Legacy: no candidate pool, preserve business-wide fallback ────────
    if (bundleSelectionStatus === 'not_required') {
        return { kind: 'legacy' };
    }

    // ── Pending: coordinator has not selected bundles yet ─────────────────
    if (bundleSelectionStatus === 'pending') {
        return {
            kind: 'rejected',
            status: 409,
            error: 'Bundle selection must be completed before orders can be submitted',
        };
    }

    // ── Selected: validate every active assignment, then build permitted set ─
    if (bundleSelectionStatus === 'selected') {
        const activeAssignments = await prisma.campaignBundle.findMany({
            where: {
                campaign_id: campaignId,
                state: 'active',
            },
            select: {
                bundle: {
                    select: {
                        id: true,
                        business_id: true,
                        is_active: true,
                    },
                },
            },
        });

        // Selected campaign with zero active assignment rows = fail closed.
        // Never falls back to business-wide catalog.
        if (activeAssignments.length === 0) {
            return {
                kind: 'rejected',
                status: 409,
                error: 'Campaign bundle availability is not configured correctly',
            };
        }

        // Every active assignment must pass all structural checks.
        // A single invalid row rejects the entire campaign — do not filter and continue.
        for (const row of activeAssignments) {
            const b = row.bundle;
            // Tenant isolation: assigned bundle must belong to the campaign's business.
            if (b.business_id !== businessId) {
                return {
                    kind: 'rejected',
                    status: 409,
                    error: 'Campaign bundle availability is not configured correctly',
                };
            }
            // Catalog status: bundle must be active in the tenant's catalog.
            if (!b.is_active) {
                return {
                    kind: 'rejected',
                    status: 409,
                    error: 'Campaign bundle availability is not configured correctly',
                };
            }
        }

        // All rows passed — build the permitted set from the validated assignments.
        const validBundleIds = new Set<string>(
            activeAssignments.map((row) => row.bundle.id),
        );

        return { kind: 'selected', activeBundleIds: validBundleIds };
    }

    // ── Unexpected status: fail closed ────────────────────────────────────
    return {
        kind: 'rejected',
        status: 409,
        error: 'Campaign bundle availability is not configured correctly',
    };
}

// ── Submitted bundle validation ──────────────────────────────────────────────

/**
 * Validates that every submitted bundle ID is eligible for the campaign.
 *
 * For `legacy` campaigns: always returns ok (business-wide validation is
 * handled downstream by buildBundlePriceMap).
 *
 * For `selected` campaigns: every submitted ID must appear in the active
 * assignment set. The entire order is rejected if any single ID fails.
 *
 * For `rejected` campaigns: propagates the rejection status and message.
 *
 * @param mode             The resolved campaign ordering mode
 * @param submittedBundleIds  Array of bundle IDs from the order request
 */
export function validateBundleEligibility(
    mode: CampaignOrderBundleMode,
    submittedBundleIds: string[],
): BundleEligibilityResult {
    // Rejected campaigns (pending, unexpected) — propagate the rejection
    if (mode.kind === 'rejected') {
        return { ok: false, status: mode.status, error: mode.error };
    }

    // Legacy campaigns — no campaign-level restriction
    if (mode.kind === 'legacy') {
        return { ok: true };
    }

    // Selected campaigns — every submitted ID must be in the active set
    for (const bundleId of submittedBundleIds) {
        if (!mode.activeBundleIds.has(bundleId)) {
            return {
                ok: false,
                status: 400,
                error: 'One or more selected bundles are not available for this campaign',
            };
        }
    }

    return { ok: true };
}
