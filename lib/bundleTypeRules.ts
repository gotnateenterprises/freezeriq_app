/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S2) — what a Bundle Editor save may do with `bundle_type`.
 *
 * A bundle is a MEAL bundle (every bundle before S1, and the default) or a FUNDRAISER ADD-ON: sold only
 * as an optional extra on a fundraiser that assigns it (campaign_add_ons), beside at least one meal bundle.
 *
 * An add-on, enforced here on every create and update (and by database CHECKs underneath):
 *   - is ONE size: saved with serving_tier 'family' — an existing real tier, so its order lines keep
 *     variant_size serves_5 with multiplier 1. No zero tier, fake size or zero multiplier is introduced;
 *   - is never on the storefront (show_on_storefront false; CHECK bundles_addon_not_on_storefront), which
 *     also keeps it out of every legacy fundraiser lineup, flyer, packet and tracker;
 *   - is never in a meal family (CHECK bundles_addon_has_no_family), so it has no Serves 2 sibling.
 * Its contents, recipes, image, description and price are kept exactly as they are.
 *
 * Changing the type is refused, in words the tenant can act on, when it would corrupt something:
 *   Meal -> Add-on   the bundle is in a meal family, or on an OPEN fundraiser's meal lineup;
 *   Add-on -> Meal   the bundle is currently a fundraiser's assigned add-on.
 * Past orders are untouched either way: each order line keeps the role it was sold with (item_role).
 */

import {
    ADD_ON_BUNDLE_TYPE,
    MEAL_BUNDLE_TYPE,
    normalizeBundleType,
    type BundleType,
} from './campaignAddOns';
import { CLOSED_STATUSES } from './campaignBundleSelection';

/** The one serving tier an add-on is saved with (an existing canonical tier; multiplier 1). */
export const ADD_ON_SERVING_TIER = 'family';

export const ADDON_STOREFRONT_REFUSAL =
    'A fundraiser add-on is only sold beside a fundraiser meal order, so it can\'t be shown on the storefront.';
export const ADDON_TIER_REFUSAL =
    'A fundraiser add-on has one size, so it has no serving size or Serves 2 version.';

const has = (body: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

export type RequestedBundleType = { ok: true; value: BundleType | undefined } | { ok: false; error: string };

/** The type a request asks for: undefined when it does not say (an omitted key leaves the column alone). */
export function parseRequestedBundleType(body: unknown): RequestedBundleType {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: true, value: undefined };
    const b = body as Record<string, unknown>;
    if (!has(b, 'bundle_type')) return { ok: true, value: undefined };
    if (b.bundle_type === MEAL_BUNDLE_TYPE) return { ok: true, value: MEAL_BUNDLE_TYPE };
    if (b.bundle_type === ADD_ON_BUNDLE_TYPE) return { ok: true, value: ADD_ON_BUNDLE_TYPE };
    return { ok: false, error: 'Bundle type must be "meal" or "addon".' };
}

/**
 * Shapes the columns a save writes for the bundle's EFFECTIVE type (requested, else stored).
 * For an add-on: an explicit storefront=true or a non-'family' tier is refused (never silently changed),
 * and both columns are then pinned, so a bundle becoming an add-on is taken off the storefront and given
 * its one size in the same write. A meal bundle's data passes through untouched.
 */
export function shapeBundleWriteForType<T extends { serving_tier?: string; show_on_storefront?: boolean }>(
    data: T,
    effectiveType: BundleType,
): { ok: true; data: T } | { ok: false; error: string } {
    if (effectiveType !== ADD_ON_BUNDLE_TYPE) return { ok: true, data };
    if (data.show_on_storefront === true) return { ok: false, error: ADDON_STOREFRONT_REFUSAL };
    if (data.serving_tier !== undefined && data.serving_tier !== ADD_ON_SERVING_TIER) {
        return { ok: false, error: ADDON_TIER_REFUSAL };
    }
    return { ok: true, data: { ...data, serving_tier: ADD_ON_SERVING_TIER, show_on_storefront: false } };
}

/**
 * Null when the bundle may change from `from` to `to`; otherwise the reason. Reads through the client or
 * transaction passed in (the bundle PUT holds the bundle row lock while it decides and writes).
 */
export async function bundleTypeChangeRefusal(
    db: any,
    params: { bundleId: string; from: unknown; to: BundleType; familyId: string | null },
): Promise<string | null> {
    const from = normalizeBundleType(params.from);
    if (from === params.to) return null;

    if (params.to === ADD_ON_BUNDLE_TYPE) {
        if (params.familyId) {
            return 'This bundle is paired with a Serves 2 version, so it can\'t become a fundraiser add-on. Create a separate add-on bundle instead.';
        }
        const onOpenLineup = await db.campaignBundle.count({
            where: {
                bundle_id: params.bundleId,
                campaign: { closed_at: null, status: { notIn: [...CLOSED_STATUSES] } },
            },
        });
        if (onOpenLineup > 0) {
            return 'This bundle is on an open fundraiser\'s meal lineup, so it can\'t become an add-on. Take it off that lineup first, or create a separate add-on bundle.';
        }
        return null;
    }

    const assigned = await db.campaignAddOn.count({ where: { bundle_id: params.bundleId } });
    if (assigned > 0) {
        return 'This bundle is a fundraiser\'s supporter add-on. Remove it under that fundraiser\'s Supporter Add-On before making it a meal bundle.';
    }
    return null;
}
