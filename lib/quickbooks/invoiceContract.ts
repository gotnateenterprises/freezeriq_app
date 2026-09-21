/**
 * QB-INVOICE-1C — the READ-BACK CONTRACT for a QuickBooks invoice FreezerIQ created.
 *
 * FreezerIQ owns every number. QuickBooks is only allowed to hold them. After each step of the send
 * lifecycle the invoice is read back and checked here, and ANY failure stops the lifecycle before the
 * next step: nothing is sent, the FreezerIQ invoice stays not-SENT, and the same QuickBooks invoice is
 * kept for controlled repair (lib/quickbooks/invoiceSend.ts).
 *
 * Proven against the Intuit US sandbox company in the 1C accounting and send-safety spikes (2026-09-15):
 *   - the exact $62.50 @ 1% rounding fixture — $557.50 + $5.59 − $111.50 — reads back as $451.59;
 *   - QuickBooks keeps pre-tax NON lines, an ordinary tax line and a negative share line exactly;
 *   - a create with no recipient, EmailStatus NotSet and every online-payment flag false stays unsent;
 *   - a sparse update that omits the payment flags silently re-defaults them (hence the flag checks at
 *     every stage);
 *   - an explicit send moves EmailStatus to EmailSent and fills DeliveryInfo (type Email + time);
 *   - updating an already-emailed invoice REMOVES DeliveryInfo.DeliveryTime and keeps EmailStatus, DeliveryType and
 *     any DeliveryErrorType (sandbox acceptance, 2026-09-16) — hence the delivery time is checked at 'sent' only.
 *
 * Money is compared in integer cents. The contract is pure: no I/O, no clock except the one passed in.
 */

import type { QuickBooksInvoiceSnapshot, QuickBooksPaymentFlags } from '@/lib/quickbooks/intuitClient';

export type ContractStage =
    /** Straight after CREATE: provably unsent, no recipient anywhere, every online-payment flag false. */
    | 'created'
    /** After the recipient update: still unsent, recipients exact, flags still all false. */
    | 'recipients'
    /** After the payment-option update, or re-checked immediately before Send: still unsent, flags == tenant options. */
    | 'payment_options'
    /** After QuickBooks reports the invoice sent (explicit Send, or detected during payment configuration). */
    | 'sent'
    /**
     * A sent invoice on the way to being re-sent: read before the re-send, and again after the recipient update.
     * Everything 'sent' requires except the delivery TIME, which QuickBooks removes when the invoice is updated.
     */
    | 'resend_recipients'
    /**
     * QB-INVOICE-1D: a sent invoice re-read before its payment evidence is trusted. Every identity, line and
     * money check still applies — it must still be the invoice FreezerIQ created, with FreezerIQ's numbers —
     * EXCEPT `balance_unpaid`, because a payment legitimately lowers the Balance (the payment check classifies the
     * Balance itself), and no delivery check, because payment evidence does not depend on who was emailed.
     */
    | 'payment';

export interface ExpectedQuickBooksLine {
    role: 'bundle' | 'share' | 'tax';
    itemId: string;
    /** The account the tenant's mapped item must post to — re-proven on every read (items are editable in QuickBooks). */
    accountId: string;
    description: string;
    /** Quantity in hundredths (FreezerIQ stores DECIMAL(10,2)). */
    qtyHundredths: number;
    unitPriceCents: number;
    amountCents: number;
}

export interface ExpectedQuickBooksInvoice {
    customerId: string;
    txnDate: string;
    termId: string;
    dueDate: string;
    lines: ExpectedQuickBooksLine[];
    /** Required exactly when set (the tax-exempt memo); otherwise not checked. */
    memo: string | null;
    preTaxCents: number;
    taxCents: number;
    shareCents: number;
    totalCents: number;
}

export interface ExpectedDelivery {
    billEmail: string | null;
    billEmailCc: string | null;
    payment: QuickBooksPaymentFlags;
    /** The QuickBooks invoice id and DocNumber recorded at create; later reads must not differ. */
    qboInvoiceId?: string;
    docNumber?: string;
    /** 'sent': when FreezerIQ asked QuickBooks to send (or to apply the payment options that caused an auto-send). */
    sendRequestedAt?: Date;
}

export interface ContractFailure {
    check: string;
    expected?: unknown;
    actual?: unknown;
}

export interface ContractResult {
    ok: boolean;
    failures: ContractFailure[];
    /** Present when QuickBooks reports a delivery problem. Not a contract failure: SENT means "QuickBooks sent it". */
    deliveryErrorType: string | null;
}

/** Tolerated clock difference between FreezerIQ and Intuit when comparing a DeliveryTime with the send request. */
export const DELIVERY_CLOCK_SKEW_MS = 2 * 60 * 1000;

const cents = (n: number | null): number | null => (n === null ? null : Math.round(n * 100));
/** True when a QuickBooks decimal is a whole number of cents (UnitPrice can carry up to 7 decimals). */
const wholeCents = (n: number | null): boolean => n !== null && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** YYYY-MM-DD plus N days, on calendar dates (no time zone involved). */
export function addDaysToDate(date: string, days: number): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m || !Number.isInteger(days) || days < 0) throw new Error('invalid date arithmetic');
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
    return d.toISOString().slice(0, 10);
}

export function verifyQuickBooksInvoice(
    inv: QuickBooksInvoiceSnapshot,
    expected: ExpectedQuickBooksInvoice,
    delivery: ExpectedDelivery,
    stage: ContractStage,
): ContractResult {
    const failures: ContractFailure[] = [];
    const check = (name: string, ok: boolean, exp?: unknown, act?: unknown) => {
        if (!ok) failures.push({ check: name, expected: exp, actual: act });
    };

    // ── identity / header ──
    check('qbo_invoice_id', /^[0-9]{1,32}$/.test(inv.id) && (delivery.qboInvoiceId === undefined || inv.id === delivery.qboInvoiceId), delivery.qboInvoiceId, inv.id);
    check('doc_number_present', typeof inv.docNumber === 'string' && inv.docNumber.trim().length > 0, 'QuickBooks-assigned', inv.docNumber);
    if (delivery.docNumber !== undefined) check('doc_number_unchanged', inv.docNumber === delivery.docNumber, delivery.docNumber, inv.docNumber);
    check('customer', inv.customerId === expected.customerId, expected.customerId, inv.customerId);
    check('currency_usd', inv.currency === 'USD', 'USD', inv.currency);
    check('txn_date', inv.txnDate === expected.txnDate, expected.txnDate, inv.txnDate);
    check('terms', inv.termId === expected.termId, expected.termId, inv.termId);
    check('due_date', inv.dueDate === expected.dueDate, expected.dueDate, inv.dueDate);
    if (expected.memo !== null) check('memo', inv.customerMemo === expected.memo, expected.memo, inv.customerMemo);

    // ── lines: only item lines plus QuickBooks' own subtotal line ──
    const sales = inv.lines.filter((l) => l.detailType === 'SalesItemLineDetail');
    const unexpected = inv.lines.filter((l) => l.detailType !== 'SalesItemLineDetail' && l.detailType !== 'SubTotalLineDetail');
    check('no_unexpected_line_types', unexpected.length === 0, [], unexpected.map((l) => l.detailType));
    check('line_count', sales.length === expected.lines.length, expected.lines.length, sales.length);
    expected.lines.forEach((e, i) => {
        const a = sales[i];
        const at = `line_${i + 1}_${e.role}`;
        if (!a) { failures.push({ check: `${at}_missing` }); return; }
        check(`${at}_item`, a.itemId === e.itemId, e.itemId, a.itemId);
        check(`${at}_posting_account`, a.itemAccountId === e.accountId, e.accountId, a.itemAccountId);
        check(`${at}_description`, a.description === e.description, e.description, a.description);
        check(`${at}_qty`, a.qty !== null && Math.abs(a.qty * 100 - e.qtyHundredths) < 1e-6, e.qtyHundredths / 100, a.qty);
        check(`${at}_unit_price`, wholeCents(a.unitPrice) && cents(a.unitPrice) === e.unitPriceCents, e.unitPriceCents / 100, a.unitPrice);
        check(`${at}_amount`, wholeCents(a.amount) && cents(a.amount) === e.amountCents, e.amountCents / 100, a.amount);
        check(`${at}_non_taxable`, a.taxCode === 'NON', 'NON', a.taxCode);
    });

    // ── money: each FreezerIQ component, then the invariant ──
    const byRole = (role: ExpectedQuickBooksLine['role']) => expected.lines
        .map((e, i) => ({ e, a: sales[i] }))
        .filter((x) => x.e.role === role)
        .reduce((s, x) => s + (cents(x.a?.amount ?? null) ?? 0), 0);
    check('bundle_sales_equal_pre_tax_sales', byRole('bundle') === expected.preTaxCents, expected.preTaxCents / 100, byRole('bundle') / 100);
    check('tax_line_equals_frozen_tax', byRole('tax') === expected.taxCents, expected.taxCents / 100, byRole('tax') / 100);
    check('share_line_equals_negative_share', byRole('share') === -expected.shareCents, -expected.shareCents / 100, byRole('share') / 100);
    check('no_quickbooks_tax', (inv.totalTax === null || cents(inv.totalTax) === 0) && inv.taxLineCount === 0 && inv.txnTaxCodeId === null, 0,
        { totalTax: inv.totalTax, taxLines: inv.taxLineCount, taxCode: inv.txnTaxCodeId });
    check('total_equals_freezeriq_total', wholeCents(inv.totalAmt) && cents(inv.totalAmt) === expected.totalCents, expected.totalCents / 100, inv.totalAmt);
    if (stage !== 'payment') {
        check('balance_unpaid', wholeCents(inv.balance) && cents(inv.balance) === expected.totalCents, expected.totalCents / 100, inv.balance);
    }
    const lineSum = sales.reduce((s, l) => s + (cents(l.amount) ?? 0), 0);
    check('lines_sum_to_total', lineSum === cents(inv.totalAmt), cents(inv.totalAmt), lineSum);

    // ── delivery safety ──
    const flags = inv.payment;
    const flagsEqual = (want: QuickBooksPaymentFlags) => flags.card === want.card && flags.ach === want.ach && flags.paypal === want.paypal && flags.affirm === want.affirm;
    const unsent = () => {
        check('email_status_not_set', inv.emailStatus === 'NotSet', 'NotSet', inv.emailStatus);
        check('no_delivery_info', inv.delivery === null, null, inv.delivery);
        check('no_einvoice_status', inv.eInvoiceStatus === null, null, inv.eInvoiceStatus);
    };
    const recipients = () => {
        check('recipient', inv.billEmail === delivery.billEmail, delivery.billEmail, inv.billEmail);
        check('cc', inv.billEmailCc === delivery.billEmailCc, delivery.billEmailCc, inv.billEmailCc);
        check('no_bcc', inv.billEmailBcc === null, null, inv.billEmailBcc);
    };
    const allOff = { card: false, ach: false, paypal: false, affirm: false };

    if (stage === 'created') {
        unsent();
        check('no_recipient_at_create', inv.billEmail === null, null, inv.billEmail);
        check('no_cc_at_create', inv.billEmailCc === null, null, inv.billEmailCc);
        check('no_bcc', inv.billEmailBcc === null, null, inv.billEmailBcc);
        check('payment_flags_all_false', flagsEqual(allOff), allOff, flags);
    } else if (stage === 'recipients') {
        unsent();
        recipients();
        check('payment_flags_all_false', flagsEqual(allOff), allOff, flags);
    } else if (stage === 'payment_options') {
        unsent();
        recipients();
        check('payment_flags_match_tenant_options', flagsEqual(delivery.payment), delivery.payment, flags);
    } else if (stage === 'sent' || stage === 'resend_recipients') {
        recipients();
        check('payment_flags_match_tenant_options', flagsEqual(delivery.payment), delivery.payment, flags);
        check('email_status_sent', inv.emailStatus === 'EmailSent', 'EmailSent', inv.emailStatus);
        check('delivery_type_email', inv.delivery?.type === 'Email', 'Email', inv.delivery?.type ?? null);
        // The delivery TIME is required at 'sent' only. Updating an already-emailed invoice makes QuickBooks drop
        // DeliveryInfo.DeliveryTime while keeping EmailStatus, DeliveryType and any DeliveryErrorType, so between a
        // re-send's recipient update and its Send there is legitimately no time to check. Nothing is weakened: the
        // Send that follows must stamp a fresh one, and because the update cleared it the old time cannot stand in.
        if (stage === 'sent') {
            const time = Date.parse(inv.delivery?.time ?? '');
            check('delivery_time_present', Number.isFinite(time), 'a time', inv.delivery?.time ?? null);
            if (delivery.sendRequestedAt) {
                check('delivery_time_not_before_request', Number.isFinite(time) && time >= delivery.sendRequestedAt.getTime() - DELIVERY_CLOCK_SKEW_MS,
                    delivery.sendRequestedAt.toISOString(), inv.delivery?.time ?? null);
            }
        }
    }

    return { ok: failures.length === 0, failures, deliveryErrorType: inv.delivery?.errorType ?? null };
}
