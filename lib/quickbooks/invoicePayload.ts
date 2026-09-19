/**
 * QB-INVOICE-1C — turn one FreezerIQ fundraiser invoice into the exact QuickBooks invoice to create, and
 * into the expectation its read-back must meet (lib/quickbooks/invoiceContract.ts). Pure: no I/O.
 *
 * OWNER-LOCKED CONTENT (1C accounting spike, accepted 2026-09-15):
 *   - BUNDLE LINES: one line per stored FreezerIQ invoice line, at its PRE-TAX quantity x unit price,
 *     on the tenant's one generic fundraiser sales item, described with the bundle name and size, and
 *     explicitly NON-taxable. Never one QuickBooks item per bundle.
 *   - SUPPORTER TAX: one ordinary NON-taxable line carrying Invoice.tax_amount EXACTLY — the tax frozen
 *     per supporter order and summed at closeout. Never QuickBooks sales tax (no TxnTaxDetail), never
 *     rebuilt from a rate or from tax-inclusive unit prices (the $62.50 @ 1% fixture drifts by 1-2 cents
 *     that way). Omitted when the tax is zero. A TAX_EXEMPT invoice carries the memo instead.
 *   - ORGANIZATION SHARE: one visible NEGATIVE line carrying Invoice.fundraiser_profit_amount exactly,
 *     on the tenant's share item. It is a line of its own and never reduces the tax line.
 *   - The create is always UNSENT: no recipient, EmailStatus NotSet, all four online-payment flags
 *     false, no DocNumber (QuickBooks assigns it). lib/quickbooks/intuitClient.ts refuses anything else.
 *
 * HARD GATE: the plan is refused unless the stored invoice reconciles to the cent —
 *   each line: quantity x unit price == line total (QuickBooks rejects a mismatch, error 6070);
 *   invoice:   sum(bundle lines) - share + tax == total_amount.
 * So QuickBooks' TotalAmt can only equal Invoice.total_amount if QuickBooks keeps what it is given, and
 * the read-back contract proves that it did.
 */

import type { QuickBooksInvoiceCreateBody } from '@/lib/quickbooks/intuitClient';
import { addDaysToDate, type ExpectedQuickBooksInvoice, type ExpectedQuickBooksLine } from '@/lib/quickbooks/invoiceContract';

export const TAX_EXEMPT_MEMO = 'Tax exempt — documentation on file.';
/** Well inside QuickBooks' documented line limits; a fundraiser invoice has one line per bundle and size. */
export const MAX_QUICKBOOKS_INVOICE_LINES = 500;

export type InvoicePlanProblem =
    | 'not_campaign_invoice'
    | 'no_lines'
    | 'too_many_lines'
    | 'total_not_positive'
    | 'money_invalid'
    | 'line_does_not_reconcile'
    | 'invoice_does_not_reconcile'
    | 'tax_status_conflict'
    | 'share_item_not_configured'
    | 'tax_item_not_configured'
    | 'description_invalid'
    | 'date_invalid';

export interface InvoiceItemForQuickBooks {
    id: string;
    description: string;
    variantSize: string | null;
    quantity: unknown;
    unitPrice: unknown;
    total: unknown;
}

export interface InvoiceForQuickBooks {
    id: string;
    campaignId: string | null;
    totalAmount: unknown;
    taxAmount: unknown;
    taxRatePercent: unknown;
    taxStatus: string | null;
    shareAmount: unknown;
    sharePercent: unknown;
    items: InvoiceItemForQuickBooks[];
}

/** The tenant's verified QuickBooks invoice settings (lib/quickbooks/invoiceSettings.ts). */
export interface InvoiceMapping {
    salesItemId: string;
    salesAccountId: string;
    shareItemId: string | null;
    shareAccountId: string | null;
    taxItemId: string | null;
    taxAccountId: string | null;
    termId: string;
    termDueDays: number;
}

export type InvoicePlan =
    | { ok: true; body: QuickBooksInvoiceCreateBody; expected: ExpectedQuickBooksInvoice }
    | { ok: false; problem: InvoicePlanProblem };

/**
 * Exact hundredths from a DECIMAL(10,2)-shaped value (Prisma Decimal, string or number), or null.
 * Strings are parsed digit by digit, so "437.50" is 43750 with no floating-point step.
 */
export function toHundredths(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(2) : '') : String(value).trim();
    const m = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
    if (!m) {
        // A Decimal can print more places ("62.500"); accept only when the extra places are zeros.
        const x = /^(-)?(\d{1,12})\.(\d{2})0+$/.exec(s);
        if (!x) return null;
        return (x[1] ? -1 : 1) * (Number(x[2]) * 100 + Number(x[3]));
    }
    const frac = (m[3] ?? '').padEnd(2, '0');
    return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(frac));
}

/** 20.00 -> "20", 1.50 -> "1.5". */
export function formatPercent(value: unknown): string | null {
    const h = toHundredths(value);
    if (h === null || h <= 0) return null;
    return String(Number((h / 100).toFixed(2)));
}

const SIZE_LABEL: Record<string, string> = { serves_2: 'Serves 2', serves_5: 'Serves 5' };

/** "Family Friendly" + serves_5 -> "Family Friendly — Serves 5"; a name that already states its size is kept. */
export function bundleLineDescription(description: string, variantSize: string | null): string {
    const name = (description ?? '').trim();
    const label = variantSize ? SIZE_LABEL[variantSize] ?? null : null;
    if (!label) return name;
    return name.toLowerCase().includes(label.toLowerCase()) ? name : `${name} — ${label}`;
}

const money = (hundredths: number) => hundredths / 100;

export function planQuickBooksInvoice(input: {
    invoice: InvoiceForQuickBooks;
    mapping: InvoiceMapping;
    qboCustomerId: string;
    /** The tenant-local calendar date the invoice is sent (YYYY-MM-DD). */
    txnDate: string;
}): InvoicePlan {
    const { invoice, mapping } = input;
    const refuse = (problem: InvoicePlanProblem): InvoicePlan => ({ ok: false, problem });

    if (!invoice.campaignId) return refuse('not_campaign_invoice');
    if (!Array.isArray(invoice.items) || invoice.items.length === 0) return refuse('no_lines');
    if (invoice.items.length + 2 > MAX_QUICKBOOKS_INVOICE_LINES) return refuse('too_many_lines');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.txnDate)) return refuse('date_invalid');

    const total = toHundredths(invoice.totalAmount);
    const tax = toHundredths(invoice.taxAmount ?? 0);
    const share = toHundredths(invoice.shareAmount ?? 0);
    if (total === null || tax === null || share === null) return refuse('money_invalid');
    if (tax < 0 || share < 0) return refuse('money_invalid');
    if (total <= 0) return refuse('total_not_positive');
    if (invoice.taxStatus === 'TAX_EXEMPT' && tax !== 0) return refuse('tax_status_conflict');
    if (share > 0 && (!mapping.shareItemId || !mapping.shareAccountId)) return refuse('share_item_not_configured');
    if (tax > 0 && (!mapping.taxItemId || !mapping.taxAccountId)) return refuse('tax_item_not_configured');

    // Largest line first, then name, then id: the order closeout wrote, made deterministic.
    const items = invoice.items.map((it) => ({
        it,
        qty: toHundredths(it.quantity),
        unit: toHundredths(it.unitPrice),
        lineTotal: toHundredths(it.total),
        description: bundleLineDescription(it.description, it.variantSize),
    }));
    for (const x of items) {
        if (x.qty === null || x.unit === null || x.lineTotal === null || x.qty <= 0 || x.unit < 0 || x.lineTotal < 0) return refuse('money_invalid');
        // qty (hundredths) x unit (cents) is in 1/100 cents; it must be a whole cent AND the stored total.
        if ((x.qty * x.unit) % 100 !== 0 || (x.qty * x.unit) / 100 !== x.lineTotal) return refuse('line_does_not_reconcile');
        if (!x.description || x.description.length > 4000) return refuse('description_invalid');
    }
    items.sort((a, b) => (b.lineTotal! - a.lineTotal!) || a.description.localeCompare(b.description) || a.it.id.localeCompare(b.it.id));

    const preTax = items.reduce((s, x) => s + x.lineTotal!, 0);
    if (preTax - share + tax !== total) return refuse('invoice_does_not_reconcile');

    const expectedLines: ExpectedQuickBooksLine[] = items.map((x) => ({
        role: 'bundle', itemId: mapping.salesItemId, accountId: mapping.salesAccountId,
        description: x.description, qtyHundredths: x.qty!, unitPriceCents: x.unit!, amountCents: x.lineTotal!,
    }));
    if (share > 0) {
        const pct = formatPercent(invoice.sharePercent);
        expectedLines.push({
            role: 'share', itemId: mapping.shareItemId!, accountId: mapping.shareAccountId!,
            description: pct ? `Organization fundraiser share — ${pct}%` : 'Organization fundraiser share',
            qtyHundredths: 100, unitPriceCents: -share, amountCents: -share,
        });
    }
    if (tax > 0) {
        const rate = formatPercent(invoice.taxRatePercent);
        expectedLines.push({
            role: 'tax', itemId: mapping.taxItemId!, accountId: mapping.taxAccountId!,
            description: rate ? `Sales tax collected from supporters — ${rate}%` : 'Sales tax collected from supporters',
            qtyHundredths: 100, unitPriceCents: tax, amountCents: tax,
        });
    }

    const memo = invoice.taxStatus === 'TAX_EXEMPT' ? TAX_EXEMPT_MEMO : null;
    const body: QuickBooksInvoiceCreateBody = {
        CustomerRef: { value: input.qboCustomerId },
        TxnDate: input.txnDate,
        SalesTermRef: { value: mapping.termId },
        PrivateNote: `FreezerIQ fundraiser invoice ${invoice.id}`,
        ...(memo ? { CustomerMemo: { value: memo } } : {}),
        EmailStatus: 'NotSet',
        AllowOnlineCreditCardPayment: false,
        AllowOnlineACHPayment: false,
        AllowOnlinePayPalPayment: false,
        AllowOnlineAffirmPayment: false,
        Line: expectedLines.map((l) => ({
            DetailType: 'SalesItemLineDetail' as const,
            Amount: money(l.amountCents),
            Description: l.description,
            SalesItemLineDetail: {
                ItemRef: { value: l.itemId },
                Qty: l.qtyHundredths / 100,
                UnitPrice: money(l.unitPriceCents),
                TaxCodeRef: { value: 'NON' as const },
            },
        })),
    };

    let dueDate: string;
    try {
        dueDate = addDaysToDate(input.txnDate, mapping.termDueDays);
    } catch {
        return refuse('date_invalid');
    }

    return {
        ok: true,
        body,
        expected: {
            customerId: input.qboCustomerId,
            txnDate: input.txnDate,
            termId: mapping.termId,
            dueDate,
            lines: expectedLines,
            memo,
            preTaxCents: preTax,
            taxCents: tax,
            shareCents: share,
            totalCents: total,
        },
    };
}
