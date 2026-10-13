/**
 * PROD-PACKED-READY-NAME-1 — who is this order FOR?
 *
 * The name Production shows on an order row. One rule, in one place, so the lane
 * can never again disagree with the box label about whose box it is.
 *
 * THE DEFECT THIS FIXES
 *
 * Packed & Ready titled every row `order.customer?.name || order.customer_name`.
 * `Order.customer` is the order's linked CRM Customer, and the two fundraiser
 * order paths do not link the same thing (lib/coordinatorSupporterOrders.ts):
 *
 *   public supporter order    -> a per-supporter Customer, so customer.name IS the
 *                                supporter. Order.first_name / last_name are set.
 *   coordinator "+ Add Order" -> customer_id = campaign.customer_id, the
 *                                ORGANIZATION. customer.name is "Edgar County Farm
 *                                Bureau". The supporter's name lives only in
 *                                Order.customer_name; first/last are not written.
 *
 * So every manually entered fundraiser order showed the organization where the
 * person belongs, while the box label — which reads order-time identity and never
 * the Customer relation — printed the person correctly.
 *
 * THE RULE
 *
 *   fundraiser order  ->  the label's own resolver, resolveSupporterName
 *                         (first+last, else customer_name). The Customer relation
 *                         is NOT consulted: for a fundraiser order it may be the
 *                         organization. No provable name -> "Unknown Supporter",
 *                         never the organization standing in for a person.
 *   any other order   ->  exactly what Production has always shown:
 *                         customer.name, else customer_name, else "Unknown Customer".
 *
 * WHY IT CALLS THE LABEL'S RESOLVER INSTEAD OF COPYING IT
 *
 * `resolveSupporterName` (lib/supporterBoxManifest.ts) is the authority the owner
 * has verified on printed labels. Calling it — rather than re-deriving first/last
 * precedence and placeholder rules here — makes "the lane and the label name the
 * same person" true by construction, not by two implementations happening to
 * agree. It reads only first_name / last_name / customer_name, so it carries no
 * box or print assumption into this display.
 *
 * WHICH ORDERS COUNT AS FUNDRAISER ORDERS is lib/delivery/orderClassification.ts's
 * `isFundraiserFulfillmentOrder` (source === 'fundraiser' AND a campaign_id), the
 * one canonical conjunction. A row carrying only one of the two signals is NOT
 * treated as fundraiser here, so an ambiguous or ordinary order keeps its
 * existing behaviour exactly.
 *
 * DISPLAY ONLY. Pure: no Prisma, no React, no I/O. Nothing here changes an order,
 * a status, a box count or a label.
 */
import { isFundraiserFulfillmentOrder } from './delivery/orderClassification';
import { resolveSupporterName } from './supporterBoxManifest';

/** Shown for a fundraiser order that has no provable supporter name. */
export const UNKNOWN_SUPPORTER_LABEL = 'Unknown Supporter';
/** Shown for an ordinary order with no name at all — Production's long-standing text. */
export const UNKNOWN_CUSTOMER_LABEL = 'Unknown Customer';

/** The fields of an order row this rule reads. All optional: a missing field is "not known". */
export interface RecipientNameOrder {
    id?: string | null;
    source?: string | null;
    campaign_id?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    customer_name?: string | null;
    customer?: { name?: string | null } | null;
}

export function resolveOrderRecipientName(order: RecipientNameOrder | null | undefined): string {
    if (order && isFundraiserFulfillmentOrder(order)) {
        return resolveSupporterName({
            id: order.id ?? '',
            first_name: order.first_name ?? null,
            last_name: order.last_name ?? null,
            customer_name: order.customer_name ?? null,
            items: [],
        }) ?? UNKNOWN_SUPPORTER_LABEL;
    }
    return order?.customer?.name || order?.customer_name || UNKNOWN_CUSTOMER_LABEL;
}
