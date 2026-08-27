/**
 * SUPPORTER-CONFIRM-HTML-1 — coordinator input cannot become markup in the
 * supporter's order confirmation.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * sendOrderConfirmationEmail dropped two coordinator-authored values into HTML
 * raw: `externalPaymentLink` straight into an `href`, and `paymentInstructions`
 * straight into the body. Its sibling in the same file,
 * sendFundraiserCoordinatorNotification, already escaped every field.
 *
 * The link is the sharper edge. Escaping alone would NOT have contained it:
 * `javascript:alert(1)` contains no HTML-special character, so it passes through
 * an escaper untouched and remains a working href. The scheme itself has to be
 * checked — which is why the render path reuses checkPaymentLink, the same rule
 * the coordinator setup form enforces.
 *
 * Reachability is not theoretical: the tenant-side PATCH /api/campaigns/[id]
 * assigns `external_payment_link: body.external_payment_link` with no
 * validation at all, so an arbitrary value can reach the column and from there
 * every supporter who orders.
 *
 * These tests EXECUTE the real sender against a doubled provider and read the
 * body that would actually have been transmitted.
 */

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

/**
 * Every attribute name that appears inside an ACTUAL tag.
 *
 * Asserting on the raw body would fail for a harmless reason: escaped text
 * legitimately still reads "onerror=alert(1)" — that is the coordinator's own
 * typing, rendered visibly and inertly. What matters is whether it sits inside
 * a tag, so tags are what this looks at.
 */
function attributesInTags(html: string): string[] {
    const out: string[] = [];
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
        for (const m of tag.matchAll(/\s([a-zA-Z-]+)\s*=/g)) out.push(m[1].toLowerCase());
    }
    return [...new Set(out)];
}

const ORDER = { customer_name: 'Sam Supporter', external_id: 'ord_123', total_amount: 125 };
const ITEMS = [{ quantity: 2, variant_size: 'serves_5', bundle: { name: 'Comfort Classics' } }];

/** Runs the REAL sender and returns the payload it would have transmitted. */
async function confirm(opts: { instructions?: string | null; link?: string | null; order?: any; items?: any[] } = {}) {
    const { sendOrderConfirmationEmail } = await import('@/lib/email');
    await sendOrderConfirmationEmail(
        'sam@example.test',
        opts.order ?? ORDER,
        opts.items ?? ITEMS,
        'org@example.test',
        opts.instructions ?? null,
        opts.link ?? null,
        'biz-1',
    );
    const payload = send.mock.calls[0]?.[0] ?? {};
    return { html: (payload.html ?? '') as string, subject: (payload.subject ?? '') as string, payload };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key' };
    send.mockResolvedValue({ data: { id: 'm1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

// ── PAYMENT INSTRUCTIONS: human text, never markup ──────────────────────────
describe('SUPPORTER-CONFIRM-HTML-1 · payment instructions', () => {
    it('ordinary instructions render normally', async () => {
        const { html } = await confirm({ instructions: 'Venmo @our-boosters' });
        expect(html).toContain('Venmo @our-boosters');
        expect(html).toContain('Payment Instructions:');
    });

    it('a script tag becomes visible text, not a script', async () => {
        const { html } = await confirm({ instructions: '<script>alert(1)</script>' });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('an onerror image payload cannot execute', async () => {
        const { html } = await confirm({ instructions: '<img src=x onerror=alert(1)>' });
        expect(html).not.toContain('<img');
        // The literal text "onerror=" survives — escaped and visible — because
        // that is what the coordinator typed. What must not exist is a real tag
        // carrying an event handler.
        expect(attributesInTags(html).filter((a) => a.startsWith('on'))).toEqual([]);
        expect(html).toContain('&lt;img');
    });

    it('coordinator-authored formatting markup does not survive as markup', async () => {
        const { html } = await confirm({ instructions: '<strong>Pay me</strong>' });
        expect(html).not.toContain('<strong>Pay me</strong>');
        expect(html).toContain('&lt;strong&gt;Pay me&lt;/strong&gt;');
    });

    it('an anchor in the instructions is never a link', async () => {
        const { html } = await confirm({ instructions: '<a href="https://attacker.example">click</a>' });
        expect(html).not.toContain('href="https://attacker.example"');
        expect(html).toContain('&lt;a href=');
    });

    it('ampersands, quotes and angle brackets are all escaped', async () => {
        const { html } = await confirm({ instructions: `Ben & Jerry's "cash" <only>` });
        expect(html).toContain('Ben &amp; Jerry&#39;s &quot;cash&quot; &lt;only&gt;');
    });

    it('line breaks are preserved without introducing markup', async () => {
        const { html } = await confirm({ instructions: 'Line one\nLine two' });
        // pre-wrap carries the coordinator's newline; no <br> is invented.
        expect(html).toContain('white-space: pre-wrap');
        expect(html).toContain('Line one\nLine two');
        expect(html).not.toContain('Line one<br');
    });

    it('no coordinator raw HTML survives anywhere in the body', async () => {
        const { html } = await confirm({ instructions: '</p><script>steal()</script><p>' });
        expect(html).not.toContain('<script>steal()');
        expect(html).not.toContain('</p><script>');
    });
});

// ── PAYMENT LINK: scheme-checked before it can be clickable ─────────────────
describe('SUPPORTER-CONFIRM-HTML-1 · payment link', () => {
    it('a valid https URL stays clickable', async () => {
        const { html } = await confirm({ link: 'https://venmo.com/our-boosters' });
        expect(html).toContain('href="https://venmo.com/our-boosters"');
        expect(html).toContain('Pay Now');
    });

    it('query-string ampersands are escaped inside the href', async () => {
        const { html } = await confirm({ link: 'https://pay.test/x?a=1&b=2' });
        expect(html).toContain('href="https://pay.test/x?a=1&amp;b=2"');
        expect(html).not.toContain('href="https://pay.test/x?a=1&b=2"');
    });

    it('a quote cannot break out of the href attribute', async () => {
        const { html } = await confirm({ link: 'https://pay.test/" onmouseover="alert(1)' });
        // This one is a VALID https URL on a real host, so it is accepted — and
        // normalization percent-encodes the quote and space, which is what
        // defuses it. The anchor therefore points at a harmless path on the
        // coordinator's own domain and gains no event handler.
        expect(attributesInTags(html).filter((a) => a.startsWith('on'))).toEqual([]);
        expect(html).toContain('%22');
        expect(html).not.toContain('href="https://pay.test/" onmouseover=');
        const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs.every((h) => !h.includes('"') && !/\son/i.test(h))).toBe(true);
    });

    it('an attacker cannot close the anchor and inject markup', async () => {
        const { html } = await confirm({ link: 'https://pay.test/"><script>alert(1)</script><a href="' });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('"><script');
    });

    it('javascript: is NEVER clickable', async () => {
        const { html } = await confirm({ link: 'javascript:alert(1)' });
        expect(html).not.toContain('href="javascript:');
        expect(html).not.toMatch(/<a[^>]*javascript:/i);
        // Shown to the supporter, but inert.
        expect(html).toContain('javascript:alert(1)');
    });

    it('data: is NEVER clickable', async () => {
        const { html } = await confirm({ link: 'data:text/html,<script>alert(1)</script>' });
        expect(html).not.toMatch(/<a[^>]*href="data:/i);
        expect(html).not.toContain('<script>');
    });

    it('vbscript: and file: are never clickable', async () => {
        for (const bad of ['vbscript:msgbox(1)', 'file:///etc/passwd']) {
            jest.clearAllMocks();
            const { html } = await confirm({ link: bad });
            expect(html).not.toMatch(new RegExp(`<a[^>]*href="${bad.split(':')[0]}:`, 'i'));
        }
    });

    it('a malformed URL is never clickable', async () => {
        for (const bad of ['not a url', 'http://', '://nope', 'https://nodot']) {
            jest.clearAllMocks();
            const { html } = await confirm({ link: bad });
            expect(html).not.toContain('Pay Now');
        }
    });

    it('plain http is refused as an anchor — the rule is https-only, shared with setup', async () => {
        // checkPaymentLink (lib/coordinatorSetup) is the one payment-link rule in
        // the product; the render path adopts it rather than inventing a looser one.
        const { html } = await confirm({ link: 'http://pay.test/x' });
        expect(html).not.toContain('href="http://pay.test/x"');
        expect(html).toContain('http://pay.test/x');   // still visible, inert
    });

    it('embedded credentials are refused', async () => {
        const { html } = await confirm({ link: 'https://user:pass@pay.test/x' });
        expect(html).not.toContain('Pay Now');
    });

    it('no payment section at all when there is no link and no instructions', async () => {
        const { html } = await confirm({});
        expect(html).not.toContain('Payment Required');
        expect(html).not.toContain('Payment Instructions:');
    });
});

// ── ADJACENT FIELDS IN THE SAME TEMPLATE ────────────────────────────────────
describe('SUPPORTER-CONFIRM-HTML-1 · same-template fields', () => {
    it('the supporter-typed name cannot inject markup', async () => {
        const { html } = await confirm({ order: { ...ORDER, customer_name: '<img src=x onerror=alert(1)>' } });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    it('a tenant-authored bundle name cannot inject markup', async () => {
        const { html } = await confirm({ items: [{ quantity: 1, variant_size: 'serves_5', bundle: { name: '<script>x</script>' } }] });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('the subject is control-stripped, and printable text survives', async () => {
        const { subject } = await confirm({ order: { ...ORDER, customer_name: "Ben & Jerry's\nBcc: attacker@evil.test" } });
        expect(subject).not.toContain('\n');
        expect(subject).toContain("Ben & Jerry's");
    });

    it('the whole document contains only the template\'s own tags', async () => {
        const { html } = await confirm({
            instructions: '<script>a</script><iframe></iframe>',
            link: 'javascript:alert(1)',
            order: { ...ORDER, customer_name: '<svg onload=alert(1)>' },
        });
        const tags = [...new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()))];
        expect(tags.every((t) => ['div', 'h1', 'h3', 'p', 'strong', 'a'].includes(t))).toBe(true);
    });
});

// ── NO SIDE EFFECTS ─────────────────────────────────────────────────────────
describe('SUPPORTER-CONFIRM-HTML-1 · rendering mutates nothing', () => {
    it('the order and items objects are not modified', async () => {
        const order = { ...ORDER };
        const items = [{ quantity: 2, variant_size: 'serves_5', bundle: { name: 'Comfort Classics' } }];
        const orderBefore = JSON.stringify(order);
        const itemsBefore = JSON.stringify(items);
        await confirm({ order, items, instructions: '<script>x</script>', link: 'javascript:alert(1)' });
        expect(JSON.stringify(order)).toBe(orderBefore);
        expect(JSON.stringify(items)).toBe(itemsBefore);
    });

    it('rendering touches no database model', async () => {
        const db = await import('@/lib/db');
        await confirm({ instructions: 'Venmo @x', link: 'https://pay.test/x' });
        // The only prisma surface this path uses is the tenant-sender lookup.
        expect(Object.keys((db as any).prisma)).toEqual(['business']);
    });

    it('the supporter is the only recipient', async () => {
        const { payload } = await confirm({ link: 'https://pay.test/x' });
        expect(payload.to).toEqual(['sam@example.test']);
    });
});

// ── SOURCE CONTRACT ─────────────────────────────────────────────────────────
describe('SUPPORTER-CONFIRM-HTML-1 · source contract', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'lib/email.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function sendOrderConfirmationEmail'), src.indexOf('// ── FR-LAUNCH-1D'));
    // The HTML-building region only: from the item list through the closing of
    // htmlContent. The subject is a header, not markup, and is asserted
    // separately via safeSubject.
    const htmlRegion = fn.slice(fn.indexOf('const itemsHtml'), fn.indexOf('try {'));

    it('no raw coordinator value is interpolated into the HTML', () => {
        for (const raw of ['${paymentInstructions}', '${externalPaymentLink}', '${order.customer_name}', '${i.bundle?.name', '${i.variant_size}', '${order.external_id}']) {
            expect(htmlRegion).not.toContain(raw);
        }
        // The subject is not markup, and gets the header treatment instead.
        expect(fn).toContain('safeSubject(`Order Confirmation: ${order.customer_name}`)');
    });

    it('the href is scheme-checked, not merely escaped', () => {
        expect(fn).toContain('safePaymentHref(externalPaymentLink)');
        expect(fn).toContain('href="${escapeHtml(paymentHref)}"');
    });

    it('the scheme rule is the shared one, not a second sanitizer', () => {
        expect(src).toContain("import { checkPaymentLink } from '@/lib/coordinatorSetup'");
        expect(src).toContain('checkPaymentLink(typeof raw === \'string\' ? raw : null)');
        // Only ONE escaper in this module — the pre-existing one.
        expect(src.split('function escapeHtml(').length - 1).toBe(1);
    });
});
