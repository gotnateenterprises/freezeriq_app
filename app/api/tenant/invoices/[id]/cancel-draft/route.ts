/**
 * DATA-CLEANUP-GUARDS-1 — POST /api/tenant/invoices/[id]/cancel-draft
 *
 * Withdraws a $0.00 DRAFT that was never sent, by marking it CANCELED. The row is
 * kept: canceling is the alternative to deleting, not a disguised delete. The rule
 * for which drafts qualify, and why it stops at $0.00, is in lib/invoiceRemoval.ts.
 *
 * ACCESS: session-authenticated, tenant-scoped (SEC-TENANT-1's effective business),
 * ADMIN or super-admin. Another tenant's invoice answers 404, like a missing one.
 * Body `{ confirm: true }` is required, so no stray request can cancel anything.
 *
 * IDEMPOTENT: a repeat finds the invoice CANCELED and answers alreadyCanceled
 * without writing.
 *
 * CONCURRENCY: the fundraiser's selection lock is taken FIRST — the same lock, in
 * the same order, as closeout and the public supporter checkout — so an order
 * cannot land on the fundraiser between the count and the write. The invoice row is
 * then locked and re-read, and the write itself is conditional on DRAFT. QuickBooks
 * cannot race this: a $0.00 draft has no lines, and "Send via QuickBooks" refuses an
 * invoice without lines before it reserves anything (planQuickBooksInvoice).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { lockCampaignSelection } from '@/lib/campaignSelectionLock';
import { evaluateDraftCancel, lockInvoiceForRemoval, mayRemoveInvoices } from '@/lib/invoiceRemoval';

type Outcome =
    | { kind: 'not_found' }
    | { kind: 'refused'; status: number; code: string; error: string }
    | { kind: 'already_canceled' }
    | { kind: 'changed' }
    | { kind: 'canceled'; campaignId: string | null };

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
        if (!mayRemoveInvoices({
            role: (session.user as any).role,
            isSuperAdmin: (session.user as any).isSuperAdmin === true,
        })) {
            return NextResponse.json({ error: 'Only an administrator can cancel an invoice.' }, { status: 403 });
        }

        const { id: invoiceId } = await params;

        let body: any = null;
        try { body = await req.json(); } catch { /* no body: refused just below */ }
        if (body?.confirm !== true) {
            return NextResponse.json({ error: 'Confirm the cancellation to continue.' }, { status: 400 });
        }

        // Which fundraiser, if any — read first so its lock can be the transaction's first statement.
        const located = await prisma.invoice.findFirst({
            where: { id: invoiceId, business_id: businessId },
            select: { id: true, campaign_id: true },
        });
        if (!located) {
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
        }

        const outcome: Outcome = await prisma.$transaction(async (tx) => {
            if (located.campaign_id) await lockCampaignSelection(tx, located.campaign_id);
            if (!await lockInvoiceForRemoval(tx as any, { invoiceId, businessId })) return { kind: 'not_found' };

            const invoice = await tx.invoice.findFirst({
                where: { id: invoiceId, business_id: businessId },
                select: {
                    id: true,
                    status: true,
                    campaign_id: true,
                    total_amount: true,
                    tax_amount: true,
                    paid_at: true,
                    payment_reference: true,
                    quickbooks_invoice_links: { select: { id: true } },
                    quickbooks_invoice_send: { select: { id: true } },
                },
            });
            if (!invoice) return { kind: 'not_found' };
            // The lock was taken for the fundraiser the invoice belonged to a moment ago;
            // campaign linkage is never rewritten, so a mismatch means something unexpected.
            if ((invoice.campaign_id ?? null) !== (located.campaign_id ?? null)) return { kind: 'changed' };

            const activeCampaignOrderCount = invoice.campaign_id
                ? await tx.order.count({ where: { campaign_id: invoice.campaign_id, canceled_at: null } })
                : null;

            const decision = evaluateDraftCancel({
                status: String(invoice.status),
                total_amount: invoice.total_amount as any,
                tax_amount: invoice.tax_amount as any,
                paid_at: invoice.paid_at,
                payment_reference: invoice.payment_reference,
                hasQuickBooksLink: (invoice.quickbooks_invoice_links ?? []).length > 0,
                hasQuickBooksSend: Boolean(invoice.quickbooks_invoice_send),
                activeCampaignOrderCount,
            });
            if (!decision.ok) return { kind: 'refused', status: decision.status, code: decision.code, error: decision.error };
            if (decision.alreadyCanceled) return { kind: 'already_canceled' };

            const updated = await tx.invoice.updateMany({
                where: { id: invoiceId, business_id: businessId, status: 'DRAFT' as any },
                data: { status: 'CANCELED' as any },
            });
            if (updated.count !== 1) return { kind: 'changed' };
            return { kind: 'canceled', campaignId: invoice.campaign_id ?? null };
        });

        switch (outcome.kind) {
            case 'not_found':
                return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
            case 'refused':
                return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status });
            case 'changed':
                return NextResponse.json(
                    { error: 'This invoice changed while you were canceling it. Reload and try again.' },
                    { status: 409 },
                );
            case 'already_canceled':
                return NextResponse.json({
                    success: true,
                    alreadyCanceled: true,
                    invoice: { id: invoiceId, status: 'CANCELED' },
                    message: 'This invoice was already canceled.',
                });
            case 'canceled':
                // No schema holds who canceled it; the status and updated_at hold the fact.
                console.info(`[invoice] $0.00 draft canceled invoice=${invoiceId.slice(0, 8)}${outcome.campaignId ? ` campaign=${outcome.campaignId.slice(0, 8)}` : ''}`);
                return NextResponse.json({
                    success: true,
                    alreadyCanceled: false,
                    invoice: { id: invoiceId, status: 'CANCELED' },
                });
        }
    } catch (e: any) {
        console.error('Invoice Cancel Draft Error:', e?.message ?? e);
        return NextResponse.json({ error: 'Something went wrong canceling this invoice.' }, { status: 500 });
    }
}
