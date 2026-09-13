/**
 * FR-SUPPORTER-PAYMENT-STATUS-1 — a coordinator's record that a supporter paid.
 *
 * ── WHICH PAYMENT THIS IS ───────────────────────────────────────────────────
 *
 *   THIS:     supporter  -> fundraiser coordinator   (cash, check, Venmo, ...)
 *   NOT THIS: organization -> My Freezer Chef        (Invoice.status / paid_at)
 *
 * The two are independent and must stay that way. Marking a supporter paid
 * never touches an invoice, and settling an organization's invoice never marks
 * a supporter paid. Nothing in closeout, sales totals, organization share or
 * tax reads Order.paid_at — the closeout route says so in its own comment:
 * "Payment status is deliberately NOT a filter".
 *
 * ── WHAT FreezerIQ ACTUALLY KNOWS ───────────────────────────────────────────
 *
 * Nothing, on its own. No processor ever confirms a fundraiser supporter
 * payment; a Venmo/PayPal/Cash App link is information only; and no order that
 * predates this column carries evidence either way. So:
 *
 *   paid_at set   -> "the coordinator marked this paid"      -> "Paid"
 *   paid_at NULL  -> "the coordinator has not marked it"     -> "Payment not marked"
 *
 * NULL is deliberately never rendered as "Unpaid". For every order that
 * existed before this phase that would be an unsupported claim about money,
 * shown to the person who has to collect it.
 *
 * ── WHY THIS MODULE IS PURE ─────────────────────────────────────────────────
 *
 * The exact WHERE guard and the exact data written are defined here, once, and
 * the route spreads them. That makes the rule testable without Prisma or a
 * session, and it makes "the write touches only paid_at and paid_by" a property
 * a test can assert on the real object rather than a promise in a comment.
 */

// ── Actions ──────────────────────────────────────────────────────────────────

export const SUPPORTER_PAYMENT_ACTIONS = ['mark_paid', 'mark_unpaid'] as const;
export type SupporterPaymentAction = (typeof SUPPORTER_PAYMENT_ACTIONS)[number];

export function isSupporterPaymentAction(value: unknown): value is SupporterPaymentAction {
    return typeof value === 'string'
        && (SUPPORTER_PAYMENT_ACTIONS as readonly string[]).includes(value);
}

/** CoordinatorActionEvent.action_type for each transition. */
export const SUPPORTER_PAYMENT_EVENT_TYPES: Readonly<Record<SupporterPaymentAction, string>> = {
    mark_paid: 'order_marked_paid',
    mark_unpaid: 'order_marked_unpaid',
};

// ── Actor ────────────────────────────────────────────────────────────────────

/**
 * Order.paid_by for a mark made from the coordinator portal.
 *
 * `coordinator` is the house actor-class value (Order.canceled_by uses exactly
 * that), so anything reading the class still matches with a prefix check.
 * The session id is appended because a coordinator session identifies no
 * person — CoordinatorSession carries only campaign_id — and "which session
 * did this" is the most precise truthful answer available.
 *
 * The session id is the row's primary key, NOT the cookie secret: the secret is
 * stored only as session_hash. It is also never sent to a client — paid_by is
 * deliberately absent from SUPPORTER_ORDER_SELECT.
 */
export function coordinatorPaymentActor(sessionId: string | null | undefined): string {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    return id ? `coordinator:${id}` : 'coordinator';
}

// ── The write ────────────────────────────────────────────────────────────────

export interface PaymentTransitionScope {
    orderId: string;
    /** Resolved from the coordinator session. Never taken from the request. */
    campaignId: string;
}

/**
 * The conditional-update WHERE for a transition.
 *
 * Every predicate is load-bearing:
 *
 *   id + campaign_id       ownership. An order id belonging to another campaign
 *                          matches zero rows, so it cannot be marked — and the
 *                          response cannot tell the caller whether it exists.
 *   source: 'fundraiser'   campaign orders only. Both the public supporter
 *                          route and the coordinator "+ Add Order" route write
 *                          this value, so it covers every supporter order.
 *   canceled_at: null      a canceled order is not something to collect on.
 *   paid_at state          the transition itself. Only an unmarked order can be
 *                          marked, and only a marked one unmarked — so a double
 *                          tap never overwrites the original paid_at timestamp.
 *
 * Note what is NOT here: the campaign's closed state. Payment is collected at
 * pickup, which routinely happens AFTER closeout (Cumberland: orders close
 * October 7, delivery October 27). Blocking this on a closed campaign would
 * disable the feature on the one day it matters most. It is safe to allow
 * because closeout reads none of these fields.
 */
export function paymentTransitionWhere(
    action: SupporterPaymentAction,
    scope: PaymentTransitionScope,
) {
    const base = {
        id: scope.orderId,
        campaign_id: scope.campaignId,
        source: 'fundraiser' as const,
        canceled_at: null,
    };
    return action === 'mark_paid'
        ? { ...base, paid_at: null }
        : { ...base, NOT: { paid_at: null } };
}

/**
 * The data a transition writes — ONLY paid_at and paid_by.
 *
 * Nothing else on the order can change through this path: not amounts, not
 * tax, not items, not status, not the invoice link. Tests assert the exact key
 * set of this object, so a field cannot quietly be added to it.
 */
export function paymentTransitionData(
    action: SupporterPaymentAction,
    input: { now: Date; actor: string },
): { paid_at: Date | null; paid_by: string | null } {
    return action === 'mark_paid'
        ? { paid_at: input.now, paid_by: input.actor }
        : { paid_at: null, paid_by: null };
}

/** The ownership-scoped lookup used to explain a zero-row transition. */
export function paymentOwnershipWhere(scope: PaymentTransitionScope) {
    return {
        id: scope.orderId,
        campaign_id: scope.campaignId,
        source: 'fundraiser' as const,
        canceled_at: null,
    };
}

export type NoopPaymentOutcome = 'already_in_state' | 'not_found' | 'conflict';

/**
 * A transition matched zero rows. Why?
 *
 *   not_found         not this coordinator's active order. `row` must come
 *                     from paymentOwnershipWhere, so an order in ANOTHER
 *                     campaign arrives here as null and is indistinguishable
 *                     from one that does not exist.
 *   already_in_state  a harmless double tap, or a second device got there
 *                     first. The coordinator's intent is already true.
 *   conflict          owned and active, but NOT in the requested state — so the
 *                     conditional update missed because a concurrent change
 *                     landed between the two statements. Reporting success
 *                     here would be a false statement about money; the caller
 *                     must tell the coordinator to refresh.
 */
export function explainNoopPaymentTransition(
    action: SupporterPaymentAction,
    row: { paid_at?: Date | string | null } | null | undefined,
): NoopPaymentOutcome {
    if (!row) return 'not_found';
    const isPaid = Boolean(row.paid_at);
    const inTargetState = action === 'mark_paid' ? isPaid : !isPaid;
    return inTargetState ? 'already_in_state' : 'conflict';
}

// ── Display ──────────────────────────────────────────────────────────────────

export type SupporterPaymentState = 'paid' | 'not_marked';

export const PAYMENT_PAID_LABEL = 'Paid';
/** Never "Unpaid" — see the module header. */
export const PAYMENT_NOT_MARKED_LABEL = 'Payment not marked';

export function supporterPaymentState(
    order: { paid_at?: Date | string | null } | null | undefined,
): SupporterPaymentState {
    return order?.paid_at ? 'paid' : 'not_marked';
}

export type GroupPaymentState = 'paid' | 'not_marked' | 'partly_marked';

export interface GroupPaymentSummary {
    state: GroupPaymentState;
    paidCount: number;
    orderCount: number;
}

/**
 * One supporter can hold several orders on a pickup manifest. The row needs a
 * single honest answer: all marked, none marked, or "1 of 2" — never a "Paid"
 * that is only true of some of the food on the table.
 */
export function summarizeGroupPayment(
    orders: ReadonlyArray<{ paid_at?: Date | string | null }> | null | undefined,
): GroupPaymentSummary {
    const list = orders ?? [];
    const orderCount = list.length;
    const paidCount = list.filter((o) => Boolean(o?.paid_at)).length;
    const state: GroupPaymentState =
        orderCount > 0 && paidCount === orderCount ? 'paid'
            : paidCount === 0 ? 'not_marked'
                : 'partly_marked';
    return { state, paidCount, orderCount };
}

/**
 * "Sep 12".
 *
 * paid_at is a real INSTANT — the moment a coordinator tapped the button — so
 * it is formatted in local time, like created_at. It must NOT go through
 * lib/calendarDate.ts: that module is for DATE-only values (deadlines, delivery
 * days) and reads UTC fields, which would move a late-evening U.S. mark onto
 * the next calendar day. `timeZone` exists only so tests can be deterministic;
 * the UI omits it and gets the viewer's own zone.
 */
export function formatPaidDate(
    paidAt: Date | string | null | undefined,
    options: { timeZone?: string } = {},
): string | null {
    if (!paidAt) return null;
    const d = paidAt instanceof Date ? paidAt : new Date(paidAt);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    });
}
