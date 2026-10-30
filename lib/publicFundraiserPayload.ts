/**
 * FR-FLOW-1 — the public supporter payload allowlist for a fundraiser campaign.
 *
 * The public fundraiser page is a Server Component that hands a campaign object
 * to a Client Component. Anything crossing that boundary is serialized into the
 * page's HTML, so it is public by definition. This module is the single place
 * that decides what may cross.
 *
 * It is an explicit INCLUDE list, not a delete list. A column added to the page
 * query later cannot leak by being forgotten here — it simply will not be
 * copied. That is the whole point of the shape.
 *
 * Pure and dependency-free so the boundary can be unit-tested directly.
 */

/**
 * Campaign fields the supporter page legitimately renders.
 * Every one of these is already visible on the public page today.
 */
export const PUBLIC_CAMPAIGN_FIELDS = [
    'id',
    'name',
    'about_text',
    'participant_label',
    'end_date',
    'delivery_date',
    'pickup_location',
    // FR-FLOW-3: the coordinator's confirmed pickup time. Already public — the
    // page has always rendered a time from customer_fundraiser_info; this makes
    // the campaign-specific value the one supporters see.
    'delivery_time',
    'payment_instructions',
    'external_payment_link',
    // FR-TAX-CORRECTNESS-1: this campaign's FROZEN tax treatment. Deliberately
    // public — the supporter is the one being charged the tax, so the page must
    // be able to show them the same figure the server will persist. Contrast
    // org_share_percent below, which is tenant-internal and stays forbidden:
    // what the organization earns is none of the supporter's business, but what
    // the supporter pays certainly is.
    'tax_status',
    'tax_rate_percent',
    'organization_name',
    'customer_fundraiser_info',
] as const;

/**
 * Fields that must NEVER reach the public payload. This list is not the
 * mechanism — the include list above is — but it names the specific things that
 * were leaking, so a test can assert on them by name and fail loudly if the
 * projection is ever replaced by a spread.
 *
 * portal_token is the coordinator's only credential for the private portal and
 * setup page. The rest are tenant-internal financial and lifecycle fields.
 */
export const FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS = [
    'portal_token',
    'public_token',
    'settlement_total',
    'settlement_notes',
    'closed_by',
    'closed_at',
    'org_share_percent',
    'checks_payable',
    'goal_amount',
    'customer_id',
    'status',
    'bundle_selection_status',
    'bundle_selection_limit',
    'bundle_selection_at',
    'checklist',
    'coordinator_email',
    'created_at',
    'updated_at',
] as const;

/**
 * Keys of the organization's free-form `fundraiser_info` JSON that the supporter
 * page reads. The blob also carries internal values (checks_payable_to, flyer
 * details, goals), so it is narrowed rather than forwarded whole.
 */
export const PUBLIC_FUNDRAISER_INFO_KEYS = [
    'delivery_date',
    'delivery_time',
    'pickup_location',
] as const;

export interface PublicFundraiserInfo {
    delivery_date: unknown;
    delivery_time: unknown;
    pickup_location: unknown;
}

export type PublicCampaign = Record<(typeof PUBLIC_CAMPAIGN_FIELDS)[number], unknown> & {
    customer_fundraiser_info: PublicFundraiserInfo;
};

/**
 * Project a raw campaign row onto the public allowlist.
 *
 * Missing fields become null rather than being omitted, so the client sees a
 * stable shape whatever the query returned.
 */
export function toPublicCampaign(row: Record<string, any> | null | undefined): PublicCampaign | null {
    if (!row) return null;

    const info = (row.customer_fundraiser_info && typeof row.customer_fundraiser_info === 'object')
        ? row.customer_fundraiser_info
        : {};

    const out: Record<string, unknown> = {};
    for (const field of PUBLIC_CAMPAIGN_FIELDS) {
        out[field] = row[field] ?? null;
    }

    out.customer_fundraiser_info = {
        delivery_date: info.delivery_date ?? null,
        delivery_time: info.delivery_time ?? null,
        pickup_location: info.pickup_location ?? null,
    };

    return out as PublicCampaign;
}

// ── FR-SUPPORTER-SHARE-INTEGRITY-1: the rest of the page's public payload ────────────────────
//
// toPublicCampaign closed the campaign row. The page still handed the client component everything
// else WHOLE: the business row (id, timezone), the tenant_branding row (`SELECT b.*` — user_id and
// the review/thank-you settings), every bundle column (`SELECT *` — sku, stock_on_hand, business_id,
// catalog_id, family_id…), each bundle_contents row, the dollar sales and estimated earnings behind
// the progress bar, and the ordering mode's internal reason code. All of it was serialized into the
// public HTML. The include-lists below are built from what FundraiserClient actually renders.

/** Business fields the supporter page reads (the brand name rule needs name + display_name). */
export const PUBLIC_SUPPORTER_BUSINESS_FIELDS = ['name', 'display_name', 'slug', 'logo_url'] as const;
/** TenantBranding fields the supporter page reads: the accent colour and the logo. */
export const PUBLIC_SUPPORTER_BRANDING_FIELDS = ['primary_color', 'logo_url'] as const;
/** Bundle fields a bundle card renders, plus `id` (what an order line names). */
export const PUBLIC_SUPPORTER_BUNDLE_FIELDS = ['id', 'name', 'description', 'serving_tier', 'price', 'image_url'] as const;
/** Meal fields: the public menu. Names are shown today; the rest is published meal information. */
export const PUBLIC_SUPPORTER_RECIPE_FIELDS = ['name', 'description', 'image_url', 'cook_time', 'allergens', 'macros'] as const;

/** Named so a test can fail loudly if a projection is ever replaced by a spread. */
export const FORBIDDEN_PUBLIC_SUPPORTER_FIELDS = {
    business: ['id', 'timezone', 'custom_domain', 'contact_email', 'stripe_customer_id', 'stripe_subscription_id', 'plan', 'subscription_status', 'default_food_tax_percent'],
    branding: ['id', 'user_id', 'business_name', 'review_qr_url', 'thank_you_note', 'review_prompt', 'sign_off', 'created_at', 'updated_at'],
    bundle: ['sku', 'stock_on_hand', 'business_id', 'catalog_id', 'family_id', 'is_active', 'show_on_storefront', 'is_surplus', 'order_cutoff_date'],
    item: ['id', 'bundle_id', 'recipe_id', 'position'],
    progress: ['totalSales', 'estimatedEarnings', 'raisedAmount', 'progressPercent'],
    orderMode: ['reasonCode', 'activeOrderableBundleIds'],
} as const;

function pick<K extends string>(row: Record<string, any> | null | undefined, keys: readonly K[]): Record<K, unknown> {
    const out = {} as Record<K, unknown>;
    for (const k of keys) out[k] = row?.[k] ?? null;
    return out;
}

/** Plain JSON number, or null — Decimals arrive as strings and must not reach the client as NaN. */
function num(v: unknown): number | null {
    const n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
}

export interface PublicSupporterBundle {
    id: unknown; name: unknown; description: unknown; serving_tier: unknown; price: number | null; image_url: unknown;
    items: { quantity: number | null; recipe: Record<(typeof PUBLIC_SUPPORTER_RECIPE_FIELDS)[number], unknown> }[];
}

/**
 * The business object the supporter component receives: brand, logo, accent colour and the bundle
 * lineup. `bundles` arrive in the page's formatted shape (`items[].recipe` already nested).
 */
export function toPublicSupporterBusiness(
    business: Record<string, any> | null | undefined,
    branding: Record<string, any> | null | undefined,
    bundles: readonly Record<string, any>[] | null | undefined,
) {
    return {
        ...pick(business, PUBLIC_SUPPORTER_BUSINESS_FIELDS),
        branding: pick(branding, PUBLIC_SUPPORTER_BRANDING_FIELDS),
        bundles: (bundles || []).map((b): PublicSupporterBundle => ({
            ...pick(b, PUBLIC_SUPPORTER_BUNDLE_FIELDS),
            price: num(b?.price),
            items: (b?.items || []).map((i: any) => ({
                quantity: num(i?.quantity),
                recipe: pick(i?.recipe, PUBLIC_SUPPORTER_RECIPE_FIELDS),
            })),
        })),
    };
}

/** Progress: the two weighted-bundle numbers the page shows. No dollar figures. */
export function toPublicBundleProgress(progress: { totalBundlesSold?: unknown; bundleGoal?: unknown } | null | undefined) {
    return {
        totalBundlesSold: num(progress?.totalBundlesSold) ?? 0,
        bundleGoal: num(progress?.bundleGoal),
    };
}

// ── FR-SUPPORTER-SHARE-INTEGRITY-1: the public scoreboard API (/api/fundraiser/[token]) ───────
//
// The route returned the campaign row it selected plus `total_sales` — the fundraiser's DOLLAR
// sales — and every order's `total_amount`, i.e. how much each (name-masked) supporter spent, with
// a timestamp. It also carried the lifecycle status, the dollar goal and dates the scoreboard never
// shows. Built from ScoreboardClient's real usage: progress is in weighted bundles, so no dollar
// figure is needed at all.

/** Campaign fields the scoreboard renders. */
export const PUBLIC_SCOREBOARD_FIELDS = [
    'name', 'mission_text', 'about_text', 'bundle_goal', 'bundle_selection_status',
    'payment_instructions', 'external_payment_link',
] as const;

/** Named so a test can fail loudly if the projection is ever replaced by a spread. */
export const FORBIDDEN_PUBLIC_SCOREBOARD_FIELDS = [
    'id', 'status', 'total_sales', 'goal_amount', 'start_date', 'end_date', 'delivery_date', 'pickup_location',
    'portal_token', 'public_token', 'settlement_total', 'org_share_percent', 'closed_at', 'customer_id',
] as const;
export const FORBIDDEN_PUBLIC_SCOREBOARD_ORDER_FIELDS = ['id', 'total_amount', 'email', 'phone', 'first_name', 'last_name', 'customer_id'] as const;

/**
 * The scoreboard payload. `maskName` is the route's own first-name + last-initial rule, passed in
 * so the masking stays where it is defined. Orders keep only what the "Recent Support" list shows.
 */
export function toPublicScoreboard(
    row: Record<string, any> | null | undefined,
    maskName: (name: string | null | undefined) => string | null,
) {
    if (!row) return null;
    return {
        ...pick(row, PUBLIC_SCOREBOARD_FIELDS),
        customer: { name: row.customer?.name ?? null },
        orders: (row.orders || []).map((o: any) => ({
            customer_name: maskName(o?.customer_name),
            created_at: o?.created_at ?? null,
            items: (o?.items || []).map((i: any) => ({ quantity: num(i?.quantity) ?? 0, variant_size: i?.variant_size ?? null })),
        })),
    };
}

/** The ordering mode the page gates on, and the customer-safe sentence that explains a block. */
export function toPublicOrderMode(mode: Record<string, any> | null | undefined) {
    if (!mode) return null;
    return {
        allowed: mode.allowed === true,
        mode: typeof mode.mode === 'string' ? mode.mode : 'invalid',
        ...(typeof mode.safeMessage === 'string' ? { safeMessage: mode.safeMessage } : {}),
    };
}
