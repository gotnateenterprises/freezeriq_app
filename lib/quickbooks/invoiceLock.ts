/**
 * QB-INVOICE-1C — what a QuickBooks invoice changes about the FreezerIQ invoice it copies.
 *
 * From the moment "Send via QuickBooks" reserves an invoice's QuickBooks link, QuickBooks holds (or is about to
 * hold) a copy of that invoice's customer, lines and amounts under its own number. FreezerIQ then refuses every
 * ordinary action that would make the two disagree without anyone noticing:
 *   - deleting the invoice (the database refuses too: the link and the lifecycle reference it);
 *   - re-pointing it at another organization, or changing its status, through the generic editor;
 *   - emailing a FreezerIQ copy, which would reach the organization under a different number;
 *   - editing the lines, amounts, organization share or tax that QuickBooks copied. INV-C already froze those on a
 *     fundraiser invoice, but freezing them silently answers 200 to a request that asked to change them, so an
 *     invoice QuickBooks holds refuses it instead and writes nothing at all.
 * Correcting an invoice after QuickBooks has it needs a future void/repair workflow; nothing here edits QuickBooks.
 * Recording a payment (INV-D) is unaffected, and so are due date, payment method and the other editable fields.
 *
 * Pure: routes select QUICKBOOKS_LINK_SELECT with the invoice they already read.
 */

export const QUICKBOOKS_LINK_SELECT = { quickbooks_invoice_links: { select: { id: true } } } as const;

export function hasQuickBooksInvoice(row: unknown): boolean {
    const links = (row as { quickbooks_invoice_links?: unknown } | null | undefined)?.quickbooks_invoice_links;
    return Array.isArray(links) && links.length > 0;
}

export const QUICKBOOKS_INVOICE_LOCK_MESSAGES = {
    delete: 'This invoice has a QuickBooks invoice, so it cannot be deleted. QuickBooks keeps its copy.',
    edit: 'This invoice has a QuickBooks invoice. Its organization and status cannot be changed by editing, so FreezerIQ and QuickBooks stay in agreement.',
    email: 'This invoice is sent through QuickBooks. Use Send via QuickBooks, so the organization receives one invoice with one number.',
    money: 'This invoice has a QuickBooks invoice. Its lines, amounts, organization share and tax cannot be changed by editing, so FreezerIQ and QuickBooks keep the same numbers. Nothing was changed.',
} as const;

/** The invoice's frozen financial facts, as the route already reads them. */
export interface LockedInvoiceMoney {
    total_amount?: unknown;
    tax_amount?: unknown;
    tax_rate_percent?: unknown;
    taxable_base_amount?: unknown;
    tax_status?: unknown;
    fundraiser_profit_amount?: unknown;
    fundraiser_profit_percent?: unknown;
    items?: Array<{ description?: unknown; quantity?: unknown; unit_price?: unknown; total?: unknown }> | null;
}

/** Money is compared as integer cents (quantities as hundredths), so "451.59", 451.59 and Decimal all agree. */
const hundredths = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const lineSignature = (l: { description?: unknown; quantity?: unknown; unit_price?: unknown; total?: unknown }) =>
    [String(l.description ?? ''), hundredths(l.quantity), hundredths(l.unit_price), hundredths(l.total)].join('|');
const lines = (list: LockedInvoiceMoney['items']) => (Array.isArray(list) ? list.map(lineSignature).sort() : null);

/**
 * QB-INVOICE-1C: the financial fact an edit is trying to change on an invoice QuickBooks holds, or null when the
 * request leaves every one of them as it is. A field the request omits (or sends empty) is not an attempt to
 * change it — the generic editor has always meant "leave it alone" by omission, and due date, payment method and
 * the other presentation fields stay editable. Money is FreezerIQ's, frozen at closeout by INV-C and copied into
 * QuickBooks at send: rather than silently preserving the stored values, the route refuses the request outright.
 */
export function lockedFinancialEdit(persisted: LockedInvoiceMoney, body: Record<string, unknown>): string | null {
    const money: Array<[string, unknown, unknown]> = [
        ['total_amount', body.total_amount, persisted.total_amount],
        ['tax_amount', body.tax_amount, persisted.tax_amount],
        ['tax_rate_percent', body.tax_rate_percent, persisted.tax_rate_percent],
        ['taxable_base_amount', body.taxable_base_amount, persisted.taxable_base_amount],
        ['fundraiser_profit_amount', body.fundraiser_profit_amount, persisted.fundraiser_profit_amount],
        ['fundraiser_profit_percent', body.fundraiser_profit_percent, persisted.fundraiser_profit_percent],
    ];
    for (const [field, sent, stored] of money) {
        const asked = hundredths(sent);
        if (asked !== null && asked !== hundredths(stored)) return field;
    }
    if (typeof body.tax_status === 'string' && body.tax_status !== persisted.tax_status) return 'tax_status';
    const sentLines = lines(body.items as LockedInvoiceMoney['items']);
    const storedLines = lines(persisted.items);
    // Only comparable when the invoice's own lines were read; an omitted `items` is never an attempt to change them.
    if (sentLines && storedLines && (sentLines.length !== storedLines.length || sentLines.some((l, i) => l !== storedLines[i]))) return 'items';
    return null;
}
