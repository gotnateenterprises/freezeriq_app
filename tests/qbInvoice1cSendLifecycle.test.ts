/**
 * QB-INVOICE-1C — "Send via QuickBooks", executed end to end over the session-free service, the database double
 * and a QuickBooks double as strict as the Intuit sandbox where send safety depends on it
 * (tests/helpers/quickbooksInvoiceFakes.ts).
 *
 * What these prove, in the owner's words:
 *   - one QuickBooks invoice per FreezerIQ invoice, created UNSENT (no recipient, EmailStatus NotSet, all four
 *     payment flags false, no DocNumber), with a deterministic requestid — never a second one, not on a double
 *     click, a lost response, a stopped lifecycle or a resend;
 *   - every step is read back and verified before the next; any mismatch stops before anything is sent, keeps the
 *     QuickBooks invoice, and leaves the FreezerIQ invoice not-SENT;
 *   - recipients and payment options are applied only after the financial read-back, with all four flags restated
 *     on every update (a partial update would silently re-enable them);
 *   - QuickBooks' own auto-send during payment configuration is detected, verified and recorded — Send is never
 *     called after it; otherwise the explicit Send is verified;
 *   - SENT is recorded only then, atomically with the lifecycle, and only from DRAFT;
 *   - delivery problems are followed up on the SAME invoice without touching PAID.
 */

import {
    checkQuickBooksInvoiceDelivery,
    CREATE_RETRY_WINDOW_MS,
    getQuickBooksInvoiceSendView,
    LEASE_MS,
    resendQuickBooksInvoice,
    resumeQuickBooksInvoiceSend,
    startQuickBooksInvoiceSend,
} from '@/lib/quickbooks/invoiceSend';
import { invoiceCreateRequestId } from '@/lib/quickbooks/invoiceLinks';
import { captureConsole } from './helpers/quickbooksFakes';
import { ADMIN_USER, BIZ, CC, invoiceWorld, OTHER_BIZ, RECIPIENT, type World, type WorldOptions } from './helpers/quickbooksInvoiceWorld';

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

async function review(w: World, invoiceId: string) {
    const view: any = await getQuickBooksInvoiceSendView(input(w, invoiceId), w.deps);
    expect(view.state).toBe('ready');
    return view;
}

async function send(w: World, invoiceId: string, recipients: { to?: unknown; cc?: unknown } = {}) {
    const view = await review(w, invoiceId);
    return startQuickBooksInvoiceSend({
        ...input(w, invoiceId), userId: ADMIN_USER, reviewToken: view.reviewToken,
        recipientTo: 'to' in recipients ? recipients.to : RECIPIENT, recipientCc: 'cc' in recipients ? recipients.cc : null,
    }, w.deps);
}

const lifecycle = (w: World, invoiceId: string) => w.store.sends.get(invoiceId);
const FLAGS = ['AllowOnlineCreditCardPayment', 'AllowOnlineACHPayment', 'AllowOnlinePayPalPayment', 'AllowOnlineAffirmPayment'];

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · the review shows exactly what QuickBooks will get', () => {
    it('the $451.59 rounding fixture: bundles pre-tax on the sales item, −$111.50 share, $5.59 supporter tax, and nothing sent or written', async () => {
        const w = await world();
        const inv = w.seedE2();
        const view = await review(w, inv.id);
        expect(view.preview).toEqual({
            quickBooksCustomerName: 'Lincoln PTA',
            txnDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            lines: [
                { role: 'bundle', description: 'Family Friendly — Serves 5', quantity: 7, unitPrice: 62.5, amount: 437.5 },
                { role: 'bundle', description: 'Date Night (Serves 2)', quantity: 2, unitPrice: 60, amount: 120 },
                { role: 'share', description: 'Organization fundraiser share — 20%', quantity: 1, unitPrice: -111.5, amount: -111.5 },
                { role: 'tax', description: 'Sales tax collected from supporters — 1%', quantity: 1, unitPrice: 5.59, amount: 5.59 },
            ],
            totals: { bundles: 557.5, share: 111.5, tax: 5.59, total: 451.59 },
            memo: null,
        });
        expect(view.suggestedRecipient).toBe(RECIPIENT);
        expect(view.suggestedRecipientSource).toBe('organization'); // no coordinator assigned in this world
        expect(view.payment).toEqual({ card: false, ach: false });
        expect(w.qbo.writes()).toEqual([]);
        expect(w.store.link.invoiceLinks.size).toBe(0);
        expect(w.store.sends.size).toBe(0);
    });
});

describe('QB-INVOICE-1C · recipients: the campaign coordinator (overridable) plus optional CCs', () => {
    it('suggests the campaign’s assigned coordinator; an ended relationship falls back to the organization contact; the tenant’s default CC is prefilled', async () => {
        const w = await world({ defaultCc: 'books@freezer-chef.example' });
        const inv = w.seedE2();
        w.store.assignCoordinator(inv.campaign_id!, { name: 'Pat Coordinator', email: ' Pat.Coordinator@Lincoln-PTA.example ' });
        expect(await review(w, inv.id)).toMatchObject({ suggestedRecipient: 'pat.coordinator@lincoln-pta.example', suggestedRecipientSource: 'assigned', suggestedCc: 'books@freezer-chef.example' });
        w.store.assignCoordinator(inv.campaign_id!, { name: 'Pat Coordinator', email: 'pat.coordinator@lincoln-pta.example', ended: true });
        expect(await review(w, inv.id)).toMatchObject({ suggestedRecipient: RECIPIENT, suggestedRecipientSource: 'organization' });
        // The suggestion is only a suggestion: the tenant sends to whoever they review.
        const view = await review(w, inv.id);
        const result = await startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: 'Treasurer@Lincoln-PTA.example', recipientCc: null }, w.deps);
        expect(result.outcome).toBe('sent');
        expect(w.qbo.sent).toMatchObject([{ to: 'treasurer@lincoln-pta.example', cc: null }]);
    });

    it('a comma-separated CC list is written and read back exactly', async () => {
        const w = await world();
        const inv = w.seedE2();
        const result = await send(w, inv.id, { cc: `${CC}, Books@Freezer-Chef.example` });
        expect(result.outcome).toBe('sent');
        expect(w.qbo.updates()[0].body.BillEmailCc).toEqual({ Address: `${CC}, books@freezer-chef.example` });
        expect(w.qbo.sent).toMatchObject([{ to: RECIPIENT, cc: `${CC}, books@freezer-chef.example` }]);
        expect(lifecycle(w, inv.id)!.recipient_cc).toBe(`${CC}, books@freezer-chef.example`);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · explicit Send branch', () => {
    it('creates ONE unsent invoice, verifies it, adds recipients with every flag false, sends it, and only then marks FreezerIQ SENT', async () => {
        const w = await world();
        const inv = w.seedE2();
        const result = await send(w, inv.id, { cc: CC });
        expect(result.outcome).toBe('sent');

        // CREATE: unsent, no recipient, all four flags false, no DocNumber, the deterministic requestid.
        const [create] = w.qbo.creates();
        expect(w.qbo.creates()).toHaveLength(1);
        expect(create.requestId).toBe(invoiceCreateRequestId(inv.id));
        expect(create.body).toEqual({
            CustomerRef: { value: w.qboCustomer.Id },
            TxnDate: expect.any(String),
            SalesTermRef: { value: w.terms.net15.Id },
            PrivateNote: `FreezerIQ fundraiser invoice ${inv.id}`,
            EmailStatus: 'NotSet',
            AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
            Line: [
                { DetailType: 'SalesItemLineDetail', Amount: 437.5, Description: 'Family Friendly — Serves 5', SalesItemLineDetail: { ItemRef: { value: w.items.sales.Id }, Qty: 7, UnitPrice: 62.5, TaxCodeRef: { value: 'NON' } } },
                { DetailType: 'SalesItemLineDetail', Amount: 120, Description: 'Date Night (Serves 2)', SalesItemLineDetail: { ItemRef: { value: w.items.sales.Id }, Qty: 2, UnitPrice: 60, TaxCodeRef: { value: 'NON' } } },
                { DetailType: 'SalesItemLineDetail', Amount: -111.5, Description: 'Organization fundraiser share — 20%', SalesItemLineDetail: { ItemRef: { value: w.items.share.Id }, Qty: 1, UnitPrice: -111.5, TaxCodeRef: { value: 'NON' } } },
                { DetailType: 'SalesItemLineDetail', Amount: 5.59, Description: 'Sales tax collected from supporters — 1%', SalesItemLineDetail: { ItemRef: { value: w.items.tax.Id }, Qty: 1, UnitPrice: 5.59, TaxCodeRef: { value: 'NON' } } },
            ],
        });

        // RECIPIENTS: one sparse update, recipients + all four flags restated false, nothing financial.
        expect(w.qbo.updates()).toHaveLength(1);
        const [update] = w.qbo.updates();
        expect(Object.keys(update.body).sort()).toEqual(['AllowOnlineACHPayment', 'AllowOnlineAffirmPayment', 'AllowOnlineCreditCardPayment', 'AllowOnlinePayPalPayment', 'BillEmail', 'BillEmailCc', 'Id', 'SyncToken', 'sparse']);
        expect(update.body).toMatchObject({ BillEmail: { Address: RECIPIENT }, BillEmailCc: { Address: CC }, sparse: true });
        for (const f of FLAGS) expect(update.body[f]).toBe(false);

        // SEND: explicit, on the same invoice, to its own recipients (never a sendTo override).
        expect(w.qbo.sends()).toHaveLength(1);
        expect(w.qbo.sends()[0].search).not.toMatch(/sendTo/i);
        expect(w.qbo.sent).toEqual([{ invoiceId: [...w.qbo.invoices.keys()][0], to: RECIPIENT, cc: CC, bcc: null, at: expect.any(String), auto: false }]);

        // Every write was preceded by a read-back.
        expect(w.qbo.calls.filter((c) => ['create', 'read', 'update', 'send'].includes(c.op)).map((c) => c.op))
            .toEqual(['create', 'read', 'read', 'update', 'read', 'read', 'read', 'send', 'read']);

        // QuickBooks holds exactly FreezerIQ's total.
        const qboInvoice = [...w.qbo.invoices.values()][0];
        expect(qboInvoice).toMatchObject({ TotalAmt: 451.59, Balance: 451.59, EmailStatus: 'EmailSent' });
        expect(qboInvoice.TotalAmt.toFixed(2)).toBe(inv.total_amount);

        // FreezerIQ: SENT, written once, only from DRAFT, inside the lifecycle transaction.
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
        expect(w.store.invoiceWrites).toEqual([{ where: { id: inv.id, business_id: BIZ, status: 'DRAFT' }, data: { status: 'SENT' }, inTransaction: true }]);
        expect(lifecycle(w, inv.id)).toMatchObject({
            status: 'sent', send_count: 1, auto_sent: false, recipient_to: RECIPIENT, recipient_cc: CC,
            qbo_doc_number: qboInvoice.DocNumber, qbo_sync_token: qboInvoice.SyncToken, sent_at: expect.any(Date), sent_by: ADMIN_USER,
            lease_id: null, lease_until: null, problem: null,
        });
        // The link records ONLY the id from FreezerIQ's own create.
        expect([...w.store.link.invoiceLinks.values()]).toMatchObject([{ invoice_id: inv.id, connection_id: w.generationId, qbo_invoice_id: qboInvoice.Id, request_id: invoiceCreateRequestId(inv.id) }]);
        expect(result).toMatchObject({ view: { state: 'sent', docNumber: qboInvoice.DocNumber, autoSent: false, sendCount: 1 } });
    });

    it('a tax-exempt invoice carries the exempt memo and no tax line; a zero share carries no share line', async () => {
        const w = await world();
        const inv = w.seedE2({ tax_amount: '0.00', tax_status: 'TAX_EXEMPT', tax_rate_percent: null, fundraiser_profit_amount: '0.00', fundraiser_profit_percent: '0.00', total_amount: '557.50' });
        expect((await send(w, inv.id)).outcome).toBe('sent');
        const body = w.qbo.creates()[0].body;
        expect(body.CustomerMemo).toEqual({ value: 'Tax exempt — documentation on file.' });
        expect(body.Line.map((l: any) => l.Description)).toEqual(['Family Friendly — Serves 5', 'Date Night (Serves 2)']);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · online payment options and QuickBooks auto-send', () => {
    it('BRANCH B: QuickBooks emails the invoice when the verified card/ACH options are applied — recorded as the send, Send never called', async () => {
        const w = await world({ online: { card: true, ach: true }, autoSend: true });
        const inv = w.seedE2();
        const result = await send(w, inv.id);
        expect(result.outcome).toBe('sent');
        expect(w.qbo.sends()).toHaveLength(0);
        expect(w.qbo.sent).toMatchObject([{ to: RECIPIENT, auto: true }]);
        const [recipients, payment] = w.qbo.updates().map((u) => u.body);
        for (const f of FLAGS) expect(recipients[f]).toBe(false); // recipients first, flags still off
        expect(payment).toMatchObject({ BillEmail: { Address: RECIPIENT }, AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false });
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', auto_sent: true, send_count: 1 });
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
        expect(result).toMatchObject({ view: { state: 'sent', autoSent: true } });
    });

    it('BRANCH A: options applied and still NotSet → explicit Send, verified', async () => {
        const w = await world({ online: { card: true, ach: false }, autoSend: false });
        const inv = w.seedE2();
        expect((await send(w, inv.id)).outcome).toBe('sent');
        expect(w.qbo.sends()).toHaveLength(1);
        expect(w.qbo.updates().map((u) => [u.body.AllowOnlineCreditCardPayment, u.body.AllowOnlineACHPayment])).toEqual([[false, false], [true, false]]);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', auto_sent: false });
    });

    it('no payment options: no second update, explicit Send', async () => {
        const w = await world({ autoSend: true }); // autosend cannot trigger: card and ACH stay false
        const inv = w.seedE2();
        expect((await send(w, inv.id)).outcome).toBe('sent');
        expect(w.qbo.updates()).toHaveLength(1);
        expect(w.qbo.sent).toMatchObject([{ auto: false }]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · idempotency and concurrency', () => {
    it('a repeat click after sent answers sent and touches QuickBooks no further', async () => {
        const w = await world();
        const inv = w.seedE2();
        const first: any = await send(w, inv.id);
        const writes = w.qbo.writes().length;
        const again = await startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: 'a'.repeat(64), recipientTo: RECIPIENT, recipientCc: null }, w.deps);
        expect(again).toMatchObject({ outcome: 'sent', view: { state: 'sent', docNumber: first.view.docNumber } });
        expect(w.qbo.writes()).toHaveLength(writes);
    });

    it('double click: concurrent sends create exactly ONE QuickBooks invoice and email it once', async () => {
        const w = await world();
        const inv = w.seedE2();
        const view = await review(w, inv.id);
        const click = () => startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
        const results = await Promise.all([click(), click(), click()]);
        expect(results.map((r) => r.outcome).filter((o) => o === 'sent').length).toBeGreaterThanOrEqual(1);
        for (const r of results) expect(['sent', 'in_progress']).toContain(r.outcome);
        expect(w.qbo.invoices.size).toBe(1);
        expect(new Set(w.qbo.creates().map((c) => c.requestId))).toEqual(new Set([invoiceCreateRequestId(inv.id)]));
        expect(w.qbo.sent).toHaveLength(1);
        expect(w.store.link.invoiceLinks.size).toBe(1);
        expect(w.store.sends.size).toBe(1);
        expect(w.store.invoiceWrites).toHaveLength(1);
    });

    it('a lost create response is replayed with the SAME requestid: the one invoice QuickBooks created is recorded and used', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'create', kind: 'lost' });
        expect((await send(w, inv.id)).outcome).toBe('sent');
        expect(w.qbo.creates()).toHaveLength(2);
        expect(new Set(w.qbo.creates().map((c) => c.requestId)).size).toBe(1);
        expect(w.qbo.invoices.size).toBe(1);
        expect(w.qbo.sent).toHaveLength(1);
    });

    it('a create lost twice pauses; resume continues with the SAME requestid and the existing link, never a second invoice', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'create', kind: 'lost' });
        w.qbo.failNext({ op: 'create', kind: 'lost' });
        const paused = await send(w, inv.id);
        expect(paused).toMatchObject({ outcome: 'in_progress', view: { state: 'in_progress', step: 'reserved', problem: 'create_outcome_unknown', busy: false } });
        expect(w.store.invoices.get(inv.id)!.status).toBe('DRAFT');
        expect(w.qbo.invoices.size).toBe(1); // QuickBooks did create it; FreezerIQ has not seen the answer

        const resumed = await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps);
        expect(resumed.outcome).toBe('sent');
        expect(w.qbo.invoices.size).toBe(1);
        expect(new Set(w.qbo.creates().map((c) => c.requestId))).toEqual(new Set([invoiceCreateRequestId(inv.id)]));
        expect(w.store.link.invoiceLinks.size).toBe(1);
    });

    it('past the create retry window, an unconfirmed create stops for review instead of being retried', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'create', kind: 'lost_before' });
        w.qbo.failNext({ op: 'create', kind: 'lost_before' });
        expect((await send(w, inv.id)).outcome).toBe('in_progress');
        const creates = w.qbo.creates().length;
        w.clock.offsetMs = CREATE_RETRY_WINDOW_MS + 60_000;
        const later = await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps);
        expect(later).toMatchObject({ outcome: 'needs_review', view: { state: 'needs_review', problem: 'create_outcome_unknown' } });
        expect(w.qbo.creates()).toHaveLength(creates);
        expect(w.qbo.invoices.size).toBe(0);
        // Stopped means stopped: another click changes nothing and creates nothing.
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('needs_review');
        expect(w.qbo.creates()).toHaveLength(creates);
    });

    it('a lifecycle another request is driving answers in_progress and makes no QuickBooks write; an expired lease can be taken over', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'create', kind: 'lost_before' });
        w.qbo.failNext({ op: 'create', kind: 'lost_before' });
        await send(w, inv.id); // paused at reserved
        const row = lifecycle(w, inv.id);
        w.store.sends.set(inv.id, { ...row, lease_id: 'someone-else', lease_until: new Date(w.now() + LEASE_MS) });
        const writes = w.qbo.writes().length;
        expect(await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).toMatchObject({ outcome: 'in_progress', view: { busy: true } });
        expect(w.qbo.writes()).toHaveLength(writes);
        w.clock.offsetMs = LEASE_MS + 1000;
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('sent');
        expect(w.qbo.invoices.size).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · fail-closed read-back: stop, send nothing, keep the invoice, never create another', () => {
    async function stoppedBy(tamper: (w: World) => void, options: WorldOptions = {}) {
        const w = await world(options);
        const inv = w.seedE2();
        tamper(w);
        const result = await send(w, inv.id);
        expect(result.outcome).toBe('needs_review');
        expect(w.qbo.sent).toEqual([]);
        expect(w.qbo.sends()).toHaveLength(0);
        expect(w.store.invoices.get(inv.id)!.status).toBe('DRAFT');
        expect(w.store.invoiceWrites).toEqual([]);
        expect(w.qbo.invoices.size).toBe(1);
        // Another attempt stays stopped and creates nothing.
        const again = await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps);
        expect(again.outcome).toBe('needs_review');
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.invoices.size).toBe(1);
        return { w, inv, view: (result as any).view };
    }

    it('QuickBooks sales tax appearing on the created invoice', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('create', (i) => { i.TxnTaxDetail = { TxnTaxCodeRef: { value: '2' }, TotalTax: 5.59, TaxLine: [{ Amount: 5.59 }] }; }));
        expect(view).toMatchObject({ problem: 'verification_failed_created', problemDetail: expect.stringContaining('quickbooks_tax_did_not_affect_total') });
    });

    it('an unexpected taxable line', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('create', (i) => { i.Line[0].SalesItemLineDetail.TaxCodeRef.value = 'TAX'; }));
        expect(view.problemDetail).toContain('line_1_bundle_non_taxable');
    });

    it('a line re-pointed to another account (ItemAccountRef)', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('create', (i) => { i.Line[2].SalesItemLineDetail.ItemAccountRef.value = w.accounts.expense.Id; }));
        expect(view.problemDetail).toContain('line_3_share_posting_account');
    });

    it('a one-cent drift in QuickBooks’ total', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('create', (i) => { i.TotalAmt = 451.6; i.Balance = 451.6; }));
        expect(view.problemDetail).toContain('total_equals_freezeriq_total');
    });

    it('a recipient that does not read back exactly', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('update', (i) => { i.BillEmail = { Address: 'someone-else@example.invalid' }; }));
        expect(view).toMatchObject({ problem: 'verification_failed_recipients', problemDetail: expect.stringContaining('recipient') });
    });

    it('an unexpected BCC after the recipient update', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('update', (i) => { i.BillEmailBcc = { Address: 'hidden@example.invalid' }; }));
        expect(view.problemDetail).toContain('no_bcc');
    });

    it('a payment flag re-enabled behind FreezerIQ’s back after the recipient update', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('update', (i) => { i.AllowOnlineCreditCardPayment = true; }));
        expect(view.problemDetail).toContain('payment_flags_all_false');
    });

    it('QuickBooks reporting the invoice emailed when no online options were applied (unexpected send) — never Send again', async () => {
        const { w } = await stoppedBy((w) => w.qbo.afterNext('update', (i) => {
            i.EmailStatus = 'EmailSent';
            i.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: new Date().toISOString() };
        }));
        expect(w.qbo.sends()).toHaveLength(0);
    });

    it('a company-wide default CC copied onto the created invoice (the setting was added in QuickBooks after the gate read it)', async () => {
        const { view } = await stoppedBy((w) => w.qbo.afterNext('create', (i) => { i.BillEmailCc = { Address: 'bookkeeper@example.invalid' }; }));
        expect(view.problemDetail).toContain('no_cc_at_create');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · a failed send reuses the same invoice', () => {
    it('Send refused with 5xx and not sent → paused; resume emails the SAME invoice once', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'send', kind: 'status', status: 503 });
        const paused = await send(w, inv.id);
        expect(paused).toMatchObject({ outcome: 'in_progress', view: { step: 'payment_options_set', problem: 'send_outcome_unknown' } });
        expect(w.store.invoices.get(inv.id)!.status).toBe('DRAFT');
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('sent');
        expect(w.qbo.invoices.size).toBe(1);
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.sent).toHaveLength(1);
    });

    it('Send refused with a validation Fault → paused (send_rejected); resume emails the same invoice', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'send', kind: 'status', status: 400, code: '6000' });
        // The detail is the sanitized Intuit record kept for support: reason, HTTP status, Fault code and
        // Intuit's own correlation id (Intuit App Assessment, Error Handling Q3).
        const refused: any = await send(w, inv.id);
        expect(refused).toMatchObject({ outcome: 'in_progress', view: { problem: 'send_rejected' } });
        expect(refused.view.problemDetail).toMatch(/^kind:rejected,http:400,fault:6000,tid:tid-\d+$/);
        expect(lifecycle(w, inv.id)!.send_requested_at).toBeNull();
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('sent');
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.sent).toHaveLength(1);
    });

    it('the Send response is lost after QuickBooks emailed: the read-back shows it sent, and it is never emailed twice', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'send', kind: 'lost' });
        expect((await send(w, inv.id)).outcome).toBe('sent');
        expect(w.qbo.sent).toHaveLength(1);
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
    });

    it('a stale SyncToken on the recipient update writes nothing and pauses; resume re-reads and continues', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'update', kind: 'status', status: 400, code: '5010' });
        expect(await send(w, inv.id)).toMatchObject({ outcome: 'in_progress', view: { step: 'created', problem: 'stale_object' } });
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('sent');
        expect(w.qbo.creates()).toHaveLength(1);
    });

    it('QuickBooks unreachable mid-lifecycle pauses at the last verified step', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'update', kind: 'lost_before' });
        expect(await send(w, inv.id)).toMatchObject({ outcome: 'in_progress', view: { step: 'created', problem: 'update_outcome_unknown' } });
        expect((await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).outcome).toBe('sent');
        expect(w.qbo.updates().filter((u) => u.body).length).toBe(2);
        expect(w.qbo.sent).toHaveLength(1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · the pre-create gate', () => {
    it('refuses without writing anything: not a draft, not a fundraiser invoice, no settings, customer not linked or inactive, company default CC, custom numbering, non-US company', async () => {
        const cases: Array<[string, (w: World) => string, string]> = [
            ['not draft', (w) => w.seedE2({ status: 'SENT' }).id, 'invoice_not_draft'],
            ['paid', (w) => w.seedE2({ status: 'PAID' }).id, 'invoice_not_draft'],
            ['manual invoice', (w) => w.seedE2({ campaign_id: null }).id, 'invoice_not_campaign'],
            ['customer inactive', (w) => { w.customers.setActive('9130000000000001', w.qboCustomer.Id, false); return w.seedE2().id; }, 'customer_link_invalid'],
            ['customer not linked', (w) => { w.store.link.links.clear(); return w.seedE2().id; }, 'customer_not_linked'],
            ['company CC', (w) => { w.qbo.prefs.defaultCc = 'bookkeeper@example.invalid'; return w.seedE2().id; }, 'company_default_cc'],
            ['company BCC', (w) => { w.qbo.prefs.defaultBcc = 'hidden@example.invalid'; return w.seedE2().id; }, 'company_default_bcc'],
            ['custom numbering', (w) => { w.qbo.prefs.customTxnNumbers = true; return w.seedE2().id; }, 'custom_transaction_numbers'],
            ['sales item re-pointed in QuickBooks', (w) => { w.qbo.item(w.items.sales.Id)!.IncomeAccountRef = { value: w.accounts.services.Id }; return w.seedE2().id; }, 'sales_item_account_changed'],
            ['share item inactive', (w) => { w.qbo.item(w.items.share.Id)!.Active = false; return w.seedE2().id; }, 'share_item_unavailable'],
            ['term days changed', (w) => { w.qbo.term(w.terms.net15.Id)!.DueDays = 30; return w.seedE2().id; }, 'term_changed'],
            ['line does not reconcile', (w) => w.seedE2({ items: [{ id: 'x', description: 'Family Friendly', variant_size: 'serves_5', quantity: '7.00', unit_price: '62.50', total: '437.49' }, { id: 'y', description: 'Date Night (Serves 2)', variant_size: 'serves_2', quantity: '2.00', unit_price: '60.00', total: '120.00' }] }).id, 'line_does_not_reconcile'],
            ['one-cent invoice drift', (w) => w.seedE2({ total_amount: '451.60' }).id, 'invoice_does_not_reconcile'],
        ];
        for (const [name, arrange, blocker] of cases) {
            const w = await world();
            const id = arrange(w);
            const view: any = await getQuickBooksInvoiceSendView(input(w, id), w.deps);
            expect({ name, view }).toEqual({ name, view: { state: 'blocked', blockers: [blocker] } });
            const result = await startQuickBooksInvoiceSend({ ...input(w, id), userId: ADMIN_USER, reviewToken: 'b'.repeat(64), recipientTo: RECIPIENT, recipientCc: null }, w.deps);
            expect({ name, result }).toEqual({ name, result: { outcome: 'blocked', blockers: [blocker] } });
            expect({ name, writes: w.qbo.writes().length, links: w.store.link.invoiceLinks.size, sends: w.store.sends.size }).toEqual({ name, writes: 0, links: 0, sends: 0 });
        }
    });

    it('missing settings and a non-US company block too', async () => {
        const w = await world({ noSettings: true });
        const inv = w.seedE2();
        expect(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)).toEqual({ state: 'blocked', blockers: ['settings_missing'] });
        const w2 = await world();
        const inv2 = w2.seedE2();
        const originalFetch = w2.deps.fetchImpl;
        (w2.deps as any).fetchImpl = async (url: string, init?: RequestInit) => {
            const res = await originalFetch(url, init);
            if (!url.includes('/companyinfo/')) return res;
            const body = await res.json();
            return new Response(JSON.stringify({ ...body, CompanyInfo: { ...body.CompanyInfo, Country: 'CA' } }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        expect(await getQuickBooksInvoiceSendView(input(w2, inv2.id), w2.deps)).toEqual({ state: 'blocked', blockers: ['not_us_company'] });
    });

    it('financial values changed after review: the click is stale and nothing is written', async () => {
        const w = await world();
        const inv = w.seedE2();
        const view = await review(w, inv.id);
        const row = w.store.invoices.get(inv.id)!;
        row.tax_amount = '5.60';
        row.total_amount = '451.60';
        const result = await startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
        expect(result).toMatchObject({ outcome: 'stale', view: { state: 'ready' } });
        expect((result as any).view.reviewToken).not.toBe(view.reviewToken);
        expect(w.qbo.writes()).toEqual([]);
        expect(w.store.sends.size).toBe(0);
        expect(w.store.link.invoiceLinks.size).toBe(0);
    });

    it('payment options changed after review: stale', async () => {
        const w = await world();
        const inv = w.seedE2();
        const view = await review(w, inv.id);
        w.store.settings.get(BIZ).allow_online_card = true;
        const result = await startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
        expect(result.outcome).toBe('stale');
        expect(w.qbo.writes()).toEqual([]);
    });

    it('invalid recipients and review tokens are refused before anything happens', async () => {
        const w = await world();
        const inv = w.seedE2();
        const view = await review(w, inv.id);
        const attempt = (over: Record<string, unknown>) => startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null, ...over }, w.deps);
        expect(await attempt({ recipientTo: 'not an email' })).toEqual({ outcome: 'invalid', reason: 'recipient' });
        expect(await attempt({ recipientTo: `${'a'.repeat(95)}@x.example` })).toEqual({ outcome: 'invalid', reason: 'recipient' });
        expect(await attempt({ recipientTo: 'a@example.invalid, b@example.invalid' })).toEqual({ outcome: 'invalid', reason: 'recipient' });
        expect(await attempt({ recipientCc: 'a@example.invalid, not-an-email' })).toEqual({ outcome: 'invalid', reason: 'cc' });
        expect(await attempt({ recipientCc: 'a@example.invalid; b@example.invalid' })).toEqual({ outcome: 'invalid', reason: 'cc' });
        expect(await attempt({ recipientCc: ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x}@example.invalid`).join(', ') })).toEqual({ outcome: 'invalid', reason: 'cc' });
        expect(await attempt({ recipientCc: `x@example.invalid, ${RECIPIENT.toUpperCase()}` })).toEqual({ outcome: 'invalid', reason: 'cc' });
        expect(await attempt({ reviewToken: 'forged' })).toEqual({ outcome: 'invalid', reason: 'review_token' });
        expect(w.qbo.writes()).toEqual([]);
    });

    it('an invoice that is not a draft is refused before QuickBooks is touched at all', async () => {
        for (const status of ['PAID', 'PENDING', 'OVERDUE', 'CANCELED', 'SENT'] as const) {
            const w = await world();
            const inv = w.seedE2({ status });
            // The dialog says why, and offers nothing.
            expect(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)).toEqual({ state: 'blocked', blockers: ['invoice_not_draft'] });
            // A posted send — even with a well-formed review token — is refused by the gate.
            const result = await startQuickBooksInvoiceSend({
                ...input(w, inv.id), userId: ADMIN_USER, reviewToken: 'a'.repeat(64), recipientTo: RECIPIENT, recipientCc: null,
            }, w.deps);
            expect({ status, result }).toEqual({ status, result: { outcome: 'blocked', blockers: ['invoice_not_draft'] } });
            // Nothing reached QuickBooks, nothing was recorded, and the invoice was not written.
            expect({ status, calls: w.qbo.calls }).toEqual({ status, calls: [] });
            expect({ status, links: w.store.link.invoiceLinks.size }).toEqual({ status, links: 0 });
            expect({ status, lifecycles: w.store.sends.size }).toEqual({ status, lifecycles: 0 });
            expect({ status, writes: w.store.invoiceWrites }).toEqual({ status, writes: [] });
            expect(w.store.invoices.get(inv.id)!.status).toBe(status);
        }
    });

    it('resume and re-send refuse a paid invoice too, so a settled invoice can never be sent again', async () => {
        const w = await world();
        const inv = w.seedE2();
        expect((await send(w, inv.id)).outcome).toBe('sent');
        const writesBefore = w.qbo.writes().length;
        const invoiceWritesBefore = w.store.invoiceWrites.length;
        w.store.invoices.get(inv.id)!.status = 'PAID'; // recorded through INV-D's settle, outside QuickBooks code

        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['invoice_not_sent'] });
        // Resume on a settled invoice simply reports the state it is already in; it never sends again.
        expect(await resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).toMatchObject({ outcome: 'sent' });

        expect(w.qbo.writes()).toHaveLength(writesBefore); // not one further create, update or send
        expect(w.qbo.sent).toHaveLength(1);
        expect(w.store.invoiceWrites).toHaveLength(invoiceWritesBefore); // the FreezerIQ invoice is not written again
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', send_count: 1 });
        expect(w.store.invoices.get(inv.id)!.status).toBe('PAID');
    });

    it('another tenant’s invoice is not found', async () => {
        const w = await world();
        const inv = w.store.seedInvoice({ business_id: OTHER_BIZ, customer_id: w.store.seedOrganization(OTHER_BIZ, 'Other Org') });
        await expect(getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)).rejects.toThrow('Invoice not found');
        await expect(resumeQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER }, w.deps)).rejects.toThrow('Invoice not found');
        expect(w.qbo.calls).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · delivery follow-up, resend and PAID', () => {
    it('a delivery problem is recorded from QuickBooks without touching the FreezerIQ invoice — PAID stays PAID', async () => {
        const w = await world();
        const inv = w.seedE2();
        await send(w, inv.id);
        w.store.invoices.get(inv.id)!.status = 'PAID'; // recorded through INV-D's settle, outside QuickBooks code
        const qboId = [...w.qbo.invoices.keys()][0];
        w.qbo.markUndeliverable(qboId);
        const checked = await checkQuickBooksInvoiceDelivery(input(w, inv.id), w.deps);
        expect(checked).toMatchObject({ outcome: 'checked', view: { state: 'sent', deliveryErrorType: 'Undeliverable', invoiceStatus: 'PAID' } });
        expect(w.store.invoices.get(inv.id)!.status).toBe('PAID');
        expect(w.store.invoiceWrites).toHaveLength(1); // only the original DRAFT -> SENT
        expect(w.qbo.writes().filter((c) => c.op !== 'create' && c.op !== 'update' && c.op !== 'send')).toEqual([]);
        // A PAID invoice is never re-sent.
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['invoice_not_sent'] });
    });

    it('resend to a corrected recipient: same QuickBooks invoice, recipients updated with every flag restated, emailed again, nothing created', async () => {
        const w = await world({ online: { card: true, ach: true } });
        const inv = w.seedE2();
        expect((await send(w, inv.id)).outcome).toBe('sent');
        const qboId = [...w.qbo.invoices.keys()][0];
        w.qbo.markUndeliverable(qboId);
        await checkQuickBooksInvoiceDelivery(input(w, inv.id), w.deps);
        const updates = w.qbo.updates().length;

        w.clock.offsetMs = 5_000;
        const result = await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'Fixed@Lincoln-PTA.example', recipientCc: CC }, w.deps);
        expect(result).toMatchObject({ outcome: 'sent', view: { state: 'sent', sendCount: 2, recipientTo: 'fixed@lincoln-pta.example', recipientCc: CC } });
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.invoices.size).toBe(1);
        const resendUpdate = w.qbo.updates()[updates].body;
        expect(resendUpdate).toMatchObject({ Id: qboId, BillEmail: { Address: 'fixed@lincoln-pta.example' }, BillEmailCc: { Address: CC } });
        expect(resendUpdate).toMatchObject({ AllowOnlineCreditCardPayment: true, AllowOnlineACHPayment: true, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false });
        expect(w.qbo.sent.map((s) => s.to)).toEqual([RECIPIENT, 'fixed@lincoln-pta.example']);
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
        expect(w.store.invoiceWrites).toHaveLength(1);
    });

    it('the recipient update clears QuickBooks’ DeliveryTime: the re-send survives it and earns a NEW one', async () => {
        const w = await world();
        const inv = w.seedE2();
        await send(w, inv.id);
        const qboId = [...w.qbo.invoices.keys()][0];
        const firstTime = w.qbo.invoices.get(qboId)!.DeliveryInfo.DeliveryTime;
        w.qbo.markUndeliverable(qboId);
        const firstSentAt = lifecycle(w, inv.id)!.sent_at;

        w.clock.offsetMs = 60_000;
        const result = await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps);
        // The update really did clear it — the fake now behaves as the sandbox does — and the send stamped a new one.
        const delivery = w.qbo.invoices.get(qboId)!.DeliveryInfo;
        expect(delivery.DeliveryTime).toBeDefined();
        expect(Date.parse(delivery.DeliveryTime)).toBeGreaterThan(Date.parse(firstTime));
        expect(result).toMatchObject({ outcome: 'sent', view: { state: 'sent', sendCount: 2, recipientTo: 'fixed@lincoln-pta.example' } });
        const row = lifecycle(w, inv.id)!;
        expect(row.sent_at.getTime()).toBe(Date.parse(delivery.DeliveryTime));
        expect(row.sent_at.getTime()).toBeGreaterThan(firstSentAt!.getTime());
        expect(row).toMatchObject({ status: 'sent', send_count: 2, problem: null, lease_id: null });
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.invoices.size).toBe(1);
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
        expect(w.store.invoiceWrites).toHaveLength(1);
    });

    it('a re-send interrupted after the update (no DeliveryTime left) is not stuck: the next attempt sends the same invoice', async () => {
        const w = await world();
        const inv = w.seedE2();
        await send(w, inv.id);
        const qboId = [...w.qbo.invoices.keys()][0];
        w.qbo.markUndeliverable(qboId);
        w.qbo.failNext({ op: 'send', kind: 'lost_before' }); // the update lands, the send never reaches QuickBooks
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['quickbooks_unavailable'] });
        expect(lifecycle(w, inv.id)).toMatchObject({ problem: 'send_outcome_unknown' });
        const parked = w.qbo.invoices.get(qboId)!;
        expect(parked.BillEmail.Address).toBe('fixed@lincoln-pta.example');
        expect(parked.DeliveryInfo).toMatchObject({ DeliveryType: 'Email', DeliveryErrorType: 'Undeliverable' });
        expect(parked.DeliveryInfo.DeliveryTime).toBeUndefined();
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', send_count: 1, lease_id: null });

        // Second attempt: QuickBooks already holds the corrected recipient, so no second update — just the send.
        const updates = w.qbo.updates().length;
        w.clock.offsetMs = 120_000;
        const again = await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps);
        expect(again).toMatchObject({ outcome: 'sent', view: { state: 'sent', sendCount: 2, recipientTo: 'fixed@lincoln-pta.example' } });
        expect(w.qbo.updates()).toHaveLength(updates);
        expect(w.qbo.creates()).toHaveLength(1);
        expect(w.qbo.invoices.size).toBe(1);
        expect(lifecycle(w, inv.id)).toMatchObject({ send_count: 2, problem: null });
    });

    it('a re-send whose Send stamps no new delivery time fails closed: nothing recorded, nothing created, invoice still SENT once', async () => {
        for (const leave of ['none', 'stale'] as const) {
            const w = await world();
            const inv = w.seedE2();
            await send(w, inv.id);
            const qboId = [...w.qbo.invoices.keys()][0];
            const original = w.qbo.invoices.get(qboId)!.DeliveryInfo.DeliveryTime;
            w.qbo.markUndeliverable(qboId);
            const sends = w.qbo.sent.length;

            w.clock.offsetMs = 10 * 60_000; // the old time is now far older than the re-send request
            w.qbo.afterNext('send', (i) => {
                if (leave === 'none') delete i.DeliveryInfo.DeliveryTime; else i.DeliveryInfo.DeliveryTime = original;
            });
            expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
                .toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
            expect(lifecycle(w, inv.id)).toMatchObject({
                status: 'sent', send_count: 1, problem: 'verification_failed_sent',
                problem_detail: leave === 'none' ? 'delivery_time_present,delivery_time_not_before_request' : 'delivery_time_not_before_request',
                lease_id: null,
            });
            expect(lifecycle(w, inv.id)!.recipient_to).toBe(RECIPIENT); // the corrected recipient is NOT recorded
            expect(w.qbo.sent).toHaveLength(sends + 1); // QuickBooks did email — we simply refuse to claim it verified
            expect(w.qbo.creates()).toHaveLength(1);
            expect(w.qbo.invoices.size).toBe(1);
            expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
            expect(w.store.invoiceWrites).toHaveLength(1);
        }
    });

    it('resend refuses when the QuickBooks invoice no longer matches what was sent (for example it was paid in QuickBooks)', async () => {
        const w = await world();
        const inv = w.seedE2();
        await send(w, inv.id);
        const qboId = [...w.qbo.invoices.keys()][0];
        w.qbo.tamper(qboId, (i) => { i.Balance = 0; });
        const sends = w.qbo.sent.length;
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
            .toEqual({ outcome: 'blocked', blockers: ['qbo_invoice_changed'] });
        expect(w.qbo.sent).toHaveLength(sends);
        expect(lifecycle(w, inv.id)).toMatchObject({ status: 'sent', problem: 'qbo_invoice_changed', lease_id: null });
    });

    it('resend cannot silently drop a CC QuickBooks already holds', async () => {
        const w = await world();
        const inv = w.seedE2();
        await send(w, inv.id, { cc: CC });
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: 'fixed@lincoln-pta.example', recipientCc: null }, w.deps))
            .toEqual({ outcome: 'invalid', reason: 'cc' });
        expect(lifecycle(w, inv.id)).toMatchObject({ lease_id: null, send_count: 1 });
    });

    it('an invoice not sent through QuickBooks cannot be resent or checked', async () => {
        const w = await world();
        const inv = w.seedE2();
        expect(await resendQuickBooksInvoice({ ...input(w, inv.id), userId: ADMIN_USER, recipientTo: RECIPIENT, recipientCc: null }, w.deps)).toEqual({ outcome: 'blocked', blockers: ['not_sent_via_quickbooks'] });
        expect(await checkQuickBooksInvoiceDelivery(input(w, inv.id), w.deps)).toEqual({ outcome: 'not_sent', view: null });
        expect(w.qbo.calls).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1C · nothing sensitive leaves the service', () => {
    it('no view, result or log line carries a token, realm id, connection id, raw QuickBooks id or the recipient', async () => {
        const w = await world({ online: { card: true, ach: false }, autoSend: true });
        const inv = w.seedE2();
        const { output, result } = await captureConsole(async () => {
            const bodies: string[] = [];
            const view = await review(w, inv.id);
            bodies.push(JSON.stringify(view));
            const sent = await startQuickBooksInvoiceSend({ ...input(w, inv.id), userId: ADMIN_USER, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, w.deps);
            bodies.push(JSON.stringify(sent));
            bodies.push(JSON.stringify(await getQuickBooksInvoiceSendView(input(w, inv.id), w.deps)));
            bodies.push(JSON.stringify(await checkQuickBooksInvoiceDelivery(input(w, inv.id), w.deps)));
            return bodies;
        });
        const qboIds = [...w.qbo.invoices.keys(), w.qboCustomer.Id, w.items.sales.Id, w.items.share.Id, w.items.tax.Id, w.accounts.sales.Id, w.terms.net15.Id];
        for (const body of result) {
            expect(body).not.toMatch(/ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|AUTHCODE|TESTCLIENTSECRET|TESTTOKENKEY|9130000000000001/);
            expect(body).not.toContain(w.generationId);
            for (const id of qboIds) expect(body).not.toContain(`"${id}"`);
        }
        expect(output).not.toMatch(/ACCESSTOKEN-SECRET|REFRESHTOKEN-SECRET|9130000000000001|lincoln-pta|Lincoln/);
        expect(output).not.toContain(w.generationId);
    });
});
