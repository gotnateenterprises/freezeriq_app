/**
 * INTUIT APP ASSESSMENT — Error Handling Q2/Q3: the sanitized Intuit error detail.
 *
 * Q2 ("does your app capture intuit_tid from response headers?") is answered by the client, which reads the
 * header on every response and carries it on every IntuitError. Q3 ("a mechanism for storing all error
 * information in logs that can be shared for troubleshooting") is answered by this formatter plus the durable
 * `quickbooks_invoice_sends.problem_detail` column it feeds: after a failed send, a support case can be
 * reconstructed from the database alone — reason, stage, HTTP status, Intuit Fault codes and intuit_tid.
 *
 * What must NEVER be in that record is the point of most of these tests: no access or refresh token, no
 * authorization code, no client secret, no realm id, no customer name or email, no invoice amounts or lines.
 */
import { IntuitError, intuitErrorDetail } from '@/lib/quickbooks/intuitClient';
import { QuickBooksConnectionError } from '@/lib/quickbooks/connection';
import { startQuickBooksInvoiceSend, getQuickBooksInvoiceSendView } from '@/lib/quickbooks/invoiceSend';
import { ADMIN_USER, BIZ, CC, invoiceWorld, RECIPIENT, type World, type WorldOptions } from './helpers/quickbooksInvoiceWorld';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) expect(w.store.violations).toEqual([]); });
async function world(options: WorldOptions = {}) { const w = await invoiceWorld(options); worlds.push(w); return w; }
const input = (w: World, invoiceId: string) => ({ businessId: BIZ, invoiceId, config: w.config });

async function send(w: World, invoiceId: string) {
    const view: any = await getQuickBooksInvoiceSendView(input(w, invoiceId), w.deps);
    return startQuickBooksInvoiceSend({
        ...input(w, invoiceId), userId: ADMIN_USER, reviewToken: view.reviewToken ?? 'f'.repeat(64),
        recipientTo: RECIPIENT, recipientCc: CC,
    }, w.deps);
}

describe('QB · the sanitized Intuit error detail', () => {
    it('A: status, Fault code and intuit_tid all survive, in one deterministic bounded string', () => {
        const e = new IntuitError('rejected', { status: 400, intuitTid: 'abc-123-DEF', faultCodes: ['6000', '2380'] });
        expect(intuitErrorDetail(e)).toBe('kind:rejected,http:400,fault:6000|2380,tid:abc-123-DEF');
        // Deterministic: the same error always formats the same way.
        expect(intuitErrorDetail(e)).toBe(intuitErrorDetail(e));
        // Each field is optional and simply absent when Intuit did not provide it.
        expect(intuitErrorDetail(new IntuitError('network'))).toBe('kind:network');
        expect(intuitErrorDetail(new IntuitError('http', { status: 503 }))).toBe('kind:http,http:503');
        expect(intuitErrorDetail(new IntuitError('stale_object', { status: 400, faultCodes: ['5010'] }))).toBe('kind:stale_object,http:400,fault:5010');
        expect(intuitErrorDetail(new IntuitError('unauthorized', { status: 401, intuitTid: 'T-9' }))).toBe('kind:unauthorized,http:401,tid:T-9');
        // A non-Intuit error keeps the old behaviour: its NAME, never its message.
        expect(intuitErrorDetail(new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443'))).toBe('kind:TypeError');
        expect(intuitErrorDetail('some string')).toBe('kind:unknown');
        expect(intuitErrorDetail(null)).toBe('kind:unknown');
        // Bounded.
        const long = new IntuitError('rejected', { status: 400, intuitTid: 'x'.repeat(128), faultCodes: Array(8).fill('123456') });
        expect(intuitErrorDetail(long).length).toBeLessThanOrEqual(140);
    });

    it('C: nothing sensitive can reach the detail, even when the error is constructed with hostile input', () => {
        const hostile = new IntuitError('rejected', {
            status: 400,
            // Only shapes that pass IntuitError's own validation survive; everything else is dropped there.
            intuitTid: 'tid-ok-1',
            faultCodes: ['6000', 'ya29.A0ARrdaM-secret-access-token', 'AB11700000000refreshtoken', 'not a code!'],
        });
        const detail = intuitErrorDetail(hostile);
        expect(detail).toBe('kind:rejected,http:400,fault:6000,tid:tid-ok-1');
        for (const secret of ['ya29', 'secret-access-token', 'AB117', 'refreshtoken', 'not a code']) {
            expect({ secret, present: detail.includes(secret) }).toEqual({ secret, present: false });
        }
        // The formatter reads only IntuitError's own fields — it never sees a body, a URL or a token.
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/quickbooks/intuitClient.ts'), 'utf8');
        const fn = src.slice(src.indexOf('export function intuitErrorDetail'), src.indexOf('export interface IntuitTokenSet'));
        for (const f of ['accessToken', 'refreshToken', 'clientSecret', 'realmId', 'body', 'JSON.stringify', 'headers']) {
            expect({ f, present: fn.includes(f) }).toEqual({ f, present: false });
        }
    });
});

describe('QB-INVOICE-1C · a failed send leaves a durable, shareable troubleshooting record', () => {
    it('B: problem_detail carries the stage, Intuit kind, HTTP status, Fault code and intuit_tid', async () => {
        const w = await world();
        const inv = w.seedE2();
        // Intuit refuses the create with a Fault, a status and a correlation id.
        w.qbo.failNext({ op: 'create', kind: 'status', status: 400, code: '6000' });
        const result = await send(w, inv.id);
        expect(result.outcome).toBe('needs_review');

        const row = w.store.sends.get(inv.id)!;
        expect(row.problem).toBe('create_rejected');
        expect(row.problem_detail).toContain('kind:rejected');
        expect(row.problem_detail).toContain('http:400');
        expect(row.problem_detail).toContain('fault:6000');
        expect(row.problem_detail).toMatch(/tid:[A-Za-z0-9-]+/); // Intuit's correlation id, from the response header
        expect(row.problem_detail.length).toBeLessThanOrEqual(500); // the column's CHECK
        expect(row.problem_at).toBeInstanceOf(Date);
        // The FreezerIQ invoice is untouched by a failure.
        expect(w.store.invoices.get(inv.id)!.status).toBe('DRAFT');
    });

    it('C: the durable record carries no token, secret, realm id, recipient or accounting data', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'create', kind: 'status', status: 400, code: '6000' });
        await send(w, inv.id);
        const detail = w.store.sends.get(inv.id)!.problem_detail as string;

        const realm = w.intuit.realmId ?? '9130000000000001';
        for (const secret of [realm, RECIPIENT, 'coordinator', 'Lincoln PTA', '451.59', '437.5', '111.5', 'Bearer', 'access', 'refresh', 'secret', 'code=']) {
            expect({ secret, inDetail: detail.toLowerCase().includes(String(secret).toLowerCase()) }).toEqual({ secret, inDetail: false });
        }
        // Only the four documented fields, in the documented shape.
        expect(detail).toMatch(/^kind:[a-z_]+(,http:\d+)?(,fault:[0-9A-Za-z|-]+)?(,tid:[A-Za-z0-9-]+)?$/);
    });

    it('D+F: a successful send records no problem at all, and the lifecycle is unchanged', async () => {
        const w = await world();
        const inv = w.seedE2();
        const result = await send(w, inv.id);
        expect(result.outcome).toBe('sent');
        const row = w.store.sends.get(inv.id)!;
        expect({ problem: row.problem, detail: row.problem_detail, at: row.problem_at }).toEqual({ problem: null, detail: null, at: null });
        expect(row.status).toBe('sent');
        expect(row.send_count).toBe(1);
        expect(w.store.invoices.get(inv.id)!.status).toBe('SENT');
    });

    it('D: a refused SEND still parks resumably — unchanged behaviour, now with the correlation id retained', async () => {
        const w = await world();
        const inv = w.seedE2();
        w.qbo.failNext({ op: 'send', kind: 'status', status: 400, code: '2380' });
        const result = await send(w, inv.id);
        expect(result.outcome).toBe('in_progress'); // paused, not stopped: the SAME invoice is sent next time
        const row = w.store.sends.get(inv.id)!;
        expect(row.problem).toBe('send_rejected');
        expect(row.status).not.toBe('needs_review');
        expect(row.send_requested_at).toBeNull(); // lifecycle semantics untouched
        expect(row.problem_detail).toContain('kind:rejected');
        expect(row.problem_detail).toContain('http:400');
        expect(row.problem_detail).toContain('fault:2380');
        expect(row.problem_detail).toMatch(/tid:[A-Za-z0-9-]+/);
        expect(w.qbo.invoices.size).toBe(1); // no second QuickBooks invoice
    });

    it('E: the OAuth/connection layer still logs its own reason and correlation id', () => {
        const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib/quickbooks/connection.ts'), 'utf8');
        expect(src).toContain('function tidSuffix(');
        expect(src).toContain('intuit_tid=${e.intuitTid}');
        expect(src).toContain('company verification failed:');
        expect(src).toContain('refresh failed:');
    });
});
