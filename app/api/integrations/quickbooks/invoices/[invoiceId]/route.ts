/**
 * /api/integrations/quickbooks/invoices/[invoiceId] — QB-INVOICE-1C "Send via QuickBooks".
 *
 * GET   where this invoice stands: blocked (and why), ready (with exactly what would be created in QuickBooks
 *       and a review token), in progress, needs review, or sent (with QuickBooks' number and delivery state).
 * POST  {"action":"send","reviewToken":"…","recipientTo":"…","recipientCc":"…"|null}
 *       {"action":"resume"}
 *       {"action":"check_delivery"}
 *       {"action":"resend","recipientTo":"…","recipientCc":"…"|null}
 *
 * Nothing is created or sent at fundraiser close. A QuickBooks invoice is created ONLY by an explicit "send"
 * carrying the review token the GET issued for the invoice exactly as it stands — and it is created unsent,
 * verified, and only then emailed by QuickBooks (lib/quickbooks/invoiceSend.ts). SENT means QuickBooks reports it
 * emailed the invoice — not delivered, not paid. Nothing here touches PAID, payments or fulfillment.
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
    checkQuickBooksInvoiceDelivery,
    getQuickBooksInvoiceSendView,
    InvoiceNotFoundError,
    resendQuickBooksInvoice,
    resumeQuickBooksInvoiceSend,
    startQuickBooksInvoiceSend,
    type SendActionResult,
} from '@/lib/quickbooks/invoiceSend';

// A send reads and writes QuickBooks several times, each verified; give it room.
export const maxDuration = 60;

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };
const ID = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN = 'Only a tenant administrator can send invoices through QuickBooks.';
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

const CONNECTION_BLOCKERS = new Set(['not_connected', 'reconnect_required', 'quickbooks_unavailable']);

function actionStatus(result: SendActionResult): number {
    switch (result.outcome) {
        case 'sent': return 200;
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
    if (action !== 'send' && action !== 'resume' && action !== 'check_delivery' && action !== 'resend') {
        return json({ error: 'Invalid request' }, 400);
    }

    const businessId = (session.user as any).businessId as string;
    const userId = session.user.id as string;
    const config = resolved.config;
    try {
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
                : await resendQuickBooksInvoice({ businessId, invoiceId, config, userId, recipientTo: body.recipientTo, recipientCc: body.recipientCc ?? null });
        return json(result, actionStatus(result));
    } catch (e) {
        if (e instanceof InvoiceNotFoundError) return json({ error: 'Invoice not found' }, 404);
        console.error(`[quickbooks] invoice ${action} failed: ${intuitErrorDetail(e)}`);
        return json({ error: 'Could not complete the QuickBooks request.' }, 500);
    }
}
