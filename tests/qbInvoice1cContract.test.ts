/**
 * QB-INVOICE-1C — the read-back contract (lib/quickbooks/invoiceContract.ts). Pure.
 *
 * A QuickBooks invoice passes only if QuickBooks kept exactly what FreezerIQ sent — and, at each stage, provably
 * nothing more: unsent with no recipient after create; exact recipients with every payment flag still false; the
 * tenant's options and still unsent before Send; EmailSent with an email DeliveryInfo no older than the request
 * after it. Every mutation below is something QuickBooks can do (or did, in the 1C spikes).
 */

import { parseQuickBooksInvoice, type QuickBooksPaymentFlags } from '@/lib/quickbooks/intuitClient';
import { addDaysToDate, DELIVERY_CLOCK_SKEW_MS, verifyQuickBooksInvoice, type ContractStage } from '@/lib/quickbooks/invoiceContract';
import { planQuickBooksInvoice, type InvoiceMapping } from '@/lib/quickbooks/invoicePayload';

const MAPPING: InvoiceMapping = { salesItemId: '11', salesAccountId: '79', shareItemId: '12', shareAccountId: '80', taxItemId: '13', taxAccountId: '81', termId: '2', termDueDays: 15 };
const planned = planQuickBooksInvoice({
    invoice: {
        id: 'inv-e2', campaignId: 'camp-1', totalAmount: '451.59', taxAmount: '5.59', taxRatePercent: '1.00', taxStatus: 'TAXABLE', shareAmount: '111.50', sharePercent: '20.00',
        items: [
            { id: 'a', description: 'Family Friendly', variantSize: 'serves_5', quantity: '7.00', unitPrice: '62.50', total: '437.50' },
            { id: 'b', description: 'Date Night (Serves 2)', variantSize: 'serves_2', quantity: '2.00', unitPrice: '60.00', total: '120.00' },
        ],
    },
    mapping: MAPPING, qboCustomerId: '58', txnDate: '2026-09-15',
});
if (!planned.ok) throw new Error('fixture does not plan');
const EXPECTED = planned.expected;
const ACCOUNT_OF: Record<string, string> = { 11: '79', 12: '80', 13: '81' };
const OFF: QuickBooksPaymentFlags = { card: false, ach: false, paypal: false, affirm: false };
const REQUESTED = new Date('2026-09-15T19:00:00Z');

/** The invoice as QuickBooks reads it back straight after FreezerIQ's create (shape observed in the sandbox). */
function created(): any {
    return {
        Id: '130', SyncToken: '0', DocNumber: '1052', TxnDate: '2026-09-15', DueDate: '2026-09-30',
        CustomerRef: { value: '58', name: 'Lincoln PTA' }, CurrencyRef: { value: 'USD', name: 'United States Dollar' }, SalesTermRef: { value: '2' },
        EmailStatus: 'NotSet', PrintStatus: 'NeedToPrint', TxnTaxDetail: { TotalTax: 0 },
        AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
        Line: [
            ...planned.ok ? planned.body.Line.map((l, i) => ({
                Id: String(i + 1), LineNum: i + 1, Description: l.Description, Amount: l.Amount, DetailType: 'SalesItemLineDetail',
                SalesItemLineDetail: { ItemRef: { value: l.SalesItemLineDetail.ItemRef.value }, ItemAccountRef: { value: ACCOUNT_OF[l.SalesItemLineDetail.ItemRef.value] }, UnitPrice: l.SalesItemLineDetail.UnitPrice, Qty: l.SalesItemLineDetail.Qty, TaxCodeRef: { value: 'NON' } },
            })) : [],
            { Amount: 451.59, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
        ],
        TotalAmt: 451.59, Balance: 451.59,
    };
}
const withRecipients = (raw: any, to = 'coordinator@lincoln-pta.example', cc: string | null = null) => ({ ...raw, SyncToken: '1', BillEmail: { Address: to }, ...(cc ? { BillEmailCc: { Address: cc } } : {}) });
const emailed = (raw: any, at = '2026-09-15T19:00:30Z') => ({ ...raw, EmailStatus: 'EmailSent', DeliveryInfo: { DeliveryType: 'Email', DeliveryTime: at } });
/** What QuickBooks leaves behind when FreezerIQ updates an invoice it has already emailed: no DeliveryTime. */
function updatedAfterSend(to = 'fixed@lincoln-pta.example'): any {
    const raw = emailed(withRecipients(created(), to));
    raw.SyncToken = '2';
    delete raw.DeliveryInfo.DeliveryTime;
    return raw;
}

function check(raw: any, stage: ContractStage, delivery: Partial<{ billEmail: string | null; billEmailCc: string | null; payment: QuickBooksPaymentFlags; docNumber: string; qboInvoiceId: string; sendRequestedAt: Date }> = {}) {
    const inv = parseQuickBooksInvoice(raw);
    if (!inv) throw new Error('unparseable fixture');
    return verifyQuickBooksInvoice(inv, EXPECTED, {
        billEmail: stage === 'created' ? null : 'coordinator@lincoln-pta.example', billEmailCc: null, payment: OFF, qboInvoiceId: '130', ...delivery,
    }, stage);
}
const failed = (r: ReturnType<typeof check>) => r.failures.map((f) => f.check);

describe('QB-INVOICE-1C · read-back contract: the accepted invoice passes every stage', () => {
    it('created → recipients → payment options → sent', () => {
        expect(check(created(), 'created')).toEqual({ ok: true, failures: [], deliveryErrorType: null });
        expect(check(withRecipients(created()), 'recipients')).toMatchObject({ ok: true });
        const withOptions = { ...withRecipients(created()), AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true };
        expect(check(withOptions, 'payment_options', { payment: { card: true, ach: true, paypal: false, affirm: false } })).toMatchObject({ ok: true });
        expect(check(emailed(withOptions), 'sent', { payment: { card: true, ach: true, paypal: false, affirm: false }, sendRequestedAt: REQUESTED, docNumber: '1052' })).toMatchObject({ ok: true });
    });

    it('a delivery problem is reported, not a contract failure — SENT means QuickBooks sent it', () => {
        const raw = emailed(withRecipients(created()));
        raw.DeliveryInfo.DeliveryErrorType = 'Undeliverable';
        expect(check(raw, 'sent', { sendRequestedAt: REQUESTED })).toEqual({ ok: true, failures: [], deliveryErrorType: 'Undeliverable' });
    });
});

describe('QB-INVOICE-1C · read-back contract: money and tax', () => {
    it('one-cent drift in TotalAmt, a line amount, or the balance is rejected', () => {
        expect(failed(check({ ...created(), TotalAmt: 451.6 }, 'created'))).toEqual(expect.arrayContaining(['total_equals_freezeriq_total', 'lines_sum_to_total']));
        const line = created();
        line.Line[3].Amount = 5.6;
        expect(failed(check(line, 'created'))).toEqual(expect.arrayContaining(['line_4_tax_amount', 'tax_line_equals_frozen_tax']));
        expect(failed(check({ ...created(), Balance: 0 }, 'created'))).toEqual(['balance_unpaid']);
    });

    /**
     * QuickBooks AUTOMATED SALES TAX. A company with sales tax switched on (Illinois Department of Revenue, custom
     * rates Tax Exempt 0% and Food 1%, in the Production company this was proven against) stamps its own tax detail
     * onto every invoice — a transaction tax code, and in some companies a zero-value tax line — even when FreezerIQ
     * sends none and every line is NON. The fixtures below are those zero-tax metadata patterns, not a captured
     * Production payload: tax code only, zero tax line only, and both, in the TaxLine shape the Intuit Accounting
     * API documents (Amount + TaxLineDetail.TaxRateRef).
     *
     * The invariant is that QuickBooks' own tax did not change the money — NOT that QuickBooks holds no tax
     * metadata. FreezerIQ stays authoritative for fundraiser tax and carries it as its own line, which the
     * surrounding checks keep proving to the cent.
     */
    it('zero-value Automated Sales Tax metadata passes; tax that is worth money does not', () => {
        const withTax = (TxnTaxDetail: unknown) => failed(check({ ...created(), TxnTaxDetail }, 'created'));
        const AST_LINE = { Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '5' }, PercentBased: true, TaxPercent: 1, NetAmountTaxable: 0 } };

        // 1 · no tax block at all (a legacy-sales-tax company)          2 · a stated zero total, no tax lines
        expect(withTax(undefined)).toEqual([]);
        expect(withTax({ TotalTax: 0 })).toEqual([]);
        // 3 · zero total + the transaction tax code Automated Sales Tax attaches
        expect(withTax({ TotalTax: 0, TxnTaxCodeRef: { value: '7' } })).toEqual([]);
        // 4 · zero total + one zero-value automated tax line            5 · several of them
        expect(withTax({ TotalTax: 0, TaxLine: [AST_LINE] })).toEqual([]);
        expect(withTax({ TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [AST_LINE, { ...AST_LINE, Amount: 0 }] })).toEqual([]);
        // 6 · tax that is worth money                                   7 · a zero total contradicted by a tax line
        expect(withTax({ TotalTax: 5.59 })).toEqual(['quickbooks_tax_did_not_affect_total']);
        expect(withTax({ TotalTax: 0, TaxLine: [{ ...AST_LINE, Amount: 0.01 }] })).toEqual(['quickbooks_tax_did_not_affect_total']);
        // 8 · native tax that moved the total: the tax check AND the total/line-sum checks all refuse it
        expect(failed(check({ ...created(), TxnTaxDetail: { TotalTax: 5.59, TaxLine: [{ Amount: 5.59 }] }, TotalAmt: 457.18 }, 'created')))
            .toEqual(['quickbooks_tax_did_not_affect_total', 'total_equals_freezeriq_total', 'lines_sum_to_total']);
        // 9 · the whole Production-equivalent shape: every sales line NON, zero-value automated tax metadata
        const ast = { ...created(), TxnTaxDetail: { TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [AST_LINE] } };
        expect(ast.Line.filter((l: any) => l.SalesItemLineDetail).every((l: any) => l.SalesItemLineDetail.TaxCodeRef.value === 'NON')).toBe(true);
        expect(check(ast, 'created')).toEqual({ ok: true, failures: [], deliveryErrorType: null });
        // 10 · FreezerIQ's OWN supporter-tax line stays governed by the mapping — one cent off is still refused
        const drifted = { ...ast, Line: created().Line };
        drifted.Line[3] = { ...drifted.Line[3], Amount: 5.6 };
        expect(failed(check(drifted, 'created'))).toEqual(expect.arrayContaining(['line_4_tax_amount', 'tax_line_equals_frozen_tax']));
        // 12 · tax detail that cannot be read is never read as "no tax"
        expect(withTax('nope')).toEqual(['quickbooks_tax_did_not_affect_total']);
        expect(withTax({ TotalTax: '0' })).toEqual(['quickbooks_tax_did_not_affect_total']);
        expect(withTax({ TotalTax: 0, TaxLine: { Amount: 0 } })).toEqual(['quickbooks_tax_did_not_affect_total']);
        expect(withTax({ TotalTax: 0, TaxLine: [{ Amount: '0' }] })).toEqual(['quickbooks_tax_did_not_affect_total']);
        expect(withTax({ TotalTax: 0.004 })).toEqual(['quickbooks_tax_did_not_affect_total']);
    });

    /** 11 · a tax-exempt organization: FreezerIQ sends no tax line at all, and the company's tax code is still zero. */
    it('a $0 tax-exempt invoice passes with the same zero-value automated tax metadata', () => {
        const exempt = planQuickBooksInvoice({
            invoice: {
                id: 'inv-x', campaignId: 'camp-1', totalAmount: '340.00', taxAmount: '0.00', taxRatePercent: '0.00', taxStatus: 'EXEMPT', shareAmount: '85.00', sharePercent: '20.00',
                items: [{ id: 'a', description: 'Family Friendly', variantSize: 'serves_5', quantity: '4.00', unitPrice: '106.25', total: '425.00' }],
            },
            mapping: MAPPING, qboCustomerId: '58', txnDate: '2026-09-15',
        });
        if (!exempt.ok) throw new Error('fixture does not plan');
        expect(exempt.expected.taxCents).toBe(0);
        expect(exempt.body.Line).toHaveLength(2); // one bundle line, one negative share line — no tax line
        const raw = {
            Id: '131', SyncToken: '0', DocNumber: '1053', TxnDate: '2026-09-15', DueDate: '2026-09-30',
            CustomerRef: { value: '58' }, CurrencyRef: { value: 'USD' }, SalesTermRef: { value: '2' }, EmailStatus: 'NotSet',
            TxnTaxDetail: { TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [{ Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '6' }, NetAmountTaxable: 0 } }] },
            AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
            Line: [
                ...exempt.body.Line.map((l, i) => ({
                    Id: String(i + 1), Description: l.Description, Amount: l.Amount, DetailType: 'SalesItemLineDetail',
                    SalesItemLineDetail: {
                        ItemRef: { value: l.SalesItemLineDetail.ItemRef.value }, ItemAccountRef: { value: ACCOUNT_OF[l.SalesItemLineDetail.ItemRef.value] },
                        UnitPrice: l.SalesItemLineDetail.UnitPrice, Qty: l.SalesItemLineDetail.Qty, TaxCodeRef: { value: 'NON' },
                    },
                })),
                { Amount: 340, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} },
            ],
            TotalAmt: 340, Balance: 340,
        };
        const inv = parseQuickBooksInvoice(raw);
        expect(verifyQuickBooksInvoice(inv!, exempt.expected, { billEmail: null, billEmailCc: null, payment: OFF, qboInvoiceId: '131' }, 'created'))
            .toEqual({ ok: true, failures: [], deliveryErrorType: null });
    });

    it('an unexpected taxable line, a re-pointed ItemAccountRef, another item, description or quantity is rejected', () => {
        const taxable = created(); taxable.Line[0].SalesItemLineDetail.TaxCodeRef.value = 'TAX';
        expect(failed(check(taxable, 'created'))).toEqual(['line_1_bundle_non_taxable']);
        const repointed = created(); repointed.Line[2].SalesItemLineDetail.ItemAccountRef.value = '99';
        expect(failed(check(repointed, 'created'))).toEqual(['line_3_share_posting_account']);
        const item = created(); item.Line[1].SalesItemLineDetail.ItemRef.value = '14';
        expect(failed(check(item, 'created'))).toEqual(expect.arrayContaining(['line_2_bundle_item']));
        const text = created(); text.Line[0].Description = 'Family Friendly';
        expect(failed(check(text, 'created'))).toEqual(['line_1_bundle_description']);
        const qty = created(); qty.Line[0].SalesItemLineDetail.Qty = 7.5;
        expect(failed(check(qty, 'created'))).toEqual(['line_1_bundle_qty']);
        const price = created(); price.Line[0].SalesItemLineDetail.UnitPrice = 62.5000001;
        expect(failed(check(price, 'created'))).toEqual(['line_1_bundle_unit_price']);
    });

    it('a missing, extra or discount line is rejected', () => {
        const missing = created(); missing.Line.splice(3, 1); missing.TotalAmt = 446; missing.Balance = 446;
        expect(failed(check(missing, 'created'))).toEqual(expect.arrayContaining(['line_count', 'line_4_tax_missing']));
        const discount = created(); discount.Line.splice(4, 0, { Amount: 1, DetailType: 'DiscountLineDetail', DiscountLineDetail: {} });
        expect(failed(check(discount, 'created'))).toEqual(['no_unexpected_line_types']);
    });

    it('the header: customer, USD, date, terms, due date, DocNumber present and unchanged', () => {
        expect(failed(check({ ...created(), CustomerRef: { value: '59' } }, 'created'))).toEqual(['customer']);
        expect(failed(check({ ...created(), CurrencyRef: { value: 'CAD' } }, 'created'))).toEqual(['currency_usd']);
        expect(failed(check({ ...created(), TxnDate: '2026-09-16', DueDate: '2026-10-01' }, 'created'))).toEqual(['txn_date', 'due_date']);
        expect(failed(check({ ...created(), SalesTermRef: { value: '3' } }, 'created'))).toEqual(['terms']);
        const noDoc = created(); delete noDoc.DocNumber;
        expect(failed(check(noDoc, 'created'))).toEqual(['doc_number_present']);
        expect(failed(check({ ...withRecipients(created()), DocNumber: '1053' }, 'recipients', { docNumber: '1052' }))).toEqual(['doc_number_unchanged']);
        expect(failed(check({ ...created(), Id: '131' }, 'created'))).toEqual(['qbo_invoice_id']);
        expect(addDaysToDate('2026-12-20', 15)).toBe('2027-01-04');
    });
});

describe('QB-INVOICE-1C · read-back contract: delivery safety at each stage', () => {
    it('created: unsent, no recipient/CC/BCC, all four flags false', () => {
        expect(failed(check(withRecipients(created()), 'created'))).toEqual(['no_recipient_at_create']);
        expect(failed(check({ ...created(), BillEmailCc: { Address: 'bookkeeper@example.invalid' } }, 'created'))).toEqual(['no_cc_at_create']);
        expect(failed(check({ ...created(), BillEmailBcc: { Address: 'hidden@example.invalid' } }, 'created'))).toEqual(['no_bcc']);
        for (const flag of ['AllowOnlineCreditCardPayment', 'AllowOnlineACHPayment', 'AllowOnlinePayPalPayment', 'AllowOnlineAffirmPayment']) {
            expect(failed(check({ ...created(), [flag]: true }, 'created'))).toEqual(['payment_flags_all_false']);
        }
        const omitted = created(); delete omitted.AllowOnlinePayPalPayment; // an absent flag is not "false"
        expect(failed(check(omitted, 'created'))).toEqual(['payment_flags_all_false']);
        expect(failed(check(emailed(created()), 'created'))).toEqual(['email_status_not_set', 'no_delivery_info']);
        expect(failed(check({ ...created(), EInvoiceStatus: 'Sent' }, 'created'))).toEqual(['no_einvoice_status']);
    });

    it('recipients: exact recipient and CC, no BCC, still unsent, flags still all false (a partial update re-defaults them)', () => {
        expect(failed(check(withRecipients(created(), 'other@example.invalid'), 'recipients'))).toEqual(['recipient']);
        expect(failed(check(withRecipients(created(), 'coordinator@lincoln-pta.example', 'cc@example.invalid'), 'recipients'))).toEqual(['cc']);
        expect(failed(check({ ...withRecipients(created()), BillEmailBcc: { Address: 'hidden@example.invalid' } }, 'recipients'))).toEqual(['no_bcc']);
        expect(failed(check({ ...withRecipients(created()), AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true }, 'recipients'))).toEqual(['payment_flags_all_false']);
        expect(failed(check(emailed(withRecipients(created())), 'recipients'))).toEqual(['email_status_not_set', 'no_delivery_info']);
    });

    it('payment options: the tenant’s flags exactly, still unsent', () => {
        const raw = { ...withRecipients(created()), AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true, AllowOnlinePayPalPayment: true };
        expect(failed(check(raw, 'payment_options', { payment: { card: true, ach: true, paypal: false, affirm: false } }))).toEqual(['payment_flags_match_tenant_options']);
    });

    it('sent: EmailSent, email delivery, a delivery time no older than the request, exact recipients, flags unchanged', () => {
        const base = withRecipients(created());
        expect(failed(check(base, 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['email_status_sent', 'delivery_type_email', 'delivery_time_present', 'delivery_time_not_before_request']);
        expect(failed(check({ ...emailed(base), DeliveryInfo: { DeliveryType: 'Print', DeliveryTime: '2026-09-15T19:00:30Z' } }, 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['delivery_type_email']);
        const stale = new Date(REQUESTED.getTime() - DELIVERY_CLOCK_SKEW_MS - 60_000).toISOString();
        expect(failed(check(emailed(base, stale), 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['delivery_time_not_before_request']);
        expect(failed(check(emailed(base, 'yesterday'), 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['delivery_time_present', 'delivery_time_not_before_request']);
        expect(failed(check(emailed(withRecipients(created(), 'other@example.invalid')), 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['recipient']);
        expect(failed(check({ ...emailed(base), AllowOnlineCreditCardPayment: true }, 'sent', { sendRequestedAt: REQUESTED }))).toEqual(['payment_flags_match_tenant_options']);
    });

    it('resend_recipients: the delivery time QuickBooks removes when it updates a sent invoice is not required — and cannot pass as a send', () => {
        const at = { billEmail: 'fixed@lincoln-pta.example', docNumber: '1052' };
        expect(check(updatedAfterSend(), 'resend_recipients', at)).toEqual({ ok: true, failures: [], deliveryErrorType: null });
        // The same read is NOT a sent invoice: the send must stamp a fresh time, and the cleared one cannot stand in.
        expect(failed(check(updatedAfterSend(), 'sent', { ...at, sendRequestedAt: REQUESTED }))).toEqual(['delivery_time_present', 'delivery_time_not_before_request']);
        // The first send is unchanged: a delivery time is still required there, and still may not predate the request.
        expect(failed(check(withRecipients(created()), 'sent', { sendRequestedAt: REQUESTED })))
            .toEqual(['email_status_sent', 'delivery_type_email', 'delivery_time_present', 'delivery_time_not_before_request']);
        // The delivery error that survived the update is still reported, not a failure.
        const stillFailing = updatedAfterSend(); stillFailing.DeliveryInfo.DeliveryErrorType = 'Undeliverable';
        expect(check(stillFailing, 'resend_recipients', at)).toEqual({ ok: true, failures: [], deliveryErrorType: 'Undeliverable' });
    });

    it('resend_recipients rejects everything else exactly as before: identity, money, posting account, recipients, flags, delivery', () => {
        const at = { billEmail: 'fixed@lincoln-pta.example', docNumber: '1052' };
        const bad = (raw: any, over: Parameters<typeof check>[2] = {}) => failed(check(raw, 'resend_recipients', { ...at, ...over }));
        expect(bad({ ...updatedAfterSend(), Id: '999' })).toEqual(['qbo_invoice_id']);
        expect(bad({ ...updatedAfterSend(), DocNumber: '1099' })).toEqual(['doc_number_unchanged']);
        expect(bad({ ...updatedAfterSend(), CustomerRef: { value: '77' } })).toEqual(['customer']);
        expect(bad({ ...updatedAfterSend(), TotalAmt: 451.6 })).toEqual(expect.arrayContaining(['total_equals_freezeriq_total', 'lines_sum_to_total']));
        expect(bad({ ...updatedAfterSend(), Balance: 0 })).toEqual(['balance_unpaid']);
        expect(bad({ ...updatedAfterSend(), TxnTaxDetail: { TotalTax: 5.59 } })).toEqual(['quickbooks_tax_did_not_affect_total']);
        const amount = updatedAfterSend(); amount.Line[1].Amount = 119.99;
        expect(bad(amount)).toEqual(expect.arrayContaining(['line_2_bundle_amount', 'bundle_sales_equal_pre_tax_sales']));
        const repointed = updatedAfterSend(); repointed.Line[2].SalesItemLineDetail.ItemAccountRef.value = '99';
        expect(bad(repointed)).toEqual(['line_3_share_posting_account']);
        const item = updatedAfterSend(); item.Line[0].SalesItemLineDetail.ItemRef.value = '12';
        expect(bad(item)).toEqual(['line_1_bundle_item']);
        const qty = updatedAfterSend(); qty.Line[0].SalesItemLineDetail.Qty = 8;
        expect(bad(qty)).toEqual(expect.arrayContaining(['line_1_bundle_qty']));
        expect(bad(updatedAfterSend(), { billEmail: 'someone-else@example.invalid' })).toEqual(['recipient']);
        expect(bad(updatedAfterSend(), { billEmailCc: 'treasurer@lincoln-pta.example' })).toEqual(['cc']);
        expect(bad({ ...updatedAfterSend(), BillEmailBcc: { Address: 'hidden@example.invalid' } })).toEqual(['no_bcc']);
        expect(bad({ ...updatedAfterSend(), AllowOnlineCreditCardPayment: true })).toEqual(['payment_flags_match_tenant_options']);
        expect(bad({ ...updatedAfterSend(), EmailStatus: 'NotSet' })).toEqual(['email_status_sent']);
        expect(bad({ ...updatedAfterSend(), DeliveryInfo: { DeliveryType: 'Print' } })).toEqual(['delivery_type_email']);
        expect(bad({ ...updatedAfterSend(), DeliveryInfo: undefined })).toEqual(['delivery_type_email']);
    });
});
