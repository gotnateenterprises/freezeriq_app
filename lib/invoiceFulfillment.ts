/**
 * INV-A — invoice fulfilment policy.
 *
 * THE PHANTOM ORDER PROBLEM
 * ─────────────────────────
 * Creating an invoice with bundle-backed lines auto-creates a `source: 'manual'`
 * Order so the invoice enters the kitchen pipeline. That is correct for an
 * ordinary manual invoice — it is the only record of that work.
 *
 * It is catastrophically wrong for a fundraiser campaign invoice. A campaign
 * invoice is a SUMMARY of orders that already exist: the coordinator's and the
 * storefront's real fundraiser orders. Auto-creating another Order from its
 * aggregated lines would duplicate the entire campaign into production intake —
 * the kitchen would be told to make the food twice.
 *
 * INV-A therefore establishes the rule before INV-B can trip over it: a
 * campaign-linked invoice NEVER produces a fulfilment Order. The campaign's own
 * orders are the fulfilment record, and closeout is what releases them.
 *
 * Lives in lib/ rather than the route so it is unit-testable — Next.js route
 * modules may only export HTTP verb handlers.
 */

export interface FulfillmentDecisionInput {
    /** The invoice's campaign linkage. Non-null => this is a fundraiser invoice. */
    campaignId: string | null | undefined;
    /** How many lines are bundle-backed (i.e. could become OrderItems). */
    fulfillableItemCount: number;
}

/**
 * Should this invoice auto-create/maintain a fulfilment Order?
 *
 * Ordinary invoice with bundle lines  -> true  (unchanged legacy behaviour)
 * Ordinary invoice, custom lines only -> false (unchanged legacy behaviour)
 * Campaign-linked invoice, any shape  -> false (INV-A rule)
 */
export function shouldCreateFulfillmentOrder(input: FulfillmentDecisionInput): boolean {
    if (input.campaignId) return false;
    return input.fulfillableItemCount > 0;
}

/**
 * Statuses an ordinary client may set through the generic invoice API.
 *
 * DRAFT and SENT are deliberately excluded. They are fundraiser-lifecycle
 * values: DRAFT is written only by INV-B's server-side generator, and the
 * DRAFT -> SENT transition is INV-C's deliberate human send action. The invoice
 * route passes `status` straight from the request body to Prisma with no
 * validation, so without this allowlist adding the enum values would instantly
 * make them spoofable by any authenticated tenant user.
 *
 * This is NOT the full invoice state machine — INV-C owns that. It is the
 * minimum gate that prevents INV-A's enum expansion from widening the API.
 */
export const CLIENT_SETTABLE_INVOICE_STATUSES = ['PENDING', 'PAID', 'OVERDUE', 'CANCELED'] as const;

export type ClientSettableInvoiceStatus = typeof CLIENT_SETTABLE_INVOICE_STATUSES[number];

export function isClientSettableInvoiceStatus(value: unknown): value is ClientSettableInvoiceStatus {
    return typeof value === 'string'
        && (CLIENT_SETTABLE_INVOICE_STATUSES as readonly string[]).includes(value);
}
