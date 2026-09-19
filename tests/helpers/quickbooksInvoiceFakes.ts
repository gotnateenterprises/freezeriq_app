/**
 * QB-INVOICE-1C — test doubles for QuickBooks invoice settings and the "Send via QuickBooks" lifecycle.
 *
 * `fakeQuickBooksInvoicing` plugs into fakeIntuit({ accounting }) next to the 1B customer fake. It is as strict as
 * QuickBooks where FreezerIQ's send safety depends on it — the behaviours below were observed in Sandbox Company US
 * during the 1C accounting and send-safety spikes (2026-09-15):
 *   - an online-payment flag a create or a SPARSE update omits is set to the company default (true for card and
 *     ACH), so a "partial" update silently re-enables them;
 *   - an invoice line posts to its item's CURRENT income account (ItemAccountRef);
 *   - QuickBooks assigns DocNumber unless custom transaction numbers are on; DueDate = TxnDate + term days;
 *   - a company-wide CC/BCC preference is copied onto an invoice created without its own;
 *   - the explicit send needs a BillEmail (Fault 2380), moves EmailStatus to EmailSent, fills DeliveryInfo and
 *     keeps the SyncToken; a DeliveryErrorType can appear later (markUndeliverable);
 *   - updating an ALREADY-EMAILED invoice REMOVES DeliveryInfo.DeliveryTime, keeping EmailStatus, DeliveryType and
 *     any DeliveryErrorType (sandbox acceptance, 2026-09-16) — so a re-send must earn a brand-new delivery time;
 *   - an update with a stale SyncToken is Fault 5010 and writes nothing; a missing object is Fault 610;
 *   - a repeated requestid returns the original response and creates nothing;
 *   - optional autoSend: QuickBooks emails an invoice on its own when card or ACH is enabled ON THE INVOICE and it
 *     has a BillEmail (the documented autosend condition FreezerIQ must survive).
 * Failures are injectable (refused, 200-with-Fault, lost after processing, never arrived, malformed, gated) and
 * any invoice can be tampered with, so every read-back check can be driven. Every call is recorded.
 *
 * `fakeInvoiceSendDb` extends the 1B fakeLinkDb with the 1C tables and the guarantees the lifecycle relies on:
 * UNIQUE(invoice_id) on the lifecycle (P2002), every CHECK constraint of the migration (P2004), the foreign keys to
 * the invoice link and the invoice (P2003), settings bound to the LIVE generation (Forget deletes them), and
 * transactions that roll back what they wrote when they throw. The FreezerIQ invoice may be READ, and written
 * exactly one way — status DRAFT → SENT, inside a transaction; any other invoice write FAILS THE TEST.
 */

import { randomUUID } from 'crypto';
import type { AccountingRequest } from './quickbooksFakes';
import { fakeLinkDb } from './quickbooksCustomerFakes';

const tick = () => new Promise<void>((r) => setImmediate(r));
const prismaError = (code: string) => Object.assign(new Error(`Fake Prisma error ${code}`), { code });
const round2 = (n: number) => Math.round(n * 100) / 100;
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ═══════════════════════════════════════════════════════════════════════════
// Fake QuickBooks invoicing
// ═══════════════════════════════════════════════════════════════════════════

export interface FakeAccount { Id: string; Name: string; AccountType: string; AccountSubType: string | null; Active: boolean }
export interface FakeItem { Id: string; Name: string; Type: string; Active: boolean; IncomeAccountRef?: { value: string }; Taxable?: boolean }
export interface FakeTerm { Id: string; Name: string; Type: string; DueDays?: number; Active: boolean }
export interface FakePreferences {
    defaultCc: string | null;
    defaultBcc: string | null;
    emailCopyToCompany: boolean;
    onlinePayments: boolean;
    customTxnNumbers: boolean;
    homeCurrency: string;
    multiCurrency: boolean;
}

export type InvoicingOp = 'create' | 'update' | 'read' | 'send' | 'query' | 'preferences' | 'entity' | 'item_create';
export type InvoicingFailure =
    /** Refused before processing: nothing happened. */
    | { op: InvoicingOp; kind: 'status'; status: number; code?: string }
    /** HTTP 200 carrying a Fault; nothing happened. */
    | { op: InvoicingOp; kind: 'fault200'; code?: string }
    /** Processed by "QuickBooks", but the response never arrives. */
    | { op: InvoicingOp; kind: 'lost' }
    /** The request never reached QuickBooks. */
    | { op: InvoicingOp; kind: 'lost_before' }
    /** Processed, but the response body is not what Intuit documents. */
    | { op: InvoicingOp; kind: 'malformed' }
    /** Held until the test releases it, then processed normally. */
    | { op: InvoicingOp; kind: 'gate'; wait: Promise<void> };

export interface InvoicingCall { op: InvoicingOp | 'other'; method: string; path: string; search: string; query?: string; body?: any; requestId: string | null; realm: string }
export interface SentEmail { invoiceId: string; to: string | null; cc: string | null; bcc: string | null; at: string; auto: boolean }

const FLAG_FIELDS = {
    card: 'AllowOnlineCreditCardPayment',
    ach: 'AllowOnlineACHPayment',
    paypal: 'AllowOnlinePayPalPayment',
    affirm: 'AllowOnlineAffirmPayment',
} as const;

export function fakeQuickBooksInvoicing(opts: { now?: () => number; autoSend?: boolean } = {}) {
    const now = opts.now ?? Date.now;
    const accounts = new Map<string, FakeAccount>();
    const items = new Map<string, FakeItem>();
    const terms = new Map<string, FakeTerm>();
    const invoices = new Map<string, any>();
    const prefs: FakePreferences = { defaultCc: null, defaultBcc: null, emailCopyToCompany: false, onlinePayments: true, customTxnNumbers: false, homeCurrency: 'USD', multiCurrency: false };
    /** What an omitted flag becomes (the company setting). */
    const companyFlagDefaults = { card: true, ach: true, paypal: false, affirm: false };
    const replay = new Map<string, { status: number; body: any }>();
    const calls: InvoicingCall[] = [];
    const sent: SentEmail[] = [];
    const failures: InvoicingFailure[] = [];
    const afterOps: Array<{ op: InvoicingOp; fn: (inv: any) => void }> = [];
    let autoSend = !!opts.autoSend;
    let seq = 200;
    let docSeq = 1040;

    const nowIso = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const fault = (json: AccountingRequest['json'], status: number, code: string, type = 'ValidationFault') =>
        json(status, { Fault: { Error: [{ Message: 'fault', Detail: `code ${code}`, code }], type }, time: nowIso() });
    const takeFailure = (op: InvoicingOp) => {
        const i = failures.findIndex((f) => f.op === op);
        return i === -1 ? null : failures.splice(i, 1)[0];
    };
    const runAfter = (op: InvoicingOp, inv: any) => {
        const i = afterOps.findIndex((a) => a.op === op);
        if (i !== -1) afterOps.splice(i, 1)[0].fn(inv);
    };
    const addDays = (date: string, days: number) => {
        const [y, m, d] = date.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    };

    /** QuickBooks' own autosend condition: card or ACH on the invoice, and a recipient. */
    const maybeAutoSend = (inv: any) => {
        if (!autoSend || inv.EmailStatus === 'EmailSent' || !inv.BillEmail?.Address) return;
        if (inv.AllowOnlineCreditCardPayment !== true && inv.AllowOnlineACHPayment !== true) return;
        inv.EmailStatus = 'EmailSent';
        inv.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: nowIso() };
        sent.push({ invoiceId: inv.Id, to: inv.BillEmail?.Address ?? null, cc: inv.BillEmailCc?.Address ?? null, bcc: inv.BillEmailBcc?.Address ?? null, at: inv.DeliveryInfo.DeliveryTime, auto: true });
    };

    /** Runs a failure-injectable operation: `process` does the work and returns the success response. */
    async function injectable(op: InvoicingOp, json: AccountingRequest['json'], process: () => Response | Promise<Response>): Promise<Response> {
        const f = takeFailure(op);
        if (f?.kind === 'gate') await f.wait;
        if (f?.kind === 'lost_before') throw new TypeError('fetch failed: connection reset before the request was sent');
        if (f?.kind === 'status') return fault(json, f.status, f.code ?? '10000', f.status >= 500 ? 'SystemFault' : 'ValidationFault');
        if (f?.kind === 'fault200') return fault(json, 200, f.code ?? '10000', 'SystemFault');
        const res = await process();
        if (f?.kind === 'lost') throw new TypeError('fetch failed: response lost after the server processed the request');
        if (f?.kind === 'malformed') return json(200, { Invoice: { Id: 'not-a-number' }, Item: { Id: 'x' } });
        return res;
    }

    function createInvoice(body: any, json: AccountingRequest['json']): Response {
        if (!body || body.Id !== undefined) return fault(json, 400, '2020');
        if (!Array.isArray(body.Line) || body.Line.length === 0) return fault(json, 400, '6000');
        const lines: any[] = [];
        let total = 0;
        for (const [i, l] of body.Line.entries()) {
            const d = l.SalesItemLineDetail;
            const item = d ? items.get(d.ItemRef?.value) : undefined;
            if (l.DetailType !== 'SalesItemLineDetail' || !item || !item.Active) return fault(json, 400, '2500');
            if (Math.abs(round2(d.Qty * d.UnitPrice) - l.Amount) > 0.0049) return fault(json, 400, '6070');
            total = round2(total + l.Amount);
            lines.push({
                Id: String(i + 1), LineNum: i + 1, Description: l.Description, Amount: l.Amount, DetailType: 'SalesItemLineDetail',
                SalesItemLineDetail: {
                    ItemRef: { value: item.Id, name: item.Name },
                    ItemAccountRef: item.IncomeAccountRef ? { value: item.IncomeAccountRef.value, name: accounts.get(item.IncomeAccountRef.value)?.Name } : undefined,
                    UnitPrice: d.UnitPrice, Qty: d.Qty, TaxCodeRef: { value: d.TaxCodeRef?.value ?? 'NON' },
                },
            });
        }
        lines.push({ Amount: total, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} });
        if (body.EmailStatus === 'NeedToSend' && !body.BillEmail?.Address) return fault(json, 400, '6000');
        const term = body.SalesTermRef ? terms.get(body.SalesTermRef.value) : undefined;
        const inv: any = {
            Id: String(++seq), SyncToken: '0', domain: 'QBO', sparse: false,
            ...(body.DocNumber !== undefined ? { DocNumber: body.DocNumber } : prefs.customTxnNumbers ? {} : { DocNumber: String(++docSeq) }),
            TxnDate: body.TxnDate,
            DueDate: term?.DueDays !== undefined ? addDays(body.TxnDate, term.DueDays) : body.TxnDate,
            CustomerRef: { value: body.CustomerRef?.value, name: 'Customer' },
            CurrencyRef: { value: prefs.homeCurrency, name: 'United States Dollar' },
            ...(body.SalesTermRef ? { SalesTermRef: { value: body.SalesTermRef.value } } : {}),
            ...(body.PrivateNote !== undefined ? { PrivateNote: body.PrivateNote } : {}),
            ...(body.CustomerMemo !== undefined ? { CustomerMemo: { value: body.CustomerMemo.value } } : {}),
            EmailStatus: body.EmailStatus ?? 'NotSet',
            ...(body.BillEmail ? { BillEmail: { Address: body.BillEmail.Address } } : {}),
            ...(body.BillEmailCc ? { BillEmailCc: { Address: body.BillEmailCc.Address } } : prefs.defaultCc ? { BillEmailCc: { Address: prefs.defaultCc } } : {}),
            ...(body.BillEmailBcc ? { BillEmailBcc: { Address: body.BillEmailBcc.Address } } : prefs.defaultBcc ? { BillEmailBcc: { Address: prefs.defaultBcc } } : {}),
            TxnTaxDetail: { TotalTax: 0 },
            Line: lines,
            TotalAmt: total,
            Balance: total,
            MetaData: { CreateTime: nowIso(), LastUpdatedTime: nowIso() },
        };
        for (const [k, field] of Object.entries(FLAG_FIELDS)) {
            inv[field] = typeof body[field] === 'boolean' ? body[field] : companyFlagDefaults[k as keyof typeof companyFlagDefaults];
        }
        maybeAutoSend(inv);
        invoices.set(inv.Id, inv);
        runAfter('create', inv);
        return json(200, { Invoice: copy(inv), time: nowIso() });
    }

    function updateInvoice(body: any, json: AccountingRequest['json']): Response {
        const inv = invoices.get(body.Id);
        if (!inv) return fault(json, 400, '610');
        if (body.SyncToken !== inv.SyncToken) return fault(json, 400, '5010');
        for (const [k, v] of Object.entries(body)) {
            if (k === 'Id' || k === 'SyncToken' || k === 'sparse') continue;
            inv[k] = copy(v);
        }
        // The observed quirk: every flag an update omits returns to the company default — sparse or not.
        for (const [k, field] of Object.entries(FLAG_FIELDS)) {
            if (typeof body[field] !== 'boolean') inv[field] = companyFlagDefaults[k as keyof typeof companyFlagDefaults];
        }
        inv.SyncToken = String(Number(inv.SyncToken) + 1);
        inv.MetaData = { ...inv.MetaData, LastUpdatedTime: nowIso() };
        // Observed live: updating an ALREADY-EMAILED invoice drops DeliveryInfo.DeliveryTime. EmailStatus,
        // DeliveryType and any DeliveryErrorType survive; only the next send stamps a new time.
        if (inv.EmailStatus === 'EmailSent' && inv.DeliveryInfo) delete inv.DeliveryInfo.DeliveryTime;
        maybeAutoSend(inv);
        runAfter('update', inv);
        return json(200, { Invoice: copy(inv), time: nowIso() });
    }

    async function accounting(req: AccountingRequest): Promise<Response | undefined> {
        const { json, realm } = req;
        const requestId = req.url.searchParams.get('requestid');
        const record = (op: InvoicingCall['op'], extra: Partial<InvoicingCall> = {}) =>
            calls.push({ op, method: req.method, path: req.path, search: req.url.search, requestId, realm, ...extra });
        const known = /^\/(preferences|query|account\/\d+|item(\/\d+)?|term\/\d+|invoice(\/\d+(\/send)?)?)$/.test(req.path);
        if (!known) return undefined; // customers etc. belong to other fakes
        if (req.url.searchParams.get('minorversion') !== '75') { record('other'); return fault(json, 400, '4000'); }

        if (req.method === 'GET' && req.path === '/preferences') {
            record('preferences');
            return injectable('preferences', json, () => json(200, {
                Preferences: {
                    SalesFormsPrefs: {
                        ...(prefs.defaultCc ? { SalesEmailCc: { Address: prefs.defaultCc } } : {}),
                        ...(prefs.defaultBcc ? { SalesEmailBcc: { Address: prefs.defaultBcc } } : {}),
                        EmailCopyToCompany: prefs.emailCopyToCompany,
                        ETransactionPaymentEnabled: prefs.onlinePayments,
                        CustomTxnNumbers: prefs.customTxnNumbers,
                    },
                    CurrencyPrefs: { HomeCurrency: { value: prefs.homeCurrency }, MultiCurrencyEnabled: prefs.multiCurrency },
                },
                time: nowIso(),
            }));
        }

        if (req.method === 'GET' && req.path === '/query') {
            const q = req.url.searchParams.get('query') ?? '';
            if (/^select \* from Customer /.test(q)) return undefined; // the 1B customer fake answers these
            record('query', { query: q });
            return injectable('query', json, () => {
                const list = q === 'select * from Account maxresults 1000' ? ['Account', [...accounts.values()]]
                    : q === 'select * from Item maxresults 1000' ? ['Item', [...items.values()]]
                        : q === 'select * from Term maxresults 200' ? ['Term', [...terms.values()]]
                            : null;
                if (!list) return fault(json, 400, '4000'); // anything else — an invoice search included — is refused here
                const active = (list[1] as any[]).filter((x) => x.Active).map(copy);
                return json(200, { QueryResponse: active.length ? { [list[0] as string]: active, startPosition: 1, maxResults: active.length } : {}, time: nowIso() });
            });
        }

        const entity = /^\/(account|item|term)\/(\d+)$/.exec(req.path);
        if (req.method === 'GET' && entity) {
            record('entity');
            return injectable('entity', json, () => {
                const store = entity[1] === 'account' ? accounts : entity[1] === 'item' ? items : terms;
                const row = store.get(entity[2]);
                if (!row) return fault(json, 400, '610');
                const key = entity[1][0].toUpperCase() + entity[1].slice(1);
                return json(200, { [key]: copy(row), time: nowIso() });
            });
        }

        if (req.method === 'POST' && req.path === '/item') {
            let body: any = null;
            try { body = JSON.parse(req.body); } catch { /* null */ }
            record('item_create', { body });
            const key = `item|${realm}|${requestId}`;
            if (requestId && replay.has(key)) return json(replay.get(key)!.status, replay.get(key)!.body);
            return injectable('item_create', json, () => {
                let status = 200;
                let responseBody: any;
                if (!body?.Name || [...items.values()].some((i) => i.Name.toLowerCase() === String(body.Name).toLowerCase())) {
                    status = 400;
                    responseBody = { Fault: { Error: [{ code: '6240' }], type: 'ValidationFault' } };
                } else if (!accounts.has(body.IncomeAccountRef?.value)) {
                    status = 400;
                    responseBody = { Fault: { Error: [{ code: '2500' }], type: 'ValidationFault' } };
                } else {
                    const item: FakeItem = { Id: String(++seq), Name: body.Name, Type: body.Type, Active: true, Taxable: body.Taxable, IncomeAccountRef: { value: body.IncomeAccountRef.value } };
                    items.set(item.Id, item);
                    responseBody = { Item: copy(item), time: nowIso() };
                }
                if (requestId) replay.set(key, { status, body: responseBody });
                return json(status, responseBody);
            });
        }

        if (req.method === 'POST' && req.path === '/invoice') {
            let body: any = null;
            try { body = JSON.parse(req.body); } catch { /* null */ }
            const isUpdate = body && body.Id !== undefined;
            record(isUpdate ? 'update' : 'create', { body });
            const key = `invoice|${realm}|${requestId}`;
            return injectable(isUpdate ? 'update' : 'create', json, async () => {
                // A repeated requestid answers with the original response (and a replay can be lost too).
                if (requestId && replay.has(key)) return json(replay.get(key)!.status, replay.get(key)!.body);
                const res = isUpdate ? updateInvoice(body, json) : createInvoice(body, json);
                if (requestId) replay.set(key, { status: res.status, body: await res.clone().json() });
                return res;
            });
        }

        const read = /^\/invoice\/(\d+)$/.exec(req.path);
        if (req.method === 'GET' && read) {
            record('read');
            return injectable('read', json, () => {
                const inv = invoices.get(read[1]);
                return inv ? json(200, { Invoice: copy(inv), time: nowIso() }) : fault(json, 400, '610');
            });
        }

        const send = /^\/invoice\/(\d+)\/send$/.exec(req.path);
        if (req.method === 'POST' && send) {
            record('send');
            return injectable('send', json, () => {
                const inv = invoices.get(send[1]);
                if (!inv) return fault(json, 400, '610');
                const to = req.url.searchParams.get('sendTo') ?? inv.BillEmail?.Address ?? null;
                if (!to) return fault(json, 400, '2380');
                inv.EmailStatus = 'EmailSent';
                inv.DeliveryInfo = { DeliveryType: 'Email', DeliveryTime: nowIso() };
                sent.push({ invoiceId: inv.Id, to, cc: inv.BillEmailCc?.Address ?? null, bcc: inv.BillEmailBcc?.Address ?? null, at: inv.DeliveryInfo.DeliveryTime, auto: false });
                runAfter('send', inv);
                return json(200, { Invoice: copy(inv), time: nowIso() });
            });
        }

        record('other');
        return fault(json, 400, '4000');
    }

    return {
        accounting,
        calls,
        sent,
        invoices,
        prefs,
        companyFlagDefaults,
        setAutoSend: (on: boolean) => { autoSend = on; },
        seedAccount(a: Partial<FakeAccount> & { Name: string; AccountType: string }): FakeAccount {
            const row: FakeAccount = { Id: String(++seq), AccountSubType: null, Active: true, ...a };
            accounts.set(row.Id, row);
            return row;
        },
        seedItem(i: Partial<FakeItem> & { Name: string; IncomeAccountRef: { value: string } }): FakeItem {
            const row: FakeItem = { Id: String(++seq), Type: 'Service', Active: true, Taxable: false, ...i };
            items.set(row.Id, row);
            return row;
        },
        seedTerm(t: Partial<FakeTerm> & { Name: string }): FakeTerm {
            const row: FakeTerm = { Id: String(++seq), Type: 'STANDARD', Active: true, ...t };
            terms.set(row.Id, row);
            return row;
        },
        account: (id: string) => accounts.get(id),
        item: (id: string) => items.get(id),
        term: (id: string) => terms.get(id),
        failNext: (f: InvoicingFailure) => { failures.push(f); },
        /** One-shot: mutate the stored invoice right after the next `op` is processed (QuickBooks "doing something"). */
        afterNext: (op: InvoicingOp, fn: (inv: any) => void) => { afterOps.push({ op, fn }); },
        /** Change a stored invoice as if someone edited it in QuickBooks. */
        tamper: (id: string, fn: (inv: any) => void) => { fn(invoices.get(id)); },
        markUndeliverable: (id: string) => { invoices.get(id).DeliveryInfo.DeliveryErrorType = 'Undeliverable'; },
        creates: () => calls.filter((c) => c.op === 'create'),
        updates: () => calls.filter((c) => c.op === 'update'),
        sends: () => calls.filter((c) => c.op === 'send'),
        reads: () => calls.filter((c) => c.op === 'read'),
        writes: () => calls.filter((c) => c.method !== 'GET'),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fake database: the 1B tables plus quickbooks_invoice_settings and quickbooks_invoice_sends
// ═══════════════════════════════════════════════════════════════════════════

export interface FakeInvoiceItem { id: string; description: string; variant_size: string | null; quantity: string; unit_price: string; total: string }
export interface FakeInvoice {
    id: string; business_id: string; customer_id: string; campaign_id: string | null; status: string;
    total_amount: string; tax_amount: string | null; tax_rate_percent: string | null; tax_status: string | null;
    fundraiser_profit_amount: string | null; fundraiser_profit_percent: string | null; paid_at: Date | null;
    items: FakeInvoiceItem[];
}

type Undo = Array<() => void>;

const matchWhere = (row: any, where: Record<string, any> = {}): boolean => Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as any[]).some((w) => matchWhere(row, w));
    if (k === 'AND') return (v as any[]).every((w) => matchWhere(row, w));
    if (k === 'NOT') return !matchWhere(row, v);
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    if (v && typeof v === 'object') {
        if ('lt' in v) return row[k] instanceof Date && row[k].getTime() < v.lt.getTime();
        if ('gt' in v) return row[k] instanceof Date && row[k].getTime() > v.gt.getTime();
        if ('in' in v) return (v.in as any[]).includes(row[k]);
    }
    return row[k] === v;
});

function project(row: any, select: Record<string, any> | undefined, relations: Record<string, (row: any, sel: any) => any>): any {
    if (!select) return { ...row };
    const out: any = {};
    for (const [k, v] of Object.entries(select)) {
        if (!v) continue;
        if (relations[k]) out[k] = relations[k](row, v === true ? undefined : v.select);
        else out[k] = row[k];
    }
    return out;
}

const HEX64 = /^[a-f0-9]{64}$/;
const NUM_ID = /^[0-9]{1,32}$/;

export function fakeInvoiceSendDb() {
    const link = fakeLinkDb();
    const invoices = new Map<string, FakeInvoice>();
    const timezones = new Map<string, string>();
    const contactEmails = new Map<string, string | null>();
    /** campaign_id -> the campaign's primary coordinator assignment, already in CAMPAIGN_COORDINATOR_ASSIGNMENT_SELECT shape. */
    const coordinators = new Map<string, any>();
    const settings = new Map<string, any>();
    const sends = new Map<string, any>(); // invoice_id -> row
    const violations = link.violations;
    const rejectedWrites = link.rejectedWrites;
    /** Every FreezerIQ invoice write, as attempted. */
    const invoiceWrites: Array<{ where: any; data: any; inTransaction: boolean }> = [];
    const refuse = (table: string, code: string) => { rejectedWrites.push(`${table}:${code}`); return prismaError(code); };

    /** Forget deletes the integrations row: settings go with it (CASCADE), and only the LIVE generation is valid. */
    const cascade = () => {
        for (const [biz, s] of [...settings]) {
            const g = link.connections.get(s.connection_id);
            if (!link.base.rows.has(`${biz}|quickbooks`) || !g || g.live_business_id !== biz) settings.delete(biz);
        }
    };

    // ── invoices ──
    const invoiceModel = (undo: Undo | null) => new Proxy({}, {
        get(_t, method: string) {
            if (method === 'findFirst') {
                return async ({ where, select }: any) => {
                    await tick();
                    const r = [...invoices.values()].find((i) => i.id === where.id && (where.business_id === undefined || i.business_id === where.business_id)
                        && (where.status === undefined || i.status === where.status));
                    if (!r) return null;
                    return project(r, select, {
                        items: (row, sel) => row.items.map((it: any) => project(it, sel, {})),
                        business: (row, sel) => project({ timezone: timezones.get(row.business_id) ?? 'America/Chicago' }, sel, {}),
                        customer: (row, sel) => project({ ...link.customers.get(row.customer_id), contact_email: contactEmails.get(row.customer_id) ?? null, contact_name: 'Org contact' }, sel, {}),
                        campaign: (row, sel) => (row.campaign_id ? project({ primary_coordinator: coordinators.get(row.campaign_id) ?? null }, sel, { primary_coordinator: (r) => r.primary_coordinator }) : null),
                        quickbooks_invoice_links: (row, sel) => [...link.invoiceLinks.values()].filter((l) => l.invoice_id === row.id).map((l) => project(l, sel, {})),
                    });
                };
            }
            if (method === 'updateMany') {
                return async ({ where, data }: any) => {
                    await tick();
                    invoiceWrites.push({ where: { ...where }, data: { ...data }, inTransaction: !!undo });
                    const allowed = !!undo && Object.keys(data).length === 1 && data.status === 'SENT' && where.status === 'DRAFT' && typeof where.id === 'string' && typeof where.business_id === 'string';
                    if (!allowed) {
                        violations.push(`invoice.updateMany ${JSON.stringify({ where, data, inTransaction: !!undo })}`);
                        throw new Error('the only invoice write allowed is DRAFT -> SENT inside a transaction');
                    }
                    let count = 0;
                    for (const inv of invoices.values()) {
                        if (inv.id === where.id && inv.business_id === where.business_id && inv.status === 'DRAFT') {
                            const before = inv.status;
                            inv.status = 'SENT';
                            undo!.push(() => { inv.status = before; });
                            count++;
                        }
                    }
                    return { count };
                };
            }
            return async () => { violations.push(`invoice.${method}`); throw new Error(`invoice.${method} must never be called by QuickBooks invoicing`); };
        },
    });

    // ── settings ──
    const checkSettings = (row: any) => {
        const pair = (a: any, b: any) => (a === null && b === null) || (a !== null && b !== null && NUM_ID.test(a) && NUM_ID.test(b));
        const ok = row.provider === 'quickbooks' && NUM_ID.test(row.sales_item_id) && NUM_ID.test(row.sales_account_id)
            && NUM_ID.test(row.term_id) && Number.isInteger(row.term_due_days) && row.term_due_days >= 0 && row.term_due_days <= 3650
            && pair(row.share_item_id, row.share_account_id) && pair(row.tax_item_id, row.tax_account_id)
            && (row.default_cc === null || (row.default_cc !== '' && row.default_cc.length <= 100));
        if (!ok) throw refuse('quickbooks_invoice_settings', 'P2004');
        const g = link.connections.get(row.connection_id);
        if (!link.base.rows.has(`${row.business_id}|quickbooks`) || !g || g.live_business_id !== row.business_id) throw refuse('quickbooks_invoice_settings', 'P2003');
    };
    const settingsModel = (undo: Undo | null) => ({
        async findUnique({ where }: any) {
            await tick(); cascade();
            const r = settings.get(where.business_id);
            return r ? { ...r } : null;
        },
        async upsert({ where, create, update }: any) {
            await tick(); cascade();
            const existing = settings.get(where.business_id);
            const next = existing
                ? { ...existing, ...update, updated_at: new Date() }
                : { provider: 'quickbooks', share_item_id: null, share_account_id: null, tax_item_id: null, tax_account_id: null, allow_online_card: false, allow_online_ach: false, default_cc: null, updated_by: null, created_at: new Date(), updated_at: new Date(), ...create };
            checkSettings(next);
            settings.set(where.business_id, next);
            undo?.push(() => { if (existing) settings.set(where.business_id, existing); else settings.delete(where.business_id); });
            return { ...next };
        },
    });

    // ── send lifecycles ──
    const checkSend = (row: any) => {
        const ok = HEX64.test(row.review_hash) && /^\d{4}-\d{2}-\d{2}$/.test(row.txn_date)
            && row.mapping !== null && typeof row.mapping === 'object' && !Array.isArray(row.mapping)
            && typeof row.recipient_to === 'string' && row.recipient_to !== '' && row.recipient_to.length <= 100 && !row.recipient_to.includes(',')
            && (row.recipient_cc === null || (row.recipient_cc !== '' && row.recipient_cc.length <= 100))
            && ((row.lease_id === null) === (row.lease_until === null))
            && row.revision >= 0 && row.send_count >= 0
            && (['reserved', 'needs_review'].includes(row.status) || (!!row.qbo_doc_number && row.qbo_sync_token !== null && row.created_verified_at !== null))
            && (row.status !== 'sent' || (row.sent_at !== null && row.send_count >= 1))
            && ['reserved', 'created', 'recipients_set', 'payment_options_set', 'sent', 'needs_review'].includes(row.status);
        if (!ok) throw refuse('quickbooks_invoice_sends', 'P2004');
        const l = [...link.invoiceLinks.values()].find((x) => x.business_id === row.business_id && x.invoice_id === row.invoice_id);
        const inv = invoices.get(row.invoice_id);
        if (!l || !inv || inv.business_id !== row.business_id) throw refuse('quickbooks_invoice_sends', 'P2003');
    };
    const SEND_DEFAULTS = {
        recipient_cc: null, qbo_doc_number: null, qbo_sync_token: null, lease_id: null, lease_until: null, revision: 0,
        create_requested_at: null, created_verified_at: null, recipients_verified_at: null, payment_options_verified_at: null,
        send_requested_at: null, sent_at: null, auto_sent: false, send_count: 0, delivery_error_type: null, delivery_checked_at: null,
        problem: null, problem_detail: null, problem_at: null, started_by: null, sent_by: null,
    };
    const sendModel = (undo: Undo | null) => new Proxy({
        async findUnique({ where }: any) {
            await tick();
            const r = sends.get(where.invoice_id);
            return r ? { ...r } : null;
        },
        async findFirst({ where }: any) {
            await tick();
            const r = [...sends.values()].find((s) => matchWhere(s, where));
            return r ? { ...r } : null;
        },
        async create({ data }: any) {
            await tick();
            if (sends.has(data.invoice_id)) throw refuse('quickbooks_invoice_sends', 'P2002');
            const row = { id: randomUUID(), ...SEND_DEFAULTS, ...data, mapping: copy(data.mapping), created_at: new Date(), updated_at: new Date() };
            checkSend(row);
            sends.set(row.invoice_id, row);
            undo?.push(() => { sends.delete(row.invoice_id); });
            return { ...row };
        },
        async updateMany({ where, data }: any) {
            await tick();
            const matched = [...sends.values()].filter((s) => matchWhere(s, where));
            const next = matched.map((s) => ({ before: s, after: { ...s, ...data, updated_at: new Date() } }));
            for (const n of next) checkSend(n.after); // all or nothing, like one UPDATE statement
            for (const n of next) {
                sends.set(n.after.invoice_id, n.after);
                undo?.push(() => { sends.set(n.before.invoice_id, n.before); });
            }
            return { count: next.length };
        },
    }, {
        get(target: any, method: string) {
            if (method in target) return target[method];
            return async () => { violations.push(`quickBooksInvoiceSend.${method}`); throw new Error(`quickBooksInvoiceSend.${method} must never be called`); };
        },
    });

    async function $transaction(fn: (tx: any) => Promise<any>, opts?: any) {
        const undo: Undo = [];
        try {
            return await link.db.$transaction(async (tx: any) => fn({
                ...tx,
                invoice: invoiceModel(undo),
                quickBooksInvoiceSettings: settingsModel(undo),
                quickBooksInvoiceSend: sendModel(undo),
            }), opts);
        } catch (e) {
            for (const u of undo.reverse()) u(); // what this transaction wrote is rolled back
            throw e;
        }
    }

    const db = {
        ...link.db,
        invoice: invoiceModel(null),
        quickBooksInvoiceSettings: settingsModel(null),
        quickBooksInvoiceSend: sendModel(null),
        $transaction,
    } as any;

    return {
        db,
        link,
        invoices,
        settings,
        sends,
        violations,
        rejectedWrites,
        invoiceWrites,
        setTimezone: (businessId: string, tz: string) => { timezones.set(businessId, tz); },
        /** The campaign's assigned coordinator (as the coordinator portal records it). */
        assignCoordinator(campaignId: string, c: { name: string; email: string | null; ended?: boolean }) {
            coordinators.set(campaignId, {
                org_contact: { ended_at: c.ended ? new Date() : null, contact: { display_name: c.name, contact_points: c.email ? [{ value: c.email, is_primary: true }] : [] } },
            });
        },
        seedOrganization(businessId: string, name: string, contactEmail: string | null = null): string {
            const id = link.seedOrganization(businessId, name);
            contactEmails.set(id, contactEmail);
            return id;
        },
        seedInvoice(inv: Partial<FakeInvoice> & { business_id: string; customer_id: string }): FakeInvoice {
            const row: FakeInvoice = {
                id: randomUUID(), campaign_id: randomUUID(), status: 'DRAFT', total_amount: '0.00', tax_amount: '0.00', tax_rate_percent: null,
                tax_status: 'TAXABLE', fundraiser_profit_amount: '0.00', fundraiser_profit_percent: '20.00', paid_at: null, items: [], ...inv,
            };
            invoices.set(row.id, row);
            link.invoices.set(row.id, { id: row.id, business_id: row.business_id, status: row.status, total_amount: row.total_amount, paid_at: null, campaign_id: row.campaign_id });
            return row;
        },
    };
}
