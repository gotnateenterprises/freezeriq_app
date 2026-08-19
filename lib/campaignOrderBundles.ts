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
import { isCampaignClosed, isCampaignPastOrderDeadline } from '@/lib/campaignBundleSelection';
import { isValidIanaTimeZone } from '@/lib/tenantTimezone';
import { normalizeStrictServingTier } from '@/lib/serving_multipliers';

// ── Domain types ─────────────────────────────────────────────────────────────

/**
 * Discriminated union describing how a campaign's ordering eligibility was
 * resolved. Callers branch on `mode` and never fall through silently.
 * Returned as a JSON-safe object across the server-client boundary.
 */
export type CampaignOrderBundleMode =
    | { allowed: boolean; mode: 'legacy'; activeOrderableBundleIds: string[] }
    | { allowed: boolean; mode: 'closed' | 'pending' | 'invalid'; reasonCode: string; safeMessage: string; activeOrderableBundleIds: string[] }
    | { allowed: boolean; mode: 'selected'; activeOrderableBundleIds: string[] };

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
 * Determines the ordering mode for a campaign based on its bundle_selection_status
 * and closed state.
 *
 * For `selected` campaigns, loads active CampaignBundle rows and resolves
 * each to a bundle that:
 *   - exists in the database
 *   - belongs to the expected business (tenant isolation)
 *   - has is_active = true (catalog status)
 *
 * Selected campaigns with zero valid active assignments fail closed.
 *
 * @param campaign            The campaign to evaluate (must contain closed_at, status, bundle_selection_status, bundle_selection_limit, id)
 * @param businessId          The trusted business ID (derived server-side)
 */
export async function resolveCampaignOrderMode(
    campaign: any,
    businessId: string,
    /**
     * The tenant's IANA zone, from the durable Business row. Supplied ONLY by
     * supporter-facing callers; see the deadline block below for why the
     * tenant-facing tools deliberately omit it. Never client-supplied.
     */
    deadlineTimeZone?: string | null
): Promise<CampaignOrderBundleMode> {
    // 1. Closed: Check campaign dates/status first.
    if (isCampaignClosed(campaign)) {
        return {
            allowed: false,
            mode: 'closed',
            reasonCode: 'closed',
            safeMessage: 'Campaign is closed. Order changes are no longer permitted.',
            activeOrderableBundleIds: []
        };
    }

    // 1b. FR-ORDERABILITY-1-R: the SUPPORTER ordering deadline.
    //
    // Checked BEFORE the bundle-selection matrix so it applies to every mode.
    // The original defect was never a legacy-bypass problem: CRM4 Runtime Test
    // reached `selected` through the modern coordinator gate and stayed
    // orderable weeks past its end_date, because nothing on the order path
    // consulted the deadline at all. Sitting ahead of the branch is what makes
    // legacy and modern campaigns expire identically.
    //
    // WHY THE TIMEZONE IS A PARAMETER, AND WHY IT IS OPTIONAL
    // The deadline is a supporter-facing rule. Only the two public paths — the
    // fundraiser page and the public order route — pass a zone, and they pass
    // the durable Business.timezone. The tenant-facing callers (coordinator
    // portal, tracker, pickup sheet, flyer, packet, promo scripts) deliberately
    // pass none: a coordinator must still be able to pull a tracker or a
    // pickup sheet after supporter ordering has closed, which is exactly when
    // they need it most. Omitting the zone therefore means "this caller is not
    // a supporter ordering path", not "skip the check for convenience".
    if (deadlineTimeZone !== undefined && deadlineTimeZone !== null) {
        // A tenant whose zone cannot be resolved must not keep selling. Fail
        // closed, and say nothing about the configuration to the customer.
        if (!isValidIanaTimeZone(deadlineTimeZone)) {
            return {
                allowed: false,
                mode: 'invalid',
                reasonCode: 'timezone_unavailable',
                safeMessage: 'This fundraiser is temporarily unavailable. Please try again later.',
                activeOrderableBundleIds: []
            };
        }
        if (isCampaignPastOrderDeadline(campaign, deadlineTimeZone)) {
            return {
                allowed: false,
                mode: 'closed',
                reasonCode: 'deadline_passed',
                safeMessage: 'This fundraiser is no longer accepting orders.',
                activeOrderableBundleIds: []
            };
        }
    }

    const { bundle_selection_status, bundle_selection_limit, id: campaignId } = campaign;

    // 2. Legacy: no candidate pool, preserve business-wide fallback
    if (bundle_selection_status === 'not_required') {
        return { allowed: true, mode: 'legacy', activeOrderableBundleIds: [] };
    }

    // 3. Pending: coordinator has not selected bundles yet
    if (bundle_selection_status === 'pending') {
        return {
            allowed: false,
            mode: 'pending',
            reasonCode: 'pending',
            safeMessage: 'The coordinator is finalizing the menu.',
            activeOrderableBundleIds: []
        };
    }

    // 4. Selected: validate every active assignment, then build permitted set
    if (bundle_selection_status === 'selected') {
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
                        family_id: true,
                        serving_tier: true,
                    },
                },
            },
        });

        // Selected campaign with zero active assignment rows = fail closed.
        if (activeAssignments.length === 0) {
            return {
                allowed: false,
                mode: 'invalid',
                reasonCode: 'invalid',
                safeMessage: 'Campaign bundle availability is not configured correctly',
                activeOrderableBundleIds: []
            };
        }

        const families = new Map<string, { s5: boolean; s2: boolean }>();

        // Every active assignment must pass all structural checks.
        // A single invalid row rejects the entire campaign — do not filter and continue.
        for (const row of activeAssignments) {
            const b = row.bundle;
            // Tenant isolation: assigned bundle must belong to the campaign's business.
            // Catalog status: bundle must be active in the tenant's catalog.
            // Family identity: bundle must belong to a family.
            if (b.business_id !== businessId || !b.is_active || !b.family_id) {
                return {
                    allowed: false,
                    mode: 'invalid',
                    reasonCode: 'invalid',
                    safeMessage: 'Campaign bundle availability is not configured correctly',
                    activeOrderableBundleIds: []
                };
            }

            const f = families.get(b.family_id) || { s5: false, s2: false };

            // Strict tier resolution: recognizes the same alias vocabulary as
            // the coordinator-selection path (resolveVariantSize's DB_MAP), but
            // never defaults an unrecognized tier to serves_5 — fail closed.
            const tier = normalizeStrictServingTier(b.serving_tier);

            if (tier === 'serves_5') {
                if (f.s5) return { allowed: false, mode: 'invalid', reasonCode: 'invalid', safeMessage: 'Campaign bundle availability is not configured correctly', activeOrderableBundleIds: [] };
                f.s5 = true;
            } else if (tier === 'serves_2') {
                if (f.s2) return { allowed: false, mode: 'invalid', reasonCode: 'invalid', safeMessage: 'Campaign bundle availability is not configured correctly', activeOrderableBundleIds: [] };
                f.s2 = true;
            } else {
                return { allowed: false, mode: 'invalid', reasonCode: 'invalid', safeMessage: 'Campaign bundle availability is not configured correctly', activeOrderableBundleIds: [] };
            }

            families.set(b.family_id, f);
        }

        // Must exactly match the campaign's required number of families
        if (families.size !== bundle_selection_limit) {
            return {
                allowed: false,
                mode: 'invalid',
                reasonCode: 'invalid',
                safeMessage: 'Campaign bundle availability is not configured correctly',
                activeOrderableBundleIds: []
            };
        }

        // Each family must have exactly one serves_5 and exactly one serves_2
        for (const f of families.values()) {
            if (!f.s5 || !f.s2) {
                return {
                    allowed: false,
                    mode: 'invalid',
                    reasonCode: 'invalid',
                    safeMessage: 'Campaign bundle availability is not configured correctly',
                    activeOrderableBundleIds: []
                };
            }
        }

        // All rows passed — build the permitted set from the validated assignments.
        const validBundleIds = activeAssignments.map((row) => row.bundle.id);

        return { allowed: true, mode: 'selected', activeOrderableBundleIds: validBundleIds };
    }

    // ── Unexpected status: fail closed ────────────────────────────────────
    return {
        allowed: false,
        mode: 'invalid',
        reasonCode: 'invalid',
        safeMessage: 'Campaign bundle availability is not configured correctly',
        activeOrderableBundleIds: []
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
 * @param mode                The resolved campaign ordering mode
 * @param submittedBundleIds  Array of bundle IDs from the order request
 */
export function validateBundleEligibility(
    mode: CampaignOrderBundleMode,
    submittedBundleIds: string[],
): BundleEligibilityResult {
    // Rejected campaigns (pending, invalid, closed) — propagate the rejection
    if (!mode.allowed) {
        return { ok: false, status: 400, error: 'safeMessage' in mode ? mode.safeMessage : 'Order not allowed' };
    }

    // Legacy campaigns — no campaign-level restriction
    if (mode.mode === 'legacy') {
        return { ok: true };
    }

    // Selected campaigns — every submitted ID must be in the active set
    const activeSet = new Set(mode.activeOrderableBundleIds);
    for (const bundleId of submittedBundleIds) {
        if (!activeSet.has(bundleId)) {
            return {
                ok: false,
                status: 400,
                error: 'One or more selected bundles are not available for this campaign',
            };
        }
    }

    return { ok: true };
}
