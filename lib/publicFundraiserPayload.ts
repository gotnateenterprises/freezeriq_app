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
    'payment_instructions',
    'external_payment_link',
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
