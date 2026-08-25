/**
 * INV-C — the review surface: DRAFT/SENT presentation, and protecting INV-B's
 * frozen totals from the generic invoice editor.
 *
 * TWO SEPARATE CONCERNS
 *
 * 1. PRESENTATION. The invoices page's status union predated DRAFT and SENT, so
 *    a generated fundraiser invoice fell through the badge's final else-branch
 *    and rendered rose — the OVERDUE treatment. A brand-new invoice awaiting
 *    review looked like a problem. SENT must also be visually distinct from
 *    PAID, because sending is not payment.
 *
 * 2. EDIT SAFETY. PUT /api/tenant/invoices deletes and recreates `items` from
 *    the request body and re-prices them through resolveInvoiceItems. For a
 *    campaign-linked invoice that is a live hazard rather than a theoretical
 *    one: INV-B froze those lines against the campaign's settlement_total inside
 *    the campaign lock, and "Mark as Paid" round-trips the entire invoice through
 *    this endpoint — so a bundle price changed after closeout would silently
 *    rewrite a historical invoice nobody meant to edit.
 */

const calls: Array<{ op: string; args?: any }> = [];
let persistedInvoice: any;

jest.mock('@/lib/db', () => ({
    prisma: {
        invoice: {
            findFirst: async (args: any) => { calls.push({ op: 'invoice.findFirst', args }); return persistedInvoice; },
            update: async (args: any) => { calls.push({ op: 'invoice.update', args }); return { ...args.data, id: args.where.id, items: [], order: null, customer: {} }; },
        },
        invoiceItem: {
            deleteMany: async (args: any) => { calls.push({ op: 'invoiceItem.deleteMany', args }); return { count: 0 }; },
        },
        customer: {
            findUnique: async () => ({ business_id: 'biz-a' }),
        },
        order: { update: async () => ({}), create: async () => ({}) },
        orderItem: { deleteMany: async () => ({ count: 0 }) },
        $transaction: async (fn: any) => fn({
            invoice: {
                update: async (args: any) => { calls.push({ op: 'invoice.update', args }); return { ...args.data, id: args.where.id, items: [], order: null, customer: {} }; },
            },
            invoiceItem: {
                deleteMany: async (args: any) => { calls.push({ op: 'invoiceItem.deleteMany', args }); return { count: 0 }; },
            },
            order: { update: async () => ({}), create: async () => ({}) },
            orderItem: { deleteMany: async () => ({ count: 0 }) },
        }),
    },
}));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

jest.mock('@/lib/pricing', () => ({
    buildBundlePriceMap: async () => ({}),
    findInactiveBundleNames: async () => [],
}));

import {
    sumOutstandingInvoices,
    isOutstandingInvoiceStatus,
    OUTSTANDING_INVOICE_STATUSES,
} from '@/lib/invoiceSendTruth';

const read = (p: string): string =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

/** Executable code only — a comment describing the fix must not satisfy a test. */
const code = (p: string): string =>
    read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');

const PAGE = 'app/invoices/page.tsx';

// ═══════════════════════════════════════════════════════════════════════════
// PRESENTATION
// ═══════════════════════════════════════════════════════════════════════════

describe('DRAFT and SENT render intentionally', () => {
    it('the status union includes DRAFT and SENT', () => {
        const c = code(PAGE);
        expect(c).toMatch(/status:\s*'DRAFT' \| 'SENT' \| 'PENDING' \| 'PAID' \| 'OVERDUE' \| 'CANCELED';/);
    });

    it('DRAFT is neutral slate — not the rose used for OVERDUE', () => {
        const c = code(PAGE);
        expect(c).toMatch(/inv\.status === 'DRAFT' \? 'bg-slate-200 text-slate-600/);
    });

    it('SENT is indigo, visually distinct from the emerald used for PAID', () => {
        const c = code(PAGE);
        expect(c).toMatch(/inv\.status === 'SENT' \? 'bg-indigo-100 text-indigo-600'/);
        expect(c).toMatch(/inv\.status === 'PAID' \? 'bg-emerald-100 text-emerald-600'/);
        // The two must not share a class, or SENT would read as payment received.
        const sent = c.match(/inv\.status === 'SENT' \? '([^']+)'/)?.[1];
        const paid = c.match(/inv\.status === 'PAID' \? '([^']+)'/)?.[1];
        expect(sent).toBeTruthy();
        expect(sent).not.toBe(paid);
        expect(sent).not.toMatch(/emerald/);
    });

    it('DRAFT and SENT are filterable', () => {
        const c = code(PAGE);
        expect(c).toMatch(/\['ALL', 'DRAFT', 'SENT', 'PENDING', 'PAID', 'OVERDUE'\]/);
    });

    it('neither DRAFT nor SENT is counted as paid revenue', () => {
        const c = code(PAGE);
        // The "Paid This Month" stat still filters strictly on PAID.
        expect(c).toMatch(/i\.status === 'PAID'\)\.reduce/);
        expect(c).not.toMatch(/i\.status === 'SENT'\)\.reduce\(\(acc, curr\) => acc \+ Number\(curr\.total_amount\), 0\)\.toFixed\(2\)}`, icon: CheckCircle2/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// TOTAL OUTSTANDING — the owner's receivable contract
// ═══════════════════════════════════════════════════════════════════════════

describe('Total Outstanding counts issued, unpaid invoices', () => {
    /** The exact mixed set from the owner contract. */
    const MIXED = [
        { status: 'DRAFT', total_amount: 100 },
        { status: 'SENT', total_amount: 200 },
        { status: 'PENDING', total_amount: 300 },
        { status: 'OVERDUE', total_amount: 400 },
        { status: 'PAID', total_amount: 500 },
        { status: 'CANCELED', total_amount: 600 },
    ];

    it('the owner\'s worked example totals $900', () => {
        // 200 SENT + 300 PENDING + 400 OVERDUE. Not the 100 draft, not paid,
        // not canceled.
        expect(sumOutstandingInvoices(MIXED)).toBe(900);
    });

    it('DRAFT is excluded — under review, not yet issued', () => {
        expect(isOutstandingInvoiceStatus('DRAFT')).toBe(false);
        expect(sumOutstandingInvoices([{ status: 'DRAFT', total_amount: 202.5 }])).toBe(0);
    });

    it('SENT is INCLUDED — a real receivable, which is not a payment claim', () => {
        expect(isOutstandingInvoiceStatus('SENT')).toBe(true);
        expect(sumOutstandingInvoices([{ status: 'SENT', total_amount: 202.5 }])).toBe(202.5);
    });

    it('PENDING and OVERDUE are included; PAID and CANCELED are not', () => {
        expect(isOutstandingInvoiceStatus('PENDING')).toBe(true);
        expect(isOutstandingInvoiceStatus('OVERDUE')).toBe(true);
        expect(isOutstandingInvoiceStatus('PAID')).toBe(false);
        expect(isOutstandingInvoiceStatus('CANCELED')).toBe(false);
        expect(OUTSTANDING_INVOICE_STATUSES).toEqual(['PENDING', 'SENT', 'OVERDUE']);
    });

    it('sums to the cent across Decimal strings', () => {
        // Prisma serialises Decimal to string; float addition must not drift.
        expect(sumOutstandingInvoices([
            { status: 'SENT', total_amount: '202.5' },
            { status: 'PENDING', total_amount: '0.1' },
            { status: 'OVERDUE', total_amount: '0.2' },
        ])).toBe(202.8);
    });

    it('ignores unusable amounts rather than producing NaN', () => {
        expect(sumOutstandingInvoices([
            { status: 'SENT', total_amount: 'not-a-number' },
            { status: 'SENT', total_amount: 100 },
        ])).toBe(100);
        expect(sumOutstandingInvoices([])).toBe(0);
    });

    it('an unknown status is never counted', () => {
        expect(isOutstandingInvoiceStatus('WHATEVER')).toBe(false);
        expect(isOutstandingInvoiceStatus(null)).toBe(false);
        expect(isOutstandingInvoiceStatus(undefined)).toBe(false);
        expect(sumOutstandingInvoices([{ status: 'WHATEVER', total_amount: 999 }])).toBe(0);
    });

    it('the page uses the shared rule rather than an inline PENDING-only filter', () => {
        const c = code(PAGE);
        expect(c).toMatch(/value: `\$\$\{sumOutstandingInvoices\(invoices\)\.toFixed\(2\)\}`|sumOutstandingInvoices\(invoices\)\.toFixed\(2\)/);
        expect(c).not.toMatch(/'Total Outstanding'[^\n]*i\.status === 'PENDING'\)\.reduce/);
    });

    it('"Paid This Month" remains PAID-only', () => {
        const c = code(PAGE);
        const stat = c.slice(c.indexOf("'Paid This Month'"), c.indexOf("'Paid This Month'") + 260);
        expect(stat).toMatch(/i\.status === 'PAID'/);
        expect(stat).not.toMatch(/SENT|DRAFT|sumOutstandingInvoices/);
    });
});

describe('the send path goes through the invoice endpoint, not the generic mailer', () => {
    it('handleSendEmail posts to the invoice send route', () => {
        const c = code(PAGE);
        expect(c).toMatch(/fetch\(`\/api\/tenant\/invoices\/\$\{selectedInvoice\.id\}\/send`/);
    });

    it('the browser does not assert a status itself', () => {
        const c = code(PAGE);
        const start = c.indexOf('const handleSendEmail');
        expect(start).toBeGreaterThan(-1);
        const fn = c.slice(start, start + 1600);
        expect(fn).not.toMatch(/status:\s*'SENT'/);
        expect(fn).not.toMatch(/setInvoices\(/);
        // It re-reads server truth instead.
        expect(fn).toMatch(/fetchInvoices\(\)/);
    });

    it('the recipient is no longer sent from the browser as `to`', () => {
        const c = code(PAGE);
        const start = c.indexOf('const handleSendEmail');
        const fn = c.slice(start, start + 1600);
        expect(fn).not.toMatch(/to: selectedInvoice\.customer\.contact_email/);
    });

    it('safety mode is reported truthfully, as still a draft', () => {
        const c = code(PAGE);
        expect(c).toMatch(/Safety Mode: email logged, not sent\. Invoice stays a draft\./);
    });
});

describe('fundraiser email copy is truthful', () => {
    it('a fundraiser invoice is not described as a "recent order"', () => {
        const c = code(PAGE);
        expect(c).toMatch(/Please find your fundraiser invoice attached/);
        expect(c).toMatch(/isFundraiserInvoice/);
    });

    it('the copy claims no payment was received', () => {
        const c = code(PAGE);
        const start = c.indexOf('const isFundraiserInvoice');
        expect(start).toBeGreaterThan(-1);
        const body = c.slice(start, start + 1400);
        expect(body).not.toMatch(/payment received|has been paid|settled|processed|paid in full/i);
        expect(body).toMatch(/Amount Due/);
    });

    it('the compose dialog still shows the customer as recipient', () => {
        const c = code(PAGE);
        expect(c).toMatch(/recipientEmail=\{selectedInvoice\.customer\.contact_email\}|recipientEmail=/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDIT SAFETY — executed against the real PUT handler
// ═══════════════════════════════════════════════════════════════════════════

describe('PUT cannot rewrite a generated fundraiser invoice\'s frozen totals', () => {
    const BIZ = 'biz-a';

    const put = async (body: any) => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        return PUT(new Request('http://localhost/api/tenant/invoices', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }) as any);
    };

    beforeEach(() => {
        calls.length = 0;
        mockAuth.mockReset();
        mockAuth.mockResolvedValue({ user: { id: 'u', businessId: BIZ, role: 'ADMIN' } });
        persistedInvoice = {
            campaign_id: 'camp-1',
            total_amount: '202.5',
            tax_amount: '2.5',
            fundraiser_profit_percent: '20',
            fundraiser_profit_amount: '50',
        };
    });

    it('the frozen financial fields are preserved, not recomputed from the body', async () => {
        await put({
            id: 'inv-1',
            customer_id: 'cust-1',
            status: 'PAID',
            items: [{ description: 'TAMPERED', quantity: 999, unit_price: 1, total: 999 }],
            tax_amount: 9999,
            fundraiser_profit_percent: 99,
            fundraiser_profit_amount: 9999,
        });

        const update = calls.find((c) => c.op === 'invoice.update');
        expect(update).toBeTruthy();
        expect(String(update!.args.data.total_amount)).toBe('202.5');
        expect(String(update!.args.data.tax_amount)).toBe('2.5');
        expect(String(update!.args.data.fundraiser_profit_percent)).toBe('20');
        expect(String(update!.args.data.fundraiser_profit_amount)).toBe('50');
    });

    it('the invoice lines are left completely alone', async () => {
        await put({
            id: 'inv-1', customer_id: 'cust-1', status: 'PAID',
            items: [{ description: 'TAMPERED', quantity: 999, unit_price: 1, total: 999 }],
        });

        // No delete-and-recreate cycle at all for a campaign invoice.
        expect(calls.some((c) => c.op === 'invoiceItem.deleteMany')).toBe(false);
        const update = calls.find((c) => c.op === 'invoice.update')!;
        expect(update.args.data.items).toBeUndefined();
    });

    it('presentation fields still update normally', async () => {
        await put({
            id: 'inv-1', customer_id: 'cust-1', status: 'PAID',
            items: [], payment_method: 'check', due_date: '2026-09-01',
        });
        const update = calls.find((c) => c.op === 'invoice.update')!;
        expect(update.args.data.status).toBe('PAID');
        expect(update.args.data.payment_method).toBe('check');
        expect(update.args.data.due_date).toBeInstanceOf(Date);
    });

    it('an ORDINARY manual invoice is completely unaffected by the guard', async () => {
        persistedInvoice = {
            campaign_id: null,
            total_amount: '100', tax_amount: '0',
            fundraiser_profit_percent: '0', fundraiser_profit_amount: '0',
        };

        await put({
            id: 'inv-2', customer_id: 'cust-1', status: 'PENDING',
            items: [], tax_amount: 5, fundraiser_profit_amount: 0,
        });

        // The normal edit path runs: lines are replaced and totals recomputed.
        expect(calls.some((c) => c.op === 'invoiceItem.deleteMany')).toBe(true);
        const update = calls.find((c) => c.op === 'invoice.update')!;
        expect(update.args.data.items).toBeDefined();
        expect(String(update!.args.data.tax_amount)).toBe('5');
    });

    it('DRAFT and SENT still cannot be set through the generic editor', async () => {
        for (const status of ['DRAFT', 'SENT']) {
            const res = await put({ id: 'inv-1', customer_id: 'cust-1', status, items: [] });
            expect(res.status).toBe(400);
        }
    });
});
