/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — the supporter's confirmation email carries the same payment
 * section the confirmation screen shows, and stays exactly as safe as SUPPORTER-CONFIRM-HTML-1 made it.
 *
 * Runs the REAL sender against a doubled provider and reads the body that would have been sent.
 * A fundraiser order passes `{ methods }` (the campaign's supporter-facing projection); a storefront
 * order passes nothing and keeps its old shape. All data is fictional.
 */
import { toPublicPaymentMethods, checkPaymentMethods, PAYMENT_DUE_GUIDANCE, PAYMENT_CONTACT_FALLBACK } from '@/lib/supporterPaymentMethods';

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
const ORDER = { customer_name: 'Sam Supporter', external_id: 'ord_pmu1', total_amount: 125, tax_amount: 1.25 };
const ITEMS = [{ quantity: 1, variant_size: 'serves_5', bundle: { name: 'Harvest Bundle (fixture)' } }];
const PAYEE = 'Lincoln PTO (fixture)';
const stored = (input: unknown) => { const r = checkPaymentMethods(input); if (!r.ok) throw new Error(r.error); return r.value; };
const ALL = toPublicPaymentMethods(stored([
    { type: 'cash' }, { type: 'check' }, { type: 'venmo', handle: '@maple-fixture' }, { type: 'paypal', account: 'maple@example.test' },
    { type: 'cashapp', cashtag: '$MapleFixture' }, { type: 'other', label: 'Pay at pickup', details: 'Bring cash.\nThank you!', link: 'https://pay.example.test/x?a=1&b=2' },
]), PAYEE);

async function confirm(opts: { instructions?: string | null; link?: string | null; fundraiser?: { methods: any } } = {}) {
    const { sendOrderConfirmationEmail } = await import('@/lib/email');
    await sendOrderConfirmationEmail('sam@example.test', ORDER, ITEMS, 'org@example.test', opts.instructions ?? null, opts.link ?? null, undefined, opts.fundraiser);
    const payload = send.mock.calls[0]?.[0] ?? {};
    return { html: (payload.html ?? '') as string, payload };
}
const tagsIn = (html: string) => [...new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key' };
    send.mockResolvedValue({ data: { id: 'm1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('COORDINATOR-PAYMENT-METHOD-UX-1 · confirmation email', () => {
    it('E1. a fundraiser receipt carries the due line, every selected method, the instructions — and "Open …" links, never "Pay Now" (19, 25, 26)', async () => {
        const { html } = await confirm({ instructions: 'Include the member name.', fundraiser: { methods: ALL } });
        expect(html).toContain('>Payment<');
        expect(html).toContain(PAYMENT_DUE_GUIDANCE);
        for (const t of ['Cash', 'Pay your fundraiser coordinator directly.', `Make checks payable to ${PAYEE}`, '@maple-fixture', 'maple@example.test', '$MapleFixture', 'Pay at pickup', 'Include the member name.']) {
            expect(html).toContain(t);
        }
        expect(hrefs(html)).toEqual(['https://venmo.com/u/maple-fixture', 'https://cash.app/$MapleFixture', 'https://pay.example.test/x?a=1&amp;b=2']);
        for (const label of ['Open Venmo', 'Open Cash App', 'Open link']) expect(html).toContain(label);
        expect(html).not.toMatch(/Pay Now|Payment Required/);
        expect(html).not.toMatch(/\bPaid\b/);
        expect(html).toContain('does not mark your order paid');
        // the total in the summary is the persisted figure, unchanged by any of this
        expect(html).toContain('$126.25');
    });

    it('E2. only the methods the campaign selected appear (20)', async () => {
        const { html } = await confirm({ fundraiser: { methods: toPublicPaymentMethods(stored([{ type: 'cash' }, { type: 'check' }]), PAYEE) } });
        expect(html).toContain(`Make checks payable to ${PAYEE}`);
        expect(html).not.toMatch(/Venmo|PayPal|Cash App|Pay at pickup/);
        expect(hrefs(html)).toEqual([]);
    });

    it('E3. a legacy campaign keeps its own words, with no due line stamped over them, and its link says what it does (23, 38)', async () => {
        const { html } = await confirm({ instructions: 'cash or check at pick up', link: 'https://venmo.com/u/old-link', fundraiser: { methods: null } });
        expect(html).toContain('cash or check at pick up');
        expect(html).not.toContain(PAYMENT_DUE_GUIDANCE);
        expect(hrefs(html)).toEqual(['https://venmo.com/u/old-link']);
        expect(html).toContain('Open payment link');
    });

    it('E4. nothing configured still tells the supporter what to do (40)', async () => {
        const { html } = await confirm({ fundraiser: { methods: null } });
        expect(html).toContain(PAYMENT_DUE_GUIDANCE);
        expect(html).toContain(PAYMENT_CONTACT_FALLBACK);
    });

    it('E5. everything coordinator-typed is escaped, and only the template\'s own tags exist (14)', async () => {
        const forged = [
            // renders (its link is valid) — so its markup-laden text must arrive escaped
            { type: 'other', label: '<img src=x onerror=alert(1)>', detail: '</p><script>steal()</script>', href: 'https://pay.example.test/ok', actionLabel: 'Open link' },
            // dropped entirely: a link that is not exactly what the https rule would produce
            { type: 'other', label: 'Breakout', detail: 'x', href: 'https://pay.example.test/"><script>x</script>', actionLabel: 'Open link' },
            { type: 'venmo', label: 'Venmo', detail: '@x', href: 'javascript:alert(1)', actionLabel: 'Open Venmo' },
        ];
        const { html } = await confirm({ instructions: '<script>a</script>', link: 'javascript:alert(1)', fundraiser: { methods: forged } });
        // the template's own tags only (span is its tax-breakdown row — this order is taxed)
        expect(tagsIn(html).every((t) => ['div', 'h1', 'h3', 'p', 'strong', 'a', 'span'].includes(t))).toBe(true);
        expect(hrefs(html)).toEqual(['https://pay.example.test/ok']);
        expect(html).not.toContain('Breakout');
        expect(html).not.toContain('<script>');
        expect(html).not.toMatch(/<img/);
        expect(html).not.toMatch(/href="javascript:/i);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
        expect(html).toContain('Payment link: javascript:alert(1)');   // the coordinator's typing, shown inert
        for (const h of hrefs(html)) expect(h.startsWith('https://')).toBe(true);
    });

    it('E6. a storefront receipt (no fundraiser payment) is unchanged: no section without instructions or a link', async () => {
        const { html } = await confirm({});
        expect(html).not.toContain('>Payment<');
        expect(html).not.toContain(PAYMENT_DUE_GUIDANCE);
    });

    it('E7. the old storefront link button no longer says "Pay Now" — it says what it does', async () => {
        const { html } = await confirm({ link: 'https://pay.example.test/x' });
        expect(html).toContain('Open payment link');
        expect(html).not.toMatch(/Pay Now|Payment Required/);
    });

    it('E8. no "null" or "undefined" in a receipt with sparse methods (39)', async () => {
        const sparse = toPublicPaymentMethods(stored([{ type: 'check' }, { type: 'paypal', account: 'maple@example.test' }]), null);
        const { html } = await confirm({ fundraiser: { methods: sparse } });
        expect(html).not.toMatch(/>\s*null\s*<|>\s*undefined\s*</);
        expect(html).toContain('Check');
    });

    it('E9. the supporter is still the only recipient', async () => {
        const { payload } = await confirm({ fundraiser: { methods: ALL } });
        expect(payload.to).toEqual(['sam@example.test']);
    });
});
