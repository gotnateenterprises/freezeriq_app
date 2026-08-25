/**
 * INV-C — send a fundraiser invoice, and record that truthfully.
 *
 * WHY THIS EXISTS AS ITS OWN ENDPOINT
 *
 * The DRAFT -> SENT transition has to be decided by the server, in the same
 * request that talks to the email provider. The browser cannot be trusted to
 * report its own success: the generic invoice PUT deliberately refuses DRAFT and
 * SENT (see CLIENT_SETTABLE_INVOICE_STATUSES), precisely so a status that means
 * "we really posted this" cannot be set by whoever happens to be holding the
 * page.
 *
 * WHAT IS AND IS NOT TRUSTED FROM THE CLIENT
 *
 *   recipient   NEVER from the request. Resolved here from the invoice's own
 *               customer, so a composed message cannot be redirected.
 *   status      NEVER from the request. Decided from the provider outcome.
 *   subject     from the request — the compose dialog is meant to be editable.
 *   html        from the request, same reason.
 *   attachments from the request. The PDF is generated in the browser by jsPDF
 *               (app/invoices/page.tsx) and there is no server renderer to
 *               replace it with; that is existing architecture INV-C does not
 *               rewrite. It is the message BODY, not an authority.
 *
 * SENT IS NOT PAID. This route never writes PAID and never records a payment,
 * a settlement, or a paid date. Those are INV-D.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { Resend } from 'resend';
import {
    decideInvoiceSendStatus,
    isLiveEmailConfigured,
    type ProviderSendOutcome,
} from '@/lib/invoiceSendTruth';

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

        // ── Tenant ownership. Scoped by the EFFECTIVE business (SEC-TENANT-1),
        //    so a super admin viewing another tenant acts as that tenant and can
        //    never reach an invoice outside it.
        const invoice = await prisma.invoice.findFirst({
            where: { id: invoiceId, business_id: businessId },
            select: {
                id: true,
                status: true,
                campaign_id: true,
                total_amount: true,
                customer: { select: { name: true, contact_email: true } },
            },
        });

        if (!invoice) {
            // Same answer for "not yours" as for "does not exist" — a tenant
            // must not be able to probe for another tenant's invoice ids.
            return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
        }

        // ── Recipient authority: the invoice's own customer, resolved server-side.
        //    Never `body.to`, and never the signed-in user — under View As those
        //    would be the admin's own address rather than the coordinator's.
        const recipient = invoice.customer?.contact_email?.trim();
        if (!recipient) {
            return NextResponse.json(
                { error: 'This invoice\'s customer has no email address on file.' },
                { status: 400 },
            );
        }

        let body: any = {};
        try {
            body = await req.json();
        } catch {
            // No body — fall through to the required-field check below.
        }

        const subject = typeof body?.subject === 'string' ? body.subject.trim() : '';
        const html = typeof body?.html === 'string' ? body.html : '';
        const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

        if (!subject || !html) {
            return NextResponse.json(
                { error: 'A subject and message body are required.' },
                { status: 400 },
            );
        }

        // ── Attempt the provider send. Safety mode is honoured exactly as
        //    app/api/email/send/route.ts honours it: when EMAIL_LIVE is not
        //    'true' nothing is posted, and this route must not pretend otherwise.
        let outcome: ProviderSendOutcome;

        if (!isLiveEmailConfigured(process.env as any)) {
            console.log(
                `[SAFETY MODE / MOCK INVOICE EMAIL] invoice=${invoice.id} to=${recipient} attachments=${attachments.length}`,
            );
            outcome = { ok: true, mocked: true };
        } else {
            try {
                const { getTenantSender } = await import('@/lib/email');
                const sender = await getTenantSender(businessId);
                const resend = new Resend(process.env.RESEND_API_KEY);

                const processed = attachments.map((att: any) =>
                    typeof att?.content === 'string'
                        ? { ...att, content: Buffer.from(att.content, 'base64') }
                        : att,
                );

                const data = await resend.emails.send({
                    from: sender.from,
                    to: [recipient],
                    replyTo: sender.replyTo,
                    subject,
                    html,
                    attachments: processed,
                });

                outcome = data.error
                    ? { ok: false, mocked: false, error: String(data.error?.message ?? data.error) }
                    : { ok: true, mocked: false, providerId: data.data?.id ?? null };
            } catch (err: any) {
                outcome = { ok: false, mocked: false, error: err?.message ?? 'send failed' };
            }
        }

        const decision = decideInvoiceSendStatus(outcome);

        // ── Record the transition ONLY when the provider actually accepted it.
        //    Guarded on status DRAFT so a re-send of an already-SENT invoice is a
        //    no-op rather than a redundant write, and so nothing here can move an
        //    invoice backwards out of PAID.
        let finalStatus: string = invoice.status;
        if (decision.markSent) {
            const claimed = await prisma.invoice.updateMany({
                where: { id: invoice.id, business_id: businessId, status: 'DRAFT' as any },
                data: { status: 'SENT' as any },
            });
            finalStatus = claimed.count === 1 ? 'SENT' : invoice.status;
        }

        if (!decision.markSent) {
            if (decision.reason === 'mocked') {
                // Truthful, and deliberately not an error: the operator asked for
                // safety mode. The invoice stays DRAFT because nothing was posted.
                return NextResponse.json({
                    success: true,
                    sent: false,
                    mocked: true,
                    status: finalStatus,
                    recipient,
                    message: 'Safety mode: the email was logged, not sent. The invoice remains a draft.',
                });
            }

            console.error('[InvoiceSend] provider failure:', outcome.error);
            // Provider text is never surfaced to the browser.
            return NextResponse.json(
                {
                    success: false,
                    sent: false,
                    mocked: false,
                    status: finalStatus,
                    error: 'The email could not be sent. The invoice is still a draft — you can try again.',
                },
                { status: 502 },
            );
        }

        return NextResponse.json({
            success: true,
            sent: true,
            mocked: false,
            status: finalStatus,
            recipient,
        });
    } catch (e: any) {
        console.error('Invoice Send Error:', e);
        return NextResponse.json(
            { error: 'Something went wrong sending this invoice.' },
            { status: 500 },
        );
    }
}
