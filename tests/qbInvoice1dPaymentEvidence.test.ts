/**
 * QB-INVOICE-1D — the payment-evidence rules, pure, over QuickBooks responses copied FIELD FOR FIELD from the real
 * Intuit sandbox shape spike (2026-09-21; the raw evidence is kept outside the repository). Only the ids are renumbered
 * (synthetic: invoice 7001, customers 901/902, payments 8001–8009, credit memo 8102) and the notes rewritten; no field
 * was added that Intuit does not return, and none that it does return was dropped.
 *
 * The spike established the one fact this whole phase turns on: a credit memo applied to an invoice leaves Balance 0
 * and ONE linked "Payment" on the invoice — exactly what a real payment looks like from the invoice. Only the Payment
 * object itself (TotalAmt 0, a CreditMemo line) tells them apart. These tests pin that the rules read the Payment.
 */

import {
    classifyInvoicePaymentState,
    quickBooksPaymentReference,
    verifyPaymentEvidence,
} from '@/lib/quickbooks/invoicePayment';
import { parseLinkedTxns, parseQuickBooksPayment } from '@/lib/quickbooks/intuitClient';
import {
    isVerifiedSettlement,
    isVerifiedSettlementMethod,
    SETTLEMENT_PAYMENT_METHODS,
    settlementMethodLabel,
    validateSettlement,
    VERIFIED_SETTLEMENT_METHODS,
} from '@/lib/invoiceSettlement';

const NOW = new Date('2026-09-21T18:00:00Z');
const INVOICE = '7001';
const CUSTOMER = '901';
const TOTAL = 10000; // $100.00, in cents

// ── raw payments, exactly as Intuit returned them (minorversion 75) ─────────
const line = (amount: number, txnId: string, txnType: string) => ({ Amount: amount, LinkedTxn: [{ TxnId: txnId, TxnType: txnType }], LineEx: { any: [] } });
const rawPayment = (over: Record<string, unknown> = {}) => ({
    CustomerRef: { value: CUSTOMER, name: 'FreezerIQ Test Customer' },
    DepositToAccountRef: { value: '4' },
    TotalAmt: 100,
    UnappliedAmt: 0,
    ProcessPayment: false,
    domain: 'QBO',
    sparse: false,
    Id: '8001',
    SyncToken: '0',
    MetaData: { CreateTime: '2026-09-21T10:12:03-07:00', LastUpdatedTime: '2026-09-21T10:12:03-07:00' },
    TxnDate: '2026-09-21',
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    PrivateNote: 'test payment',
    Line: [line(100, INVOICE, 'Invoice')],
    ...over,
});

/** Spike scenario E — the one shape 1D may settle. */
const CLEAN = rawPayment();
/** Spike scenario B — a credit memo applied: TotalAmt 0, the Invoice line AND a CreditMemo line. No DepositToAccountRef. */
const CREDIT_MEMO_APPLICATION = (() => {
    const p: any = rawPayment({ Id: '8002', TotalAmt: 0, Line: [line(100, INVOICE, 'Invoice'), line(100, '8102', 'CreditMemo')] });
    delete p.DepositToAccountRef;
    return p;
})();
/** Spike scenario C — overpayment: $150 received, $100 applied, $50 unapplied. */
const OVERPAYMENT = rawPayment({ Id: '8003', TotalAmt: 150, UnappliedAmt: 50 });
/** Spike scenario D — voided: TotalAmt 0, Line [], note prefixed "Voided - ". */
const VOIDED = rawPayment({ Id: '8004', TotalAmt: 0, UnappliedAmt: 0, Line: [], PrivateNote: 'Voided - test payment' });
/** Spike scenario A — a $40 partial payment. */
const PARTIAL = rawPayment({ Id: '8005', TotalAmt: 40, Line: [line(40, INVOICE, 'Invoice')] });

const evidence = (raw: any, over: Partial<Parameters<typeof verifyPaymentEvidence>[1]> = {}) =>
    verifyPaymentEvidence(parseQuickBooksPayment(raw)!, { paymentId: raw.Id, qboInvoiceId: INVOICE, customerId: CUSTOMER, totalCents: TOTAL, now: NOW, ...over });

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · parsing Intuit responses (allowlist, fail closed)', () => {
    it('parses a real Payment into exactly the evidence fields — no note, no card data, no deposit account', () => {
        expect(parseQuickBooksPayment(CLEAN)).toEqual({
            id: '8001', txnDate: '2026-09-21', customerId: CUSTOMER, currency: 'USD', totalAmt: 100, unappliedAmt: 0,
            lines: [{ amount: 100, linked: [{ txnId: INVOICE, txnType: 'Invoice' }] }],
        });
        expect(JSON.stringify(parseQuickBooksPayment(CLEAN))).not.toMatch(/test payment|DepositToAccount|LineEx|FreezerIQ Test Customer/);
    });

    it('reads a voided payment as zero with no lines, and a credit application as two lines', () => {
        expect(parseQuickBooksPayment(VOIDED)).toMatchObject({ totalAmt: 0, lines: [] });
        expect(parseQuickBooksPayment(CREDIT_MEMO_APPLICATION)!.lines.map((l) => l.linked![0].txnType)).toEqual(['Invoice', 'CreditMemo']);
    });

    it('refuses what is not a Payment: no Id, a non-numeric Id, a Line that is not an array', () => {
        expect(parseQuickBooksPayment({ ...CLEAN, Id: undefined })).toBeNull();
        expect(parseQuickBooksPayment({ ...CLEAN, Id: 'abc' })).toBeNull();
        expect(parseQuickBooksPayment({ ...CLEAN, Line: {} })).toBeNull();
        expect(parseQuickBooksPayment(null)).toBeNull();
    });

    it('LinkedTxn: the empty array an unpaid invoice returns, a payment link, and null for anything malformed', () => {
        expect(parseLinkedTxns([])).toEqual([]);
        expect(parseLinkedTxns([{ TxnId: '8001', TxnType: 'Payment' }])).toEqual([{ txnId: '8001', txnType: 'Payment' }]);
        expect(parseLinkedTxns(undefined)).toBeNull();
        expect(parseLinkedTxns({ TxnId: '8001', TxnType: 'Payment' })).toBeNull();
        expect(parseLinkedTxns([{ TxnId: '8001' }])).toBeNull();
        expect(parseLinkedTxns([{ TxnId: 'x', TxnType: 'Payment' }])).toBeNull();
        expect(parseLinkedTxns([{ TxnId: '1', TxnType: 'Pay ment' }])).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · the invoice balance earns, at most, the right to read ONE payment', () => {
    const classify = (balance: number | null, links: any) => classifyInvoicePaymentState({ balance, totalCents: TOTAL, linkedTxns: parseLinkedTxns(links) });

    it('14. Balance = TotalAmt → unpaid', () => {
        expect(classify(100, [])).toEqual({ kind: 'unpaid' });
    });

    it('15. a partial Balance → partially paid, never settled (spike A: $60 left after $40)', () => {
        expect(classify(60, [{ TxnId: '8005', TxnType: 'Payment' }])).toEqual({ kind: 'partially_paid', balanceCents: 6000 });
    });

    it('16. Balance = 0 with NO payment linked → no payment evidence (a write-off or adjustment looks like this)', () => {
        expect(classify(0, [])).toEqual({ kind: 'review', reason: 'no_payment_evidence' });
    });

    it('18. Balance = 0 with any non-Payment link → unsupported, never settled', () => {
        for (const type of ['CreditMemo', 'JournalEntry', 'ReimburseCharge', 'StatementCharge', 'Estimate']) {
            expect(classify(0, [{ TxnId: '9', TxnType: type }])).toEqual({ kind: 'review', reason: 'unsupported_linked_transaction' });
            expect(classify(0, [{ TxnId: '8001', TxnType: 'Payment' }, { TxnId: '9', TxnType: type }])).toEqual({ kind: 'review', reason: 'unsupported_linked_transaction' });
        }
    });

    it('22. two payments → multiple payments, never settled in 1D (spike A after the second payment)', () => {
        expect(classify(0, [{ TxnId: '8005', TxnType: 'Payment' }, { TxnId: '8006', TxnType: 'Payment' }])).toEqual({ kind: 'review', reason: 'multiple_payments' });
    });

    it('exactly one Payment link on a zero balance → read THAT payment (and nothing else)', () => {
        expect(classify(0, [{ TxnId: '8001', TxnType: 'Payment' }])).toEqual({ kind: 'verify_payment', paymentId: '8001' });
        // The same payment listed twice is still one payment.
        expect(classify(0, [{ TxnId: '8001', TxnType: 'Payment' }, { TxnId: '8001', TxnType: 'Payment' }])).toEqual({ kind: 'verify_payment', paymentId: '8001' });
    });

    it('17. the credit-memo trap: Balance 0 and ONE linked Payment gets as far as reading it — and no further (see below)', () => {
        // Exactly what spike B returned on the INVOICE: indistinguishable from a real payment at this level.
        expect(classify(0, [{ TxnId: '8002', TxnType: 'Payment' }])).toEqual({ kind: 'verify_payment', paymentId: '8002' });
        expect(evidence(CREDIT_MEMO_APPLICATION)).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
    });

    it('a balance that is negative, above the total, not whole cents, or missing is inconsistent', () => {
        for (const b of [-0.01, 100.01, 50.005, null, Number.NaN]) expect(classify(b as any, [])).toEqual({ kind: 'review', reason: 'balance_inconsistent' });
    });

    it('unreadable links on a zero balance are never read as "one payment"', () => {
        expect(classify(0, undefined)).toEqual({ kind: 'review', reason: 'payment_evidence_unreadable' });
        expect(classify(0, [{ TxnId: 'x', TxnType: 'Payment' }])).toEqual({ kind: 'review', reason: 'payment_evidence_unreadable' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · the ONE payment must, by itself, prove exactly this invoice was paid in full', () => {
    it('23. one exact full Payment (spike E) is evidence, dated by its own TxnDate', () => {
        expect(evidence(CLEAN)).toEqual({ ok: true, paidOn: '2026-09-21' });
    });

    it('17. a credit memo application is not money: TotalAmt 0 and a CreditMemo line (spike B)', () => {
        expect(evidence(CREDIT_MEMO_APPLICATION)).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
        // Even if the credit line were somehow alone, a CreditMemo is not this invoice.
        expect(evidence(rawPayment({ Line: [line(100, '8102', 'CreditMemo')] }))).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
    });

    it('21. more received than invoiced (spike C overpayment) → never settled', () => {
        expect(evidence(OVERPAYMENT)).toEqual({ ok: false, reason: 'payment_unapplied_amount' });
        // TotalAmt above the total with nothing reported unapplied is still wrong.
        expect(evidence(rawPayment({ TotalAmt: 150, UnappliedAmt: 0 }))).toEqual({ ok: false, reason: 'payment_amount_mismatch' });
    });

    it('20. a partial allocation (spike A $40) → never settled, even if a balance somehow read 0', () => {
        expect(evidence(PARTIAL)).toEqual({ ok: false, reason: 'payment_amount_mismatch' });
        // Received in full but only part applied here.
        expect(evidence(rawPayment({ Line: [line(40, INVOICE, 'Invoice')] }))).toEqual({ ok: false, reason: 'payment_amount_mismatch' });
    });

    it('a voided payment (spike D) → never settled', () => {
        expect(evidence(VOIDED)).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
    });

    it('19. a payment for ANOTHER invoice → never settled', () => {
        expect(evidence(rawPayment({ Line: [line(100, '999', 'Invoice')] }))).toEqual({ ok: false, reason: 'payment_not_for_this_invoice' });
        expect(evidence(CLEAN, { paymentId: '8009' })).toEqual({ ok: false, reason: 'payment_not_for_this_invoice' });
    });

    it('one payment spread over this invoice AND another → never settled', () => {
        expect(evidence(rawPayment({ TotalAmt: 150, Line: [line(100, INVOICE, 'Invoice'), line(50, '999', 'Invoice')] }))).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
        // Two links on one line.
        expect(evidence(rawPayment({ Line: [{ Amount: 100, LinkedTxn: [{ TxnId: INVOICE, TxnType: 'Invoice' }, { TxnId: '999', TxnType: 'Invoice' }] }] }))).toEqual({ ok: false, reason: 'payment_includes_other_transactions' });
    });

    it('another customer’s payment, or not USD → never settled', () => {
        expect(evidence(rawPayment({ CustomerRef: { value: '902' } }))).toEqual({ ok: false, reason: 'payment_customer_mismatch' });
        expect(evidence(rawPayment({ CurrencyRef: { value: 'CAD' } }))).toEqual({ ok: false, reason: 'payment_currency_mismatch' });
        expect(evidence(rawPayment({ CurrencyRef: undefined }))).toEqual({ ok: false, reason: 'payment_currency_mismatch' });
    });

    it('an unusable date → never settled: missing, malformed, impossible, too old, or in the future', () => {
        for (const TxnDate of [undefined, '09/21/2026', '2026-02-30', '2019-12-31', '2026-09-23']) {
            expect(evidence(rawPayment({ TxnDate }))).toEqual({ ok: false, reason: 'payment_date_invalid' });
        }
        // One day of slack for time zones, exactly like Record Payment.
        expect(evidence(rawPayment({ TxnDate: '2026-09-22' }))).toEqual({ ok: true, paidOn: '2026-09-22' });
    });

    it('integer cents, never float equality: $451.59 matches 45159 exactly; $451.585 is not a payment', () => {
        const e = (total: number, amount: number) => verifyPaymentEvidence(parseQuickBooksPayment(rawPayment({ TotalAmt: amount, Line: [line(amount, INVOICE, 'Invoice')] }))!,
            { paymentId: '8001', qboInvoiceId: INVOICE, customerId: CUSTOMER, totalCents: total, now: NOW });
        expect(e(45159, 451.59)).toEqual({ ok: true, paidOn: '2026-09-21' });
        expect(e(45159, 451.585)).toEqual({ ok: false, reason: 'payment_amount_mismatch' });
        expect(e(30, 0.1 + 0.2)).toEqual({ ok: true, paidOn: '2026-09-21' }); // 0.30000000000000004 is 30 cents
    });

    it('the processing fee is irrelevant: the payment is the invoice total, whatever QuickBooks deposits', () => {
        // Nothing in a Payment carries the fee (Intuit records it on the deposit), and nothing here subtracts one.
        expect(evidence(rawPayment({ TotalAmt: 100 }))).toEqual({ ok: true, paidOn: '2026-09-21' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · the settlement method contract', () => {
    it('Record Payment still offers exactly Square and Check — a human can never CLAIM "QuickBooks"', () => {
        expect(SETTLEMENT_PAYMENT_METHODS).toEqual(['square', 'check']);
        const claim = validateSettlement({ method: 'quickbooks', paidAt: '2026-09-21', reference: 'x' }, NOW);
        expect(claim.ok).toBe(false);
    });

    it('`quickbooks` is a VERIFIED method, labelled "QuickBooks Payments"', () => {
        expect(VERIFIED_SETTLEMENT_METHODS).toEqual(['quickbooks']);
        expect(isVerifiedSettlementMethod('quickbooks')).toBe(true);
        expect(isVerifiedSettlementMethod('check')).toBe(false);
        expect(settlementMethodLabel('quickbooks')).toBe('QuickBooks Payments');
        expect(settlementMethodLabel('check')).toBe('Check');
        expect(settlementMethodLabel('square')).toBe('Square');
        expect(settlementMethodLabel(null)).toBeNull();
    });

    it('a verified settlement is recognised only when PAID with a payment date', () => {
        const paid = { status: 'PAID', paid_at: new Date('2026-09-21T12:00:00Z'), payment_method: 'quickbooks' };
        expect(isVerifiedSettlement(paid)).toBe(true);
        expect(isVerifiedSettlement({ ...paid, status: 'SENT' })).toBe(false);
        expect(isVerifiedSettlement({ ...paid, paid_at: null })).toBe(false);
        expect(isVerifiedSettlement({ ...paid, payment_method: 'check' })).toBe(false);
    });

    it('25. the stored reference is the QuickBooks Payment Id and invoice number — no token, realm or payload', () => {
        expect(quickBooksPaymentReference('8001', '2001')).toBe('QuickBooks payment 8001 · invoice #2001');
        expect(quickBooksPaymentReference('8001', null)).toBe('QuickBooks payment 8001');
        expect(quickBooksPaymentReference('9'.repeat(32), 'X'.repeat(32)).length).toBeLessThanOrEqual(100);
    });
});
