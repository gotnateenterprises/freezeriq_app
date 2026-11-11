/**
 * LEGACY-WRITER-GUARDS-1 — which orders a tenant may still hard-delete.
 *
 * DELETE /api/orders used to remove any order in the tenant, in any state, with its items and no
 * record. The fulfillment contract already says no stage removes orders or financial history
 * (FUNDRAISER_FULFILLMENT_CONTRACT.md, HARD RULE 6). The two buttons that call the route are the
 * Production page's Holding area and the Orders table, both meant for clearing a duplicate or test
 * order that never went anywhere — so that is the only order this allows: a pending, non-fundraiser
 * order with no payment, no invoice and no delivery hand-off.
 *
 * Everything else is refused, most specific reason first. An unrecognised status is refused too:
 * a value this code cannot read is not one it may prove safe to destroy.
 */
import { normalizeOrderStatus } from '@/lib/orderStatus';

export interface DeletableOrderFacts {
    status: string | null;
    source: string | null;
    campaign_id: string | null;
    paid_at: Date | string | null;
    invoice_id: string | null;
    payment_processor: string | null;
    processor_payment_id: string | null;
    released_to_delivery_at: Date | string | null;
}

export type OrderDeletionRefusalCode =
    | 'ORDER_IS_FUNDRAISER'
    | 'ORDER_HAS_PAYMENT'
    | 'ORDER_IS_INVOICED'
    | 'ORDER_RELEASED_TO_DELIVERY'
    | 'ORDER_NOT_PENDING';

export interface OrderDeletionRefusal {
    code: OrderDeletionRefusalCode;
    error: string;
}

/** The columns the rule reads, for a select that cannot drift from the rule. */
export const ORDER_DELETION_FACTS_SELECT = {
    status: true,
    source: true,
    campaign_id: true,
    paid_at: true,
    invoice_id: true,
    payment_processor: true,
    processor_payment_id: true,
    released_to_delivery_at: true,
} as const;

/** Null when the order may be hard-deleted; otherwise why not. */
export function orderDeletionRefusal(order: DeletableOrderFacts): OrderDeletionRefusal | null {
    if (order.campaign_id || order.source === 'fundraiser') {
        return {
            code: 'ORDER_IS_FUNDRAISER',
            error: "This is a fundraiser order. Fundraiser orders are kept as part of the campaign's history and can't be deleted.",
        };
    }
    if (order.paid_at || order.payment_processor || order.processor_payment_id) {
        return {
            code: 'ORDER_HAS_PAYMENT',
            error: "This order has a recorded payment, so it can't be deleted.",
        };
    }
    if (order.invoice_id) {
        return {
            code: 'ORDER_IS_INVOICED',
            error: "This order is on an invoice, so it can't be deleted.",
        };
    }
    if (order.released_to_delivery_at) {
        return {
            code: 'ORDER_RELEASED_TO_DELIVERY',
            error: "This order has been sent to delivery, so it can't be deleted.",
        };
    }
    if (normalizeOrderStatus(order.status) !== 'pending') {
        return {
            code: 'ORDER_NOT_PENDING',
            error: "This order has already moved past Pending, so it is part of production history and can't be deleted.",
        };
    }
    return null;
}
