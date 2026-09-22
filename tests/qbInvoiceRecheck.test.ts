/**
 * QB-QBO-TAX-RESUME — the ONE repair a stopped QuickBooks send allows.
 *
 * `needs_review` stays terminal, with a single exception: a send the CREATE-stage read-back stopped on an invoice
 * QuickBooks had already accepted. For that state, and only that state, the owner may ask FreezerIQ to re-read the
 * SAME QuickBooks invoice and run the contract again.
 *
 * What these prove, in the owner's words:
 *   - the repair NEVER creates a second QuickBooks invoice — the existing id is required, reused, and the create
 *     endpoint is never called from this path, not on a first recheck, a repeat, or two at once;
 *   - it never emails anything either: a match hands the SAME lifecycle back to the normal send workflow at its
 *     post-create step, which the owner still finishes with the existing Resume — the send semantics are untouched;
 *   - a recheck that still fails leaves the lifecycle stopped, the FreezerIQ invoice not-SENT, nothing sent;
 *   - every other stopped state — a later stage's failure, a lifecycle with no recorded QuickBooks id, one from an
 *     earlier connection generation, an invoice that is no longer a draft — is refused, with no QuickBooks call.
 */

import {
    getQuickBooksInvoiceSendView,
    LEASE_MS,
    recheckQuickBooksInvoiceCreate,
    resumeQuickBooksInvoiceSend,
    startQuickBooksInvoiceSend,
} from '@/lib/quickbooks/invoiceSend';
import { invoiceCreateRequestId } from '@/lib/quickbooks/invoiceLinks';
import { ADMIN_USER, BIZ, invoiceWorld, RECIPIENT, type World, type WorldOptions } from './helpers/quickbooksInvoiceWorld';

const worlds: World[] = [];
afterEach(() => {
    for (const w of worlds.splice(0)) expect(w.store.violations).toEqual([]);
});

async function world(options: WorldOptions = {}) {
    const w = await invoiceWorld(options);
    worlds.push(w);
    return w;
}

const input = (w: World, invoiceId: string) => ({ businessId: BIZ, invoiceId, config: w.config });
const act = (w: World, invoiceId: string) => ({ ...input(w, invoiceId), userId: ADMIN_USER });
const recheck = (w: World, invoiceId: string) => recheckQuickBooksInvoiceCreate(act(w, invoiceId), w.deps);
const lifecycle = (w: World, invoiceId: string) => w.store.sends.get(invoiceId)!;
const linkOf = (w: World, invoiceId: string) => [...w.store.link.invoiceLinks.values()].find((l) => l.invoice_id === invoiceId)!;

async function send(w: World, invoiceId: string) {
    const view: any = await getQuickBooksInvoiceSendView(input(w, invoiceId), w.deps);
    expect(view.state).toBe('ready');
    return startQuickBooksInvoiceSend({ ...act(w, invoiceId), reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
}

/**
 * QuickBooks' own sales tax, worth money, on the invoice it just created: the create-stage read-back refuses it and
 * the lifecycle stops — exactly the state a recheck may act on, with the QuickBooks invoice kept.
 */
async function stoppedAtCreate(options: WorldOptions = {}) {
    const w = await world(options);
    const inv = w.seedE2();
    w.qbo.afterNext('create', (i) => { i.TxnTaxDetail = { TotalTax: 5.59, TxnTaxCodeRef: { value: '7' }, TaxLine: [{ Amount: 5.59 }] }; });
    const result = await send(w, inv.id);
    expect(result.outcome).toBe('needs_review');
    expect(lifecycle(w, inv.id)).toMatchObject({ status: 'needs_review', problem: 'verification_failed_created', send_count: 0, sent_at: null });
    const qboId = [...w.qbo.invoices.keys()][0];
    expect(w.qbo.invoices.size).toBe(1);
    expect(linkOf(w, inv.id).qbo_invoice_id).toBe(qboId);
    return { w, inv, qboId };
}

/** QuickBooks settles its automated tax to the zero-value metadata a non-taxable invoice really carries. */
const settleTaxToZero = (w: World, qboId: string) => w.qbo.tamper(qboId, (i: any) => {
    i.TxnTaxDetail = { TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [{ Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '5' }, NetAmountTaxable: 0 } }] };
});

/** Nothing was emailed, the FreezerIQ invoice is untouched, and QuickBooks still holds exactly one invoice. */
function expectNothingSent(w: World, invoiceId: string, qboId: string) {
    expect(w.qbo.sent).toEqual([]);
    expect(w.qbo.sends()).toHaveLength(0);
    expect(w.qbo.creates()).toHaveLength(1);
    expect(w.qbo.invoices.size).toBe(1);
    expect([...w.qbo.invoices.keys()]).toEqual([qboId]);
    expect(w.store.invoices.get(invoiceId)!.status).toBe('DRAFT');
    expect(w.store.invoiceWrites).toEqual([]);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-QBO-TAX-RESUME · only a create-stage stop may be rechecked', () => {
    it('18. the eligible stop offers the recheck; the lifecycle itself says so', async () => {
        const { w, inv } = await stoppedAtCreate();
        expect(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps))
            .toMatchObject({ state: 'needs_review', problem: 'verification_failed_created', recheckable: true });
    });

    it('13. a draft that never reached QuickBooks is sent, never "repaired"', async () => {
        const w = await world();
        const inv = w.seedE2();
        // No lifecycle at all: there is nothing in QuickBooks to re-read.
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] });
        // A create whose answer was lost twice: paused at `reserved`, no recorded id — the normal path's business,
        // not a repair's, even though QuickBooks did create the invoice.
        w.qbo.failNext({ op: 'create', kind: 'lost' });
        w.qbo.failNext({ op: 'create', kind: 'lost' });
        expect(await send(w, inv.id)).toMatchObject({ outcome: 'in_progress', view: { step: 'reserved', problem: 'create_outcome_unknown' } });
        expect(linkOf(w, inv.id).qbo_invoice_id).toBeNull();
        const creates = w.qbo.creates().length;
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
        expect(w.qbo.creates()).toHaveLength(creates); // the repair called nothing at all
        // The normal path still owns this state: resume replays the SAME requestid and adopts the one invoice.
        expect((await resumeQuickBooksInvoiceSend(act(w, inv.id), w.deps)).outcome).toBe('sent');
        expect(w.qbo.invoices.size).toBe(1);
        expect(new Set(w.qbo.creates().map((c) => c.requestId))).toEqual(new Set([invoiceCreateRequestId(inv.id)]));
    });

    it('14. a stop from a LATER stage is not recheckable — the repair is the create stage’s alone', async () => {
        const w = await world();
        const inv = w.seedE2();
        // QuickBooks keeps a different recipient than the one FreezerIQ set: the recipients stage stops.
        w.qbo.afterNext('update', (i) => { i.BillEmail = { Address: 'someone-else@example.invalid' }; });
        expect((await send(w, inv.id)).outcome).toBe('needs_review');
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'needs_review', problem: 'verification_failed_recipients' });
        const qboId = [...w.qbo.invoices.keys()][0];
        expect(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)).toMatchObject({ state: 'needs_review', recheckable: false });
        const reads = w.qbo.reads().length;
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
        expect(w.qbo.reads()).toHaveLength(reads); // refused before QuickBooks was touched
        expectNothingSent(w, inv.id, qboId);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'needs_review', problem: 'verification_failed_recipients' });
    });

    it('15. a create-stage stop with NO recorded QuickBooks id is not recheckable (there is nothing to re-read)', async () => {
        const { w, inv, qboId } = await stoppedAtCreate();
        const link = linkOf(w, inv.id);
        w.store.link.invoiceLinks.set(link.id, { ...link, qbo_invoice_id: null, qbo_linked_at: null });
        const reads = w.qbo.reads().length;
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
        expect(w.qbo.reads()).toHaveLength(reads);
        expectNothingSent(w, inv.id, qboId);
    });

    it('16. a create-stage stop linked to an EARLIER connection generation is refused', async () => {
        const { w, inv, qboId } = await stoppedAtCreate();
        const link = linkOf(w, inv.id);
        const otherGeneration = [...w.store.link.connections.values()].find((c: any) => c.id !== w.generationId)
            ?? { ...[...w.store.link.connections.values()][0], id: 'generation-from-before' };
        w.store.link.connections.set(otherGeneration.id, { ...otherGeneration, live_business_id: null } as any);
        w.store.link.invoiceLinks.set(link.id, { ...link, connection_id: otherGeneration.id });
        const reads = w.qbo.reads().length;
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['linked_to_another_connection'] });
        expect(w.qbo.reads()).toHaveLength(reads);
        expectNothingSent(w, inv.id, qboId);
    });

    it('17. a FreezerIQ invoice that is no longer a draft is refused', async () => {
        for (const status of ['SENT', 'PAID', 'CANCELED']) {
            const { w, inv, qboId } = await stoppedAtCreate();
            w.store.invoices.set(inv.id, { ...w.store.invoices.get(inv.id)!, status });
            const reads = w.qbo.reads().length;
            expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['invoice_not_draft'] });
            expect(w.qbo.reads()).toHaveLength(reads);
            expect(w.qbo.sent).toEqual([]);
            expect(w.qbo.creates()).toHaveLength(1);
            expect([...w.qbo.invoices.keys()]).toEqual([qboId]);
        }
    });

    it('a stopped lifecycle whose send was already recorded is never recheckable', async () => {
        const { w, inv } = await stoppedAtCreate();
        const row = lifecycle(w, inv.id);
        w.store.sends.set(inv.id, { ...row, send_count: 1 });
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
        w.store.sends.set(inv.id, { ...row, send_count: 0, sent_at: new Date(w.now()) });
        expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-QBO-TAX-RESUME · the recheck reads the SAME invoice and never creates one', () => {
    it('19–22. a matching recheck returns the lifecycle to its post-create step: same invoice, same requestid, nothing sent', async () => {
        const { w, inv, qboId } = await stoppedAtCreate({ online: { card: true, ach: true } });
        settleTaxToZero(w, qboId);
        const writes = w.qbo.writes().length;

        const result = await recheck(w, inv.id);

        expect(result).toMatchObject({ outcome: 'in_progress', view: { state: 'in_progress', step: 'created', problem: null, problemDetail: null } });
        // 19 · not one QuickBooks WRITE of any kind — the recheck is a read.
        expect(w.qbo.writes()).toHaveLength(writes);
        expect(w.qbo.creates()).toHaveLength(1);
        // 20/21 · the same QuickBooks invoice, under the same link and the same deterministic requestid.
        expect(linkOf(w, inv.id)).toMatchObject({ qbo_invoice_id: qboId, connection_id: w.generationId, request_id: invoiceCreateRequestId(inv.id) });
        expect(w.qbo.creates()[0].requestId).toBe(invoiceCreateRequestId(inv.id));
        // 22 · the SAME lifecycle row, now verified at the create stage and no longer carrying a problem.
        expect(lifecycle(w, inv.id)).toMatchObject({
            status: 'created', problem: null, problem_detail: null, problem_at: null,
            recipient_to: RECIPIENT, send_count: 0, sent_at: null, lease_id: null,
            qbo_doc_number: w.qbo.invoices.get(qboId).DocNumber,
        });
        expectNothingSent(w, inv.id, qboId);
    });

    it('22. the owner’s existing Resume finishes the SAME invoice — card and ACH as reviewed, one invoice, one send', async () => {
        const { w, inv, qboId } = await stoppedAtCreate({ online: { card: true, ach: true } });
        settleTaxToZero(w, qboId);
        expect((await recheck(w, inv.id)).outcome).toBe('in_progress');
        // Nothing has been emailed by the repair itself: the send still takes the owner's own action.
        expect(w.qbo.sent).toEqual([]);

        expect((await resumeQuickBooksInvoiceSend(act(w, inv.id), w.deps)).outcome).toBe('sent');

        const qbo = w.qbo.invoices.get(qboId);
        expect(w.qbo.invoices.size).toBe(1);
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.sent).toMatchObject([{ invoiceId: qboId, to: RECIPIENT, cc: null }]);
        expect(qbo).toMatchObject({ AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false });
        expect(qbo.SalesTermRef.value).toBe(w.terms.net15.Id); // the reviewed term, unchanged by the repair
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', send_count: 1, problem: null });
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
    });

    it('23. a recheck that still does not match stays stopped, and says what failed this time', async () => {
            const { w, inv, qboId } = await stoppedAtCreate();
            const writes = w.qbo.writes().length;
            const result = await recheck(w, inv.id);
            expect(result).toMatchObject({ outcome: 'needs_review', view: { state: 'needs_review', problem: 'verification_failed_created', recheckable: true } });
            expect((result as any).view.problemDetail).toContain('quickbooks_tax_did_not_affect_total');
            expect(w.qbo.writes()).toHaveLength(writes);
            expectNothingSent(w, inv.id, qboId);
            expect(lifecycle(w, inv.id)).toMatchObject({ status: 'needs_review', lease_id: null });
            // The repair is still offered: the owner can correct QuickBooks and ask again.
            expect(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)).toMatchObject({ state: 'needs_review', recheckable: true });
    });

    it('24. rechecking repeatedly is idempotent: reads only, one invoice, and the last answer wins', async () => {
            const { w, inv, qboId } = await stoppedAtCreate();
            const writes = w.qbo.writes().length;
            for (let i = 0; i < 3; i++) expect((await recheck(w, inv.id)).outcome).toBe('needs_review');
            expect(w.qbo.writes()).toHaveLength(writes);
            expect(w.qbo.reads().length).toBeGreaterThanOrEqual(3);

            settleTaxToZero(w, qboId);
            expect((await recheck(w, inv.id)).outcome).toBe('in_progress');
            // A recheck of an already-repaired lifecycle is not a repair any more: it is refused, and changes nothing.
            expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
            expect(lifecycle(w, inv.id)).toMatchObject({ status: 'created', problem: null });
            expectNothingSent(w, inv.id, qboId);
    });

    it('25. two rechecks at once: one drives it, the other sees it busy — never two invoices, never a send', async () => {
        const { w, inv, qboId } = await stoppedAtCreate();
        settleTaxToZero(w, qboId);
        const writes = w.qbo.writes().length;

        const both = await Promise.all([recheck(w, inv.id), recheck(w, inv.id)]);

        // Exactly one request holds the lease and repairs it; the other reports the lifecycle as it stands when it
        // looks — in progress, still stopped, or no longer repairable — and drives nothing of its own.
        expect(both.some((r) => r.outcome === 'in_progress')).toBe(true);
        for (const r of both) {
            expect(['in_progress', 'needs_review', 'blocked']).toContain(r.outcome);
            if (r.outcome === 'blocked') expect(r.blockers).toEqual(['recheck_not_available']);
        }
        expect(w.qbo.writes()).toHaveLength(writes);
        expect(w.qbo.creates()).toHaveLength(1);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'created', problem: null });
        expectNothingSent(w, inv.id, qboId);
    });

    it('a recheck while another request holds the lease changes nothing until the lease expires', async () => {
        const { w, inv, qboId } = await stoppedAtCreate();
        settleTaxToZero(w, qboId);
        const row = lifecycle(w, inv.id);
        w.store.sends.set(inv.id, { ...row, lease_id: 'someone-else', lease_until: new Date(w.now() + LEASE_MS) });
        const reads = w.qbo.reads().length;
        expect((await recheck(w, inv.id)).outcome).toBe('needs_review');
        expect(w.qbo.reads()).toHaveLength(reads);
        expect(lifecycle(w, inv.id).status).toBe('needs_review');

        w.clock.offsetMs = LEASE_MS + 1000;
        expect((await recheck(w, inv.id)).outcome).toBe('in_progress');
        expect(lifecycle(w, inv.id).status).toBe('created');
        expectNothingSent(w, inv.id, qboId);
    });

    it('the QuickBooks invoice having vanished stops the lifecycle for good — and creates nothing in its place', async () => {
            const { w, inv, qboId } = await stoppedAtCreate();
            w.qbo.invoices.delete(qboId);
            expect(await recheck(w, inv.id)).toMatchObject({ outcome: 'needs_review', view: { problem: 'qbo_invoice_missing', recheckable: false } });
            expect(w.qbo.creates()).toHaveLength(1);
            expect(w.qbo.invoices.size).toBe(0);
            // Terminal from here: the repair is no longer offered.
            expect(await recheck(w, inv.id)).toEqual({ outcome: 'blocked', blockers: ['recheck_not_available'] });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-QBO-TAX-RESUME · a company on Automated Sales Tax sends normally', () => {
    /**
     * The Production shape this release exists for: QuickBooks stamps its own zero-value tax metadata onto an
     * invoice FreezerIQ created with wholly non-taxable lines. It changes no amount, so the send must simply work —
     * no stop, no repair, and FreezerIQ's own supporter-tax line still proven to the cent.
     */
    it('30. zero-value automated tax metadata does not stop the send, and never touches the money', async () => {
        const w = await world({ online: { card: true, ach: true } });
        const inv = w.seedE2();
        w.qbo.afterNext('create', (i) => {
            i.TxnTaxDetail = { TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [{ Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '5' }, PercentBased: true, TaxPercent: 1, NetAmountTaxable: 0 } }] };
        });

        expect((await send(w, inv.id)).outcome).toBe('sent');

        const qboId = [...w.qbo.invoices.keys()][0];
        const qbo = w.qbo.invoices.get(qboId);
        expect(w.qbo.invoices.size).toBe(1);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: null, send_count: 1 });
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
        // FreezerIQ's numbers, untouched by QuickBooks' own tax: total, the supporter-tax line, and every NON line.
        expect(qbo.TotalAmt).toBe(451.59);
        expect(qbo.TxnTaxDetail.TotalTax).toBe(0);
        expect(qbo.Line.filter((l: any) => l.SalesItemLineDetail).map((l: any) => l.Amount)).toEqual([437.5, 120, -111.5, 5.59]);
        expect(qbo.Line.filter((l: any) => l.SalesItemLineDetail).every((l: any) => l.SalesItemLineDetail.TaxCodeRef.value === 'NON')).toBe(true);
    });
});
