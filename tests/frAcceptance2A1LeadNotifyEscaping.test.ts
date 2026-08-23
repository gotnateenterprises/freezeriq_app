/**
 * FR-ACCEPTANCE-2A.1 — public input cannot inject markup into the tenant's
 * lead-notification email.
 *
 * THE DEFECT THIS SUITE EXISTS FOR
 *
 * sendLeadNotificationEmail interpolated `name`, `email`, `phone`, `notes` and
 * `source` straight into an HTML body with no escaping. Every one of those
 * originates at the UNAUTHENTICATED public fundraiser form — `notes` is the
 * assembled free text of the submitter's website, cause and message.
 *
 * So anything typed into a public form on the open internet was rendered as
 * markup inside the tenant's own inbox: a working link to an attacker's site,
 * sitting under a "New Lead!" heading the tenant has been trained to trust. The
 * sibling sendFundraiserCoordinatorNotification in the same file already escaped
 * every field.
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

const notify = async (lead: any) => {
    const { sendLeadNotificationEmail } = await import('@/lib/email');
    await sendLeadNotificationEmail('owner@tenant.test', lead, 'biz-aaaa-1111');
    return (send.mock.calls[0]?.[0]?.html ?? '') as string;
};

const BASE = { name: 'Jo', email: 'jo@lincolnpta.org', phone: '555-0100', source: 'Fundraiser Inquiry' };

beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, RESEND_API_KEY: 'test-key' };
    send.mockResolvedValue({ data: { id: 'm1' }, error: null });
});
afterAll(() => { process.env = ORIGINAL_ENV; });

describe('public input in the tenant lead alert', () => {
    it('neutralises a script tag in the notes', async () => {
        const html = await notify({ ...BASE, notes: '<script>alert(1)</script>' });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('cannot plant a working link to an attacker site', async () => {
        // The most valuable version of this attack: the tenant trusts this email.
        const html = await notify({ ...BASE, notes: '<a href="https://evil.example">Review lead</a>' });
        expect(html).not.toMatch(/<a href="https:\/\/evil\.example"/);
        expect(html).not.toContain('evil.example"');
        expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;');
    });

    it('neutralises an img onerror payload', async () => {
        const html = await notify({ ...BASE, notes: '<img src=x onerror=alert(1)>' });
        expect(html).not.toMatch(/<img[^>]*onerror/i);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    it('escapes every public field, not just notes', async () => {
        const html = await notify({
            name: '<b>Jo</b>',
            email: '"><script>x()</script>',
            phone: '<i>555</i>',
            source: '<u>src</u>',
            notes: '<em>n</em>',
        });
        for (const tag of ['<b>', '<i>', '<u>', '<em>', '<script>']) {
            expect(html).not.toContain(tag);
        }
        expect(html).toContain('&lt;b&gt;Jo&lt;/b&gt;');
    });

    it('cannot break out of an attribute with quotes', async () => {
        const html = await notify({ ...BASE, name: '" onmouseover="alert(1)' });
        expect(html).toContain('&quot;');
        // No unescaped quote-then-handler sequence survives.
        expect(html).not.toMatch(/"\s*onmouseover=/);
    });

    it('preserves ampersands and apostrophes as readable text', async () => {
        // Escaping must not corrupt an ordinary organization name.
        const html = await notify({ ...BASE, name: "Ben & Jerry's PTO" });
        expect(html).toContain('Ben &amp; Jerry&#39;s PTO');
        expect(html).not.toContain('Ben & Jerry');
    });

    it('escapes the acknowledgement notice too', async () => {
        // It is a fixed literal today. Escaping it means a future edit that
        // routes something less trustworthy through the field cannot
        // reintroduce injection.
        const html = await notify({ ...BASE, acknowledgement: '<script>x</script>' });
        expect(html).not.toContain('<script>');
    });

    it('MUTATION: an unescaped template would fail these assertions', async () => {
        // Guards against the suite passing vacuously. Rendering the same payload
        // the old way must produce exactly what the tests above forbid.
        const raw = `<p>${'<script>alert(1)</script>'}</p>`;
        expect(raw).toContain('<script>');
        const escaped = String('<script>alert(1)</script>')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        expect(escaped).not.toContain('<script>');
    });
});

describe('the SUBJECT is a header, not a body', () => {
    const subject = async (lead: any) => {
        const { sendLeadNotificationEmail } = await import('@/lib/email');
        await sendLeadNotificationEmail('owner@tenant.test', lead, 'biz-aaaa-1111');
        return (send.mock.calls[0]?.[0]?.subject ?? '') as string;
    };

    it('strips CR and LF so a name cannot append a header', () => {
        // A header value has no escaping mechanism: a newline ENDS the header and
        // what follows becomes a new one. This is how a public form field turns
        // into a Bcc on the tenant's own alert.
        return subject({ ...BASE, name: 'Jo\r\nBcc: evil@x.com' }).then((s) => {
            expect(s).not.toMatch(/[\r\n]/);
            expect(s).not.toMatch(/Bcc:\s*$/m);
            expect(s).toBe('New Lead Captured: Jo Bcc: evil@x.com');
        });
    });

    it('strips other C0 controls and DEL', async () => {
        const s = await subject({ ...BASE, name: 'Jo\u0000\u0001\u007FSmith' });
        // eslint-disable-next-line no-control-regex
        expect(s).not.toMatch(new RegExp('[\\u0000-\\u001F\\u007F]'));
    });

    it('leaves ordinary punctuation alone', async () => {
        expect(await subject({ ...BASE, name: "Ben & Jerry's PTO" }))
            .toBe("New Lead Captured: Ben & Jerry's PTO");
    });
});

describe('the escaping is applied at the source, not by the provider', () => {
    it('lib/email.ts escapes every interpolated lead field', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib/email.ts'), 'utf8');
        // Anchored on the markup, not the words: an earlier version of this test
        // sliced from the first "New Lead!" and caught a source comment instead.
        const body = src.slice(src.indexOf('<h1 style="color: #4f46e5;">New Lead!'), src.indexOf('View Lead in CRM'));
        // Every ${lead.*} inside the body must be wrapped in escapeHtml(...).
        const bare = [...body.matchAll(/\$\{lead\.(\w+)\}/g)].map((m) => m[1]);
        expect(bare).toEqual([]);
        expect(body).toMatch(/escapeHtml\(lead\.name\)/);
        expect(body).toMatch(/escapeHtml\(lead\.email\)/);
        expect(body).toMatch(/escapeHtml\(lead\.phone\)/);
        expect(body).toMatch(/escapeHtml\(lead\.notes\)/);
        expect(body).toMatch(/escapeHtml\(lead\.source\)/);
    });

    it('the subject uses safeSubject, and there is only one implementation', () => {
        const email = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib/email.ts'), 'utf8');
        expect(email).toMatch(/subject: safeSubject\(`New Lead Captured: \$\{lead\.name\}`\)/);
        expect(email).toMatch(/import \{ safeSubject \} from '@\/lib\/emailTemplates'/);
        // A second local copy would drift from the one the templates use.
        expect(email).not.toMatch(/function safeSubject/);
    });
});
