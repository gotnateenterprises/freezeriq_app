/**
 * QB-INVOICE-CANCEL-1 — "Cancel invoice": VOID the SAME QuickBooks invoice, then mark the FreezerIQ invoice
 * CANCELED. Executed end to end over the session-free service, the database double and a QuickBooks double whose
 * void behaves exactly as the sandbox company does (Id and DocNumber kept, SyncToken bumped, every amount zeroed,
 * PrivateNote "Voided", nothing linked).
 *
 * What these prove, in the owner's words:
 *   - it uses the SAME QuickBooks invoice, and can never create a second one, a customer or a payment;
 *   - QuickBooks is voided and RE-READ first; the FreezerIQ invoice becomes CANCELED only on that proof, and if
 *     anything fails it stays exactly as it was;
 *   - a paid invoice — in FreezerIQ or in QuickBooks — is never canceled, and nothing is ever marked paid;
 *   - the fundraiser's held food is never released, and no order is touched at all;
 *   - it is idempotent: a repeat reads QuickBooks, finds the invoice already void and writes nothing new;
 *   - a draft, an unlinked invoice, a stale generation and the wrong tenant are all refused.
 */

import {
    cancelQuickBooksInvoice,
    checkQuickBooksInvoiceDelivery,
    getQuickBooksInvoiceSendView,
    LEASE_MS,
    recheckQuickBooksInvoiceCreate,
    resendQuickBooksInvoice,
    resumeQuickBooksInvoiceSend,
    startQuickBooksInvoiceSend,
} from '@/lib/quickbooks/invoiceSend';
import { checkQuickBooksInvoicePayment } from '@/lib/quickbooks/invoicePayment';
import { settleInvoiceInTransaction } from '@/lib/invoiceSettlementTransition';
import { isOutstandingInvoiceStatus, sumOutstandingInvoices } from '@/lib/invoiceSendTruth';
import { hasQuickBooksInvoice } from '@/lib/quickbooks/invoiceLock';
import { CANCEL_PENDING_TITLE, invoiceRowAction, sendDialogView, settlementBlockedByCancellation } from '@/lib/quickbooks/invoiceSendView';
import { isSettleableInvoiceStatus, SETTLEABLE_INVOICE_STATUSES } from '@/lib/invoiceSettlement';
import { ADMIN_USER, BIZ, invoiceWorld, RECIPIENT, type World, type WorldOptions } from './helpers/quickbooksInvoiceWorld';

const worlds: World[] = [];
afterEach(() => {
    for (const w of worlds.splice(0)) expect(w.store.violations).toEqual([]);
});

async function world(options: WorldOptions = {}) {
    const w = await invoiceWorld({ settlement: true, ...options });
    worlds.push(w);
    return w;
}

const input = (w: World, invoiceId: string) => ({ businessId: BIZ, invoiceId, config: w.config });
const lifecycle = (w: World, invoiceId: string) => w.store.sends.get(invoiceId)!;
const invoiceOf = (w: World, invoiceId: string) => w.store.invoices.get(invoiceId)!;
const linkOf = (w: World, invoiceId: string) => [...w.store.link.invoiceLinks.values()].find((l) => l.invoice_id === invoiceId)!;
const cancel = (w: World, invoiceId: string, confirmation: unknown) =>
    cancelQuickBooksInvoice({ ...input(w, invoiceId), userId: ADMIN_USER, confirmation }, w.deps);

/** Runs the event loop until `ready` holds — real time, so timers and I/O progress under parallel load. */
const until = async (ready: () => boolean, what: string) => {
    const deadline = Date.now() + 10_000;
    while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    if (!ready()) throw new Error(`timed out waiting for ${what}`);
};
/** An invoice QuickBooks has created, verified and emailed — the only state "Cancel invoice" acts on. */
async function sentInvoice(options: WorldOptions = {}) {
    const w = await world(options);
    const inv = w.seedE2();
    const view: any = await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps);
    expect(view.state).toBe('ready');
    const result = await startQuickBooksInvoiceSend({
        ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null,
    }, w.deps);
    expect(result.outcome).toBe('sent');
    const qboId = [...w.qbo.invoices.keys()][0];
    const docNumber = lifecycle(w, inv.id).qbo_doc_number!;
    expect(invoiceOf(w, inv.id).status).toBe('SENT');
    w.store.seedHeldOrders(BIZ, inv.campaign_id!, 3); // the fundraiser's food, on hold and staying there
    return { w, inv, qboId, docNumber };
}

/** Nothing about the money moved: no payment, no release, no second invoice, no extra QuickBooks write. */
function expectNothingPaidOrReleased(w: World, invoiceId: string, qboId: string) {
    const invoice = invoiceOf(w, invoiceId);
    expect(invoice.paid_at ?? null).toBeNull();
    expect(invoice.payment_method ?? null).toBeNull();
    expect(invoice.payment_reference ?? null).toBeNull();
    expect(w.store.settlementWrites.filter((x) => x.count > 0)).toEqual([]); // a refused attempt may be recorded; a winner may not
    expect(w.store.orderWrites).toEqual([]);
    expect([...w.store.orders.values()].map((o) => o.status)).toEqual(['fundraiser_hold', 'fundraiser_hold', 'fundraiser_hold']);
    expect(w.qbo.invoices.size).toBe(1);
    expect([...w.qbo.invoices.keys()]).toEqual([qboId]);
    expect(w.qbo.creates()).toHaveLength(1);
    expect(w.qbo.sends()).toHaveLength(1); // the original send, never another
}

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-CANCEL-1 · the QuickBooks invoice is voided, then FreezerIQ cancels its own', () => {
    it('15/24/27/28/30. voids the SAME invoice, marks it CANCELED, pays nothing and releases nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const writes = w.qbo.writes().length;

        const result = await cancel(w, inv.id, docNumber);

        expect(result.outcome).toBe('canceled');
        // The SAME QuickBooks invoice, voided in place: same Id, same number, zero everywhere, nothing linked.
        const qbo = w.qbo.invoices.get(qboId);
        expect(w.qbo.voids().map((c) => c.body.Id)).toEqual([qboId]);
        expect({ Id: qbo.Id, DocNumber: qbo.DocNumber, TotalAmt: qbo.TotalAmt, Balance: qbo.Balance })
            .toEqual({ Id: qboId, DocNumber: docNumber, TotalAmt: 0, Balance: 0 });
        expect(qbo.PrivateNote).toMatch(/Voided$/); // QuickBooks' own marker, appended to the memo it already had
        expect(qbo.Line.every((l: any) => l.Amount === 0)).toBe(true);
        expect(qbo.LinkedTxn).toEqual([]);
        expect(w.qbo.writes()).toHaveLength(writes + 1); // exactly one new QuickBooks write: the void
        // FreezerIQ: canceled, with the link and the whole send history kept.
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(linkOf(w, inv.id).qbo_invoice_id).toBe(qboId);
        expect(lifecycle(w, inv.id)).toMatchObject({
            status: 'sent', send_count: 1, qbo_doc_number: docNumber, problem: null, lease_id: null,
            voided_by: ADMIN_USER,
        });
        expect(lifecycle(w, inv.id).voided_at).toBeInstanceOf(Date);
        expect(lifecycle(w, inv.id).sent_at).not.toBeNull();
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('16/17/18/35. the cancellation creates nothing at all — no invoice, no customer, no payment, no item', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const before = { creates: w.qbo.creates().length, customerCalls: w.customers.calls.length, calls: w.qbo.calls.length };

        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');

        expect(w.qbo.creates()).toHaveLength(before.creates);
        expect(w.customers.calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
        expect(w.qbo.calls.slice(before.calls).map((c) => c.op).sort()).toEqual(['read', 'read', 'void']);
        expect(w.qbo.invoices.size).toBe(1);
        expect([...w.qbo.invoices.keys()]).toEqual([qboId]);
    });

    it('19/20/32/34. the void carries a derived requestid, and a repeat writes nothing new', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const requestIds = w.qbo.voids().map((c) => c.requestId);
        expect(requestIds).toHaveLength(1);
        expect(requestIds[0]).toMatch(/^qbvoid-[0-9a-f]{32}$/);
        const syncToken = w.qbo.invoices.get(qboId).SyncToken;
        const note = w.qbo.invoices.get(qboId).PrivateNote;

        // A repeat: the invoice is read, found already void, and NOT voided again (no "Voided - Voided").
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(w.qbo.invoices.get(qboId).SyncToken).toBe(syncToken);
        expect(w.qbo.invoices.get(qboId).PrivateNote).toBe(note); // never "Voided - Voided"
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('34. a void whose answer was lost is reconciled by the next attempt, never voided twice', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'lost' }); // QuickBooks voided it; FreezerIQ never saw the answer
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(w.qbo.invoices.get(qboId).PrivateNote).toMatch(/Voided$/);
        expect(w.qbo.invoices.get(qboId).PrivateNote).not.toMatch(/Voided - Voided/);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
    });

    it('33. two cancellations at once: one winner, one void, one canceled invoice', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const both = await Promise.all([cancel(w, inv.id, docNumber), cancel(w, inv.id, docNumber)]);
        // One request voids and cancels; the other reports the lifecycle as it stands (it stays 'sent' — the
        // send history is never rewritten) or finds the work already done. Neither voids twice.
        expect(both.some((r) => r.outcome === 'canceled')).toBe(true);
        for (const r of both) expect(['canceled', 'sent', 'in_progress', 'blocked']).toContain(r.outcome);
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-CANCEL-1 · QuickBooks first, FreezerIQ only on proof', () => {
    it('25. QuickBooks refusing the void leaves the FreezerIQ invoice exactly as it was', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'status', status: 400, code: '6240' });
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['update_rejected'] });
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: 'void_rejected', lease_id: null });
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('26. a read-back that does not prove the void leaves the FreezerIQ invoice as it was', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        // QuickBooks voids it, then something puts money back on it before FreezerIQ reads it again.
        w.qbo.afterNext('void', (i) => { i.TotalAmt = 451.59; i.Balance = 451.59; });
        const result = await cancel(w, inv.id, docNumber);
        expect(result).toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: 'verification_failed_voided' });
        expect(lifecycle(w, inv.id).problem_detail).toContain('void_total_zero');
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
    });

    it('a QuickBooks invoice that no longer matches FreezerIQ is never voided', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.tamper(qboId, (i: any) => { i.TotalAmt = 999.99; });
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(lifecycle(w, inv.id)).toMatchObject({ problem: 'qbo_invoice_changed' });
    });

    it('an invoice QuickBooks shows as PAID is never voided, and nothing is marked paid in FreezerIQ', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.receivePayment({ invoiceId: qboId, amount: 451.59 });
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['paid_in_quickbooks'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(w.store.settlementWrites).toEqual([]);
        expect([...w.store.orders.values()].every((o) => o.status === 'fundraiser_hold')).toBe(true);
    });

    it('QuickBooks being unreachable cancels nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'read', kind: 'lost_before' });
        w.qbo.failNext({ op: 'read', kind: 'lost_before' }); // persistently unreachable, not a single blip
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(lifecycle(w, inv.id).lease_id).toBeNull();
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-CANCEL-1 · only the right invoice, and only with the deliberate confirmation', () => {
    it('the QuickBooks number must be typed exactly; anything else changes nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        for (const wrong of ['', ' ', 'yes', '9999', docNumber + '0', 1026 as unknown as string, null, undefined]) {
            expect(await cancel(w, inv.id, wrong)).toEqual({ outcome: 'invalid', reason: 'confirmation' });
        }
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        // The exact number, with incidental whitespace, is accepted.
        expect((await cancel(w, inv.id, ` ${docNumber} `)).outcome).toBe('canceled');
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('10. a PAID FreezerIQ invoice is never canceled', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps)).outcome).toBe('not_paid');
        w.store.invoices.set(inv.id, { ...invoiceOf(w, inv.id), status: 'PAID', paid_at: new Date(), payment_method: 'check' });
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['invoice_paid'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
    });

    it('11. an already canceled invoice answers canceled and writes nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const calls = w.qbo.calls.length;
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(w.qbo.calls).toHaveLength(calls); // QuickBooks is not even read
        expect(w.qbo.voids()).toHaveLength(1);
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('8/9. an outstanding invoice that is PENDING or OVERDUE is cancelable too', async () => {
        for (const status of ['PENDING', 'OVERDUE']) {
            const { w, inv, qboId, docNumber } = await sentInvoice();
            w.store.invoices.set(inv.id, { ...invoiceOf(w, inv.id), status });
            expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
            expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
            expect(w.qbo.voids()).toHaveLength(1);
            expectNothingPaidOrReleased(w, inv.id, qboId);
        }
    });

    it('23. a void read-back QuickBooks answers with nonsense cancels nothing', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'read', kind: 'malformed' });
        w.qbo.failNext({ op: 'read', kind: 'malformed' });
        const result = await cancel(w, inv.id, docNumber);
        expect(['blocked', 'canceled']).toContain(result.outcome);
        expect(result.outcome).toBe('blocked');
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
    });
    it('14. an invoice that never went through QuickBooks is refused, and 404s for another tenant', async () => {
        const w = await world();
        const inv = w.seedE2();
        expect(await cancel(w, inv.id, '1052')).toEqual({ outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] });
        expect(w.qbo.calls).toEqual([]);
        await expect(cancelQuickBooksInvoice({ businessId: 'another-tenant', invoiceId: inv.id, config: w.config, userId: ADMIN_USER, confirmation: '1052' }, w.deps))
            .rejects.toThrow('Invoice not found');
    });

    it('13. a DRAFT invoice whose lifecycle is still running is refused', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'update', kind: 'status', status: 400, code: '6240' }); // stops after create, invoice still DRAFT
        expect((await startQuickBooksInvoiceSend({
            ...input(w, inv.id), userId: ADMIN_USER,
            reviewToken: (await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps) as any).reviewToken,
            recipientTo: RECIPIENT, recipientCc: null,
        }, w.deps)).outcome).toBe('needs_review');
        expect(invoiceOf(w, inv.id).status).toBe('DRAFT');
        expect(await cancel(w, inv.id, lifecycle(w, inv.id).qbo_doc_number ?? '1052')).toEqual({ outcome: 'blocked', blockers: ['cancel_not_available'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('DRAFT');
    });

    it('12. a link from an earlier connection generation is refused', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        const link = linkOf(w, inv.id);
        const generations = [...w.store.link.connections.values()];
        const earlier = { ...generations[0], id: 'generation-from-before', live_business_id: null };
        w.store.link.connections.set(earlier.id, earlier as any);
        w.store.link.invoiceLinks.set(link.id, { ...link, connection_id: earlier.id });
        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['linked_to_another_connection'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
    });

    it('a cancellation cannot start while another request holds the lease', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        const row = lifecycle(w, inv.id);
        w.store.sends.set(inv.id, { ...row, lease_id: 'someone-else', lease_until: new Date(w.now() + LEASE_MS) });
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('sent');
        expect(w.qbo.voids()).toEqual([]);
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        w.clock.offsetMs = LEASE_MS + 1000;
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-CANCEL-1 · after cancellation', () => {
    it('7/37. the payment check refuses a canceled invoice and can never settle it', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps)).toEqual({ outcome: 'blocked', blocker: 'invoice_not_sent' });
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(w.store.settlementWrites).toEqual([]);
    });

    /**
     * QB-INVOICE-CANCEL-1 — everything a canceled invoice must NO LONGER offer, and everything it must keep.
     * The money surfaces are checked at their own source of truth, not through the UI that reads them.
     */
    it('every other action is closed: not outstanding, not settleable, no resume, no recheck, no undo, still not deletable', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const invoice = invoiceOf(w, inv.id);

        // It leaves Total Outstanding the moment it is canceled.
        expect(isOutstandingInvoiceStatus('CANCELED')).toBe(false);
        expect(sumOutstandingInvoices([{ status: invoice.status, total_amount: invoice.total_amount }])).toBe(0);
        expect(sumOutstandingInvoices([{ status: 'SENT', total_amount: invoice.total_amount }])).toBe(451.59);
        // Record Payment is neither offered nor accepted, and there is no payment to undo.
        expect(isSettleableInvoiceStatus('CANCELED')).toBe(false);
        expect(invoice.paid_at ?? null).toBeNull();
        // No resume, and no recheck: the lifecycle is sent, and the repair is only for a create-stage stop.
        expect(await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).toMatchObject({ outcome: 'sent' });
        expect(await recheckQuickBooksInvoiceCreate({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
        // The history stays: the row still points at QuickBooks' own number, and the link is intact.
        expect(invoiceRowAction({ status: 'sent', qbo_doc_number: docNumber, delivery_error_type: null }, 'CANCELED'))
            .toEqual({ label: 'View QuickBooks invoice #' + docNumber, tone: 'ok' });
        expect(linkOf(w, inv.id).qbo_invoice_id).not.toBeNull();
        // And the QuickBooks lock still applies, so the generic editor and delete keep refusing it.
        expect(hasQuickBooksInvoice({ quickbooks_invoice_links: [{ id: linkOf(w, inv.id).id }] })).toBe(true);
        expect(w.qbo.voids()).toHaveLength(1);
    });

    it('a re-send of a canceled invoice is refused, and QuickBooks is never asked to email it again', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const sends = w.qbo.sends().length;
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: RECIPIENT, recipientCc: null }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['invoice_not_sent'] });
        expect(w.qbo.sends()).toHaveLength(sends);
        expect(w.qbo.sent).toHaveLength(1);
    });

    it('the view says canceled, offers nothing further, and keeps the history', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const view: any = await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps);
        expect(view).toMatchObject({ state: 'sent', invoiceStatus: 'CANCELED', docNumber, sendCount: 1 });
        expect(view.canceledAt).toEqual(expect.any(String));
        expect(view.sentAt).toEqual(expect.any(String));
        // Checking delivery still only reads, and still changes no money.
        expect((await checkQuickBooksInvoiceDelivery(input(w, inv.id), w.deps)).outcome).toBe('checked');
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * QB-INVOICE-CANCEL-1 — the cross-operation race: cancelling voids QuickBooks (irreversible) before FreezerIQ
 * writes CANCELED, while Record Payment and the verified QuickBooks payment check both write PAID and release the
 * fundraiser's food. The terminal state must always be ONE of them, never both, and never a silent contradiction.
 *
 * Two mechanisms are proven here:
 *   1. the SHARED settlement transition refuses an invoice whose QuickBooks lifecycle holds a lease (a cancel is
 *      mid-flight in QuickBooks) or whose QuickBooks copy is already voided;
 *   2. the cancellation's own conditional write is AUTHORITATIVE — if it does not win, the cancel reports a
 *      conflict and records it, instead of claiming a cancellation that did not happen.
 */
describe('QB-INVOICE-CANCEL-1 · cancel versus payment: one terminal state, never both', () => {
    const facts = { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' };
    /** A human's Record Payment, through the very transition the settle route runs. */
    const recordPayment = (w: World, invoiceId: string) => {
        const inv = invoiceOf(w, invoiceId);
        return w.store.db.$transaction((tx: any) => settleInvoiceInTransaction(tx, {
            invoice: { id: inv.id, campaign_id: inv.campaign_id, customer_id: inv.customer_id, total_amount: inv.total_amount, customer: { type: 'fundraiser_org' } },
            businessId: BIZ,
            facts,
            fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));
    };
    /** Runs the event loop until  holds (everything here is in-process and tick-driven). */
    const until = async (ready: () => boolean, what: string) => {
        // Real time, not tick counting: under parallel load the cancel is waiting on timers and I/O too.
        const deadline = Date.now() + 10_000;
        while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
        if (!ready()) throw new Error(`timed out waiting for ${what}`);
    };
    /** Held food is released by exactly one thing — a settlement — and never by a cancellation. */
    const heldOrders = (w: World) => [...w.store.orders.values()].filter((o) => o.status === 'fundraiser_hold').length;

    it('A. Record Payment during the cancel’s QuickBooks window LOSES: no PAID, no release, the cancel completes', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        let released!: () => void;
        w.qbo.failNext({ op: 'void', kind: 'gate', wait: new Promise<void>((r) => { released = r; }) });

        const cancelling = cancel(w, inv.id, docNumber);
        await until(() => lifecycle(w, inv.id).lease_id !== null && w.qbo.calls.some((c) => c.op === 'void'), 'the cancel to hold the lease inside the void');
        const settled = await recordPayment(w, inv.id);

        expect(settled).toEqual({ count: 0 });                       // the shared transition refused it
        expect(invoiceOf(w, inv.id).status).toBe('SENT');            // nothing was marked paid
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(heldOrders(w)).toBe(3);                               // and no food moved
        released();
        expect((await cancelling).outcome).toBe('canceled');
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(w.qbo.voids()).toHaveLength(1);
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('B. the verified QuickBooks payment check during that window LOSES too, and records nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.receivePayment({ invoiceId: qboId, amount: 451.59 }); // a real QuickBooks payment, mid-cancel
        let released!: () => void;
        w.qbo.failNext({ op: 'void', kind: 'gate', wait: new Promise<void>((r) => { released = r; }) });
        const cancelling = cancel(w, inv.id, docNumber);
        await new Promise((r) => setImmediate(r));

        const checked = await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps);

        expect(['needs_review', 'blocked', 'unavailable']).toContain(checked.outcome);
        expect(invoiceOf(w, inv.id).status).not.toBe('PAID');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(heldOrders(w)).toBe(3);
        released();
        await cancelling;
        // Whatever the cancel concluded, the two money truths never both won.
        expect(invoiceOf(w, inv.id).status === 'PAID' && (w.qbo.invoices.get(qboId).TotalAmt === 0)).toBe(false);
        expect(w.store.settlementWrites.filter((x) => x.count > 0)).toEqual([]);
        expect(heldOrders(w)).toBe(3);
    });

    it('B2. a QuickBooks payment that arrives BEFORE the cancel refuses the cancel outright — nothing is voided', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.receivePayment({ invoiceId: qboId, amount: 451.59 });
        expect((await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps)).outcome).toBe('paid');
        expect(invoiceOf(w, inv.id).status).toBe('PAID');

        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['invoice_paid'] });
        expect(w.qbo.voids()).toEqual([]);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
    });

    it('C. once CANCELED, neither Record Payment nor the QuickBooks check can settle it, and no food is released', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');

        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });
        expect(await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps)).toEqual({ outcome: 'blocked', blocker: 'invoice_not_sent' });
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(w.store.settlementWrites.filter((x) => x.count > 0)).toEqual([]);
        expect(heldOrders(w)).toBe(3);
    });

    it('D. started together: exactly one wins, and the two systems never disagree', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();

        const [cancelResult] = await Promise.all([cancel(w, inv.id, docNumber), recordPayment(w, inv.id)]);

        const invoice = invoiceOf(w, inv.id);
        const qboVoided = w.qbo.invoices.get(qboId).TotalAmt === 0;
        expect(['CANCELED', 'PAID']).toContain(invoice.status);
        if (invoice.status === 'CANCELED') {
            expect(cancelResult.outcome).toBe('canceled');
            expect(qboVoided).toBe(true);
            expect(invoice.paid_at ?? null).toBeNull();
            expect(heldOrders(w)).toBe(3);                       // no release
        } else {
            // The payment won — so QuickBooks must not have been touched at all. `cancel_conflict` is NOT a
            // legitimate resolution of this race: the post-lease re-read stands the cancellation down before it
            // can write anything external, so reaching a conflict here would mean the exclusion had failed.
            expect(cancelResult.outcome).not.toBe('canceled');
            expect(cancelResult).not.toEqual({ outcome: 'blocked', blockers: ['cancel_conflict'] });
            expect(qboVoided).toBe(false);
            expect(w.qbo.voids()).toHaveLength(0);
            expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        }
        expect(w.qbo.voids().length).toBeLessThanOrEqual(1);
    });

    it('the defensive detector: an UNSUPPORTED mutation after the void is reported as a conflict, never as success', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        // QuickBooks voids it, and in that instant the invoice is settled by something else (lease bypassed to
        // model the narrowest possible window: a settlement transaction that began before the lease was claimed).
        w.qbo.afterNext('void', () => {
            const row = invoiceOf(w, inv.id);
            w.store.invoices.set(inv.id, { ...row, status: 'PAID', paid_at: new Date(), payment_method: 'check' });
        });

        const result = await cancel(w, inv.id, docNumber);

        expect(result).toEqual({ outcome: 'blocked', blockers: ['cancel_conflict'] });
        expect(invoiceOf(w, inv.id).status).toBe('PAID');          // FreezerIQ's own truth is not overwritten
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);        // QuickBooks' truth is what it is
        const row = lifecycle(w, inv.id);
        expect(row.problem).toBe('cancel_conflict');               // and both are recorded for a person
        expect(row.problem_detail).toBe('invoice_status:PAID');
        expect(row.voided_at).toBeInstanceOf(Date);
        expect(row.lease_id).toBeNull();
        expect(w.qbo.voids()).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-CANCEL-1 · the external-write gap: voided in QuickBooks, interrupted before FreezerIQ', () => {
    it('a retry reconciles it with no second void, no needs_review and no manual repair', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        // The void reaches QuickBooks and FreezerIQ dies before its own write lands. Modelled exactly: the
        // cancellation runs, then everything FreezerIQ recorded about it is taken back, leaving the real-world
        // state an interrupted process leaves behind — QuickBooks void, FreezerIQ still SENT, lease released.
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        w.store.invoices.set(inv.id, { ...invoiceOf(w, inv.id), status: 'SENT' });
        w.store.sends.set(inv.id, { ...lifecycle(w, inv.id), voided_at: null, voided_by: null });
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);        // QuickBooks IS void
        expect(invoiceOf(w, inv.id).status).toBe('SENT');          // FreezerIQ never heard
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: null, lease_id: null });

        // The retry: reads QuickBooks first, sees it is already void, writes nothing there, finishes here.
        const retried = await cancel(w, inv.id, docNumber);

        expect(retried.outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);                     // never a second void
        expect(w.qbo.invoices.get(qboId).PrivateNote).not.toMatch(/Voided - Voided/);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: null });
        expect(lifecycle(w, inv.id).voided_at).toBeInstanceOf(Date);
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });
    it('while that gap is open, a payment cannot settle the invoice either', async () => {
        const { w, inv, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'lost' }); // voided in QuickBooks, answer lost — the cancel still finishes
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        // And from here the settlement transition refuses it twice over: CANCELED, and voided in QuickBooks.
        const inv2 = invoiceOf(w, inv.id);
        expect(await w.store.db.$transaction((tx: any) => settleInvoiceInTransaction(tx, {
            invoice: { id: inv2.id, campaign_id: inv2.campaign_id, customer_id: inv2.customer_id, total_amount: inv2.total_amount, customer: { type: 'fundraiser_org' } },
            businessId: BIZ, facts: { method: 'check', paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 9' }, fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }))).toEqual({ count: 0 });
        expect([...w.store.orders.values()].every((o) => o.status === 'fundraiser_hold')).toBe(true);
    });
});
// ═══════════════════════════════════════════════════════════════════════════
/**
 * QB-INVOICE-CANCEL-1 — THE TERMINAL INVARIANT, case by case, with the ordering forced at each barrier.
 *
 * Exactly one of these may ever be the outcome:
 *   A. PAID wins     -> the QuickBooks invoice is NOT voided;
 *   B. CANCELED wins -> nothing is settled and no food is released.
 * "QuickBooks voided + FreezerIQ PAID" is not a permitted terminal state, not even a surfaced one.
 *
 * Two mechanisms do it, and both are exercised here:
 *   1. the settlement transition LOCKS the invoice's QuickBooks lifecycle row (FOR UPDATE) before it decides, so a
 *      cancellation's lease claim — an UPDATE of that same row — cannot commit while a settlement is open;
 *   2. the cancellation re-reads the invoice AFTER claiming that lease, and only that read may authorize the void.
 */
describe('QB-INVOICE-CANCEL-1 · the terminal invariant, case by case', () => {
    const facts = { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' };
    const recordPayment = (w: World, invoiceId: string) => {
        const inv = invoiceOf(w, invoiceId);
        return w.store.db.$transaction((tx: any) => settleInvoiceInTransaction(tx, {
            invoice: { id: inv.id, campaign_id: inv.campaign_id, customer_id: inv.customer_id, total_amount: inv.total_amount, customer: { type: 'fundraiser_org' } },
            businessId: BIZ, facts, fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));
    };
    const held = (w: World) => [...w.store.orders.values()].filter((o) => o.status === 'fundraiser_hold').length;

    it('CASE 1 — settlement commits BEFORE the cancel lease: PAID, zero void calls, normal release', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect(await recordPayment(w, inv.id)).toEqual({ count: 1 });
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
        expect(held(w)).toBe(0); // the settlement's own release, exactly as before

        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['invoice_paid'] });
        expect(w.qbo.voids()).toHaveLength(0);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
    });

    it('CASE 2 — the cancel lease commits BEFORE a manual settlement: refused, one void, CANCELED, no release', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        let release!: () => void;
        w.qbo.failNext({ op: 'void', kind: 'gate', wait: new Promise<void>((r) => { release = r; }) });
        const cancelling = cancel(w, inv.id, docNumber);
        await until(() => lifecycle(w, inv.id).lease_id !== null && w.qbo.calls.some((c) => c.op === 'void'), 'the cancel to hold the lease inside the void');

        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });
        expect(w.store.lifecycleLocks).toContain(inv.id); // the transition DID take the lock, and then refused
        release();

        expect((await cancelling).outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(held(w)).toBe(3);
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    it('CASE 3 — the cancel lease commits BEFORE a verified QuickBooks settlement: refused, one void, CANCELED', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        let release!: () => void;
        w.qbo.failNext({ op: 'void', kind: 'gate', wait: new Promise<void>((r) => { release = r; }) });
        const cancelling = cancel(w, inv.id, docNumber);
        await until(() => lifecycle(w, inv.id).lease_id !== null && w.qbo.calls.some((c) => c.op === 'void'), 'the cancel to hold the lease inside the void');
        // Only now does QuickBooks show a payment — after the cancellation's own pre-void check, lease held.
        w.qbo.receivePayment({ invoiceId: qboId, amount: 451.59 });

        const checked = await checkQuickBooksInvoicePayment({ ...input(w, inv.id) }, w.deps);

        expect(checked.outcome).not.toBe('paid');
        expect(invoiceOf(w, inv.id).status).not.toBe('PAID');
        expect(w.store.settlementWrites.filter((x) => x.count > 0)).toEqual([]);
        expect(held(w)).toBe(3);
        release();
        await cancelling;
        expect(invoiceOf(w, inv.id).paid_at ?? null).toBeNull();
        expect(held(w)).toBe(3);
        expect(w.qbo.voids()).toHaveLength(1);
    });

    it('CASE 4 — the previously admitted gap: a stale pre-lease read cannot authorize a void after PAID wins', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        // The cancel's PRE-lease reads see SENT (they run first), and the settlement commits before the lease is
        // claimed — exactly the interleaving the earlier design admitted. The post-lease re-read is what stops it.
        const claimLease = w.store.sends.get(inv.id)!;
        let settledDuringClaim = false;
        w.store.sends.set(inv.id, new Proxy(claimLease, {
            get(target, prop) {
                // The moment the cancel reads this row to claim the lease, the settlement commits — the worst case
                // Postgres allows, because the claim had to wait for that transaction's lock to be released.
                if (prop === 'status' && !settledDuringClaim) {
                    settledDuringClaim = true;
                    const i = invoiceOf(w, inv.id);
                    w.store.invoices.set(inv.id, { ...i, status: 'PAID', paid_at: new Date(), payment_method: 'check', payment_reference: 'check 4021' });
                }
                return (target as any)[prop];
            },
        }) as any);

        const result = await cancel(w, inv.id, docNumber);

        expect(result).toEqual({ outcome: 'blocked', blockers: ['invoice_paid'] });
        expect(w.qbo.voids()).toHaveLength(0);                       // QuickBooks was never touched
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
        expect(lifecycle(w, inv.id).lease_id).toBeNull();            // and the lease was handed back
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
    });

    it('CASE 5 — crash after the void, before the local write: settlement stays blocked and a retry finishes it', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        // Take back everything FreezerIQ recorded, leaving what an interrupted process leaves: QuickBooks voided.
        w.store.invoices.set(inv.id, { ...invoiceOf(w, inv.id), status: 'SENT' });
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);

        // The gap is protected: the lifecycle still records the void, so no settlement can slip in.
        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(held(w)).toBe(3);

        // And the retry reconciles without a second void.
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(lifecycle(w, inv.id).problem).toBeNull();
    });

    it('CASE 6 — concurrent cancels: one void, one canceled invoice, the loser idempotent', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const both = await Promise.all([cancel(w, inv.id, docNumber), cancel(w, inv.id, docNumber)]);
        expect(both.some((r) => r.outcome === 'canceled')).toBe(true);
        for (const r of both) expect(['canceled', 'sent', 'in_progress', 'blocked']).toContain(r.outcome);
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });

    // The last way the forbidden pair could have been reached is not a race at all: a void that SUCCEEDED while
    // the cancellation was refused, leaving QuickBooks worth nothing and FreezerIQ still outstanding.
    it('a void that succeeded but failed its read-back contract still seals the invoice against PAID', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        // QuickBooks voids the invoice, and something is linked to it around the same moment: the read-back reads
        // as a void (nothing left on any line) but fails the dedicated contract on `void_no_linked_transaction`.
        w.qbo.afterNext('void', (qbo: any) => { qbo.LinkedTxn = [{ TxnId: '9001', TxnType: 'Payment' }]; });

        const result = await cancel(w, inv.id, docNumber);

        expect(result).toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        expect(invoiceOf(w, inv.id).status).toBe('SENT');                   // NOT canceled — the contract refused
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);                 // but QuickBooks IS void, irreversibly
        expect(lifecycle(w, inv.id).problem).toBe('verification_failed_voided');
        expect(lifecycle(w, inv.id).voided_at).toBeInstanceOf(Date);        // so the fact is recorded anyway…
        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });       // …and PAID is unreachable from here
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(held(w)).toBe(3);
    });

    it('and a cancellation QuickBooks refused outright leaves an ordinary, settleable invoice', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'fault200', code: '6240' }); // Intuit says no: definitively unwritten

        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('blocked');

        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);            // nothing was voided…
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();          // …nothing is recorded as voided…
        expect(lifecycle(w, inv.id).void_requested_at ?? null).toBeNull();  // …the decision is released…
        expect(await recordPayment(w, inv.id)).toEqual({ count: 1 });       // …and the invoice is settleable again
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
        expect(held(w)).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
/**
 * QB-INVOICE-CANCEL-1 — THE CRASH WINDOW.
 *
 * A QuickBooks void is irreversible, and FreezerIQ cannot write to two systems at once. So the DECISION to void
 * is committed here first — `void_requested_at`, before any QuickBooks request leaves — and from that moment the
 * shared settlement transition refuses this invoice outright. That intent does not expire and does not depend on
 * the process staying alive, which is the whole point: a lease lapses after two minutes, and a killed process
 * would otherwise leave an invoice looking collectible while QuickBooks held its copy void.
 *
 * `dieAt` models the process being killed at an exact point, the way a killed process actually behaves: the
 * QuickBooks request either never leaves ('before') or is processed and never answered for ('after'), and the
 * cancellation simply stops — it is abandoned mid-flight, so NOTHING it would have written afterwards is
 * written, not even an error path or a released lease. That is the worst case, and it is what these test.
 */
const isVoidCall = (url: string) => /\/invoice\?/.test(url) && /operation=void/.test(url);
const isInvoiceRead = (url: string) => /\/invoice\/\d+/.test(url);

/** Returns a predicate that becomes true once the process has been killed at that point. */
function dieAt(w: World, when: 'before' | 'after', match: (url: string) => boolean): () => boolean {
    const real = w.deps.fetchImpl;
    let fired = false;
    const gone = new Promise<never>(() => undefined); // never settles: there is no process left to settle it
    (w.deps as { fetchImpl: typeof real }).fetchImpl = (async (url: any, init?: any) => {
        const hit = !fired && match(String(url));
        if (hit && when === 'before') { fired = true; return gone; }
        const res = await (real as any)(url, init);
        if (hit) { fired = true; return gone; }
        return res;
    }) as typeof real;
    return () => fired;
}

/** Starts a cancellation that will be killed, and waits until it has been. Its promise never settles. */
async function killedCancellation(w: World, invoiceId: string, confirmation: string, killed: () => boolean) {
    void cancelQuickBooksInvoice({ ...input(w, invoiceId), userId: ADMIN_USER, confirmation }, w.deps)
        .catch(() => undefined);
    await until(killed, 'the cancellation to reach the point the process was killed at');
}

describe('QB-INVOICE-CANCEL-1 · the crash window: a decision QuickBooks may already have acted on', () => {
    const facts = { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' };
    const recordPayment = (w: World, invoiceId: string) => {
        const inv = invoiceOf(w, invoiceId);
        return w.store.db.$transaction((tx: any) => settleInvoiceInTransaction(tx, {
            invoice: { id: inv.id, campaign_id: inv.campaign_id, customer_id: inv.customer_id, total_amount: inv.total_amount, customer: { type: 'fundraiser_org' } },
            businessId: BIZ, facts, fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));
    };
    const checkPayment = (w: World, invoiceId: string) => checkQuickBooksInvoicePayment(input(w, invoiceId), w.deps);
    const held = (w: World) => [...w.store.orders.values()].filter((o) => o.status === 'fundraiser_hold').length;
    /** "Resume cancellation": the SAME idempotent path, carrying no confirmation — the intent already is one. */
    const resume = (w: World, invoiceId: string) => cancel(w, invoiceId, undefined);
    /** The two minutes pass. Whatever the lease was, it is now worth nothing. */
    const leaseLapses = (w: World, invoiceId: string) => {
        const row = lifecycle(w, invoiceId);
        w.store.sends.set(invoiceId, { ...row, lease_id: null, lease_until: null });
    };
    /** Everything a killed cancellation must leave behind, whatever it had already done in QuickBooks. */
    async function expectUnsettleableAndRecoverable(w: World, invoiceId: string, qboId: string, voidedInQuickBooks: boolean) {
        expect(lifecycle(w, invoiceId).void_requested_at).toBeInstanceOf(Date);   // the decision survived
        expect(lifecycle(w, invoiceId).void_requested_by).toBe(ADMIN_USER);
        expect(invoiceOf(w, invoiceId).status).toBe('SENT');                      // FreezerIQ never heard the outcome
        leaseLapses(w, invoiceId);

        // Neither way to become PAID may run, however long anyone waits.
        expect(await recordPayment(w, invoiceId)).toEqual({ count: 0 });
        expect((await checkPayment(w, invoiceId)).outcome).not.toBe('paid');
        expect(invoiceOf(w, invoiceId).status).toBe('SENT');
        expect(invoiceOf(w, invoiceId).paid_at ?? null).toBeNull();
        expect(held(w)).toBe(3);

        // …and the owner is not left with a database to repair: Resume cancellation finishes it.
        const voidsBefore = w.qbo.voids().length;
        expect((await resume(w, invoiceId)).outcome).toBe('canceled');
        expect(invoiceOf(w, invoiceId).status).toBe('CANCELED');
        expect(lifecycle(w, invoiceId).voided_at).toBeInstanceOf(Date);
        expect(lifecycle(w, invoiceId).problem).toBeNull();
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);
        expect(w.qbo.voids()).toHaveLength(voidedInQuickBooks ? voidsBefore : voidsBefore + 1);
        expect(w.qbo.invoices.get(qboId).PrivateNote).not.toMatch(/Voided - Voided/);
        expect(held(w)).toBe(3);
        expectNothingPaidOrReleased(w, invoiceId, qboId);
    }

    it('TEST 1 — killed after the decision is recorded, before QuickBooks is even read', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const readsAfterSending = w.qbo.reads().length;
        const killed = dieAt(w, 'before', isInvoiceRead);

        await killedCancellation(w, inv.id, docNumber, killed);

        expect(w.qbo.reads()).toHaveLength(readsAfterSending);       // the cancellation asked QuickBooks nothing
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);     // and holds the invoice exactly as it was
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        await expectUnsettleableAndRecoverable(w, inv.id, qboId, false);
    });

    it('TEST 2 — killed after reading QuickBooks, before the void is sent', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const killed = dieAt(w, 'before', isVoidCall);

        await killedCancellation(w, inv.id, docNumber, killed);

        expect(w.qbo.voids()).toHaveLength(0);                       // the void never left
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        await expectUnsettleableAndRecoverable(w, inv.id, qboId, false);
    });

    it('TEST 3 — killed the instant Intuit accepted the void, before FreezerIQ could record it', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const killed = dieAt(w, 'after', isVoidCall); // QuickBooks really did void it; FreezerIQ never saw the answer

        await killedCancellation(w, inv.id, docNumber, killed);

        expect(w.qbo.voids()).toHaveLength(1);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);          // QuickBooks IS void…
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();   // …and FreezerIQ has no record of it
        // THE window. Only the durable decision stands between this and QuickBooks voided + FreezerIQ PAID.
        await expectUnsettleableAndRecoverable(w, inv.id, qboId, true);
    });

    it('TEST 4 — killed after the read-back came back, before the FreezerIQ invoice was canceled', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const killed = dieAt(w, 'after', (url) => isInvoiceRead(url) && w.qbo.voids().length === 1); // the read-back itself

        await killedCancellation(w, inv.id, docNumber, killed);

        expect(w.qbo.voids()).toHaveLength(1);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);
        expect(lifecycle(w, inv.id).voided_at ?? null).toBeNull();
        await expectUnsettleableAndRecoverable(w, inv.id, qboId, true);
    });

    it('TEST 5 — Intuit refuses the void outright: the decision is released and the invoice is ordinary again', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'fault200', code: '6240' });

        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['update_rejected'] });

        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);              // definitively not written
        expect(lifecycle(w, inv.id)).toMatchObject({ void_requested_at: null, void_requested_by: null, voided_at: null });
        expect(lifecycle(w, inv.id).problem).toBe('void_rejected');
        expect(lifecycle(w, inv.id).lease_id).toBeNull();
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        // Normal operation resumes in full: the invoice can be collected.
        expect(await recordPayment(w, inv.id)).toEqual({ count: 1 });
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
        expect(held(w)).toBe(0);
    });

    it('TEST 6 — an ambiguous answer is NOT a refusal: the decision stands and Resume reconciles it', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        w.qbo.failNext({ op: 'void', kind: 'lost' }); // QuickBooks processed it; the answer never arrived

        const result = await cancel(w, inv.id, docNumber);

        // This particular one the read-back can finish on its own — QuickBooks reads back as a void.
        expect(result.outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');

        // And the case that cannot: the answer is lost AND the void never applied. Nothing is cleared, because
        // a read is not a receipt for a write that may still be in flight.
        const second = await sentInvoice();
        second.w.qbo.failNext({ op: 'void', kind: 'lost_before' });

        const stuck = await cancel(second.w, second.inv.id, second.docNumber);

        expect(stuck).toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        expect(lifecycle(second.w, second.inv.id).problem).toBe('verification_failed_voided');
        expect(lifecycle(second.w, second.inv.id).void_requested_at).toBeInstanceOf(Date); // the decision STANDS
        expect(lifecycle(second.w, second.inv.id).voided_at ?? null).toBeNull();
        expect(await recordPayment(second.w, second.inv.id)).toEqual({ count: 0 });        // and nothing settles
        // What the owner sees, and the one action offered.
        const view: any = await getQuickBooksInvoiceSendView(input(second.w, second.inv.id), second.w.deps);
        const dialog = sendDialogView(view);
        expect(dialog.title).toBe(CANCEL_PENDING_TITLE);
        expect(dialog.canResumeCancel).toBe(true);
        expect([dialog.canCheckPayment, dialog.canResend, dialog.canCancel, dialog.canCheckDelivery]).toEqual([false, false, false, false]);
        // Resume finishes it against the SAME QuickBooks invoice.
        expect((await resume(second.w, second.inv.id)).outcome).toBe('canceled');
        expect(second.w.qbo.voids()).toHaveLength(2); // two REQUESTS; the first never left, so one void applied
        expect(second.w.qbo.invoices.get(second.qboId).PrivateNote).not.toMatch(/Voided - Voided/);
        expect(second.w.qbo.invoices.get(second.qboId).TotalAmt).toBe(0);
        expect(invoiceOf(second.w, second.inv.id).status).toBe('CANCELED');
    });

    it('TEST 7 — a settlement that wins BEFORE the decision leaves no decision behind', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect(await recordPayment(w, inv.id)).toEqual({ count: 1 });
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
        expect(held(w)).toBe(0); // the settlement's own release, exactly as before

        expect(await cancel(w, inv.id, docNumber)).toEqual({ outcome: 'blocked', blockers: ['invoice_paid'] });

        expect(lifecycle(w, inv.id).void_requested_at ?? null).toBeNull(); // nothing unresolved is left behind
        expect(w.qbo.voids()).toHaveLength(0);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(451.59);
        expect(invoiceOf(w, inv.id).status).toBe('PAID');
    });

    it('TEST 8 — the decision wins first: the settlement refuses and the cancellation completes', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        let release!: () => void;
        w.qbo.failNext({ op: 'void', kind: 'gate', wait: new Promise<void>((r) => { release = r; }) });
        const cancelling = cancel(w, inv.id, docNumber);
        await until(() => (lifecycle(w, inv.id).void_requested_at ?? null) !== null && w.qbo.calls.some((c) => c.op === 'void'),
            'the cancellation to hold its recorded decision inside the void');

        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });
        expect((await checkPayment(w, inv.id)).outcome).not.toBe('paid');
        release();

        expect((await cancelling).outcome).toBe('canceled');
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expect(held(w)).toBe(3);
        expectNothingPaidOrReleased(w, inv.id, qboId);
    }, 20_000);

    it('TEST 9 — the lease expires while the decision is unresolved: the settlement is STILL refused', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        const killed = dieAt(w, 'after', isVoidCall);
        await killedCancellation(w, inv.id, docNumber, killed);

        // Not "the lease was released" — the lease is set, and then deliberately allowed to lapse.
        w.store.sends.set(inv.id, { ...lifecycle(w, inv.id), lease_id: 'dead-lease', lease_until: new Date(w.now() - 1) });
        expect(lifecycle(w, inv.id).lease_until!.getTime()).toBeLessThan(w.now());
        expect(lifecycle(w, inv.id).void_requested_at).toBeInstanceOf(Date);

        expect(await recordPayment(w, inv.id)).toEqual({ count: 0 });
        expect((await checkPayment(w, inv.id)).outcome).not.toBe('paid');
        expect(invoiceOf(w, inv.id).status).toBe('SENT');
        expect(held(w)).toBe(3);
        expect(w.qbo.invoices.get(qboId).TotalAmt).toBe(0);
    });

    it('TEST 10 — a retry of an invoice already canceled is idempotent and asks QuickBooks nothing', async () => {
        const { w, inv, qboId, docNumber } = await sentInvoice();
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');
        const calls = w.qbo.calls.length;

        expect((await resume(w, inv.id)).outcome).toBe('canceled');
        expect((await cancel(w, inv.id, docNumber)).outcome).toBe('canceled');

        expect(w.qbo.calls).toHaveLength(calls);       // not one request, of any kind
        expect(w.qbo.voids()).toHaveLength(1);
        expect(invoiceOf(w, inv.id).status).toBe('CANCELED');
        expectNothingPaidOrReleased(w, inv.id, qboId);
    });
});
