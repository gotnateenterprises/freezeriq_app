/**
 * QB-INVOICE-1B — the Customer additions to lib/quickbooks/intuitClient.ts, tested at
 * the HTTP boundary with a recording fetch: exact request construction, strict
 * parsing that fails closed, and refusal of unusable input before any request.
 */

import {
    createCustomer,
    displayNameProblem,
    findCustomersByDisplayName,
    findInactiveCustomersByDisplayName,
    IntuitError,
    QUICKBOOKS_DISPLAY_NAME_MAX,
    readCustomer,
} from '@/lib/quickbooks/intuitClient';
import { QUICKBOOKS_API_BASE } from '@/lib/quickbooks/config';
import { sandboxConfig } from './helpers/quickbooksFakes';

const config = sandboxConfig();
const REALM = '9130000000000001';
const TOKEN = 'ACCESSTOKEN-SECRET-client-test';

interface Recorded { url: URL; method: string; headers: Headers; body: string }

function recorder(responses: Array<Response | (() => never)>) {
    const calls: Recorded[] = [];
    const fetchImpl = async (input: string, init: RequestInit = {}) => {
        calls.push({ url: new URL(input), method: (init.method ?? 'GET').toUpperCase(), headers: new Headers(init.headers as any), body: typeof init.body === 'string' ? init.body : '' });
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        if (typeof next === 'function') return next();
        return next;
    };
    return { calls, fetchImpl };
}

const json = (status: number, body: unknown, tid = 'tid-1') =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', intuit_tid: tid } });
const customer = (over: Record<string, unknown> = {}) => ({ Id: '58', DisplayName: 'Lincoln PTA', Active: true, Job: false, PrimaryEmailAddr: { Address: 'pta@example.invalid' }, Balance: 12, ...over });

const kindOf = async (p: Promise<unknown>) => { try { await p; return 'resolved'; } catch (e) { return e instanceof IntuitError ? e.kind : 'other'; } };

describe('QB-INVOICE-1B · findCustomersByDisplayName', () => {
    it('sends two GET queries — active, then Active = false — with the exact escaped literal, minorversion 75 and the bearer token', async () => {
        const r = recorder([json(200, { QueryResponse: { Customer: [customer()] } }), json(200, { QueryResponse: {} })]);
        const out = await findCustomersByDisplayName(config, TOKEN, REALM, "Adam's PTA", r.fetchImpl);
        expect(r.calls.map((c) => [c.method, `${c.url.origin}${c.url.pathname}`, c.url.searchParams.get('query'), c.url.searchParams.get('minorversion')])).toEqual([
            ['GET', `${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM}/query`, "select * from Customer where DisplayName = 'Adam\\'s PTA' maxresults 20", '75'],
            ['GET', `${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM}/query`, "select * from Customer where DisplayName = 'Adam\\'s PTA' and Active = false maxresults 20", '75'],
        ]);
        expect(r.calls[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect([...r.calls[0].url.searchParams.keys()].sort()).toEqual(['minorversion', 'query']);
        expect(out).toEqual([{ id: '58', displayName: 'Lincoln PTA', active: true, subCustomer: false }]); // email and balance are dropped
    });

    it('merges active and inactive results by id and returns Intuit’s case-insensitive matches untouched (the caller decides exactness)', async () => {
        const r = recorder([
            json(200, { QueryResponse: { Customer: [customer({ Id: '1', DisplayName: 'LINCOLN PTA' })] } }),
            json(200, { QueryResponse: { Customer: [customer({ Id: '2', Active: false }), customer({ Id: '3', IsProject: true })] } }),
        ]);
        expect(await findCustomersByDisplayName(config, TOKEN, REALM, 'Lincoln PTA', r.fetchImpl)).toEqual([
            { id: '1', displayName: 'LINCOLN PTA', active: true, subCustomer: false },
            { id: '2', displayName: 'Lincoln PTA', active: false, subCustomer: false },
            { id: '3', displayName: 'Lincoln PTA', active: true, subCustomer: true },
        ]);
    });

    it('fails closed: a Fault on 200, a Fault inside QueryResponse, a missing QueryResponse or one bad row throws — never "no match"', async () => {
        const cases: Array<[string, Response]> = [
            ['fault on 200', json(200, { Fault: { Error: [{ code: '10000' }], type: 'SystemFault' } })],
            ['fault inside QueryResponse', json(200, { QueryResponse: { Fault: { Error: [{ code: '4001' }] } } })],
            ['no QueryResponse', json(200, { time: 'now' })],
            ['non-array Customer', json(200, { QueryResponse: { Customer: { Id: '1' } } })],
            ['one malformed row', json(200, { QueryResponse: { Customer: [customer(), { Id: 'x', DisplayName: 'Y', Active: true }] } })],
            ['400 validation fault', json(400, { Fault: { Error: [{ code: '4000' }], type: 'ValidationFault' } })],
            ['500', json(500, {})],
        ];
        for (const [name, res] of cases) {
            const r = recorder([res]);
            expect({ name, kind: await kindOf(findCustomersByDisplayName(config, TOKEN, REALM, 'Lincoln PTA', r.fetchImpl)) })
                .toEqual({ name, kind: expect.stringMatching(/^(http|malformed|rejected)$/) });
        }
    });

    it('401/403 is unauthorized and a network failure is network — and no error message carries the token', async () => {
        for (const [res, kind] of [[json(401, {}), 'unauthorized'], [json(403, {}), 'unauthorized'], [() => { throw new TypeError(`boom ${TOKEN}`); }, 'network']] as const) {
            const r = recorder([res as any]);
            try {
                await findCustomersByDisplayName(config, TOKEN, REALM, 'Lincoln PTA', r.fetchImpl);
                throw new Error('should have thrown');
            } catch (e: any) {
                expect(e).toBeInstanceOf(IntuitError);
                expect(e.kind).toBe(kind);
                expect(`${e.message} ${e.stack}`).not.toContain(TOKEN);
            }
        }
    });

    it('refuses an unusable name or realm before any request', async () => {
        for (const name of ['', ' Lincoln', 'Lincoln ', 'A:B', 'Tab\there', 'New\nline', 'Back\\slash', 'x'.repeat(QUICKBOOKS_DISPLAY_NAME_MAX + 1)]) {
            const r = recorder([]);
            expect({ name, kind: await kindOf(findCustomersByDisplayName(config, TOKEN, REALM, name, r.fetchImpl)) }).toEqual({ name, kind: 'rejected' });
            expect(r.calls).toHaveLength(0);
        }
        const r = recorder([]);
        expect(await kindOf(findCustomersByDisplayName(config, TOKEN, '12/34', 'Lincoln PTA', r.fetchImpl))).toBe('malformed');
        expect(r.calls).toHaveLength(0);
    });

    it('displayNameProblem names each problem and accepts ordinary names', () => {
        expect(displayNameProblem('Lincoln Elementary PTO — 2026 Fall')).toBeNull();
        expect(displayNameProblem("St. Mary's Band & Choir (100%)")).toBeNull();
        expect(displayNameProblem('Niño Fundraiser')).toBeNull();
        expect(displayNameProblem('')).toBe('empty');
        expect(displayNameProblem(null)).toBe('empty');
        expect(displayNameProblem(' x')).toBe('surrounding_whitespace');
        expect(displayNameProblem('a:b')).toBe('forbidden_character');
        expect(displayNameProblem('x'.repeat(101))).toBe('too_long');
    });
});

describe('QB-INVOICE-1B · findInactiveCustomersByDisplayName (owner ruling B)', () => {
    it('sends ONE GET query — Active = false only — with the exact escaped literal, and accepts the QuickBooks suffix past 100 characters', async () => {
        const long = `${'L'.repeat(100)} (deleted)`;
        const r = recorder([json(200, { QueryResponse: { Customer: [customer({ DisplayName: "Adam's PTA (deleted)", Active: false })] } }), json(200, { QueryResponse: {} })]);
        expect(await findInactiveCustomersByDisplayName(config, TOKEN, REALM, "Adam's PTA (deleted)", r.fetchImpl)).toEqual([{ id: '58', displayName: "Adam's PTA (deleted)", active: false, subCustomer: false }]);
        expect(await findInactiveCustomersByDisplayName(config, TOKEN, REALM, long, r.fetchImpl)).toEqual([]);
        expect(r.calls.map((c) => [c.method, `${c.url.origin}${c.url.pathname}`, c.url.searchParams.get('query'), c.url.searchParams.get('minorversion')])).toEqual([
            ['GET', `${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM}/query`, "select * from Customer where DisplayName = 'Adam\\'s PTA (deleted)' and Active = false maxresults 20", '75'],
            ['GET', `${QUICKBOOKS_API_BASE.sandbox}/v3/company/${REALM}/query`, `select * from Customer where DisplayName = '${long}' and Active = false maxresults 20`, '75'],
        ]);
    });

    it('refuses an empty name, surrounding whitespace, a forbidden character or an absurd length before any request', async () => {
        const r = recorder([]);
        for (const name of ['', ' Lincoln PTA (deleted)', 'Lincoln: PTA (deleted)', 'Back\\slash (deleted)', 'x'.repeat(501)]) {
            expect({ name: name.slice(0, 24), kind: await kindOf(findInactiveCustomersByDisplayName(config, TOKEN, REALM, name, r.fetchImpl)) }).toEqual({ name: name.slice(0, 24), kind: 'rejected' });
        }
        expect(r.calls).toHaveLength(0);
    });
});

describe('QB-INVOICE-1B · readCustomer', () => {
    it('GETs /customer/{id}?minorversion=75 and keeps four fields', async () => {
        const r = recorder([json(200, { Customer: customer({ Id: '58' }) })]);
        expect(await readCustomer(config, TOKEN, REALM, '58', r.fetchImpl)).toEqual({ id: '58', displayName: 'Lincoln PTA', active: true, subCustomer: false });
        expect(`${r.calls[0].method} ${r.calls[0].url.pathname}${r.calls[0].url.search}`).toBe(`GET /v3/company/${REALM}/customer/58?minorversion=75`);
    });

    it('Fault 610 (any status) is "does not exist" → null; other failures throw', async () => {
        expect(await readCustomer(config, TOKEN, REALM, '58', recorder([json(400, { Fault: { Error: [{ code: '610' }], type: 'ValidationFault' } })]).fetchImpl)).toBeNull();
        expect(await readCustomer(config, TOKEN, REALM, '58', recorder([json(200, { Fault: { Error: [{ code: '610' }] } })]).fetchImpl)).toBeNull();
        expect(await kindOf(readCustomer(config, TOKEN, REALM, '58', recorder([json(503, {})]).fetchImpl))).toBe('http');
        expect(await kindOf(readCustomer(config, TOKEN, REALM, '58', recorder([json(200, { Fault: { Error: [{ code: '10000' }] } })]).fetchImpl))).toBe('http');
        expect(await kindOf(readCustomer(config, TOKEN, REALM, '58', recorder([json(200, { Customer: customer({ Id: '59' }) })]).fetchImpl))).toBe('malformed');
        expect(await kindOf(readCustomer(config, TOKEN, REALM, '58', recorder([json(200, { Customer: { Id: '58' } })]).fetchImpl))).toBe('malformed');
    });

    it('refuses a non-numeric id before any request', async () => {
        const r = recorder([]);
        expect(await kindOf(readCustomer(config, TOKEN, REALM, '58 or 1=1', r.fetchImpl))).toBe('rejected');
        expect(r.calls).toHaveLength(0);
    });
});

describe('QB-INVOICE-1B · createCustomer', () => {
    it('POSTs exactly {"DisplayName"} as JSON with requestid and minorversion — nothing else', async () => {
        const r = recorder([json(200, { Customer: customer({ Id: '101' }) })]);
        const created = await createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'a'.repeat(40), r.fetchImpl);
        expect(created).toEqual({ id: '101', displayName: 'Lincoln PTA', active: true, subCustomer: false });
        const c = r.calls[0];
        expect(c.method).toBe('POST');
        expect(c.url.pathname).toBe(`/v3/company/${REALM}/customer`);
        expect(Object.fromEntries(c.url.searchParams)).toEqual({ minorversion: '75', requestid: 'a'.repeat(40) });
        expect(c.headers.get('content-type')).toBe('application/json');
        expect(JSON.parse(c.body)).toEqual({ DisplayName: 'Lincoln PTA' });
    });

    it('maps outcomes: 6240 → duplicate_name; another 4xx Fault → rejected; 5xx → http; lost response → network; odd 2xx → malformed', async () => {
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([json(400, { Fault: { Error: [{ code: '6240', Message: 'Duplicate Name Exists Error' }], type: 'ValidationFault' } })]).fetchImpl))).toBe('duplicate_name');
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([json(400, { Fault: { Error: [{ code: '2050' }], type: 'ValidationFault' } })]).fetchImpl))).toBe('rejected');
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([json(503, {})]).fetchImpl))).toBe('http');
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([() => { throw new TypeError('socket hang up'); }]).fetchImpl))).toBe('network');
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([json(200, { Customer: { Id: 'abc' } })]).fetchImpl))).toBe('malformed');
        expect(await kindOf(createCustomer(config, TOKEN, REALM, 'Lincoln PTA', 'req-1', recorder([json(200, { Fault: { Error: [{ code: '10000' }] } })]).fetchImpl))).toBe('malformed');
    });

    it('refuses an unusable name or requestid before any request', async () => {
        for (const [name, requestId] of [['A:B', 'req-1'], ['Lincoln PTA', ''], ['Lincoln PTA', 'x'.repeat(51)], ['Lincoln PTA', 'has space']]) {
            const r = recorder([]);
            expect(await kindOf(createCustomer(config, TOKEN, REALM, name, requestId, r.fetchImpl))).toBe('rejected');
            expect(r.calls).toHaveLength(0);
        }
    });
});
