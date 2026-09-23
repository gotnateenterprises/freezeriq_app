/**
 * INV-D / OPS-3 / QB-INVOICE-1D — THE one conditional PAID transition, and the only place fundraiser food is
 * released to the kitchen.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * Until QB-INVOICE-1D this code lived inline in `app/api/tenant/invoices/[id]/settle/route.ts`, which
 * docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §5.1 names as the sole release writer. 1D adds a second way an
 * invoice can become PAID — a QuickBooks payment an admin has had FreezerIQ VERIFY — and the owner's rule is
 * that both must run the SAME transition, not two copies of it. A Next.js route file cannot export a helper,
 * so the transition moved here, UNCHANGED: same conditional write, same winner-only branch, same release
 * predicate, same loyalty rule. The settle route and lib/quickbooks/invoicePayment.ts both call it inside
 * their own transaction; nothing else writes PAID and nothing else releases fundraiser food.
 *
 * EXACT-ONCE, twice over, with no new schema and no time window (unchanged from OPS-3):
 *   1. the effects run only when THIS call won the conditional `updateMany` (count === 1), so a second
 *      Record Payment, a double-clicked QuickBooks check, or a concurrent pair of either reaches the effects
 *      at most once between them;
 *   2. `status: 'fundraiser_hold'` is itself the durable claim — once those rows are production_ready they can
 *      never match again, so a replay promotes nothing.
 *
 * WHAT A CALLER DECIDES, AND WHAT IT CANNOT
 *
 *   method / paidAt / reference   the caller's settlement facts, already validated for their source:
 *                                 lib/invoiceSettlement.ts validateSettlement() for a human's Record Payment,
 *                                 lib/quickbooks/invoicePayment.ts for a verified QuickBooks payment.
 *   fromStatuses                  which outstanding statuses may be settled. Always a SUBSET of
 *                                 SETTLEABLE_INVOICE_STATUSES — anything else is refused before any write, so no
 *                                 caller can settle a DRAFT, re-settle a PAID or revive a CANCELED invoice.
 *   amounts                       NOTHING. INV-B's frozen financials are not in the write set, so settling can
 *                                 never re-price an invoice.
 */

import type { Prisma } from '@prisma/client';
import { LOYALTY_ACCRUAL_ENABLED } from '@/lib/loyalty';
import {
    SETTLEABLE_INVOICE_STATUSES,
    type SettlementPaymentMethod,
    type VerifiedSettlementMethod,
} from '@/lib/invoiceSettlement';

/** What the transition needs to know about the invoice. Read by the caller, inside or before its transaction. */
export interface SettleableInvoice {
    id: string;
    campaign_id: string | null;
    customer_id: string;
    total_amount: unknown;
    customer?: { type?: string | null } | null;
}

export interface SettlementFacts {
    method: SettlementPaymentMethod | VerifiedSettlementMethod;
    /** A calendar day anchored at 12:00 UTC (lib/invoiceSettlement.ts calendarDateToUtcNoon). */
    paidAt: Date;
    reference: string | null;
}

export class SettlementStatusError extends Error {
    constructor() {
        super('fromStatuses must be a non-empty subset of the settleable statuses');
        Object.setPrototypeOf(this, SettlementStatusError.prototype); // ES5 target
        this.name = 'SettlementStatusError';
    }
}

/**
 * Settles one invoice inside the caller's transaction. Returns the conditional write's result: `count === 1`
 * means THIS call won and its effects ran; `count === 0` means another request settled it first, or it is no
 * longer in any of `fromStatuses` — the caller re-reads and reports what is stored.
 */
export async function settleInvoiceInTransaction(
    tx: Prisma.TransactionClient,
    input: {
        invoice: SettleableInvoice;
        businessId: string;
        facts: SettlementFacts;
        fromStatuses: readonly string[];
    },
): Promise<{ count: number }> {
    const { invoice, businessId, facts, fromStatuses } = input;
    if (fromStatuses.length === 0 || fromStatuses.some((s) => !(SETTLEABLE_INVOICE_STATUSES as readonly string[]).includes(s))) {
        throw new SettlementStatusError();
    }

    // ── The write is a CONDITIONAL transition. Guarding on the outstanding statuses means two concurrent
    //    settlements cannot both succeed — the loser's `count` is 0 and it falls through to the caller's
    //    re-read instead of stamping its own date over the winner's. It also makes it structurally impossible
    //    to move an invoice out of PAID, DRAFT or CANCELED.
    //
    //    QB-INVOICE-CANCEL-1 adds EXCLUSION, not just a condition, and only for invoices QuickBooks holds.
    //
    //    An invoice may not become PAID once FreezerIQ has DECIDED to void its QuickBooks copy, nor once that
    //    copy IS void, nor while a cancellation holds the lifecycle lease across its QuickBooks round trip.
    //    Three facts, and each is refused here:
    //
    //      void_requested_at   the durable intent, committed BEFORE the irreversible QuickBooks write. It does
    //                          not expire and it survives the process, so a cancellation interrupted between
    //                          Intuit accepting the void and FreezerIQ recording it leaves this invoice
    //                          unsettleable until a person (or a retry) reconciles it. This is the one that
    //                          makes "QuickBooks voided + FreezerIQ PAID" unreachable rather than merely rare.
    //      voided_at           QuickBooks' copy is void. Irreversible; nothing may ever settle it.
    //      lease_until         a live cancellation. Concurrency only — and deliberately NOT load-bearing on its
    //                          own, because a lease expires.
    //
    //    A condition alone would not be enough for the concurrency part: a settlement that began before the
    //    lease was claimed would not see it, and could commit PAID while the cancellation was already voiding
    //    QuickBooks. So this transaction LOCKS the lifecycle row first. The cancellation's lease claim — and its
    //    intent write — are UPDATEs of that same row, so neither can commit while this transaction is open:
    //      · claimed BEFORE this lock  → we see it here and refuse;
    //      · claimed AFTER we commit   → it blocked until then, and the cancellation's own post-lease re-read of
    //        this invoice sees PAID, so it stands down and QuickBooks is never voided.
    //    An invoice with no QuickBooks lifecycle (every ordinary invoice) locks nothing and is unaffected.
    const held = await tx.$queryRaw<Array<{ lease_until: Date | null; voided_at: Date | null; void_requested_at: Date | null }>>`
        SELECT "lease_until", "voided_at", "void_requested_at" FROM "quickbooks_invoice_sends" WHERE "invoice_id" = ${invoice.id} FOR UPDATE`;
    const now = new Date();
    const lifecycle = held[0];
    if (lifecycle && (lifecycle.voided_at !== null || lifecycle.void_requested_at !== null
        || (lifecycle.lease_until !== null && lifecycle.lease_until.getTime() > now.getTime()))) {
        return { count: 0 };
    }
    const result = await tx.invoice.updateMany({
        where: {
            id: invoice.id,
            business_id: businessId,
            status: { in: fromStatuses as unknown as any[] },
            OR: [
                { quickbooks_invoice_send: null },
                { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: null } },
                { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: { lt: now } } },
            ],
        },
        data: {
            status: 'PAID' as any,
            paid_at: facts.paidAt,
            payment_method: facts.method,
            payment_reference: facts.reference,
        },
    });

    // Only the request that actually won the transition runs the effects.
    if (result.count !== 1) return result;

    // ── Paid-side effects, RELOCATED not removed.
    //
    //    Both of these used to hang off `status === 'PAID'` in the generic invoice route. Taking PAID away from
    //    that route would have quietly deleted them, so they moved to the one place an invoice becomes paid —
    //    first the settle route (INV-D), now this module (QB-INVOICE-1D) — and their conditions are unchanged.

    // 1. A paid invoice releases its work to the kitchen.
    //
    //    ORDINARY invoice: promote the order linked by invoice_id. A campaign invoice has no such linked order,
    //    which is why this branch is scoped and why the campaign case needs its own.
    if (!invoice.campaign_id) {
        await tx.order.updateMany({
            where: { invoice_id: invoice.id, business_id: businessId },
            data: { status: 'production_ready' },
        });
    } else {
        // ── OPS-3: the fundraiser production release. ────────────────────────────────────────────────────
        //
        //    CAMPAIGN invoice: its fulfilment is the campaign's own orders, reached by campaign_id (they are
        //    never linked by invoice_id). Same predicate and target status as when OPS-3 moved it here from
        //    closeout.
        //
        //    business_id is asserted on the Order rows themselves, not inferred from the campaign, so a
        //    campaign id can never reach across tenants.
        await tx.order.updateMany({
            where: {
                campaign_id: invoice.campaign_id,
                business_id: businessId,
                source: 'fundraiser' as any,
                status: 'fundraiser_hold' as any,
                canceled_at: null,
            },
            data: { status: 'production_ready' as any },
        });
    }

    // 2. Loyalty accrual for direct customers/orgs. Still globally paused by LOY-P0, and still keyed on the same
    //    `Invoice <id>` reason string the old call sites used, so the two can never double-award if the
    //    unreachable branches there are ever revived.
    if (LOYALTY_ACCRUAL_ENABLED && invoice.customer?.type !== 'fundraiser_org') {
        const points = Math.floor(Number(invoice.total_amount));
        const existingPoints = await tx.loyaltyPoint.findFirst({
            where: { reason: `Invoice ${invoice.id}` },
        });
        if (!existingPoints && points > 0) {
            await tx.loyaltyPoint.create({
                data: {
                    customer_id: invoice.customer_id,
                    points,
                    reason: `Invoice ${invoice.id}`,
                },
            });
            await tx.customer.update({
                where: { id: invoice.customer_id },
                data: { loyalty_balance: { increment: points } },
            });
        }
    }

    return result;
}
