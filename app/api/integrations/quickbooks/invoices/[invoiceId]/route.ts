/**
 * /api/integrations/quickbooks/invoices/[invoiceId] — QB-INVOICE-1C "Send via QuickBooks".
 *
 * GET   where this invoice stands: blocked (and why), ready (with exactly what would be created in QuickBooks
 *       and a review token), in progress, needs review, or sent (with QuickBooks' number and delivery state).
 * POST  {"action":"send","reviewToken":"…","recipientTo":"…","recipientCc":"…"|null}
 *       {"action":"resume"}
 *       {"action":"recheck"}                                         (re-reads the SAME invoice; never creates one)
 *       {"action":"cancel","confirmation":"<DocNumber>"}            (voids the SAME invoice; marks this one Canceled)
 *       {"action":"check_delivery"}
 *       {"action":"resend","recipientTo":"…","recipientCc":"…"|null}
 *       {"action":"check_payment"}                                   (QB-INVOICE-1D)
 *
 * Nothing is created or sent at fundraiser close. A QuickBooks invoice is created ONLY by an explicit "send"
 * carrying the review token the GET issued for the invoice exactly as it stands — and it is created unsent,
 * verified, and only then emailed by QuickBooks (lib/quickbooks/invoiceSend.ts). SENT means QuickBooks reports it
 * emailed the invoice — not delivered, not paid.
 *
 * QB-INVOICE-1D: "check_payment" READS QuickBooks for this invoice's payment and marks the FreezerIQ invoice PAID —
 * through the same settlement transition Record Payment uses — only when ONE QuickBooks Payment applies exactly the
 * invoice total to exactly this invoice (lib/quickbooks/invoicePayment.ts). It never writes to QuickBooks.
 *
 * Tenant ADMIN only, acting as themselves (not View As). The invoice must belong to the session's tenant (404
 * otherwise). JSON bodies only (415 otherwise). No response carries a token, the realm id, the connection id or a
 * raw QuickBooks id; QuickBooks' own invoice NUMBER (DocNumber) is shown, as the tenant sees it in QuickBooks.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { resolveQuickBooksConfig } from '@/lib/quickbooks/config';
import { intuitErrorDetail } from '@/lib/quickbooks/intuitClient';
import {
    cancelQuickBooksInvoice,
    checkQuickBooksInvoiceDelivery,
    getQuickBooksInvoiceSendView,
    InvoiceNotFoundError,
    recheckQuickBooksInvoiceCreate,
    resendQuickBooksInvoice,
    resumeQuickBooksInvoiceSend,
    startQuickBooksInvoiceSend,
    type SendActionResult,
} from '@/lib/quickbooks/invoiceSend';
import { checkQuickBooksInvoicePayment, type PaymentCheckResult } from '@/lib/quickbooks/invoicePayment';

// A send reads and writes QuickBooks several times, each verified; give it room.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const ID = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN = 'Only a tenant administrator can send invoices through QuickBooks.';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const CONNECTION_BLOCKERS = new Set(['not_connected', 'reconnect_required', 'quickbooks_unavailable']);

/** QB-INVOICE-1D: a completed check is 200 whatever QuickBooks showed; refusals and outages say so. */
function paymentStatus(result: PaymentCheckResult): number {
    switch (result.outcome) {
        case 'paid': case 'already_paid': case 'not_paid': case 'partially_paid': return 200;
        case 'unavailable': return 503;
        case 'blocked': return result.blocker === 'not_connected' || result.blocker === 'reconnect_required' ? 503 : 409;
        default: return 409; // needs_review
    }
}

function actionStatus(result: SendActionResult): number {
    switch (result.outcome) {
        case 'sent': return 200;
        case 'canceled': return 200;
        case 'in_progress': return 202;
        case 'invalid': return 400;
        case 'blocked': return result.blockers.every((b) => CONNECTION_BLOCKERS.has(b)) ? 503 : 409;
        default: return 409; // needs_review | stale
    }
}

export async function GET(_req: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) return json({ error: FORBIDDEN }, 403);
    const { invoiceId } = await params;
    if (!ID.test(invoiceId)) return json({ error: 'Invoice not found' }, 404);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ state: 'disabled' });

    const businessId = (session.user as any).businessId as string;
    try {
        return json(await getQuickBooksInvoiceSendView({ businessId, invoiceId, config: resolved.config }));
    } catch (e) {
        if (e instanceof InvoiceNotFoundError) return json({ error: 'Invoice not found' }, 404);
        console.error(`[quickbooks] invoice send view failed: ${intuitErrorDetail(e)}`);
        return json({ state: 'error' });
    }
}

export async function POST(req: Request, { params }: { params: Promise<{ invoiceId: string }> }) {
    const session = await auth();
    if (!session?.user?.id) return json({ error: 'Unauthorized' }, 401);
    if (!mayManageQuickBooks(session.user as any)) return json({ error: FORBIDDEN }, 403);
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return json({ error: 'Expected application/json' }, 415);
    }
    const { invoiceId } = await params;
    if (!ID.test(invoiceId)) return json({ error: 'Invoice not found' }, 404);

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) return json({ error: 'QuickBooks is not available in this environment.' }, 503);

    let body: any;
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid request' }, 400);
    }
    const action = body?.action;
    if (action !== 'send' && action !== 'resume' && action !== 'recheck' && action !== 'cancel'
        && action !== 'check_delivery' && action !== 'resend' && action !== 'check_payment') {
        return json({ error: 'Invalid request' }, 400);
    }

    const businessId = (session.user as any).businessId as string;
    const userId = session.user.id as string;
    const config = resolved.config;
    try {
        if (action === 'check_payment') {
            const result = await checkQuickBooksInvoicePayment({ businessId, invoiceId, config });
            return json(result, paymentStatus(result));
        }
        if (action === 'check_delivery') {
            const result = await checkQuickBooksInvoiceDelivery({ businessId, invoiceId, config });
            return json(result, result.outcome === 'checked' ? 200 : result.outcome === 'unavailable' ? 503 : 409);
        }
        const result = action === 'send'
            ? await startQuickBooksInvoiceSend({
                businessId, invoiceId, config, userId,
                reviewToken: body.reviewToken, recipientTo: body.recipientTo, recipientCc: body.recipientCc ?? null,
            })
            : action === 'resume'
                ? await resumeQuickBooksInvoiceSend({ businessId, invoiceId, config, userId })
                // The one repair: re-read the SAME QuickBooks invoice. It never creates one, and never sends.
                : action === 'recheck'
                    ? await recheckQuickBooksInvoiceCreate({ businessId, invoiceId, config, userId })
                    // Cancel: void the SAME QuickBooks invoice, then mark this one Canceled. Never creates, never pays.
                    : action === 'cancel'
                        ? await cancelQuickBooksInvoice({ businessId, invoiceId, config, userId, confirmation: body.confirmation })
                        : await resendQuickBooksInvoice({ businessId, invoiceId, config, userId, recipientTo: body.recipientTo, recipientCc: body.recipientCc ?? null });
        return json(result, actionStatus(result));
    } catch (e) {
        if (e instanceof InvoiceNotFoundError) return json({ error: 'Invoice not found' }, 404);
        console.error(`[quickbooks] invoice ${action} failed: ${intuitErrorDetail(e)}`);
        return json({ error: 'Could not complete the QuickBooks request.' }, 500);
    }
}
