/**
 * QB-INVOICE-1D — "Check QuickBooks payment", executed end to end over the session-free service, the database double
 * and a QuickBooks double as strict as the Intuit sandbox (tests/helpers/quickbooksInvoiceFakes.ts).
 *
 * Every scenario starts from an invoice sent through the REAL 1C lifecycle (review → create → verify → recipients →
 * send → SENT), then has the ORGANIZATION do something in QuickBooks — pay, pay part, pay twice, overpay, have a credit
 * memo applied, have a payment voided — shaped exactly like the responses captured in the 1D sandbox shape spike.
 *
 * What these prove, in the owner's words:
 *   - Balance = 0 NEVER marks PAID by itself;
 *   - one exact, verified QuickBooks Payment runs the EXISTING settlement transition, from SENT, exactly once;
 *   - partial, multiple, credit-only, overpaid, voided, foreign or inconsistent payments change nothing;
 *   - fundraiser food is released exactly once, only by the settlement winner, only for this campaign;
 *   - the check never writes to QuickBooks, and no failure marks anything PAID.
 */

import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { checkQuickBooksInvoicePayment } from '@/lib/quickbooks/invoicePayment';
import { getQuickBooksInvoiceSendView, startQuickBooksInvoiceSend } from '@/lib/quickbooks/invoiceSend';
import { captureConsole } from './helpers/quickbooksFakes';
import { ADMIN_USER, BIZ, invoiceWorld, OTHER_BIZ, REALM_1, RECIPIENT, type World } from './helpers/quickbooksInvoiceWorld';

const worlds: World[] = [];
afterEach(() => {
    for (const w of worlds.splice(0)) expect(w.store.violations).toEqual([]);
});

async function world() {
    const w = await invoiceWorld({ settlement: true });
    worlds.push(w);
    return w;
}

const TOTAL = 451.59;

/** Sends the $451.59 fixture through the real 1C lifecycle and holds three supporter orders for its campaign. */
async function sentInvoice(w: World) {
    const inv = w.seedE2();
    const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: inv.id, config: w.config }, w.deps);
    expect(view.state).toBe('ready');
    const sent = await startQuickBooksInvoiceSend({
        businessId: BIZ, invoiceId: inv.id, config: w.config, userId: ADMIN_USER,
        reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null,
    }, w.deps);
    expect(sent.outcome).toBe('sent');
    expect(inv.status).toBe('SENT');
    const qboId = [...w.store.link.invoiceLinks.values()].find((l: any) => l.invoice_id === inv.id)!.qbo_invoice_id as string;
    const docNumber = w.store.sends.get(inv.id)!.qbo_doc_number as string;
    const held = w.store.seedHeldOrders(BIZ, inv.campaign_id!, 3);
    // Noise the release must never touch: another campaign's held order, and a canceled order of this campaign.
    const otherCampaign = w.store.seedHeldOrders(BIZ, 'another-campaign', 1);
    const canceled = w.store.seedHeldOrders(BIZ, inv.campaign_id!, 1, { canceled_at: new Date() });
    return { inv, qboId, docNumber, held, otherCampaign, canceled, writesAfterSend: w.qbo.writes().length };
}

const check = (w: World, invoiceId: string) => checkQuickBooksInvoicePayment({ businessId: BIZ, invoiceId, config: w.config }, w.deps);

/** Nothing financial moved in FreezerIQ, and nothing was written to QuickBooks by the check. */
function expectNothingSettled(w: World, s: Awaited<ReturnType<typeof sentInvoice>>) {
    expect(s.inv.status).toBe('SENT');
    expect(s.inv.paid_at).toBeNull();
    expect(s.inv.payment_method).toBeNull();
    expect(s.inv.payment_reference).toBeNull();
    expect(w.store.settlementWrites.filter((x) => x.count > 0)).toEqual([]);
    expect(w.store.orderWrites).toEqual([]);
    for (const o of [...s.held, ...s.otherCampaign, ...s.canceled]) expect(o.status).toBe('fundraiser_hold');
    expect(w.qbo.writes()).toHaveLength(s.writesAfterSend);
    expect(w.qbo.calls.filter((c) => c.op === 'payment_write')).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · eligibility', () => {
    it('5. a DRAFT invoice is refused before QuickBooks is contacted', async () => {
        const w = await world();
        const inv = w.seedE2();
        expect(await check(w, inv.id)).toEqual({ outcome: 'blocked', blocker: 'invoice_not_sent' });
        expect(w.qbo.calls).toEqual([]);
        expect(w.store.settlementWrites).toEqual([]);
    });

    it('6. a SENT invoice that was never sent through QuickBooks is refused, and nothing is read from QuickBooks', async () => {
        const w = await world();
        const inv = w.seedE2({ status: 'SENT' });
        expect(await check(w, inv.id)).toEqual({ outcome: 'blocked', blocker: 'not_sent_via_quickbooks' });
        expect(w.qbo.calls).toEqual([]);
    });

    it('7. a QuickBooks link from an EARLIER connection generation is refused (Forget, then reconnect)', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.store.link.forget(BIZ);
        w.intuit.consentTo(REALM_1);
        const tokens = await exchangeAuthorizationCode(w.config, 'AUTHCODE-2', w.intuit.fetchImpl);
        expect(await saveAuthorizedConnection({ businessId: BIZ, realmId: REALM_1, tokens, config: w.config, authorizedByUserId: ADMIN_USER }, w.deps)).toBe('connected');
        const readsBefore = w.qbo.reads().length;
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'blocked', blocker: 'linked_to_another_connection' });
        expect(w.qbo.reads()).toHaveLength(readsBefore);
        expectNothingSettled(w, s);
    });

    it('a tenant with no QuickBooks connection is refused', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.store.link.forget(BIZ);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'blocked', blocker: 'not_connected' });
        expectNothingSettled(w, s);
    });

    it('3. another tenant’s invoice is not found — nothing is read', async () => {
        const w = await world();
        const other = w.store.seedInvoice({ business_id: OTHER_BIZ, customer_id: w.store.seedOrganization(OTHER_BIZ, 'Other Org'), status: 'SENT' });
        await expect(check(w, other.id)).rejects.toThrow('Invoice not found for this tenant');
        expect(w.qbo.calls).toEqual([]);
    });

    it('8. an invoice already PAID answers already_paid without contacting QuickBooks and releases nothing', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        Object.assign(s.inv, { status: 'PAID', paid_at: new Date('2026-09-20T12:00:00Z'), payment_method: 'check', payment_reference: '1001' });
        const callsBefore = w.qbo.calls.length;
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'already_paid', settlement: { method: 'check', paidOn: '2026-09-20', reference: '1001' } });
        expect(w.qbo.calls).toHaveLength(callsBefore);
        expect(w.store.orderWrites).toEqual([]);
    });

    it('the FreezerIQ invoice changed since it was sent → needs review, nothing read or written', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        s.inv.items[1].description = 'Date Night (Serves 2) — edited';
        const readsBefore = w.qbo.reads().length;
        expect(await check(w, s.inv.id)).toMatchObject({ outcome: 'needs_review', reason: 'changed_since_review' });
        expect(w.qbo.reads()).toHaveLength(readsBefore);
        expectNothingSettled(w, s);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · the QuickBooks invoice must still be the one FreezerIQ created', () => {
    it('9. a QuickBooks invoice that no longer exists → needs review', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.invoices.delete(s.qboId);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'qbo_invoice_missing' });
        expectNothingSettled(w, s);
    });

    it.each([
        ['10. a different DocNumber', (inv: any) => { inv.DocNumber = '9999'; }, 'doc_number_unchanged'],
        ['11. a different customer', (inv: any) => { inv.CustomerRef = { value: '999' }; }, 'customer'],
        ['12. a different total', (inv: any) => { inv.TotalAmt = 451.6; }, 'total_equals_freezeriq_total'],
        ['13. a different currency', (inv: any) => { inv.CurrencyRef = { value: 'CAD' }; }, 'currency_usd'],
        ['an edited line', (inv: any) => { inv.Line[0].Description = 'Changed in QuickBooks'; }, 'line_1_bundle_description'],
        ['native tax added', (inv: any) => { inv.TxnTaxDetail = { TotalTax: 3.2, TxnTaxCodeRef: { value: '2' } }; }, 'no_quickbooks_tax'],
    ])('%s → needs review, never settled — even when a full payment is linked', async (_label, tamper, failedCheck) => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.tamper(s.qboId, tamper);
        const result: any = await check(w, s.inv.id);
        expect(result.outcome).toBe('needs_review');
        expect(result.reason).toBe('qbo_invoice_changed');
        expect(result.detail.split(',')).toContain(failedCheck);
        expect(w.qbo.paymentReads()).toEqual([]); // the payment is never even read
        expectNothingSettled(w, s);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · unpaid and partially paid', () => {
    it('14. Balance = TotalAmt → not paid; no FreezerIQ write of any kind', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'not_paid' });
        expect(w.qbo.paymentReads()).toEqual([]);
        expectNothingSettled(w, s);
    });

    it('15. a partial payment → partially paid with what is still due; nothing recorded', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: 200 });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'partially_paid', balanceDue: 251.59 });
        expectNothingSettled(w, s);
    });

    it('a voided payment returns the balance: not paid, nothing recorded (spike D)', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const p = w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.voidPayment(p);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'not_paid' });
        expectNothingSettled(w, s);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · BALANCE ZERO IS NOT PAYMENT', () => {
    it('16. Balance 0 with no payment linked (a write-off / adjustment) → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.tamper(s.qboId, (inv) => { inv.Balance = 0; });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'no_payment_evidence' });
        expectNothingSettled(w, s);
    });

    it('17. Balance 0 from a CREDIT MEMO — which QuickBooks shows as one linked "Payment" — → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.applyCreditMemo({ invoiceId: s.qboId, amount: TOTAL });
        const qboInvoice = w.qbo.invoices.get(s.qboId);
        expect(qboInvoice.Balance).toBe(0);
        expect(qboInvoice.LinkedTxn).toEqual([{ TxnId: expect.any(String), TxnType: 'Payment' }]); // the trap, exactly as observed
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_includes_other_transactions' });
        expect(w.qbo.paymentReads()).toHaveLength(1); // it took reading the Payment to see through it
        expectNothingSettled(w, s);
    });

    it('18. Balance 0 with an unsupported linked transaction → NOT PAID, no payment read', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.tamper(s.qboId, (inv) => { inv.Balance = 0; inv.LinkedTxn = [{ TxnId: '77', TxnType: 'JournalEntry' }]; });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'unsupported_linked_transaction' });
        expect(w.qbo.paymentReads()).toEqual([]);
        expectNothingSettled(w, s);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · the one payment', () => {
    it('19. a linked payment that is applied to ANOTHER invoice → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const p = w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.tamperPayment(p, (pay) => { pay.Line[0].LinkedTxn[0].TxnId = '99999'; });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_not_for_this_invoice' });
        expectNothingSettled(w, s);
    });

    it('20. a payment whose allocation here is partial → NOT PAID, even on a zero balance', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const p = w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.tamperPayment(p, (pay) => { pay.Line[0].Amount = 200; });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_amount_mismatch' });
        expectNothingSettled(w, s);
    });

    it('21. a payment larger than the invoice (overpayment, part unapplied) → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, total: 500 });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_unapplied_amount' });
        expectNothingSettled(w, s);
    });

    it('22. two payments that together pay it in full → NOT PAID in 1D', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: 200 });
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: 251.59 });
        expect(w.qbo.invoices.get(s.qboId).Balance).toBe(0);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'multiple_payments' });
        expect(w.qbo.paymentReads()).toEqual([]);
        expectNothingSettled(w, s);
    });

    it('one payment that also covers another invoice → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const other = w.seedE2();
        const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: other.id, config: w.config }, w.deps);
        await startQuickBooksInvoiceSend({ businessId: BIZ, invoiceId: other.id, config: w.config, userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
        const otherQbo = [...w.store.link.invoiceLinks.values()].find((l: any) => l.invoice_id === other.id)!.qbo_invoice_id as string;
        const writes = w.qbo.writes().length;
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, alsoApplyTo: [{ invoiceId: otherQbo, amount: TOTAL }] });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_includes_other_transactions' });
        expect(s.inv.status).toBe('SENT');
        expect(w.qbo.writes()).toHaveLength(writes);
    });

    it('another customer’s payment → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, customerId: '4242' });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_customer_mismatch' });
        expectNothingSettled(w, s);
    });

    it('37. the linked payment no longer exists (deleted in QuickBooks) → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const p = w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.payments.delete(p);
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_missing' });
        expectNothingSettled(w, s);
    });

    it('a future-dated payment → NOT PAID', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, txnDate: '2099-01-01' });
        expect(await check(w, s.inv.id)).toEqual({ outcome: 'needs_review', reason: 'payment_date_invalid' });
        expectNothingSettled(w, s);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · one exact full payment settles through the EXISTING transition, exactly once', () => {
    it('23–28. marks PAID via QuickBooks Payments with the payment’s own date and reference, and releases this campaign’s held food once', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const paymentId = w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, txnDate: '2026-09-20' });

        const result = await check(w, s.inv.id);
        const reference = `QuickBooks payment ${paymentId} · invoice #${s.docNumber}`;
        expect(result).toEqual({ outcome: 'paid', settlement: { method: 'quickbooks', paidOn: '2026-09-20', reference } });

        // 24–26: the settlement facts, stored by the shared transition.
        expect(s.inv.status).toBe('PAID');
        expect(s.inv.payment_method).toBe('quickbooks');
        expect(s.inv.payment_reference).toBe(reference);
        expect(s.inv.paid_at).toEqual(new Date('2026-09-20T12:00:00.000Z'));
        expect(s.inv.payment_reference).not.toMatch(/9130000000000001|ACCESSTOKEN|REFRESHTOKEN/);

        // 27: ONE conditional transition, from SENT only.
        expect(w.store.settlementWrites).toEqual([{
            where: { id: s.inv.id, business_id: BIZ, status: { in: ['SENT'] } },
            data: { status: 'PAID', paid_at: new Date('2026-09-20T12:00:00.000Z'), payment_method: 'quickbooks', payment_reference: reference },
            count: 1,
        }]);
        // 28: the release — this campaign's three held orders, never another campaign's, never a canceled one.
        expect(w.store.orderWrites).toEqual([{
            where: { campaign_id: s.inv.campaign_id, business_id: BIZ, source: 'fundraiser', status: 'fundraiser_hold', canceled_at: null },
            data: { status: 'production_ready' },
            count: 3,
        }]);
        for (const o of s.held) expect(o.status).toBe('production_ready');
        for (const o of [...s.otherCampaign, ...s.canceled]) expect(o.status).toBe('fundraiser_hold');

        // The FreezerIQ invoice's money was never part of any write.
        expect(s.inv.total_amount).toBe('451.59');
        // Not one QuickBooks write.
        expect(w.qbo.writes()).toHaveLength(s.writesAfterSend);
        expect(w.qbo.paymentReads()).toHaveLength(1);
    });

    it('29. a second identical check is idempotent: already paid, no QuickBooks call, no second release', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, txnDate: '2026-09-20' });
        expect((await check(w, s.inv.id)).outcome).toBe('paid');
        const callsAfterFirst = w.qbo.calls.length;
        expect(await check(w, s.inv.id)).toMatchObject({ outcome: 'already_paid', settlement: { method: 'quickbooks', paidOn: '2026-09-20' } });
        expect(w.qbo.calls).toHaveLength(callsAfterFirst);
        expect(w.store.orderWrites).toHaveLength(1);
        expect(w.store.settlementWrites).toHaveLength(1);
    });

    it('30. two concurrent checks settle ONCE: one paid, one already_paid, one release', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL, txnDate: '2026-09-20' });
        const results = await Promise.all([check(w, s.inv.id), check(w, s.inv.id)]);
        expect(results.map((r) => r.outcome).sort()).toEqual(['already_paid', 'paid']);
        expect(w.store.settlementWrites.map((x) => x.count).sort()).toEqual([0, 1]);
        expect(w.store.orderWrites).toHaveLength(1);
        expect(s.held.every((o) => o.status === 'production_ready')).toBe(true);
    });

    it('a Record Payment that lands first wins; the QuickBooks check then reports it and releases nothing more', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        // A human recorded a check between the QuickBooks read and the settlement.
        w.qbo.afterNext('payment_read' as any, () => {
            Object.assign(s.inv, { status: 'PAID', paid_at: new Date('2026-09-19T12:00:00Z'), payment_method: 'check', payment_reference: 'ck-7' });
        });
        const result = await check(w, s.inv.id);
        expect(result).toEqual({ outcome: 'already_paid', settlement: { method: 'check', paidOn: '2026-09-19', reference: 'ck-7' } });
        expect(w.store.settlementWrites.map((x) => x.count)).toEqual([0]);
        expect(w.store.orderWrites).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · QuickBooks failures never mark anything PAID', () => {
    it('33. a rejected access token is refreshed once and the check completes', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.intuit.expireAllAccessTokens();
        expect((await check(w, s.inv.id)).outcome).toBe('paid');
        expect(w.qbo.writes()).toHaveLength(s.writesAfterSend);
    });

    it.each([
        ['34. 429 on the invoice read', { op: 'read', kind: 'status', status: 429 }],
        ['35. 5xx on the invoice read', { op: 'read', kind: 'status', status: 503 }],
        ['35. 5xx on the payment read', { op: 'payment_read', kind: 'status', status: 500 }],
        ['36. a malformed invoice response', { op: 'read', kind: 'malformed' }],
        ['36. a malformed payment response', { op: 'payment_read', kind: 'malformed' }],
        ['a network failure on the payment read', { op: 'payment_read', kind: 'lost_before' }],
        ['a 200 carrying a Fault', { op: 'payment_read', kind: 'fault200' }],
    ])('%s → unavailable; nothing settled; the log carries Intuit’s sanitized detail and no secret', async (_label, failure) => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.failNext(failure as any);
        const { result, output } = await captureConsole(() => check(w, s.inv.id));
        expect(result).toEqual({ outcome: 'unavailable' });
        expect(output).toMatch(/invoice payment check unavailable: kind:/);
        expect(output).not.toMatch(/ACCESSTOKEN|REFRESHTOKEN|TESTCLIENTSECRET|TESTTOKENKEY|9130000000000001|Lincoln PTA|coordinator@/);
        expectNothingSettled(w, s);
    });

    it('38. an Intuit failure logs its intuit_tid (the sanitized correlation id), and only that', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.failNext({ op: 'read', kind: 'status', status: 503 });
        const { output } = await captureConsole(() => check(w, s.inv.id));
        expect(output).toMatch(/kind:http,http:503,fault:10000,tid:tid-\d+/);
        expectNothingSettled(w, s);
    });

    it('39. after any failure, the next check can still settle the same payment normally', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: TOTAL });
        w.qbo.failNext({ op: 'payment_read', kind: 'status', status: 500 });
        expect((await check(w, s.inv.id)).outcome).toBe('unavailable');
        expect(s.inv.status).toBe('SENT');
        expect((await check(w, s.inv.id)).outcome).toBe('paid');
        expect(w.store.orderWrites).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1D · read-only against QuickBooks', () => {
    it('40. across every outcome the check issues only GETs — no invoice update or send, and no payment write', async () => {
        const w = await world();
        const s = await sentInvoice(w);
        const before = w.qbo.calls.length;
        await check(w, s.inv.id);                                            // not paid
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: 100 });
        await check(w, s.inv.id);                                            // partial
        w.qbo.receivePayment({ invoiceId: s.qboId, amount: 351.59 });
        await check(w, s.inv.id);                                            // multiple → review
        const mine = w.qbo.calls.slice(before);
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((c) => c.method === 'GET')).toBe(true);
        expect(new Set(mine.map((c) => c.op))).toEqual(new Set(['read']));
        expect(w.qbo.calls.filter((c) => c.op === 'payment_write')).toEqual([]);
    });
});
