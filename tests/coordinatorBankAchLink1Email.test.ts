/**
 * COORDINATOR-BANK-ACH-LINK-1 — the supporter's confirmation email shows Bank / ACH exactly as the
 * confirmation screen does: label, the fixed truthful line, the coordinator's note, an escaped
 * "Open bank payment" link and the destination host — and still never claims the order is paid.
 *
 * Runs the REAL sender against a doubled provider and reads the body that would have been sent
 * (harness after tests/coordinatorPaymentMethodUx1Email.test.ts). All data is fictional.
 */
import { toPublicPaymentMethods, checkPaymentMethods, BANK_ACH_GUIDANCE } from '@/lib/supporterPaymentMethods';

const send = jest.fn();
jest.mock('resend', () => ({
    Resend: class { emails = { send: (...a: any[]) => send(...a) }; },
}));
jest.mock('@/lib/db', () => ({
    prisma: {
        business: { findUnique: jest.fn(async () => ({ name: 'Tenant', contact_email: 'owner@tenant.test' })) },
    },
}));

const ORIGINAL_ENV = { ...process.env };
const ORDER = { customer_name: 'Sam Supporter', external_id: 'ord_bach1', total_amount: 125, tax_amount: 1.25 };
const ITEMS = [{ quantity: 1, variant_size: 'serves_5', bundle: { name: 'Harvest Bundle (fixture)' } }];
const PAYEE = 'Lincoln PTO (fixture)';
const BANK_LINK = 'https://pay.examplebank.test/pto/maple?campaign=fall&ref=a1';
const BANK_NOTE = "Enter your order total on the bank's payment page.";
const stored = (input: unknown) => { const r = checkPaymentMethods(input); if (!r.ok) throw new Error(r.error); return r.value; };

async function confirm(methods: unknown) {
    const { sendOrderConfirmationEmail } = await import('@/lib/email');
    await sendOrderConfirmationEmail('sam@example.test', ORDER, ITEMS, 'org@example.test', null, null, undefined, { methods: methods as any });
    const payload = send.mock.calls[0]?.[0] ?? {};
    return (payload.html ?? '') as string;
}
const tagsIn = (html: string) => [...new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const opensLines = (html: string) => [...html.matchAll(/>Opens ([^<]*)</g)].map((m) => m[1]);

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key' };
    send.mockResolvedValue({ data: { id: 'm1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('COORDINATOR-BANK-ACH-LINK-1 · confirmation email', () => {
    it('M1. Bank / ACH: label, the fixed line, the note, an escaped "Open bank payment" link and its host — nothing claims payment', async () => {
        const html = await confirm(toPublicPaymentMethods(stored([{ type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }]), null));
        expect(html).toContain('>Bank / ACH<');
        expect(html).toContain(BANK_ACH_GUIDANCE.replace("'", '&#39;'));
        expect(html).toContain(BANK_NOTE.replace("'", '&#39;'));
        expect(hrefs(html)).toEqual(['https://pay.examplebank.test/pto/maple?campaign=fall&amp;ref=a1']);
        expect(html).toMatch(/>Open bank payment<\/a>/);
        expect(opensLines(html)).toEqual(['pay.examplebank.test']);
        expect(html).not.toMatch(/Pay Now|Payment Required|securely|instant|verified|payment complete/i);
        expect(html).not.toMatch(/\bPaid\b/);
        // COORDINATOR-BANK-ACH-LINK-1A: "payment link", not "payment app" — a bank page is a website.
        expect(html).toContain('Opening a payment link doesn&rsquo;t mark your order paid &mdash; your coordinator confirms it.');
        expect(html).not.toMatch(/payment app/i);
        expect(html).toContain('$126.25');
    });

    it('M2. beside Cash, Check, Venmo and Other: every method in order, each with its own wording, only Bank names a host', async () => {
        const html = await confirm(toPublicPaymentMethods(stored([
            { type: 'other', label: 'School office', details: 'Front desk.', link: 'https://pay.example.test/office' },
            { type: 'bank_ach', link: BANK_LINK }, { type: 'venmo', handle: '@maple-fixture' }, { type: 'check' }, { type: 'cash' },
        ]), PAYEE));
        expect(hrefs(html)).toEqual(['https://venmo.com/u/maple-fixture', 'https://pay.examplebank.test/pto/maple?campaign=fall&amp;ref=a1', 'https://pay.example.test/office']);
        for (const label of ['Open Venmo', 'Open bank payment', 'Open link']) expect(html).toContain(label);
        expect(opensLines(html)).toEqual(['pay.examplebank.test']);
        expect(html.indexOf('>Cash<')).toBeLessThan(html.indexOf('>Bank / ACH<'));
        expect(html.indexOf('>Bank / ACH<')).toBeLessThan(html.indexOf('>School office<'));
    });

    it('M3. a forged bank entry is escaped or dropped — never a script link, never raw markup', async () => {
        const forged = [
            { type: 'bank_ach', label: '<img src=x onerror=alert(1)>', detail: '</p><script>steal()</script>', href: BANK_LINK, actionLabel: 'Open bank payment' },
            { type: 'bank_ach', label: 'Bank / ACH', detail: 'x', href: 'javascript:alert(1)', actionLabel: 'Open bank payment' },
            { type: 'bank_ach', label: 'Bank / ACH', detail: 'no link', href: null, actionLabel: null },
        ];
        const html = await confirm(forged);
        expect(tagsIn(html).every((t) => ['div', 'h1', 'h3', 'p', 'strong', 'a', 'span'].includes(t))).toBe(true);
        expect(hrefs(html)).toEqual(['https://pay.examplebank.test/pto/maple?campaign=fall&amp;ref=a1']);
        expect(html).not.toContain('<script>');
        expect(html).not.toMatch(/<img|href="javascript:/i);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).not.toContain('no link');
    });
});
