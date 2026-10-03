/**
 * DATA-CLEANUP-GUARDS-1 — taking an invoice out of the working set without erasing history.
 *
 * Two doors, and the rule for each.
 *
 * CANCEL A DRAFT (POST /api/tenant/invoices/[id]/cancel-draft)
 *   Closeout used to write a $0.00 DRAFT for a fundraiser that sold nothing, and a
 *   DRAFT could not be withdrawn at all — the generic editor refuses to move one
 *   (GENERIC_EDIT_LOCKED_STATUSES), and the only other way out was a hard delete.
 *   Cancel moves exactly that kind of draft to CANCELED and keeps the row.
 *
 *   Deliberately narrower than "any DRAFT": only a draft that claims NOTHING — $0.00,
 *   no tax, never paid, never touched by QuickBooks, and no order on its fundraiser
 *   still waiting. A draft that bills money is the record of what a fundraiser owes.
 *   Canceling it would hide the debt (FR-HISTORY-1 files a campaign whose only
 *   invoice is CANCELED as owing nothing), and because invoices_one_per_campaign
 *   covers CANCELED rows too, the fundraiser could never be invoiced in-app again.
 *   Its held orders, released only by a PAID invoice (OPS-3), would be stranded.
 *   Widening this is an owner decision, not a default.
 *
 * HARD DELETE (DELETE /api/tenant/invoices)
 *   Previously any signed-in user could delete any invoice FreezerIQ alone held —
 *   PAID ones, sent ones, a fundraiser's closeout invoice — together with its
 *   kitchen order. Delete remains only for what it is for: an ordinary invoice
 *   entered by mistake, before anything happened to it. Everything else is history
 *   and is canceled, not deleted.
 *
 * WHY NO NEW COLUMNS
 *   There is no canceled_at / canceled_by on Invoice. The CANCELED status records
 *   the fact, updated_at stamps when the row last changed, and the route writes a
 *   server log line. Who canceled and why is not durably recorded; doing that would
 *   need an additive migration, which this phase does not make.
 *
 * Pure: the routes read the facts and these functions decide, so every rule here
 * is testable without a database.
 */

import { mayCloseOutCampaign } from '@/lib/campaignCloseout';
import { QUICKBOOKS_INVOICE_LOCK_MESSAGES } from '@/lib/quickbooks/invoiceLock';

/**
 * Who may cancel or delete an invoice: ADMIN or super-admin — the authority that
 * closes a fundraiser out (and so writes its draft) is the authority that may take
 * an invoice back out of the working set. CHEF and DRIVER may not.
 */
export function mayRemoveInvoices(user: { role?: unknown; isSuperAdmin?: unknown }): boolean {
    return mayCloseOutCampaign(user);
}

type Money = number | string | null | undefined;

/** Money compared as whole cents, so "0.00", 0 and a Decimal all agree. */
function isZeroMoney(v: Money): boolean {
    if (v === null || v === undefined || v === '') return true;
    const n = Number(String(v));
    return Number.isFinite(n) && Math.round(n * 100) === 0;
}

export interface InvoiceRemovalRefusal {
    ok: false;
    code:
        | 'not_draft'
        | 'quickbooks'
        | 'payment_recorded'
        | 'bills_money'
        | 'orders_waiting'
        | 'fundraiser_invoice'
        | 'financial_history'
        | 'order_started';
    status: 409;
    error: string;
}

const refuse = (code: InvoiceRemovalRefusal['code'], error: string): InvoiceRemovalRefusal => ({ ok: false, code, status: 409, error });

export interface DraftCancelFacts {
    status: string;
    total_amount: Money;
    tax_amount: Money;
    paid_at: Date | string | null | undefined;
    payment_reference: string | null | undefined;
    hasQuickBooksLink: boolean;
    hasQuickBooksSend: boolean;
    /** Non-canceled orders on the invoice's fundraiser; null for an invoice with no fundraiser. */
    activeCampaignOrderCount: number | null;
}

export type DraftCancelDecision =
    | { ok: true; alreadyCanceled: false }
    | { ok: true; alreadyCanceled: true }
    | InvoiceRemovalRefusal;

export function evaluateDraftCancel(f: DraftCancelFacts): DraftCancelDecision {
    // A repeat of a cancellation that already happened writes nothing and is not an error.
    if (f.status === 'CANCELED') return { ok: true, alreadyCanceled: true };
    if (f.status !== 'DRAFT') {
        return refuse('not_draft',
            'Only a draft that was never sent can be canceled here. Sent, paid and overdue invoices keep their history.');
    }
    if (f.hasQuickBooksLink || f.hasQuickBooksSend) {
        return refuse('quickbooks',
            'This invoice has a QuickBooks record, so it is canceled through QuickBooks, never here.');
    }
    if (f.paid_at || (typeof f.payment_reference === 'string' && f.payment_reference.trim() !== '')) {
        return refuse('payment_recorded', 'A payment is recorded on this invoice, so it cannot be canceled.');
    }
    if (!isZeroMoney(f.total_amount) || !isZeroMoney(f.tax_amount)) {
        return refuse('bills_money',
            'This draft bills money. Only a $0.00 draft can be canceled — canceling one that bills money would hide '
            + 'what the fundraiser owes, and its invoice could not be created again.');
    }
    if (typeof f.activeCampaignOrderCount === 'number' && f.activeCampaignOrderCount > 0) {
        return refuse('orders_waiting',
            'This fundraiser has orders waiting on this invoice: they are released to the kitchen only when it is '
            + 'paid, so it cannot be canceled.');
    }
    return { ok: true, alreadyCanceled: false };
}

/** Statuses an ordinary invoice may be deleted in: never issued as a debt, or already withdrawn. */
export const HARD_DELETABLE_INVOICE_STATUSES = ['PENDING', 'CANCELED'] as const;

/** A linked kitchen order may go with its invoice only while nothing has happened to it. */
export const UNSTARTED_ORDER_STATUSES = ['pending', 'PENDING'] as const;

export interface HardDeleteFacts {
    status: string;
    campaign_id: string | null | undefined;
    paid_at: Date | string | null | undefined;
    payment_reference: string | null | undefined;
    hasQuickBooksLink: boolean;
    hasQuickBooksSend: boolean;
    /** The fulfilment order the invoice created, if any. */
    linkedOrderStatus: string | null | undefined;
}

export type HardDeleteDecision = { ok: true } | InvoiceRemovalRefusal;

export function evaluateHardDelete(f: HardDeleteFacts): HardDeleteDecision {
    if (f.campaign_id) {
        return refuse('fundraiser_invoice',
            'A fundraiser invoice is the record of what its fundraiser owed and is never deleted. '
            + 'A $0.00 draft can be canceled instead.');
    }
    if (f.hasQuickBooksLink || f.hasQuickBooksSend) {
        return refuse('quickbooks', QUICKBOOKS_INVOICE_LOCK_MESSAGES.delete);
    }
    if (!(HARD_DELETABLE_INVOICE_STATUSES as readonly string[]).includes(f.status)) {
        return refuse('financial_history',
            `This invoice is ${String(f.status).toLowerCase()}, which makes it financial history, so it is not deleted. `
            + 'Change its status to Canceled instead.');
    }
    if (f.paid_at || (typeof f.payment_reference === 'string' && f.payment_reference.trim() !== '')) {
        return refuse('payment_recorded', 'A payment is recorded on this invoice, so it cannot be deleted.');
    }
    if (f.linkedOrderStatus && !(UNSTARTED_ORDER_STATUSES as readonly string[]).includes(f.linkedOrderStatus)) {
        return refuse('order_started',
            'Its kitchen order has already started, so deleting the invoice would erase work in progress. '
            + 'Change its status to Canceled instead.');
    }
    return { ok: true };
}

// ── The two reads the routes make inside their transaction ─────────────────

/** The slice of a Prisma interactive-transaction client these helpers use. */
export interface InvoiceRemovalTx {
    $queryRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
    invoice: { findUnique(args: unknown): Promise<any> };
}

/**
 * Row-lock the invoice (tenant-scoped) and, when given, its kitchen order, so the
 * facts read next cannot be overtaken by a concurrent payment, settlement release
 * or kitchen step — those writers queue behind this transaction instead. False
 * when the invoice is not this tenant's (or does not exist).
 */
export async function lockInvoiceForRemoval(
    tx: InvoiceRemovalTx,
    input: { invoiceId: string; businessId: string; orderId?: string | null },
): Promise<boolean> {
    const rows = await tx.$queryRawUnsafe(
        'SELECT id FROM invoices WHERE id = $1 AND business_id = $2 FOR UPDATE',
        input.invoiceId, input.businessId,
    );
    if (!Array.isArray(rows) || rows.length === 0) return false;
    if (input.orderId) {
        await tx.$queryRawUnsafe('SELECT id FROM orders WHERE id = $1 FOR UPDATE', input.orderId);
    }
    return true;
}

/** The facts evaluateHardDelete decides on, read fresh (after the lock). */
export async function readHardDeleteFacts(
    tx: InvoiceRemovalTx,
    input: { invoiceId: string; businessId: string },
): Promise<HardDeleteFacts> {
    const inv = await tx.invoice.findUnique({
        where: { id: input.invoiceId, business_id: input.businessId },
        select: {
            status: true,
            campaign_id: true,
            paid_at: true,
            payment_reference: true,
            quickbooks_invoice_links: { select: { id: true } },
            quickbooks_invoice_send: { select: { id: true } },
            order: { select: { status: true } },
        },
    });
    if (!inv) throw new Error('Invoice not found');
    return {
        status: String(inv.status),
        campaign_id: inv.campaign_id ?? null,
        paid_at: inv.paid_at ?? null,
        payment_reference: inv.payment_reference ?? null,
        hasQuickBooksLink: Array.isArray(inv.quickbooks_invoice_links) && inv.quickbooks_invoice_links.length > 0,
        hasQuickBooksSend: Boolean(inv.quickbooks_invoice_send),
        linkedOrderStatus: inv.order ? String(inv.order.status) : null,
    };
}

/**
 * What the invoices page may OFFER, from the row it already has. A presentation
 * mirror only — the routes re-decide everything with the facts they lock and read.
 */
export function offersDraftCancel(inv: {
    status: string; campaign_id?: string | null; total_amount: Money; tax_amount?: Money;
    paid_at?: Date | string | null; quickbooks_invoice_send?: unknown;
}): boolean {
    return inv.status === 'DRAFT' && !inv.quickbooks_invoice_send && !inv.paid_at
        && isZeroMoney(inv.total_amount) && isZeroMoney(inv.tax_amount);
}

export function offersHardDelete(inv: {
    status: string; campaign_id?: string | null; paid_at?: Date | string | null; quickbooks_invoice_send?: unknown;
}): boolean {
    return !inv.campaign_id && !inv.quickbooks_invoice_send && !inv.paid_at
        && (HARD_DELETABLE_INVOICE_STATUSES as readonly string[]).includes(inv.status);
}
