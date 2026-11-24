/**
 * FR-SUPPORTER-ADDON-UPSELL-1 (S4) — the campaign add-on the PUBLIC supporter page may offer.
 *
 * The supporter page shows an inline "Complete your meals" card when the campaign has an add-on. This
 * module decides whether it has one, and what of it the page may receive. It returns null — and the page
 * looks exactly as it did before S4 — unless EVERY condition holds:
 *
 *   1. the campaign is orderable (the caller passes the page's own ordering decision);
 *   2. an assignment row exists for this campaign, in this tenant;
 *   3. its bundle is this tenant's, active, and typed 'addon';
 *   4. its price is a real amount above $0;
 *   5. it has at least one meal with a real name.
 *
 * Conditions 2–3 are the same authority every order is held to (lib/campaignAddOns.loadCampaignAddOnAuthority);
 * 4–5 are the assignment rules (lib/campaignAddOnEarnings.addOnBundleIneligibility), rechecked because a bundle
 * can change after it was assigned. The page's offer is still only a DISPLAY: the order route re-decides
 * everything (409 ADDON_CHANGED when the add-on is no longer this campaign's), and the price is the server's.
 *
 * The projection is lib/publicFundraiserPayload.toPublicSupporterAddOn (an include-list). The share schedule
 * contributes at most ONE number, and only when the tenant turned the toggle on for this fundraiser and the
 * schedule has a single tier (lib/campaignAddOnShare.publicAddOnSupportPercent).
 *
 * Never breaks the page: any failure is logged and treated as "no add-on".
 */

import { ADD_ON_BUNDLE_TYPE, BUNDLE_TYPE_SELECT, SHOW_SHARE_PERCENT_SELECT, normalizeBundleType } from './campaignAddOns';
import { normalizeStoredTiers, publicAddOnSupportPercent } from './campaignAddOnShare';
import { PUBLIC_SUPPORTER_RECIPE_FIELDS, toPublicSupporterAddOn, type PublicSupporterAddOn } from './publicFundraiserPayload';
import { publicText } from './supporterBundleDetail';

const RECIPE_SELECT = Object.fromEntries(PUBLIC_SUPPORTER_RECIPE_FIELDS.map((f) => [f, true]));

export async function loadPublicCampaignAddOn(
    db: any,
    params: { campaignId: string; businessId: string; orderable: boolean },
): Promise<PublicSupporterAddOn | null> {
    if (params.orderable !== true) return null;
    try {
        const row = await db.campaignAddOn.findUnique({
            where: { campaign_id: params.campaignId },
            select: {
                business_id: true,
                bundle_id: true,
                ...SHOW_SHARE_PERCENT_SELECT,
                bundle: {
                    select: {
                        id: true,
                        name: true,
                        description: true,
                        image_url: true,
                        price: true,
                        business_id: true,
                        is_active: true,
                        ...BUNDLE_TYPE_SELECT,
                        // The bundle's own saved order — the same rule the meal bundles' SQL uses.
                        contents: {
                            select: { quantity: true, recipe: { select: RECIPE_SELECT } },
                            orderBy: { position: { sort: 'asc', nulls: 'last' } },
                        },
                    },
                },
                share_tiers: { select: { starting_quantity: true, percent: true }, orderBy: { starting_quantity: 'asc' } },
            },
        });
        if (!row || row.business_id !== params.businessId) return null;
        const bundle = row.bundle;
        if (!bundle || bundle.id !== row.bundle_id || bundle.business_id !== params.businessId) return null;
        if (bundle.is_active !== true || normalizeBundleType(bundle.bundle_type) !== ADD_ON_BUNDLE_TYPE) return null;
        const price = Number(bundle.price);
        if (!Number.isFinite(price) || !(price > 0)) return null;
        if (!publicText(bundle.name)) return null;
        const contents: any[] = Array.isArray(bundle.contents) ? bundle.contents : [];
        if (!contents.some((c) => publicText(c?.recipe?.name))) return null;

        const supportPercent = publicAddOnSupportPercent(normalizeStoredTiers(row.share_tiers), (row as any).show_share_percent);
        return toPublicSupporterAddOn(bundle, contents, supportPercent);
    } catch (err) {
        console.error('[campaign add-on] public lookup failed; showing the page without the add-on:', err);
        return null;
    }
}
