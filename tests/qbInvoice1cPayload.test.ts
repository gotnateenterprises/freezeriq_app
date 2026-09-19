/**
 * QB-INVOICE-1C — the QuickBooks invoice FreezerIQ builds (lib/quickbooks/invoicePayload.ts). Pure.
 *
 * FreezerIQ owns every number: the plan copies the stored invoice's lines, share and frozen tax exactly, refuses
 * anything that does not reconcile to the cent, and never derives tax from a rate.
 */

import { planQuickBooksInvoice, toHundredths, formatPercent, bundleLineDescription, TAX_EXEMPT_MEMO, type InvoiceForQuickBooks, type InvoiceMapping } from '@/lib/quickbooks/invoicePayload';
import { assertUnsentInvoiceCreateBody } from '@/lib/quickbooks/intuitClient';

const MAPPING: InvoiceMapping = {
    salesItemId: '11', salesAccountId: '79', shareItemId: '12', shareAccountId: '80', taxItemId: '13', taxAccountId: '81', termId: '2', termDueDays: 15,
};

/** The owner's rounding fixture (1C accounting spike E2). */
const E2: InvoiceForQuickBooks = {
    id: 'inv-e2', campaignId: 'camp-1', totalAmount: '451.59', taxAmount: '5.59', taxRatePercent: '1.00', taxStatus: 'TAXABLE',
    shareAmount: '111.50', sharePercent: '20.00',
    items: [
        { id: 'b', description: 'Date Night (Serves 2)', variantSize: 'serves_2', quantity: '2.00', unitPrice: '60.00', total: '120.00' },
        { id: 'a', description: 'Family Friendly', variantSize: 'serves_5', quantity: '7.00', unitPrice: '62.50', total: '437.50' },
    ],
};

const plan = (over: Partial<InvoiceForQuickBooks> = {}, mapping: Partial<InvoiceMapping> = {}) =>
    planQuickBooksInvoice({ invoice: { ...E2, ...over }, mapping: { ...MAPPING, ...mapping }, qboCustomerId: '58', txnDate: '2026-09-15' });

describe('QB-INVOICE-1C · the rounding fixture: $557.50 + $5.59 − $111.50 = $451.59', () => {
    it('bundle lines pre-tax at the stored qty × price on the one sales item, a negative share line, and the exact frozen tax', () => {
        const p = plan();
        if (!p.ok) throw new Error(p.problem);
        expect(p.body.Line.map((l) => [l.Description, l.SalesItemLineDetail.ItemRef.value, l.SalesItemLineDetail.Qty, l.SalesItemLineDetail.UnitPrice, l.Amount, l.SalesItemLineDetail.TaxCodeRef.value])).toEqual([
            ['Family Friendly — Serves 5', '11', 7, 62.5, 437.5, 'NON'],
            ['Date Night (Serves 2)', '11', 2, 60, 120, 'NON'],
            ['Organization fundraiser share — 20%', '12', 1, -111.5, -111.5, 'NON'],
            ['Sales tax collected from supporters — 1%', '13', 1, 5.59, 5.59, 'NON'],
        ]);
        const cents = p.body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
        expect(cents).toBe(45159);
        expect(p.expected).toMatchObject({ preTaxCents: 55750, shareCents: 11150, taxCents: 559, totalCents: 45159, dueDate: '2026-09-30', txnDate: '2026-09-15', customerId: '58', termId: '2', memo: null });
        expect(p.expected.lines.map((l) => l.accountId)).toEqual(['79', '79', '80', '81']);
    });

    it('the tax line is the stored tax — never rebuilt from the rate (1% of $557.50 would be $5.58)', () => {
        const p = plan();
        if (!p.ok) throw new Error(p.problem);
        expect(p.expected.taxCents).toBe(559);
        expect(Math.round(557.5 * 0.01 * 100)).not.toBe(559);
    });

    it('a one-cent drift anywhere is refused', () => {
        expect(plan({ totalAmount: '451.60' })).toEqual({ ok: false, problem: 'invoice_does_not_reconcile' });
        expect(plan({ taxAmount: '5.58' })).toEqual({ ok: false, problem: 'invoice_does_not_reconcile' });
        expect(plan({ shareAmount: '111.49' })).toEqual({ ok: false, problem: 'invoice_does_not_reconcile' });
        expect(plan({ items: [{ ...E2.items[1], total: '437.51' }, E2.items[0]] })).toEqual({ ok: false, problem: 'line_does_not_reconcile' });
    });

    it('the body is the send-safe create: no recipient, NotSet, all four flags false, no DocNumber, only NON item lines', () => {
        const p = plan();
        if (!p.ok) throw new Error(p.problem);
        expect(() => assertUnsentInvoiceCreateBody(p.body)).not.toThrow();
        expect(p.body).toMatchObject({ EmailStatus: 'NotSet', AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false });
        for (const k of ['BillEmail', 'BillEmailCc', 'BillEmailBcc', 'DocNumber', 'TxnTaxDetail', 'NeedToSend', 'DueDate', 'TotalAmt']) expect(p.body).not.toHaveProperty(k);
    });
});

describe('QB-INVOICE-1C · content rules', () => {
    it('tax omitted when zero; a TAX_EXEMPT invoice carries the memo and may not carry tax', () => {
        const exempt = plan({ taxAmount: '0.00', taxStatus: 'TAX_EXEMPT', totalAmount: '446.00' });
        if (!exempt.ok) throw new Error(exempt.problem);
        expect(exempt.body.Line.some((l) => l.Description.startsWith('Sales tax'))).toBe(false);
        expect(exempt.body.CustomerMemo).toEqual({ value: TAX_EXEMPT_MEMO });
        expect(exempt.expected.memo).toBe('Tax exempt — documentation on file.');
        expect(plan({ taxStatus: 'TAX_EXEMPT' })).toEqual({ ok: false, problem: 'tax_status_conflict' });
    });

    it('share omitted when zero; share and tax need their mapped items', () => {
        const noShare = plan({ shareAmount: '0.00', totalAmount: '563.09' }, { shareItemId: null, shareAccountId: null });
        expect(noShare.ok && noShare.body.Line.map((l) => l.Description)).toEqual(['Family Friendly — Serves 5', 'Date Night (Serves 2)', 'Sales tax collected from supporters — 1%']);
        expect(plan({}, { shareItemId: null, shareAccountId: null })).toEqual({ ok: false, problem: 'share_item_not_configured' });
        expect(plan({}, { taxItemId: null, taxAccountId: null })).toEqual({ ok: false, problem: 'tax_item_not_configured' });
    });

    it('only fundraiser invoices, with lines, a positive total and readable money', () => {
        expect(plan({ campaignId: null })).toEqual({ ok: false, problem: 'not_campaign_invoice' });
        expect(plan({ items: [] })).toEqual({ ok: false, problem: 'no_lines' });
        expect(plan({ totalAmount: '0.00', items: [{ ...E2.items[0], quantity: '1.00', unitPrice: '0.00', total: '0.00' }], shareAmount: '0.00', taxAmount: '0.00' })).toEqual({ ok: false, problem: 'total_not_positive' });
        expect(plan({ totalAmount: 'NaN' })).toEqual({ ok: false, problem: 'money_invalid' });
        expect(plan({ shareAmount: '-1.00' })).toEqual({ ok: false, problem: 'money_invalid' });
        expect(planQuickBooksInvoice({ invoice: E2, mapping: MAPPING, qboCustomerId: '58', txnDate: '15/09/2026' })).toEqual({ ok: false, problem: 'date_invalid' });
    });

    it('the order is deterministic: largest line first, then description, then id', () => {
        const p = plan({ items: [...E2.items].reverse() });
        const q = plan();
        expect(p.ok && q.ok && JSON.stringify(p.body)).toBe(q.ok && JSON.stringify(q.body));
    });

    it('exact decimal parsing, percent formatting and size labels', () => {
        expect(toHundredths('437.50')).toBe(43750);
        expect(toHundredths('62.500')).toBe(6250);
        expect(toHundredths(5.59)).toBe(559);
        expect(toHundredths('1e3')).toBeNull();
        expect(formatPercent('20.00')).toBe('20');
        expect(formatPercent('1.50')).toBe('1.5');
        expect(bundleLineDescription('Family Friendly', 'serves_5')).toBe('Family Friendly — Serves 5');
        expect(bundleLineDescription('Date Night (Serves 2)', 'serves_2')).toBe('Date Night (Serves 2)');
        expect(bundleLineDescription('Manual line', null)).toBe('Manual line');
    });
});
