/**
 * QB-INVOICE-1D — "Check QuickBooks payment" for one FreezerIQ fundraiser invoice that was SENT through QuickBooks.
 *
 * An EXPLICIT admin action, not monitoring: nothing here runs on a schedule, on a webhook or by itself. When the
 * admin asks, FreezerIQ reads QuickBooks and marks the invoice PAID only if QuickBooks proves — with a real Payment
 * transaction — that exactly this invoice was paid in full. Anything less changes nothing and says why.
 *
 * THE EVIDENCE RULE (owner-locked). All of it, or no settlement:
 *   A. FreezerIQ   the invoice belongs to the session tenant, is SENT, and was sent by the 1C lifecycle; its money is
 *                  unchanged since it was sent (the lifecycle's review hash); its QuickBooks link, the lifecycle and
 *                  the organization's customer link all belong to the tenant's LIVE connection generation.
 *   B. Invoice     the QuickBooks invoice is still the one FreezerIQ created: same Id, same DocNumber, same customer,
 *                  USD, same lines and money (lib/quickbooks/invoiceContract.ts, stage 'payment').
 *   C. Balance     exactly 0, in integer cents.
 *   D. Payment     the invoice links exactly ONE Payment and nothing else, and that Payment, read by its own Id:
 *                  is for the same customer, in USD; received exactly the invoice total (TotalAmt) with nothing left
 *                  unapplied; has exactly one line, which links exactly this invoice — no credit memo, journal entry,
 *                  expense or second invoice — for exactly the invoice total; and carries a plausible date.
 *
 * WHY BALANCE 0 IS NEVER ENOUGH — proven with real Intuit responses in the 1D sandbox shape spike (2026-09-21):
 * a credit memo applied to an invoice leaves Balance 0 AND a single linked "Payment" on the invoice. Only reading
 * that Payment reveals it received $0 and carries a CreditMemo line. The same is true of a payment moved over from
 * another invoice by QuickBooks' AutoApplyCredit. So the Payment object itself is the evidence, never the balance.
 *
 * WHAT IS DELIBERATELY UNSUPPORTED IN 1D (each answers needs review / partially paid, and nothing is written):
 * partial payments, several payments, payments that also apply credits or cover other invoices, overpayments, and
 * anything inconsistent. The owner broadens these later.
 *
 * SETTLEMENT is the SAME conditional transition a human's Record Payment runs (lib/invoiceSettlementTransition.ts),
 * only from SENT, recording `payment_method = 'quickbooks'`, the Payment's own date, and a reference naming the
 * QuickBooks Payment Id and invoice number. The kitchen release runs only in that transition's winner-only branch, so
 * a second check — or a concurrent one — can never release food twice. PAID is never reversed here: a refund or a
 * reversal in QuickBooks afterwards needs a later reconciliation workflow. The QuickBooks processing fee is
 * irrelevant: the invoice was paid in full; the fee is the tenant's cost, recorded by QuickBooks in the deposit.
 *
 * READ-ONLY AGAINST QUICKBOOKS: one invoice read and at most one payment read, both by id. No query, no search, no
 * write of any kind. The accounting scope is unchanged. Nothing logged or returned carries a token, the realm id, the
 * connection id or a customer's name; problems are reason codes plus Intuit's sanitized detail.
 *
 * KNOWN LIMITS, stated so nobody relies on more: QuickBooks' Payment has no status field, so a bank (ACH) payment that
 * the bank later returns reads exactly like one that settled; and a refund processed against a payment does not change
 * that payment's TotalAmt (Intuit's own documentation). Neither is detectable here.
 */

import { prisma } from '@/lib/db';
import type { QuickBooksConfig } from '@/lib/quickbooks/config';
import { QuickBooksConnectionError, type Deps } from '@/lib/quickbooks/connection';
import {
    IntuitError,
    intuitErrorDetail,
    PAYMENT_FLAGS_OFF,
    readQuickBooksInvoicePaymentLinks,
    readQuickBooksPayment,
    type QuickBooksLinkedTxnRef,
    type QuickBooksPaymentSnapshot,
} from '@/lib/quickbooks/intuitClient';
import { verifyQuickBooksInvoice } from '@/lib/quickbooks/invoiceContract';
import { InvoiceNotFoundError, loadSentReview, type InvoiceSendDeps, type SentReviewBlocker } from '@/lib/quickbooks/invoiceSend';
import {
    ConnectionChangedError,
    isConnectionProblem,
    liveConnection,
    withAccess,
    type LiveConnectionDeps,
} from '@/lib/quickbooks/liveConnection';
import {
    calendarDateToUtcNoon,
    normalizeSettlementReference,
    SETTLEMENT_DATE_FLOOR_ISO,
    SETTLEMENT_FUTURE_SLACK_DAYS,
    utcNoonToCalendarDate,
} from '@/lib/invoiceSettlement';
import { settleInvoiceInTransaction } from '@/lib/invoiceSettlementTransition';

// ── public shapes ───────────────────────────────────────────────────────────

/** Why the payment evidence was not sufficient. Codes only — never a name, an email or an amount. */
export type PaymentReviewReason =
    /** FreezerIQ side */
    | 'changed_since_review'
    | 'invoice_status_changed'
    /** the QuickBooks invoice */
    | 'qbo_invoice_missing'
    | 'qbo_invoice_changed'
    | 'balance_inconsistent'
    /** the links on it */
    | 'payment_evidence_unreadable'
    | 'no_payment_evidence'
    | 'unsupported_linked_transaction'
    | 'multiple_payments'
    /** the one Payment */
    | 'payment_missing'
    | 'payment_not_for_this_invoice'
    | 'payment_customer_mismatch'
    | 'payment_currency_mismatch'
    | 'payment_includes_other_transactions'
    | 'payment_unapplied_amount'
    | 'payment_amount_mismatch'
    | 'payment_date_invalid';

/** Why the check cannot run at all right now. Nothing was read from QuickBooks and nothing was written. */
export type PaymentCheckBlocker =
    | Exclude<SentReviewBlocker, 'changed_since_review'>
    | 'not_connected' | 'reconnect_required';

export interface PaymentSettlement {
    method: string | null;
    /** YYYY-MM-DD — the calendar day the payment was made (QuickBooks' own TxnDate for a verified payment). */
    paidOn: string | null;
    reference: string | null;
}

export type PaymentCheckResult =
    /** THIS check verified the payment and marked the invoice PAID. */
    | { outcome: 'paid'; settlement: PaymentSettlement }
    /** Already PAID (by an earlier check or a recorded payment). Nothing was read and nothing written. */
    | { outcome: 'already_paid'; settlement: PaymentSettlement }
    /** QuickBooks shows the full amount still owed. */
    | { outcome: 'not_paid' }
    /** QuickBooks shows part of it paid. FreezerIQ records nothing for a partial payment in 1D. */
    | { outcome: 'partially_paid'; balanceDue: number }
    /** QuickBooks shows something FreezerIQ will not treat as a payment on its own. Nothing was written. */
    | { outcome: 'needs_review'; reason: PaymentReviewReason; detail?: string }
    | { outcome: 'blocked'; blocker: PaymentCheckBlocker }
    /** QuickBooks could not be reached or answered unexpectedly. Nothing was written; try again. */
    | { outcome: 'unavailable' };

// ── pure evidence rules (exported for tests) ────────────────────────────────

const cents = (n: number): number => Math.round(n * 100);
/** A QuickBooks decimal that is a whole number of cents. */
const wholeCents = (n: number | null): n is number => n !== null && Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

export type InvoicePaymentState =
    | { kind: 'unpaid' }
    | { kind: 'partially_paid'; balanceCents: number }
    | { kind: 'review'; reason: Extract<PaymentReviewReason, 'balance_inconsistent' | 'payment_evidence_unreadable' | 'no_payment_evidence' | 'unsupported_linked_transaction' | 'multiple_payments'> }
    | { kind: 'verify_payment'; paymentId: string };

/**
 * What the QuickBooks invoice's Balance and LinkedTxn say — before any payment is trusted. A zero balance only earns
 * the right to READ one payment; it is never evidence on its own.
 */
export function classifyInvoicePaymentState(input: {
    balance: number | null;
    totalCents: number;
    linkedTxns: QuickBooksLinkedTxnRef[] | null;
}): InvoicePaymentState {
    if (!wholeCents(input.balance)) return { kind: 'review', reason: 'balance_inconsistent' };
    const balance = cents(input.balance);
    if (balance === input.totalCents) return { kind: 'unpaid' };
    if (balance > 0 && balance < input.totalCents) return { kind: 'partially_paid', balanceCents: balance };
    if (balance !== 0) return { kind: 'review', reason: 'balance_inconsistent' }; // negative, or more than was invoiced

    if (input.linkedTxns === null) return { kind: 'review', reason: 'payment_evidence_unreadable' };
    if (input.linkedTxns.some((t) => t.txnType !== 'Payment')) return { kind: 'review', reason: 'unsupported_linked_transaction' };
    const paymentIds = [...new Set(input.linkedTxns.map((t) => t.txnId))];
    if (paymentIds.length === 0) return { kind: 'review', reason: 'no_payment_evidence' };
    if (paymentIds.length > 1) return { kind: 'review', reason: 'multiple_payments' };
    return { kind: 'verify_payment', paymentId: paymentIds[0] };
}

export type PaymentEvidence =
    | { ok: true; paidOn: string }
    | { ok: false; reason: Extract<PaymentReviewReason, `payment_${string}`> };

/**
 * Is this ONE QuickBooks Payment, by itself, proof that exactly this invoice was paid in full? Every rule must hold;
 * the first that does not is the reason. Integer cents throughout — never a floating-point equality.
 */
export function verifyPaymentEvidence(
    payment: QuickBooksPaymentSnapshot,
    expected: { paymentId: string; qboInvoiceId: string; customerId: string; totalCents: number; now: Date },
): PaymentEvidence {
    if (payment.id !== expected.paymentId) return { ok: false, reason: 'payment_not_for_this_invoice' };
    if (payment.customerId !== expected.customerId) return { ok: false, reason: 'payment_customer_mismatch' };
    if (payment.currency !== 'USD') return { ok: false, reason: 'payment_currency_mismatch' };

    // Exactly one line, linking exactly one transaction, which is this invoice. A credit memo, a journal entry, an
    // expense or a second invoice in the same payment are all "something other than cash for this invoice".
    if (payment.lines.length !== 1) return { ok: false, reason: 'payment_includes_other_transactions' };
    const [line] = payment.lines;
    if (!line.linked || line.linked.length !== 1) return { ok: false, reason: 'payment_includes_other_transactions' };
    const [link] = line.linked;
    if (link.txnType !== 'Invoice') return { ok: false, reason: 'payment_includes_other_transactions' };
    if (link.txnId !== expected.qboInvoiceId) return { ok: false, reason: 'payment_not_for_this_invoice' };

    // Money received for this invoice: all of it applied here, exactly the invoice total, nothing left over.
    if (payment.unappliedAmt !== null && (!wholeCents(payment.unappliedAmt) || cents(payment.unappliedAmt) !== 0)) {
        return { ok: false, reason: 'payment_unapplied_amount' };
    }
    if (!wholeCents(line.amount) || cents(line.amount) !== expected.totalCents) return { ok: false, reason: 'payment_amount_mismatch' };
    if (!wholeCents(payment.totalAmt) || cents(payment.totalAmt) !== expected.totalCents) return { ok: false, reason: 'payment_amount_mismatch' };

    // The payment's own date: a real calendar day, not implausibly old, not in the future (one day of slack for time
    // zones — the same bounds a human's Record Payment is held to).
    const day = payment.txnDate && /^\d{4}-\d{2}-\d{2}$/.test(payment.txnDate) ? calendarDateToUtcNoon(payment.txnDate) : null;
    if (!day) return { ok: false, reason: 'payment_date_invalid' };
    if (day.getTime() < calendarDateToUtcNoon(SETTLEMENT_DATE_FLOOR_ISO)!.getTime()) return { ok: false, reason: 'payment_date_invalid' };
    if (day.getTime() > expected.now.getTime() + SETTLEMENT_FUTURE_SLACK_DAYS * 24 * 60 * 60 * 1000) return { ok: false, reason: 'payment_date_invalid' };
    return { ok: true, paidOn: payment.txnDate! };
}

/** The durable, non-secret evidence stored in `payment_reference`: the QuickBooks Payment Id and invoice number. */
export function quickBooksPaymentReference(paymentId: string, docNumber: string | null): string {
    return normalizeSettlementReference(`QuickBooks payment ${paymentId}${docNumber ? ` · invoice #${docNumber}` : ''}`)!;
}

// ── the check ───────────────────────────────────────────────────────────────

export type InvoicePaymentDeps = InvoiceSendDeps;

interface Resolved {
    db: NonNullable<InvoiceSendDeps['db']>;
    fetchImpl: NonNullable<Deps['fetchImpl']>;
    env?: NodeJS.ProcessEnv;
    now: () => number;
    sleep?: Deps['sleep'];
}

function resolve(deps: InvoicePaymentDeps): Resolved {
    return {
        db: deps.db ?? (prisma as unknown as NonNullable<InvoiceSendDeps['db']>),
        fetchImpl: deps.fetchImpl ?? fetch,
        env: deps.env,
        now: deps.now ?? Date.now,
        sleep: deps.sleep,
    };
}

const liveDeps = (d: Resolved): LiveConnectionDeps => ({ db: d.db, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });

/** The FreezerIQ invoice fields the check and the settlement transition read. Never money to write. */
const INVOICE_SELECT = {
    id: true, status: true, campaign_id: true, customer_id: true, total_amount: true,
    paid_at: true, payment_method: true, payment_reference: true,
    customer: { select: { type: true } },
};

interface LoadedInvoice {
    id: string; status: string; campaign_id: string | null; customer_id: string; total_amount: unknown;
    paid_at: Date | null; payment_method: string | null; payment_reference: string | null;
    customer: { type?: string | null } | null;
}

const settlementOf = (inv: Pick<LoadedInvoice, 'paid_at' | 'payment_method' | 'payment_reference'>): PaymentSettlement => ({
    method: inv.payment_method ?? null,
    paidOn: inv.paid_at ? utcNoonToCalendarDate(new Date(inv.paid_at)) : null,
    reference: inv.payment_reference ?? null,
});

async function loadInvoice(d: Resolved, businessId: string, invoiceId: string): Promise<LoadedInvoice> {
    const inv = await d.db.invoice.findFirst({ where: { id: invoiceId, business_id: businessId }, select: INVOICE_SELECT as any });
    if (!inv) throw new InvoiceNotFoundError();
    return inv as unknown as LoadedInvoice;
}

/** A reason to review, logged with its code (and Intuit's sanitized detail when there is one). Nothing is written. */
function review(reason: PaymentReviewReason, detail?: string): PaymentCheckResult {
    console.warn(`[quickbooks] invoice payment not recognised: ${reason}${detail ? ` ${detail}` : ''}`);
    return detail ? { outcome: 'needs_review', reason, detail: detail.slice(0, 300) } : { outcome: 'needs_review', reason };
}

/**
 * POST {"action":"check_payment"} — read QuickBooks for this invoice's payment and, only when the evidence rule holds
 * in full, settle it through the shared transition. Idempotent: an invoice already PAID answers already_paid without
 * contacting QuickBooks, and a concurrent check that loses the transition reports the winner's settlement.
 */
export async function checkQuickBooksInvoicePayment(
    input: { businessId: string; invoiceId: string; config: QuickBooksConfig }, deps: InvoicePaymentDeps = {},
): Promise<PaymentCheckResult> {
    const d = resolve(deps);

    // A. The FreezerIQ invoice. PAID is idempotent and needs nothing from QuickBooks.
    const invoice = await loadInvoice(d, input.businessId, input.invoiceId);
    if (invoice.status === 'PAID') return { outcome: 'already_paid', settlement: settlementOf(invoice) };
    if (invoice.status !== 'SENT') return { outcome: 'blocked', blocker: 'invoice_not_sent' };

    const live = await liveConnection(input.businessId, input.config, liveDeps(d));
    if (isConnectionProblem(live)) return live.state === 'unavailable' ? { outcome: 'unavailable' } : { outcome: 'blocked', blocker: live.state };

    const sent = await loadSentReview({ businessId: input.businessId, invoiceId: input.invoiceId, connectionId: live.connectionId }, deps);
    if (!sent.ok) return sent.blocker === 'changed_since_review' ? review('changed_since_review') : { outcome: 'blocked', blocker: sent.blocker };
    const totalCents = sent.expected.totalCents;

    let paidOn: string;
    let paymentId: string;
    try {
        // B. The QuickBooks invoice is still the one FreezerIQ created, with FreezerIQ's numbers.
        const read = await withAccess(input.businessId, input.config, live, liveDeps(d),
            (a) => readQuickBooksInvoicePaymentLinks(input.config, a.accessToken, a.realmId, sent.qboInvoiceId, d.fetchImpl));
        if (!read) return review('qbo_invoice_missing');
        const { invoice: qboInvoice, linkedTxns } = read;
        const identity = verifyQuickBooksInvoice(qboInvoice, sent.expected, {
            billEmail: null, billEmailCc: null, payment: { ...PAYMENT_FLAGS_OFF },
            qboInvoiceId: sent.qboInvoiceId, docNumber: sent.docNumber ?? undefined,
        }, 'payment');
        if (!identity.ok) return review('qbo_invoice_changed', identity.failures.map((f) => f.check).join(','));

        // C. The balance, and what is linked to it.
        const state = classifyInvoicePaymentState({ balance: qboInvoice.balance, totalCents, linkedTxns });
        if (state.kind === 'unpaid') return { outcome: 'not_paid' };
        if (state.kind === 'partially_paid') return { outcome: 'partially_paid', balanceDue: state.balanceCents / 100 };
        if (state.kind === 'review') return review(state.reason);

        // D. The ONE Payment, read by its own Id.
        const payment = await withAccess(input.businessId, input.config, live, liveDeps(d),
            (a) => readQuickBooksPayment(input.config, a.accessToken, a.realmId, state.paymentId, d.fetchImpl));
        if (!payment) return review('payment_missing');
        const evidence = verifyPaymentEvidence(payment, {
            paymentId: state.paymentId, qboInvoiceId: sent.qboInvoiceId, customerId: sent.expected.customerId, totalCents, now: new Date(d.now()),
        });
        if (!evidence.ok) return review(evidence.reason);
        paidOn = evidence.paidOn;
        paymentId = state.paymentId;
    } catch (e) {
        if (e instanceof IntuitError || e instanceof QuickBooksConnectionError || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] invoice payment check unavailable: ${e instanceof IntuitError ? intuitErrorDetail(e) : e instanceof QuickBooksConnectionError ? `kind:${e.kind}` : 'connection_changed'}`);
            return { outcome: 'unavailable' };
        }
        throw e;
    }

    // Settle through THE shared transition, from SENT only. Its winner-only branch is the one kitchen release.
    const facts = { method: 'quickbooks' as const, paidAt: calendarDateToUtcNoon(paidOn)!, reference: quickBooksPaymentReference(paymentId, sent.docNumber) };
    const claimed = await d.db.$transaction((tx) => settleInvoiceInTransaction(tx as any, {
        invoice: { id: invoice.id, campaign_id: invoice.campaign_id, customer_id: invoice.customer_id, total_amount: invoice.total_amount, customer: invoice.customer },
        businessId: input.businessId,
        facts,
        fromStatuses: ['SENT'],
    }));
    if (claimed.count === 1) {
        console.info('[quickbooks] invoice payment verified in QuickBooks; invoice marked paid');
        return { outcome: 'paid', settlement: { method: facts.method, paidOn, reference: facts.reference } };
    }
    // Lost the transition: report what is stored now.
    const now = await loadInvoice(d, input.businessId, input.invoiceId);
    if (now.status === 'PAID') return { outcome: 'already_paid', settlement: settlementOf(now) };
    return review('invoice_status_changed');
}
