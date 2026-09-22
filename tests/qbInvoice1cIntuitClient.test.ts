/**
 * QB-INVOICE-1C — the invoice and setup additions to lib/quickbooks/intuitClient.ts, at the HTTP boundary with a
 * recording fetch: exact request construction, the send-safety rules enforced by the client itself (an unsent
 * create; every payment flag restated on every update; Send without a sendTo override), strict parsing, and
 * error classification the lifecycle depends on (refused vs ambiguous vs stale).
 */

import {
    assertUnsentInvoiceCreateBody,
    createQuickBooksInvoice,
    createQuickBooksServiceItem,
    IntuitError,
    listQuickBooksAccounts,
    listQuickBooksItems,
    listQuickBooksTerms,
    parseQuickBooksInvoice,
    readQuickBooksInvoice,
    readQuickBooksItem,
    readQuickBooksPreferences,
    sendQuickBooksInvoice,
    updateQuickBooksInvoiceDelivery,
    type QuickBooksInvoiceCreateBody,
} from '@/lib/quickbooks/intuitClient';
import { QUICKBOOKS_API_BASE } from '@/lib/quickbooks/config';
import { sandboxConfig } from './helpers/quickbooksFakes';

const config = sandboxConfig();
const REALM = '9130000000000001';
const TOKEN = 'ACCESSTOKEN-SECRET-client-test';
const BASE = `${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM}`;

interface Recorded { url: URL; method: string; headers: Headers; body: string | null }
function recorder(responses: Array<Response | (() => never)>) {
    const calls: Recorded[] = [];
    const fetchImpl = async (input: string, init: RequestInit = {}) => {
        calls.push({ url: new URL(input), method: (init.method ?? 'GET').toUpperCase(), headers: new Headers(init.headers as any), body: typeof init.body === 'string' ? init.body : init.body === undefined ? null : '(non-string)' });
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        return typeof next === 'function' ? next() : next;
    };
    return { calls, fetchImpl };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', intuit_tid: 'tid-1' } });
const fault = (status: number, code: string) => json(status, { Fault: { Error: [{ Message: 'Something with coordinator@example.invalid', Detail: 'echo', code }], type: 'ValidationFault' } });
const kindOf = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return e instanceof IntuitError ? e.kind : 'other'; } };

const BODY: QuickBooksInvoiceCreateBody = {
    CustomerRef: { value: '58' }, TxnDate: '2026-09-15', SalesTermRef: { value: '2' }, PrivateNote: 'FreezerIQ fundraiser invoice inv-1', EmailStatus: 'NotSet',
    AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
    Line: [{ DetailType: 'SalesItemLineDetail', Amount: 437.5, Description: 'Family Friendly — Serves 5', SalesItemLineDetail: { ItemRef: { value: '11' }, Qty: 7, UnitPrice: 62.5, TaxCodeRef: { value: 'NON' } } }],
};
const INVOICE = {
    Id: '130', SyncToken: '0', DocNumber: '1052', TxnDate: '2026-09-15', DueDate: '2026-09-30', CustomerRef: { value: '58', name: 'Lincoln PTA' }, CurrencyRef: { value: 'USD' },
    EmailStatus: 'NotSet', TotalAmt: 437.5, Balance: 437.5, TxnTaxDetail: { TotalTax: 0 },
    BillEmail: undefined, AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
    Line: [{ Id: '1', Amount: 437.5, Description: 'Family Friendly — Serves 5', DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '11' }, ItemAccountRef: { value: '79' }, Qty: 7, UnitPrice: 62.5, TaxCodeRef: { value: 'NON' } } }, { Amount: 437.5, DetailType: 'SubTotalLineDetail', SubTotalLineDetail: {} }],
};

describe('QB-INVOICE-1C · create: always unsent, always the reserved requestid', () => {
    it('POSTs the body unchanged to /invoice with minorversion 75 and the requestid; the parsed read-back keeps an allowlist', async () => {
        const r = recorder([json(200, { Invoice: INVOICE })]);
        const inv = await createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-0123456789abcdef0123456789abcdef01234567', r.fetchImpl);
        expect(r.calls).toHaveLength(1);
        expect([r.calls[0].method, `${r.calls[0].url.origin}${r.calls[0].url.pathname}`]).toEqual(['POST', `${BASE}/invoice`]);
        expect(Object.fromEntries(r.calls[0].url.searchParams)).toEqual({ minorversion: '75', requestid: 'qbinv-0123456789abcdef0123456789abcdef01234567' });
        expect(JSON.parse(r.calls[0].body!)).toEqual(BODY);
        expect(r.calls[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect(inv).toMatchObject({ id: '130', docNumber: '1052', emailStatus: 'NotSet', billEmail: null, payment: { card: false, ach: false, paypal: false, affirm: false } });
        expect(Object.keys(inv).sort()).toEqual(['balance', 'billEmail', 'billEmailBcc', 'billEmailCc', 'currency', 'customerId', 'customerMemo', 'delivery', 'docNumber', 'dueDate', 'eInvoiceStatus', 'emailStatus', 'id', 'lines', 'payment', 'syncToken', 'taxDetailReadable', 'taxLineAmounts', 'termId', 'totalAmt', 'totalTax', 'txnDate', 'txnTaxCodeId']);
    });

    it('refuses, before any request, a body that could send: a recipient, NeedToSend, a DocNumber, native tax, a discount, a missing or true flag, a taxable line', async () => {
        const bad: Array<[string, any]> = [
            ['BillEmail', { ...BODY, BillEmail: { Address: 'a@example.invalid' } }],
            ['BillEmailCc', { ...BODY, BillEmailCc: { Address: 'a@example.invalid' } }],
            ['NeedToSend', { ...BODY, EmailStatus: 'NeedToSend' }],
            ['DocNumber', { ...BODY, DocNumber: '9001' }],
            ['TxnTaxDetail', { ...BODY, TxnTaxDetail: { TotalTax: 1 } }],
            ['flag true', { ...BODY, AllowOnlineACHPayment: true }],
            ['flag omitted', (() => { const b: any = { ...BODY }; delete b.AllowOnlineAffirmPayment; return b; })()],
            ['discount line', { ...BODY, Line: [...BODY.Line, { DetailType: 'DiscountLineDetail', Amount: 1, DiscountLineDetail: {} }] }],
            ['taxable line', { ...BODY, Line: [{ ...BODY.Line[0], SalesItemLineDetail: { ...BODY.Line[0].SalesItemLineDetail, TaxCodeRef: { value: 'TAX' } } }] }],
            ['no lines', { ...BODY, Line: [] }],
        ];
        for (const [name, body] of bad) {
            expect({ name, thrown: (() => { try { assertUnsentInvoiceCreateBody(body); return null; } catch (e) { return e instanceof IntuitError ? e.kind : 'other'; } })() }).toEqual({ name, thrown: 'rejected' });
            const r = recorder([]);
            expect({ name, kind: await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, body, 'qbinv-x', r.fetchImpl)) }).toEqual({ name, kind: 'rejected' });
            expect(r.calls).toHaveLength(0);
        }
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'has spaces', recorder([]).fetchImpl))).toBe('rejected');
    });

    it('classifies failures: a validation Fault created nothing (rejected); 5xx, a 200-with-Fault, a malformed body and a lost response are ambiguous', async () => {
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([fault(400, '6000')]).fetchImpl))).toBe('rejected');
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([json(503, {})]).fetchImpl))).toBe('http');
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([fault(200, '10000')]).fetchImpl))).toBe('malformed');
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([json(200, { Invoice: { Id: 'x' } })]).fetchImpl))).toBe('malformed');
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([() => { throw new TypeError('socket hang up'); }]).fetchImpl))).toBe('network');
        expect(await kindOf(createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([json(401, {})]).fetchImpl))).toBe('unauthorized');
    });

    it('a Fault’s codes are kept; its message and detail (which can echo request data) never are', async () => {
        try {
            await createQuickBooksInvoice(config, TOKEN, REALM, BODY, 'qbinv-x', recorder([fault(400, '6070')]).fetchImpl);
            throw new Error('expected a rejection');
        } catch (e: any) {
            expect(e).toBeInstanceOf(IntuitError);
            expect(e.faultCodes).toEqual(['6070']);
            expect(JSON.stringify({ ...e, message: e.message })).not.toMatch(/coordinator@|echo|ACCESSTOKEN/);
        }
    });
});

describe('QB-INVOICE-1C · update: recipients and flags only, every flag restated', () => {
    const fields = { billEmail: 'coordinator@lincoln-pta.example', billEmailCc: 'treasurer@lincoln-pta.example', payment: { card: false, ach: false, paypal: false, affirm: false } };

    it('a sparse update carries Id, SyncToken, recipients and ALL FOUR flags — nothing financial', async () => {
        const r = recorder([json(200, { Invoice: { ...INVOICE, SyncToken: '1', BillEmail: { Address: fields.billEmail } } })]);
        await updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields }, 'qbupd-1-abc', r.fetchImpl);
        expect(`${r.calls[0].url.origin}${r.calls[0].url.pathname}`).toBe(`${BASE}/invoice`);
        expect(r.calls[0].url.searchParams.get('requestid')).toBe('qbupd-1-abc');
        expect(JSON.parse(r.calls[0].body!)).toEqual({
            Id: '130', SyncToken: '0', sparse: true,
            BillEmail: { Address: fields.billEmail }, BillEmailCc: { Address: fields.billEmailCc },
            AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowOnlinePayPalPayment: false, AllowOnlineAffirmPayment: false,
        });
    });

    it('PARTIAL-UPDATE REGRESSION: an update without every flag is refused before any request (QuickBooks would re-enable the omitted ones)', async () => {
        for (const payment of [{ card: false, ach: false, paypal: false }, { card: true, ach: undefined, paypal: false, affirm: false }, undefined, null]) {
            const r = recorder([]);
            expect(await kindOf(updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields: { ...fields, payment: payment as any } }, 'qbupd-1-abc', r.fetchImpl))).toBe('rejected');
            expect(r.calls).toHaveLength(0);
        }
    });

    it('refuses an unusable recipient or CC before any request; a null CC leaves the field out', async () => {
        for (const bad of [{ billEmail: 'no' }, { billEmail: `${'a'.repeat(100)}@x.example` }, { billEmailCc: 'a@@example' }]) {
            const r = recorder([]);
            expect(await kindOf(updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields: { ...fields, ...bad } }, 'qbupd-1-abc', r.fetchImpl))).toBe('rejected');
            expect(r.calls).toHaveLength(0);
        }
        const r = recorder([json(200, { Invoice: INVOICE })]);
        await updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields: { ...fields, billEmailCc: null } }, 'qbupd-1-abc', r.fetchImpl);
        expect(JSON.parse(r.calls[0].body!)).not.toHaveProperty('BillEmailCc');
    });

    it('5010 is stale_object (nothing written); 610 is not_found; an answer for another invoice is malformed', async () => {
        expect(await kindOf(updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields }, 'qbupd-1-abc', recorder([fault(400, '5010')]).fetchImpl))).toBe('stale_object');
        expect(await kindOf(updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields }, 'qbupd-1-abc', recorder([fault(400, '610')]).fetchImpl))).toBe('not_found');
        expect(await kindOf(updateQuickBooksInvoiceDelivery(config, TOKEN, REALM, { id: '130', syncToken: '0', fields }, 'qbupd-1-abc', recorder([json(200, { Invoice: { ...INVOICE, Id: '131' } })]).fetchImpl))).toBe('malformed');
    });
});

describe('QB-INVOICE-1C · send and read', () => {
    it('Send is a POST to /invoice/{id}/send with an octet-stream content type, no body and no sendTo', async () => {
        const r = recorder([json(200, { Invoice: { ...INVOICE, EmailStatus: 'EmailSent', DeliveryInfo: { DeliveryType: 'Email', DeliveryTime: '2026-09-15T12:24:46-07:00' } } })]);
        const inv = await sendQuickBooksInvoice(config, TOKEN, REALM, '130', r.fetchImpl);
        expect([r.calls[0].method, `${r.calls[0].url.origin}${r.calls[0].url.pathname}`]).toEqual(['POST', `${BASE}/invoice/130/send`]);
        expect(Object.fromEntries(r.calls[0].url.searchParams)).toEqual({ minorversion: '75' });
        expect(r.calls[0].headers.get('content-type')).toBe('application/octet-stream');
        expect(r.calls[0].body).toBeNull();
        expect(inv).toMatchObject({ emailStatus: 'EmailSent', delivery: { type: 'Email', time: '2026-09-15T12:24:46-07:00', errorType: null } });
        expect(await kindOf(sendQuickBooksInvoice(config, TOKEN, REALM, '130', recorder([fault(400, '2380')]).fetchImpl))).toBe('rejected');
        expect(await kindOf(sendQuickBooksInvoice(config, TOKEN, REALM, '130 OR 1', recorder([]).fetchImpl))).toBe('rejected');
    });

    it('reads one invoice by id; 610 is null; nothing else is queried', async () => {
        const r = recorder([json(200, { Invoice: INVOICE }), fault(400, '610')]);
        expect(await readQuickBooksInvoice(config, TOKEN, REALM, '130', r.fetchImpl)).toMatchObject({ id: '130' });
        expect(await readQuickBooksInvoice(config, TOKEN, REALM, '131', r.fetchImpl)).toBeNull();
        expect(r.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET /v3/company/${REALM}/invoice/130`, `GET /v3/company/${REALM}/invoice/131`]);
        expect(await kindOf(readQuickBooksInvoice(config, TOKEN, REALM, '130', recorder([json(200, { Invoice: { ...INVOICE, Id: '999' } })]).fetchImpl))).toBe('malformed');
    });

    it('parsing keeps delivery, tax and payment facts and drops everything else', () => {
        const inv = parseQuickBooksInvoice({ ...INVOICE, BillEmailBcc: { Address: 'hidden@example.invalid' }, EInvoiceStatus: 'Viewed', TxnTaxDetail: { TotalTax: 3, TxnTaxCodeRef: { value: '2' }, TaxLine: [{ Amount: 1 }, {}] }, ShipAddr: { Line1: '1 Main' }, CustomerMemo: { value: 'memo' } })!;
        expect(inv).toMatchObject({ billEmailBcc: 'hidden@example.invalid', eInvoiceStatus: 'Viewed', totalTax: 3, txnTaxCodeId: '2', taxLineAmounts: [1, null], taxDetailReadable: true, customerMemo: 'memo' });
        expect(JSON.stringify(inv)).not.toContain('1 Main');
        expect(parseQuickBooksInvoice({ ...INVOICE, Id: 'abc' })).toBeNull();
        expect(parseQuickBooksInvoice({ ...INVOICE, Line: 'x' })).toBeNull();
    });

    /**
     * QuickBooks AUTOMATED SALES TAX returns tax metadata FreezerIQ never sends: a transaction tax code, and — in
     * companies with their own tax rates — a tax line, both worth zero on a wholly non-taxable invoice. The snapshot
     * has to carry the AMOUNTS so the contract can judge what the tax did to the money, and has to say plainly when
     * a tax block cannot be read at all, so the contract can fail closed instead of reading it as "no tax".
     */
    it('carries every native tax line AMOUNT, and marks unreadable tax detail unreadable', () => {
        const tax = (TxnTaxDetail: unknown) => {
            const inv = parseQuickBooksInvoice({ ...INVOICE, TxnTaxDetail })!;
            return { totalTax: inv.totalTax, taxLineAmounts: inv.taxLineAmounts, txnTaxCodeId: inv.txnTaxCodeId, readable: inv.taxDetailReadable };
        };
        // Legacy sales tax on a non-taxable invoice, and the three Automated Sales Tax zero-tax shapes.
        expect(tax(undefined)).toEqual({ totalTax: null, taxLineAmounts: [], txnTaxCodeId: null, readable: true });
        expect(tax({ TotalTax: 0 })).toEqual({ totalTax: 0, taxLineAmounts: [], txnTaxCodeId: null, readable: true });
        expect(tax({ TotalTax: 0, TxnTaxCodeRef: { value: '7' } })).toEqual({ totalTax: 0, taxLineAmounts: [], txnTaxCodeId: '7', readable: true });
        expect(tax({ TotalTax: 0, TaxLine: [{ Amount: 0, DetailType: 'TaxLineDetail', TaxLineDetail: { TaxRateRef: { value: '5' }, NetAmountTaxable: 0 } }] }))
            .toEqual({ totalTax: 0, taxLineAmounts: [0], txnTaxCodeId: null, readable: true });
        expect(tax({ TotalTax: 0, TxnTaxCodeRef: { value: '7' }, TaxLine: [{ Amount: 0 }, { Amount: 0 }] }))
            .toEqual({ totalTax: 0, taxLineAmounts: [0, 0], txnTaxCodeId: '7', readable: true });
        // Tax that is worth money is carried exactly, per line.
        expect(tax({ TotalTax: 5.59, TaxLine: [{ Amount: 5.59 }] })).toEqual({ totalTax: 5.59, taxLineAmounts: [5.59], txnTaxCodeId: null, readable: true });
        // Unreadable: a block that is not an object, a TotalTax that is not a finite number, tax lines that are not a list.
        expect(tax('x').readable).toBe(false);
        expect(tax([{ TotalTax: 0 }]).readable).toBe(false);
        expect(tax({ TotalTax: '0' })).toEqual({ totalTax: null, taxLineAmounts: [], txnTaxCodeId: null, readable: false });
        expect(tax({ TotalTax: 0, TaxLine: { Amount: 0 } })).toEqual({ totalTax: 0, taxLineAmounts: [], txnTaxCodeId: null, readable: false });
        // A tax line whose amount QuickBooks did not state as a number is kept as null — the contract refuses it.
        expect(tax({ TotalTax: 0, TaxLine: [{ Amount: '0' }] }).taxLineAmounts).toEqual([null]);
    });
});

describe('QB-INVOICE-1C · setup reads and the confirmed item create', () => {
    it('preferences reduce addresses to presence; lists use exactly the three documented queries; reads use the entity path', async () => {
        const r = recorder([
            json(200, { Preferences: { SalesFormsPrefs: { SalesEmailCc: { Address: 'bookkeeper@example.invalid' }, ETransactionPaymentEnabled: true, CustomTxnNumbers: false }, CurrencyPrefs: { HomeCurrency: { value: 'USD' } } } }),
            json(200, { QueryResponse: { Account: [{ Id: '79', Name: 'Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome', Active: true }] } }),
            json(200, { QueryResponse: { Item: [{ Id: '11', Name: 'Sales item', Type: 'Service', Active: true, IncomeAccountRef: { value: '79' } }] } }),
            json(200, { QueryResponse: {} }),
            json(200, { Item: { Id: '11', Name: 'Sales item', Type: 'Service', Active: true, IncomeAccountRef: { value: '79' } } }),
        ]);
        const prefs = await readQuickBooksPreferences(config, TOKEN, REALM, r.fetchImpl);
        expect(prefs).toEqual({ defaultCcPresent: true, defaultBccPresent: false, emailCopyToCompany: false, onlinePaymentsEnabled: true, customTxnNumbers: false, homeCurrency: 'USD', multiCurrencyEnabled: false });
        expect(JSON.stringify(prefs)).not.toContain('bookkeeper');
        expect(await listQuickBooksAccounts(config, TOKEN, REALM, r.fetchImpl)).toEqual([{ id: '79', name: 'Sales', accountType: 'Income', accountSubType: 'SalesOfProductIncome', active: true }]);
        expect(await listQuickBooksItems(config, TOKEN, REALM, r.fetchImpl)).toEqual([{ id: '11', name: 'Sales item', type: 'Service', active: true, incomeAccountId: '79' }]);
        expect(await listQuickBooksTerms(config, TOKEN, REALM, r.fetchImpl)).toEqual([]);
        expect(await readQuickBooksItem(config, TOKEN, REALM, '11', r.fetchImpl)).toMatchObject({ id: '11', incomeAccountId: '79' });
        expect(r.calls.map((c) => c.url.searchParams.get('query'))).toEqual([null, 'select * from Account maxresults 1000', 'select * from Item maxresults 1000', 'select * from Term maxresults 200', null]);
        expect(r.calls.map((c) => c.url.pathname.replace(`/v3/company/${REALM}`, ''))).toEqual(['/preferences', '/query', '/query', '/query', '/item/11']);
    });

    it('a malformed list row fails closed (never silently skipped)', async () => {
        expect(await kindOf(listQuickBooksItems(config, TOKEN, REALM, recorder([json(200, { QueryResponse: { Item: [{ Id: '11', Name: 'ok', Type: 'Service', Active: true }, { Id: 'x' }] } })]).fetchImpl))).toBe('malformed');
    });

    it('the item create sends a non-taxable Service item with ONLY a name and an income account, under a requestid', async () => {
        const r = recorder([json(200, { Item: { Id: '15', Name: 'FreezerIQ Fundraiser Sales', Type: 'Service', Active: true, IncomeAccountRef: { value: '79' } } })]);
        await createQuickBooksServiceItem(config, TOKEN, REALM, { name: 'FreezerIQ Fundraiser Sales', incomeAccountId: '79' }, 'abc123', r.fetchImpl);
        expect(JSON.parse(r.calls[0].body!)).toEqual({ Name: 'FreezerIQ Fundraiser Sales', Type: 'Service', Taxable: false, IncomeAccountRef: { value: '79' } });
        expect(r.calls[0].url.searchParams.get('requestid')).toBe('abc123');
        expect(await kindOf(createQuickBooksServiceItem(config, TOKEN, REALM, { name: 'A:B', incomeAccountId: '79' }, 'abc123', recorder([]).fetchImpl))).toBe('rejected');
        expect(await kindOf(createQuickBooksServiceItem(config, TOKEN, REALM, { name: 'Ok', incomeAccountId: '79' }, 'abc123', recorder([fault(400, '6240')]).fetchImpl))).toBe('duplicate_name');
    });
});
