/**
 * QB-INVOICE-1C — what a QuickBooks invoice locks in the existing FreezerIQ invoice routes, executed against the real
 * handlers over a recording Prisma double.
 *
 * Once "Send via QuickBooks" has reserved an invoice's QuickBooks link, QuickBooks holds (or is about to hold) a copy
 * of it. From then on: the invoice cannot be deleted (and the database refuses too); the generic editor cannot change
 * its organization or status; and FreezerIQ's own invoice email is refused, so the organization receives one invoice
 * under one number. Invoices without a QuickBooks invoice behave exactly as before.
 */

const calls: Array<{ op: string; args?: any }> = [];
let row: any;
let deleteError: any = null;

jest.mock('@/lib/db', () => {
    const tx = {
        invoice: {
            findUnique: async (args: any) => { calls.push({ op: 'tx.invoice.findUnique', args }); return row; },
            update: async (args: any) => { calls.push({ op: 'invoice.update', args }); return { ...args.data, id: args.where.id, items: [], order: null, customer: {} }; },
            delete: async (args: any) => { calls.push({ op: 'invoice.delete', args }); if (deleteError) throw deleteError; return {}; },
        },
        invoiceItem: { deleteMany: async (args: any) => { calls.push({ op: 'invoiceItem.deleteMany', args }); return { count: 0 }; } },
        order: { update: async () => ({}), create: async () => ({}), delete: async () => ({}) },
        orderItem: { deleteMany: async () => ({ count: 0 }) },
    };
    return {
        prisma: {
            invoice: {
                findFirst: async (args: any) => { calls.push({ op: 'invoice.findFirst', args }); return row; },
                findMany: async (args: any) => { calls.push({ op: 'invoice.findMany', args }); return []; },
                updateMany: async (args: any) => { calls.push({ op: 'invoice.updateMany', args }); return { count: 1 }; },
            },
            customer: { findUnique: async () => ({ business_id: 'biz-a' }) },
            $transaction: async (fn: any) => fn(tx),
        },
    };
});
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/pricing', () => ({ buildBundlePriceMap: async () => new Map(), findInactiveBundleNames: async () => [] }));
jest.mock('resend', () => ({ Resend: class { emails = { send: async (p: any) => { calls.push({ op: 'resend.send', args: p }); return { data: { id: 'm' }, error: null }; } }; } }));
jest.mock('@/lib/email', () => ({ getTenantSender: async () => ({ from: 'Tenant via FreezerIQ <no-reply@platform.test>', replyTo: 'tenant@biz.test' }) }));

import { QUICKBOOKS_INVOICE_LOCK_MESSAGES } from '@/lib/quickbooks/invoiceLock';

const LINKED = { quickbooks_invoice_links: [{ id: 'link-1' }] };
const ORIGINAL_ENV = { EMAIL_LIVE: process.env.EMAIL_LIVE, RESEND_API_KEY: process.env.RESEND_API_KEY };
afterAll(() => {
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const json = (method: string, body: unknown) => new Request('http://localhost/api/tenant/invoices', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as any;

beforeEach(() => {
    calls.length = 0;
    deleteError = null;
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'u', businessId: 'biz-a', role: 'ADMIN' } });
});

describe('QB-INVOICE-1C · DELETE: an invoice QuickBooks holds cannot be deleted', () => {
    it('409 with a clear message, and nothing deleted', async () => {
        row = { id: 'inv-1', order: null, ...LINKED };
        const { DELETE } = await import('@/app/api/tenant/invoices/route');
        const res = await DELETE(json('DELETE', { id: 'inv-1' }));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: QUICKBOOKS_INVOICE_LOCK_MESSAGES.delete });
        expect(calls.some((c) => c.op === 'invoice.delete' || c.op === 'invoiceItem.deleteMany')).toBe(false);
        expect(calls.find((c) => c.op === 'tx.invoice.findUnique')!.args.include).toMatchObject({ quickbooks_invoice_links: { select: { id: true } } });
    });

    it('a link created in between is caught by the database (P2003 on a QuickBooks key) and answered 409, not 500', async () => {
        row = { id: 'inv-1', order: null };
        deleteError = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003', meta: { field_name: 'quickbooks_invoice_links_business_id_invoice_id_fkey (index)' } });
        const { DELETE } = await import('@/app/api/tenant/invoices/route');
        expect((await DELETE(json('DELETE', { id: 'inv-1' }))).status).toBe(409);
    });

    it('an invoice without a QuickBooks invoice deletes exactly as before; an unrelated P2003 stays a 500', async () => {
        row = { id: 'inv-1', order: null };
        const { DELETE } = await import('@/app/api/tenant/invoices/route');
        expect((await DELETE(json('DELETE', { id: 'inv-1' }))).status).toBe(200);
        deleteError = Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003', meta: { field_name: 'some_other_fkey' } });
        expect((await DELETE(json('DELETE', { id: 'inv-1' }))).status).toBe(500);
    });
});

describe('QB-INVOICE-1C · PUT: organization and status stay as QuickBooks has them', () => {
    const persisted = (extra: any = {}) => ({ campaign_id: 'camp-1', total_amount: '451.59', tax_amount: '5.59', fundraiser_profit_percent: '20', fundraiser_profit_amount: '111.5', status: 'SENT', payment_method: null, customer_id: 'cust-1', ...extra });

    it('a status change or a different organization is refused with nothing written', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        for (const body of [
            { id: 'inv-1', customer_id: 'cust-1', status: 'CANCELED', items: [] },
            { id: 'inv-1', customer_id: 'cust-1', status: 'PENDING', items: [] },
            { id: 'inv-1', customer_id: 'cust-2', items: [] },
        ]) {
            const res = await PUT(json('PUT', body));
            expect(res.status).toBe(409);
            expect(await res.json()).toEqual({ error: QUICKBOOKS_INVOICE_LOCK_MESSAGES.edit });
        }
        expect(calls.some((c) => c.op === 'invoice.update')).toBe(false);
        expect(calls.find((c) => c.op === 'invoice.findFirst')!.args.select).toMatchObject({ customer_id: true, quickbooks_invoice_links: { select: { id: true } } });
    });

    it('due date and payment method still update, with money and status preserved', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        const res = await PUT(json('PUT', { id: 'inv-1', customer_id: 'cust-1', items: [], due_date: '2026-10-01', payment_method: 'check' }));
        expect(res.status).toBe(200);
        const update = calls.find((c) => c.op === 'invoice.update')!;
        expect(update.args.data).toMatchObject({ status: 'SENT', total_amount: '451.59', tax_amount: '5.59', payment_method: 'check' });
    });

    it('without a QuickBooks invoice, the existing edit rules are unchanged', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted();
        expect((await PUT(json('PUT', { id: 'inv-1', customer_id: 'cust-1', status: 'OVERDUE', items: [] }))).status).toBe(200);
        expect(calls.find((c) => c.op === 'invoice.update')!.args.data.status).toBe('OVERDUE');
    });
});

describe('QB-INVOICE-1C · PUT: the money QuickBooks copied is refused, not silently preserved', () => {
    const LINES = [
        { description: 'Family Friendly', quantity: '7', unit_price: '62.5', total: '437.5' },
        { description: 'Date Night (Serves 2)', quantity: '2', unit_price: '60', total: '120' },
    ];
    const persisted = (extra: any = {}) => ({
        campaign_id: 'camp-1', total_amount: '451.59', tax_amount: '5.59', tax_rate_percent: '1', taxable_base_amount: '446',
        tax_status: 'TAXABLE', fundraiser_profit_percent: '20', fundraiser_profit_amount: '111.5', status: 'SENT',
        payment_method: null, customer_id: 'cust-1', items: LINES, ...extra,
    });
    const unchanged = { id: 'inv-1', customer_id: 'cust-1', items: LINES.map((l) => ({ ...l })) };

    it('every locked financial field is answered 409 with nothing written and no QuickBooks call', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        const attempts: Array<[string, Record<string, unknown>]> = [
            ['a quantity', { items: [{ ...LINES[0], quantity: '14', total: '875' }, LINES[1]] }],
            ['a rate', { items: [{ ...LINES[0], unit_price: '72.5' }, LINES[1]] }],
            ['a line total', { items: [{ ...LINES[0], total: '437.51' }, LINES[1]] }],
            ['a removed line', { items: [LINES[0]] }],
            ['an added line', { items: [...LINES, { description: 'Delivery', quantity: '1', unit_price: '10', total: '10' }] }],
            ['the invoice total', { total_amount: 9999.99 }],
            ['the tax amount', { tax_amount: 99.99 }],
            ['the tax rate', { tax_rate_percent: '8' }],
            ['the taxable base', { taxable_base_amount: '999' }],
            ['the tax status', { tax_status: 'EXEMPT' }],
            ['the share amount', { fundraiser_profit_amount: 0 }],
            ['the share percent', { fundraiser_profit_percent: 0 }],
        ];
        for (const [what, over] of attempts) {
            calls.length = 0;
            const res = await PUT(json('PUT', { ...unchanged, ...over }));
            expect([what, res.status]).toEqual([what, 409]);
            expect(await res.json()).toEqual({ error: QUICKBOOKS_INVOICE_LOCK_MESSAGES.money });
            // Nothing written: no update, no line rewrite, no transaction at all — so updated_at cannot move.
            expect(calls.filter((c) => c.op !== 'invoice.findFirst' && c.op !== 'invoice.findMany')).toEqual([]);
        }
    });

    it('re-sending the same financial facts is not an edit: due date and payment method still save', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        const res = await PUT(json('PUT', {
            ...unchanged, due_date: '2026-10-01', payment_method: 'check',
            total_amount: '451.59', tax_amount: 5.59, tax_rate_percent: 1, taxable_base_amount: '446.00',
            tax_status: 'TAXABLE', fundraiser_profit_amount: '111.50', fundraiser_profit_percent: '20.00',
        }));
        expect(res.status).toBe(200);
        expect(calls.find((c) => c.op === 'invoice.update')!.args.data).toMatchObject({ status: 'SENT', total_amount: '451.59', tax_amount: '5.59', payment_method: 'check' });
    });

    it('an omitted field is not an attempt to change it, and the money lock never applies without a QuickBooks invoice', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        // Money fields omitted entirely (the editor's "leave it alone"); `items` is required by this route as before.
        expect((await PUT(json('PUT', { ...unchanged, due_date: '2026-10-01' }))).status).toBe(200);
        row = persisted();
        expect((await PUT(json('PUT', { ...unchanged, tax_amount: 99.99, items: [{ description: 'Anything', quantity: '1', unit_price: '5', total: '5' }] }))).status).toBe(200);
    });

    it('the route reads the lines and the frozen facts it compares against', async () => {
        const { PUT } = await import('@/app/api/tenant/invoices/route');
        row = persisted(LINKED);
        await PUT(json('PUT', unchanged));
        expect(calls.find((c) => c.op === 'invoice.findFirst')!.args.select).toMatchObject({
            total_amount: true, tax_amount: true, tax_rate_percent: true, taxable_base_amount: true, tax_status: true,
            fundraiser_profit_amount: true, fundraiser_profit_percent: true,
            items: { select: { description: true, quantity: true, unit_price: true, total: true } },
        });
    });
});

describe('QB-INVOICE-1C · the FreezerIQ invoice email refuses an invoice QuickBooks holds', () => {
    const post = async () => {
        const { POST } = await import('@/app/api/tenant/invoices/[id]/send/route');
        return POST(new Request('http://localhost/api/tenant/invoices/inv-1/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'Invoice', html: '<p>x</p>', attachments: [] }) }) as any, { params: Promise.resolve({ id: 'inv-1' }) } as any);
    };

    it('409 before any email or status write', async () => {
        process.env.EMAIL_LIVE = 'true';
        process.env.RESEND_API_KEY = 'test-key';
        row = { id: 'inv-1', status: 'DRAFT', campaign_id: 'camp-1', total_amount: '451.59', customer: { name: 'Lincoln PTA', contact_email: 'coordinator@lincoln-pta.example' }, ...LINKED };
        const res = await post();
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: QUICKBOOKS_INVOICE_LOCK_MESSAGES.email });
        expect(calls.some((c) => c.op === 'resend.send' || c.op === 'invoice.updateMany')).toBe(false);
    });

    it('an invoice without a QuickBooks invoice is emailed exactly as before', async () => {
        process.env.EMAIL_LIVE = 'true';
        process.env.RESEND_API_KEY = 'test-key';
        row = { id: 'inv-1', status: 'DRAFT', campaign_id: 'camp-1', total_amount: '451.59', customer: { name: 'Lincoln PTA', contact_email: 'coordinator@lincoln-pta.example' } };
        const res = await post();
        expect(res.status).toBe(200);
        expect(calls.some((c) => c.op === 'resend.send')).toBe(true);
    });
});

describe('QB-INVOICE-1C · the invoice list shows where a QuickBooks send stands', () => {
    it('GET includes the lifecycle status and QuickBooks’ number — never a QuickBooks id', async () => {
        const { GET } = await import('@/app/api/tenant/invoices/route');
        await GET();
        expect(calls.find((c) => c.op === 'invoice.findMany')!.args.include.quickbooks_invoice_send)
            // QB-INVOICE-CANCEL-1 adds the two cancellation facts — still never a QuickBooks id.
            .toEqual({ select: { status: true, qbo_doc_number: true, delivery_error_type: true, void_requested_at: true, voided_at: true } });
    });
});
