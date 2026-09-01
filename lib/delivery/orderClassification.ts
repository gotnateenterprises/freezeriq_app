/**
 * FULFILLMENT-CONTINUITY-1 — fundraiser fulfillment vs ordinary customer delivery.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md is the canonical ruling
 * this module implements. Read it before changing this rule.
 *
 * WHY THIS EXISTS
 *
 * app/delivery/page.tsx turns one Order into one delivery stop, and it is
 * entirely campaign-blind — the file contains no reference to campaigns at all.
 * The same map/render pair serves fundraiser supporters and ordinary customers,
 * with no discriminator between them. So a released 40-supporter fundraiser
 * becomes 40 separate stops, and because a fundraiser supporter is never asked
 * for a home address, all 40 read "No Address Provided".
 *
 * The owner's ruling is that ONE fundraiser campaign is ONE delivery stop, at
 * the campaign's own pickup location, while ordinary customers keep their
 * per-order stops at their own addresses. Making that change safely requires a
 * discriminator to exist FIRST — otherwise the grouping edit lands in the one
 * code path that also draws every regular customer's delivery.
 *
 * This module is that discriminator. It changes no behaviour and has no
 * importers yet: it is the boundary the delivery repair will consume instead of
 * re-deriving these rules inline for a third time.
 *
 * THE GROUPING KEY IS FundraiserCampaign.id — NOTHING ELSE
 *
 * Not the organization, not the customer, not the campaign name, not the
 * address. One organization may run several campaigns at once, and those are
 * separate production jobs and separate delivery stops. Two live traps make the
 * alternatives actively wrong:
 *
 *   - customer_id is NOT usable. The two fundraiser order paths disagree about
 *     it by design: a public supporter order links a per-supporter customer row,
 *     while a coordinator-entered order links the ORGANIZATION. Grouping on it
 *     yields N groups for supporters and 1 for coordinator entries in the SAME
 *     campaign.
 *   - delivery_address is NOT usable. Fundraiser supporter orders leave it NULL,
 *     so grouping on it would collapse every unrelated fundraiser together for
 *     the wrong reason.
 *
 * CLASSIFICATION IS A CONJUNCTION, AND NEVER GUESSES
 *
 * A fundraiser fulfillment order is `source === 'fundraiser'` AND a non-empty
 * `campaign_id`. Both fundraiser creation paths write the two together, nothing
 * in the codebase mutates either after creation, and the same conjunction is
 * already what the invoice-paid release matches on. A row carrying only one of
 * the two signals is an integrity anomaly, so it classifies as 'ambiguous'
 * rather than being sorted into either lane on a guess — putting it in the wrong
 * lane would either strand a supporter's food or drop a paying customer's stop.
 *
 * WHAT THIS IS NOT
 *
 * Not a stop builder, not a router, not a UI change. It answers questions; it
 * does not create delivery stops.
 *
 * Not a fulfillment_type reader. Order.fulfillment_type has exactly one writer
 * in the repo and zero readers, so every fundraiser, manual and invoice order
 * sits at the schema default. Classifying on it would be classifying on noise.
 *
 * Not a production gate. Whether an order may be COOKED is lib/productionIntake.ts.
 * Whether a campaign is closed is CLOSED_STATUSES / isCampaignClosed in
 * lib/campaignBundleSelection.ts, which is the canonical closed-campaign
 * authority. Neither rule is restated here.
 */

/** Order.source as it reaches us from Prisma — kept as a plain string so this
 *  module never imports a generated enum. */
export type OrderSourceValue = string;

/** The OrderSource value that marks a fundraiser fulfillment order. */
export const FUNDRAISER_ORDER_SOURCE = 'fundraiser';

export interface ClassifiableCampaign {
    /** FundraiserCampaign.id — the fundraiser fulfillment grouping key. */
    id: string;
    /** FundraiserCampaign.pickup_location — free text, nullable, frequently NULL. */
    pickup_location?: string | null;
}

export interface ClassifiableOrder {
    source?: OrderSourceValue | null;
    campaign_id?: string | null;
    /** Order.delivery_address — a postal address for storefront orders, a
     *  free-text note for coordinator-entered ones, NULL for supporters. */
    delivery_address?: string | null;
    /** Present only when the caller joined the campaign; absent is not "no campaign". */
    campaign?: ClassifiableCampaign | null;
}

export type DeliveryOrderKind = 'fundraiser' | 'customer' | 'ambiguous';

/** Trimmed value, or null when absent/blank. */
function text(value: string | null | undefined): string | null {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * True only when BOTH fundraiser signals are present.
 */
export function isFundraiserFulfillmentOrder(
    order: ClassifiableOrder | null | undefined,
): boolean {
    if (!order) return false;
    return order.source === FUNDRAISER_ORDER_SOURCE && text(order.campaign_id) !== null;
}

/**
 * True only when NEITHER fundraiser signal is present and the source is known.
 *
 * An ordinary customer delivery order keeps its own per-order stop at its own
 * address. This deliberately does not exclude any particular source: manual,
 * storefront, square, qbo and meta orders are all ordinary customer work.
 */
export function isRegularCustomerDeliveryOrder(
    order: ClassifiableOrder | null | undefined,
): boolean {
    if (!order) return false;
    if (text(order.source) === null) return false;
    return order.source !== FUNDRAISER_ORDER_SOURCE && text(order.campaign_id) === null;
}

/**
 * The full three-way classification. 'ambiguous' means exactly one fundraiser
 * signal was present, or the source could not be read — never a guess.
 */
export function classifyDeliveryOrder(
    order: ClassifiableOrder | null | undefined,
): DeliveryOrderKind {
    if (isFundraiserFulfillmentOrder(order)) return 'fundraiser';
    if (isRegularCustomerDeliveryOrder(order)) return 'customer';
    return 'ambiguous';
}

/**
 * The fundraiser fulfillment grouping key: FundraiserCampaign.id, or null when
 * the order is not an unambiguous fundraiser order.
 *
 * Reads `campaign_id` off the order rather than `campaign.id`, so it works on
 * payloads that never joined the campaign.
 */
export function fundraiserGroupingKey(
    order: ClassifiableOrder | null | undefined,
): string | null {
    if (!isFundraiserFulfillmentOrder(order)) return null;
    return text(order!.campaign_id);
}

export type FundraiserDeliveryLocation =
    | { status: 'resolved'; location: string; campaignId: string }
    | { status: 'not_recorded'; campaignId: string }
    | { status: 'campaign_not_loaded' }
    | { status: 'not_a_fundraiser_order' };

/**
 * Where a fundraiser campaign's single delivery stop goes.
 *
 * FundraiserCampaign.pickup_location is the ONLY authority. Order.delivery_address
 * and Customer.delivery_address are never consulted, even when populated — a
 * coordinator-entered fundraiser order can carry a free-text note in that column
 * ("Delivery to Room 24"), and treating a note as the campaign's location would
 * scatter one campaign across several stops or navigate a driver to a note.
 *
 * The result is a discriminated union rather than a bare string because the
 * caller must be able to tell "this campaign has recorded no location" (the
 * common case — no campaign-creation path writes pickup_location, so a launched
 * campaign holds NULL by default) apart from "the campaign was not joined into
 * this query". Those need different handling, and collapsing both to null is how
 * a delivery board ends up silently showing a stop with no destination.
 */
export function fundraiserDeliveryLocation(
    order: ClassifiableOrder | null | undefined,
): FundraiserDeliveryLocation {
    if (!isFundraiserFulfillmentOrder(order)) return { status: 'not_a_fundraiser_order' };

    const campaign = order!.campaign;
    if (!campaign) return { status: 'campaign_not_loaded' };

    const campaignId = text(campaign.id) ?? text(order!.campaign_id)!;
    const location = text(campaign.pickup_location);
    if (location === null) return { status: 'not_recorded', campaignId };

    return { status: 'resolved', location, campaignId };
}

/**
 * Where an ordinary customer's delivery stop goes: Order.delivery_address, or
 * null when none was recorded.
 *
 * Returns null for a fundraiser order rather than handing back its address
 * column, so a caller cannot accidentally route a supporter to a note.
 */
export function customerDeliveryLocation(
    order: ClassifiableOrder | null | undefined,
): string | null {
    if (!isRegularCustomerDeliveryOrder(order)) return null;
    return text(order!.delivery_address);
}

/**
 * Groups orders for delivery: one entry per FundraiserCampaign.id for fundraiser
 * orders, one entry per order for everyone else.
 *
 * This is the shape the future campaign-delivery repair consumes. It returns
 * groups, NOT stops — it assigns no sequence, resolves no route and renders
 * nothing. Ambiguous rows are returned in their own bucket so a caller must
 * decide about them explicitly instead of silently losing them.
 */
export interface DeliveryGroup<T> {
    kind: DeliveryOrderKind;
    /** Campaign id for fundraiser groups; null otherwise. */
    campaignId: string | null;
    orders: T[];
}

export function groupOrdersForDelivery<T extends ClassifiableOrder>(
    orders: readonly T[],
): DeliveryGroup<T>[] {
    const groups: DeliveryGroup<T>[] = [];
    const byCampaign = new Map<string, DeliveryGroup<T>>();

    for (const order of orders) {
        const key = fundraiserGroupingKey(order);

        if (key !== null) {
            const existing = byCampaign.get(key);
            if (existing) {
                existing.orders.push(order);
            } else {
                const group: DeliveryGroup<T> = { kind: 'fundraiser', campaignId: key, orders: [order] };
                byCampaign.set(key, group);
                groups.push(group);
            }
            continue;
        }

        groups.push({ kind: classifyDeliveryOrder(order), campaignId: null, orders: [order] });
    }

    return groups;
}
