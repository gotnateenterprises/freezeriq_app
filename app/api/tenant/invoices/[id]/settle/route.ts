/**
 * INV-D — record that an invoice was actually paid.
 *
 * WHY THIS EXISTS AS ITS OWN ENDPOINT
 *
 * PAID is the only invoice status that asserts money changed hands, so it is the
 * one status that must never be settable by sending a field. The generic invoice
 * PUT used to accept `status: 'PAID'` from the request body with no other
 * information, which is how Production ended up with five PAID invoices that
 * cannot say when or how they were paid. PAID has now been removed from that
 * route's allowlist and lives only here, where it cannot be written without a
 * method and a date.
 *
 * WHAT IS AND IS NOT TRUSTED FROM THE CLIENT
 *
 *   method     from the request, but validated against 'square' | 'check'.
 *   paidAt     from the request, but validated as a real, non-future calendar
 *              date. This is a human fact the server cannot derive — only the
 *              tenant knows when the check arrived.
 *   reference  from the request, normalised and length-capped. Optional.
 *   status     NEVER from the request. Always PAID, and only via a conditional
 *              transition out of an outstanding status.
 *   amounts    NEVER from the request, and never written here at all.
 *
 * WHAT THIS DOES NOT CLAIM
 *
 * Recording `square` does not verify anything with Square. No API call is made,
 * no settlement report is read, no processor fee is computed and no refund is
 * modelled. This endpoint records a statement by a human at the tenant, which is
 * the only thing FreezerIQ actually knows.
 *
 * FROZEN FINANCIALS ARE NOT TOUCHED. total_amount, tax_amount,
 * fundraiser_profit_percent, fundraiser_profit_amount and the invoice's items
 * are computed by INV-B closeout and are not in this route's write set, so
 * settling an invoice can never re-price it.
 *
 * QB-INVOICE-1D: the conditional PAID write and its winner-only effects (the
 * kitchen release, loyalty) now live in lib/invoiceSettlementTransition.ts,
 * moved there unchanged, because a VERIFIED QuickBooks payment must run the
 * same transition. This route is still the only way a HUMAN records a payment,
 * and it still accepts only Square or Check — never QuickBooks.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    validateSettlement,
    isSettleableInvoiceStatus,
    SETTLEABLE_INVOICE_STATUSES,
    hasDurableSettlement,
    isLegacyUnrecordedPayment,
    isVerifiedSettlement,
    resolveUnsettledStatus,
    VERIFIED_SETTLEMENT_UNDO_REFUSAL,
} from '@/lib/invoiceSettlement';
import { settleInvoiceInTransaction } from '@/lib/invoiceSettlementTransition';

/** Shape returned for an invoice that is settled, however it got that way. */
function settledPayload(invoice: {
    id: string;
    status: string;
    paid_at: Date | null;
    payment_method: string | null;
    payment_reference: string | null;
}) {
    return {
        success: true,
        invoice: {
            id: invoice.id,
            status: invoice.status,
            paid_at: invoice.paid_at,
            payment_method: invoice.payment_method,
            payment_reference: invoice.payment_reference,
        },
    };
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;

        if (!session?.user || !businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: invoiceId } = await params;

        // ── Tenant ownership. Scoped by the EFFECTIVE business (SEC-TENANT-1), so
        //    a super admin using View As acts as that tenant and can never settle
        //    an invoice outside it.
        const invoice = await prisma.invoice.findFirst({
            where: { id: invoiceId, business_id: businessId },
            select: {
                id: true,
                status: true,
                paid_at: true,
                payment_method: true,
                payment_reference: true,
                // Needed only for the paid-side effects below, never rewritten.
                campaign_id: true,
                customer_id: true,
                total_amount: true,
                customer: { select: { type: true } },
            },
        });

        if (!invoice) {
            // Same answer for "not yours" as for "does not exist", so invoice ids
            // in other tenants cannot be probed.
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
        }

        // ── Idempotency, part one: already settled.
        //    A double-click, a retried request or a stale tab must not overwrite
        //    the settlement facts that are already recorded. The FIRST recorded
        //    payment is the one that happened; a second click carries the same
        //    form values at best and different ones at worst. Return what is
        //    stored rather than what was just submitted.
        if (invoice.status === 'PAID') {
            return NextResponse.json({
                ...settledPayload(invoice as any),
                alreadySettled: true,
                message: 'This invoice was already recorded as paid.',
            });
        }

        if (!isSettleableInvoiceStatus(invoice.status)) {
            // DRAFT: never issued, so "they paid it" cannot be true yet.
            // CANCELED: withdrawn, never collectable.
            const reason = invoice.status === 'DRAFT'
                ? 'This invoice is still a draft. Send it before recording a payment.'
                : 'A canceled invoice cannot be marked paid.';
            return NextResponse.json({ error: reason }, { status: 409 });
        }

        let body: any = {};
        try {
            body = await req.json();
        } catch {
            // No body — the validator below produces the field-specific message.
        }

        const validation = validateSettlement(
            { method: body?.method, paidAt: body?.paidAt, reference: body?.reference },
            new Date(),
        );

        if (!validation.ok) {
            return NextResponse.json({ error: validation.error }, { status: 400 });
        }

        const { method, paidAt, reference } = validation.value;

        // ── Idempotency, part two: the write is a CONDITIONAL transition, and the
        //    paid-side effects (the kitchen release and loyalty) run only for the
        //    request that won it. Both live in lib/invoiceSettlementTransition.ts —
        //    moved there UNCHANGED by QB-INVOICE-1D so that a verified QuickBooks
        //    payment runs exactly this transition rather than a copy of it. A human's
        //    Record Payment may settle any outstanding status, as it always could.
        const claimed = await prisma.$transaction((tx) => settleInvoiceInTransaction(tx, {
            invoice,
            businessId,
            facts: { method, paidAt, reference },
            fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));

        if (claimed.count !== 1) {
            // Lost the race, or the invoice moved underneath us. Report the truth
            // that is now stored rather than the truth we were about to write.
            const current = await prisma.invoice.findFirst({
                where: { id: invoice.id, business_id: businessId },
                select: {
                    id: true,
                    status: true,
                    paid_at: true,
                    payment_method: true,
                    payment_reference: true,
                },
            });

            if (current?.status === 'PAID') {
                return NextResponse.json({
                    ...settledPayload(current as any),
                    alreadySettled: true,
                    message: 'This invoice was already recorded as paid.',
                });
            }

            return NextResponse.json(
                { error: 'This invoice changed while you were recording the payment. Reload and try again.' },
                { status: 409 },
            );
        }

        return NextResponse.json({
            ...settledPayload({
                id: invoice.id,
                status: 'PAID',
                paid_at: paidAt,
                payment_method: method,
                payment_reference: reference,
            }),
            alreadySettled: false,
        });
    } catch (e: any) {
        console.error('Invoice Settle Error:', e);
        return NextResponse.json(
            { error: 'Something went wrong recording this payment.' },
            { status: 500 },
        );
    }
}

/**
 * UNDO PAYMENT — correct a mistaken settlement.
 *
 * DELETE on this route deletes the SETTLEMENT, not the invoice. It exists on the
 * settle route on purpose: recording payment and correcting that record are the
 * same authority, and splitting them across files is how the two drift into
 * disagreeing about what "settled" means.
 *
 * WHAT THIS IS NOT
 *
 * Not a refund. Not a chargeback. Not a partial payment. Not a reversal ledger.
 * No money moves and nothing is recorded as having moved. This is the
 * administrative correction of a human clicking Record Payment on the wrong row.
 *
 * WHAT IT REFUSES
 *
 * The five historical PAID invoices carry no paid_at, because they were settled
 * before FreezerIQ recorded settlement at all. They are NOT correctable here.
 * There is nothing recorded to clear, so "undo" would not fix a mistake — it
 * would erase a real payment and re-assert a debt the organization does not owe.
 * They are left exactly as they are.
 */
export async function DELETE(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;

        if (!session?.user || !businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id: invoiceId } = await params;

        // Tenant ownership, scoped by the EFFECTIVE business (SEC-TENANT-1).
        const invoice = await prisma.invoice.findFirst({
            where: { id: invoiceId, business_id: businessId },
            select: {
                id: true,
                status: true,
                paid_at: true,
                payment_method: true,
                payment_reference: true,
                // Needed only to derive the restored status. Never rewritten.
                campaign_id: true,
                due_date: true,
            },
        });

        if (!invoice) {
            // Identical answer to "not yours", so ids cannot be probed.
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
        }

        // ── Idempotency, part one: already corrected.
        //    A double-click or a retried request finds an invoice that is no
        //    longer PAID. That is the requested end state, so report it as
        //    success with the CURRENT truth rather than inventing a conflict.
        if (invoice.status !== 'PAID') {
            return NextResponse.json({
                success: true,
                alreadyCorrected: true,
                invoice: {
                    id: invoice.id,
                    status: invoice.status,
                    paid_at: invoice.paid_at,
                    payment_method: invoice.payment_method,
                    payment_reference: invoice.payment_reference,
                },
                message: 'This invoice is already marked unpaid.',
            });
        }

        // ── QB-INVOICE-1D: a payment FreezerIQ VERIFIED with the provider is not a
        //    human's statement, so it is not this action's to undo. Checked first
        //    so the owner gets the specific reason. The kitchen release that came
        //    with it is never reversed here either (see below).
        if (isVerifiedSettlement(invoice)) {
            return NextResponse.json(
                { error: VERIFIED_SETTLEMENT_UNDO_REFUSAL, reason: 'verified_settlement' },
                { status: 409 },
            );
        }

        // ── The legacy gate. Checked BEFORE the durable-settlement test so the
        //    owner gets the specific reason rather than a generic refusal.
        if (isLegacyUnrecordedPayment(invoice)) {
            return NextResponse.json(
                {
                    error: 'This payment was recorded before FreezerIQ tracked payment details, '
                        + 'so there is nothing to undo. Its payment date and method are not known, '
                        + 'and marking it unpaid would remove a real payment from the record.',
                    reason: 'legacy_unrecorded_payment',
                },
                { status: 409 },
            );
        }

        // ── Defensive: PAID with a date but a method outside the settlement
        //    contract. Nothing can produce this today (the settle endpoint
        //    validates, and the generic PUT preserves settlement fields on a PAID
        //    invoice), which is exactly why it is refused rather than guessed at.
        if (!hasDurableSettlement(invoice)) {
            return NextResponse.json(
                {
                    error: 'This invoice\'s payment record is incomplete and cannot be undone automatically.',
                    reason: 'incomplete_settlement_record',
                },
                { status: 409 },
            );
        }

        const restoredStatus = resolveUnsettledStatus(invoice, new Date());

        const corrected = await prisma.$transaction(async (tx) => {
            // ── Conditional transition. Guarded on PAID *and* a non-null paid_at
            //    so it can never touch a legacy row, and so two admins correcting
            //    at once produce one coherent result instead of two.
            const result = await tx.invoice.updateMany({
                where: {
                    id: invoice.id,
                    business_id: businessId,
                    status: 'PAID' as any,
                    paid_at: { not: null },
                },
                data: {
                    status: restoredStatus as any,
                    paid_at: null,
                    payment_method: null,
                    payment_reference: null,
                },
            });

            if (result.count !== 1) return result;

            // ── Loyalty points are deliberately NOT reversed here.
            //
            //    LOY-P0 has accrual globally paused (LOYALTY_ACCRUAL_ENABLED is
            //    false), so a settlement awards nothing and a correction has
            //    nothing to take back — a reversal today would be dead code.
            //
            //    It would also be the first points-DECREMENT path in the codebase.
            //    The public redeem route was removed on purpose and a standing
            //    test asserts every surviving points mutation increments, never
            //    decrements. Introducing a spend path as a side effect of an
            //    invoice correction is not INV-D's call to make.
            //
            //    COUPLING, stated so it is not discovered later: whoever un-pauses
            //    LOY-P0 must decide what a corrected payment does to points
            //    already awarded. Accrual is keyed on `Invoice <id>` in this file,
            //    which is where that decision belongs.

            // ── Linked fulfilment orders are deliberately NOT reverted.
            //    Settlement promotes an ordinary invoice's order — and, since
            //    OPS-3, a campaign invoice's fundraiser orders — to
            //    production_ready. Production is a PHYSICAL fact: correcting a
            //    bookkeeping mistake does not un-cook food, and the order's prior
            //    status is not recorded, so "restoring" it would be a guess that
            //    could pull real work out of the kitchen queue.
            //
            //    OPS-3 reviewed this and deliberately left it exactly as it is.
            //    Un-releasing a fundraiser batch here would silently delete a
            //    kitchen requirement for food that may already be in progress.
            //    Handling a genuine post-release payment reversal is registered
            //    as future debt, not solved by a side effect of an undo button.

            return result;
        });

        if (corrected.count !== 1) {
            // Lost a race with another corrector. Report what is stored now.
            const current = await prisma.invoice.findFirst({
                where: { id: invoice.id, business_id: businessId },
                select: {
                    id: true, status: true, paid_at: true,
                    payment_method: true, payment_reference: true,
                },
            });
            return NextResponse.json({
                success: true,
                alreadyCorrected: true,
                invoice: current,
                message: 'This invoice is already marked unpaid.',
            });
        }

        return NextResponse.json({
            success: true,
            alreadyCorrected: false,
            invoice: {
                id: invoice.id,
                status: restoredStatus,
                paid_at: null,
                payment_method: null,
                payment_reference: null,
            },
        });
    } catch (e: any) {
        console.error('Invoice Undo Payment Error:', e);
        return NextResponse.json(
            { error: 'Something went wrong undoing this payment.' },
            { status: 500 },
        );
    }
}
