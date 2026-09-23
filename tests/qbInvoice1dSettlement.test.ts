/**
 * QB-INVOICE-1D — the shared settlement transition, and Record Payment / Undo Payment around it.
 *
 * 1D moved the conditional PAID write and its winner-only effects out of the settle route, UNCHANGED, into
 * lib/invoiceSettlementTransition.ts, so a verified QuickBooks payment and a human's Record Payment run the same one.
 * These tests execute the real route and the real transition over a recording transaction double:
 *   - the transition refuses to settle out of anything but an outstanding status, before any write;
 *   - its effects (the kitchen release) run only for the request that won the conditional write;
 *   - Record Payment still settles Square/Check exactly as before, and can never record "quickbooks";
 *   - Undo Payment still corrects a human's Check/Square record, and refuses a VERIFIED settlement.
 */

import { settleInvoiceInTransaction, SettlementStatusError } from '@/lib/invoiceSettlementTransition';

type Call = { op: string; args: any };
const calls: Call[] = [];
let invoiceRow: any;

/** QB-INVOICE-CANCEL-1: the QuickBooks lifecycle this invoice has, if any — what the FOR UPDATE lock reads. */
let lifecycleRow: { lease_until: Date | null; voided_at: Date | null; void_requested_at: Date | null } | null = null;

/** A transaction double whose invoice write is CONDITIONAL on the stored status, like the real UPDATE … WHERE. */
const tx = {
    // QB-INVOICE-CANCEL-1: the transition locks this invoice's QuickBooks lifecycle row before it decides anything.
    $queryRaw: async (sql: any) => {
        calls.push({ op: 'lifecycle.forUpdate', args: String(Array.isArray(sql) ? sql.join('?') : sql).replace(/\s+/g, ' ').trim() });
        return lifecycleRow ? [lifecycleRow] : [];
    },
    invoice: {
        updateMany: async (a: any) => {
            calls.push({ op: 'invoice.updateMany', args: a });
            const where = a.where;
            const statusOk = where.status?.in ? where.status.in.includes(invoiceRow.status) : where.status === undefined || where.status === invoiceRow.status;
            const paidOk = where.paid_at?.not === null ? invoiceRow.paid_at !== null : true;
            if (where.id !== invoiceRow.id || where.business_id !== 'biz-a' || !statusOk || !paidOk) return { count: 0 };
            Object.assign(invoiceRow, a.data);
            return { count: 1 };
        },
    },
    order: { updateMany: async (a: any) => { calls.push({ op: 'order.updateMany', args: a }); return { count: 2 }; } },
    loyaltyPoint: { findFirst: async () => { calls.push({ op: 'loyalty', args: null }); return null; }, create: async () => ({}) },
    customer: { update: async () => ({}) },
};

jest.mock('@/lib/db', () => ({
    prisma: {
        $transaction: async (fn: any) => fn(tx),
        invoice: { findFirst: async () => ({ ...invoiceRow }) },
    },
}));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const route = () => require('@/app/api/tenant/invoices/[id]/settle/route');
const req = (method: string, body?: unknown) => new Request('http://localhost/api/tenant/invoices/inv-1/settle', {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const params = { params: Promise.resolve({ id: 'inv-1' }) };

beforeEach(() => {
    calls.length = 0;
    invoiceRow = {
        id: 'inv-1', status: 'SENT', paid_at: null, payment_method: null, payment_reference: null,
        campaign_id: 'camp-1', customer_id: 'cust-1', total_amount: 451.59, due_date: null, customer: { type: 'fundraiser_org' },
    };
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'a@t.test', businessId: 'biz-a' } });
});

const facts = { method: 'quickbooks' as const, paidAt: new Date('2026-09-20T12:00:00Z'), reference: 'QuickBooks payment 901 · invoice #1041' };
const settle = (fromStatuses: readonly string[]) => settleInvoiceInTransaction(tx as any, {
    invoice: { id: 'inv-1', campaign_id: 'camp-1', customer_id: 'cust-1', total_amount: 451.59, customer: { type: 'fundraiser_org' } },
    businessId: 'biz-a', facts, fromStatuses,
});

describe('QB-INVOICE-1D · the shared transition', () => {
    it('refuses — before any write — to settle out of DRAFT, PAID, CANCELED, or nothing at all', async () => {
        for (const bad of [['DRAFT'], ['PAID'], ['CANCELED'], ['SENT', 'DRAFT'], []]) {
            await expect(settle(bad)).rejects.toBeInstanceOf(SettlementStatusError);
        }
        expect(calls).toEqual([]);
    });

    it('27/28. the winner writes exactly the settlement facts and releases ONLY this campaign’s held orders', async () => {
        expect(await settle(['SENT'])).toEqual({ count: 1 });
        // The lifecycle row is LOCKED first: that lock is what excludes a concurrent cancellation.
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate', 'invoice.updateMany', 'order.updateMany']);
        expect(calls[0].args).toContain('FROM "quickbooks_invoice_sends" WHERE "invoice_id" = ? FOR UPDATE');
        expect(calls[1].args).toEqual({
            where: {
                id: 'inv-1', business_id: 'biz-a', status: { in: ['SENT'] },
                OR: [
                    // QB-INVOICE-CANCEL-1: not while a QuickBooks lease is held on this invoice, never once
                    // FreezerIQ has decided to void its QuickBooks copy, and never once that copy IS void.
                    // Ordinary invoices carry no lifecycle row.
                    { quickbooks_invoice_send: null },
                    { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: null } },
                    { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: { lt: expect.any(Date) } } },
                ],
            },
            data: { status: 'PAID', paid_at: facts.paidAt, payment_method: 'quickbooks', payment_reference: facts.reference },
        });
        expect(calls[2].args).toEqual({
            where: { campaign_id: 'camp-1', business_id: 'biz-a', source: 'fundraiser', status: 'fundraiser_hold', canceled_at: null },
            data: { status: 'production_ready' },
        });
        // Loyalty accrual is paused (LOY-P0) — still never reached.
        expect(calls.some((c) => c.op === 'loyalty')).toBe(false);
    });

    /**
     * QB-INVOICE-CANCEL-1 — the exclusion itself, at the transition. The lifecycle row is locked FOR UPDATE before
     * anything is decided, and any of the three cancellation facts stops the settlement dead: no PAID write is even
     * attempted, so no kitchen release can follow.
     */
    it('refuses, before any write, on a live lease, a durable void intent, or a voided QuickBooks invoice', async () => {
        lifecycleRow = { lease_until: new Date(Date.now() + 60_000), voided_at: null, void_requested_at: null };
        expect(await settle(['SENT'])).toEqual({ count: 0 });
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate']);
        expect(invoiceRow.status).toBe('SENT');

        calls.length = 0;
        lifecycleRow = { lease_until: null, voided_at: new Date(), void_requested_at: new Date() };
        expect(await settle(['SENT'])).toEqual({ count: 0 });
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate']);
        expect(invoiceRow.status).toBe('SENT');

        // THE crash window: the process died mid-cancellation, so the lease has long expired — but the durable
        // intent has not, and it alone must keep this invoice unsettleable.
        calls.length = 0;
        lifecycleRow = { lease_until: new Date(Date.now() - 600_000), voided_at: null, void_requested_at: new Date(Date.now() - 600_000) };
        expect(await settle(['SENT'])).toEqual({ count: 0 });
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate']);
        expect(invoiceRow.status).toBe('SENT');

        // An EXPIRED lease with nothing else is not an exclusion: the lifecycle is idle, so a settlement proceeds.
        calls.length = 0;
        lifecycleRow = { lease_until: new Date(Date.now() - 1_000), voided_at: null, void_requested_at: null };
        expect(await settle(['SENT'])).toEqual({ count: 1 });
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate', 'invoice.updateMany', 'order.updateMany']);
        expect(invoiceRow.status).toBe('PAID');
    });

    it('a loser (already PAID, or no longer SENT) writes nothing further and releases nothing', async () => {
        invoiceRow.status = 'PAID';
        expect(await settle(['SENT'])).toEqual({ count: 0 });
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate', 'invoice.updateMany']);
        invoiceRow.status = 'OVERDUE';
        calls.length = 0;
        expect(await settle(['SENT'])).toEqual({ count: 0 }); // the QuickBooks check settles from SENT only
        expect(calls.map((c) => c.op)).toEqual(['lifecycle.forUpdate', 'invoice.updateMany']);
    });
});

describe('QB-INVOICE-1D · Record Payment (31: manual settlement still works)', () => {
    it('settles a Check on a SENT invoice through the same transition, from any outstanding status, and releases once', async () => {
        const res = await route().POST(req('POST', { method: 'check', paidAt: '2026-09-15', reference: 'ck-1001' }), params);
        expect(res.status).toBe(200);
        expect(calls[1].args.where).toEqual({
            id: 'inv-1', business_id: 'biz-a', status: { in: ['PENDING', 'SENT', 'OVERDUE'] },
            // QB-INVOICE-CANCEL-1: and not while a QuickBooks lease is held on it, nor once FreezerIQ has
            // decided to void it there, nor once it IS voided there.
            OR: [
                { quickbooks_invoice_send: null },
                { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: null } },
                { quickbooks_invoice_send: { voided_at: null, void_requested_at: null, lease_until: { lt: expect.any(Date) } } },
            ],
        });
        expect(calls[1].args.data).toMatchObject({ status: 'PAID', payment_method: 'check', payment_reference: 'ck-1001' });
        expect(calls.filter((c) => c.op === 'order.updateMany')).toHaveLength(1);
        expect(invoiceRow.status).toBe('PAID');
    });

    it('a human can NEVER record "quickbooks" — it is not a method Record Payment accepts', async () => {
        const res = await route().POST(req('POST', { method: 'quickbooks', paidAt: '2026-09-15', reference: 'QuickBooks payment 901' }), params);
        expect(res.status).toBe(400);
        expect(calls).toEqual([]);
        expect(invoiceRow.status).toBe('SENT');
    });
});

describe('QB-INVOICE-1D · Undo Payment (32: the manual correction is unchanged)', () => {
    it('still undoes a human’s Check record back to SENT, and never reverts the release', async () => {
        Object.assign(invoiceRow, { status: 'PAID', paid_at: new Date('2026-09-15T12:00:00Z'), payment_method: 'check', payment_reference: 'ck-1001' });
        const res = await route().DELETE(req('DELETE'), params);
        expect(res.status).toBe(200);
        expect(invoiceRow).toMatchObject({ status: 'SENT', paid_at: null, payment_method: null, payment_reference: null });
        expect(calls.some((c) => c.op === 'order.updateMany')).toBe(false);
    });

    it('refuses to undo a VERIFIED QuickBooks settlement (409), and writes nothing', async () => {
        Object.assign(invoiceRow, { status: 'PAID', paid_at: new Date('2026-09-20T12:00:00Z'), payment_method: 'quickbooks', payment_reference: facts.reference });
        const res = await route().DELETE(req('DELETE'), params);
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.reason).toBe('verified_settlement');
        expect(body.error).toMatch(/verified with the payment provider/);
        expect(calls).toEqual([]);
        expect(invoiceRow.status).toBe('PAID');
    });
});
