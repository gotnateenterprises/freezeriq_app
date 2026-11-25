/**
 * INQUIRY-REPLY-EXTRA-1 (owner-approved 2026-11-25, decisions D8–D10) — the tenant's ONE optional section in the
 * fundraiser inquiry reply, set in Settings → Fundraisers → "Fundraiser Inquiry Reply".
 *
 *   A  validation and storage (tenant-scoped system_settings row; no migration)
 *   B  rendering: built-in email byte-identical when unset; the section placed before "Ready to get a date on
 *      the calendar?"; heading in the template's <h3>; every character escaped
 *   C  ONE rendering authority for all three send paths (automatic, Respond dialog, generic send)
 *   D  the Settings API: administrator only, the session's tenant only, preview writes and sends nothing
 *   E  the Settings card and page
 *   F  protections preserved: send-once, recipient, Preview redirect, consent, lead routing untouched
 *
 * Fictional data only (public repository).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import {
    INQUIRY_REPLY_BODY_MAX,
    INQUIRY_REPLY_HEADING_MAX,
    INQUIRY_REPLY_PREVIEW_SAMPLE,
    activeInquiryReplySection,
    decodeInquiryReplyExtra,
    encodeInquiryReplyExtra,
    inquiryReplyExtraKey,
    mayManageInquiryReply,
    parseInquiryReplyExtraInput,
    readInquiryReplyExtra,
    writeInquiryReplyExtra,
} from '@/lib/inquiryReplyExtra';
import { EMAIL_TEMPLATES, type TemplateTenant } from '@/lib/emailTemplates';
import { renderInquiryReply } from '@/lib/inquiryReply';
import { htmlToEditableText } from '@/lib/plainTextEmail';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ireDb; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__ireSession ?? null) }));
const sent: any[] = [];
jest.mock('@/lib/emailSafety', () => ({
    createResendClient: () => ({ emails: { send: jest.fn(async (msg: any) => { sent.push(msg); return { data: { id: `msg-${sent.length}` }, error: null }; }) } }),
}));
jest.mock('@/lib/email', () => ({
    getTenantSender: jest.fn(async () => ({ from: 'Example Kitchen via FreezerIQ <notifications@example.test>', replyTo: 'hello@example.test' })),
    sendLeadNotificationEmail: jest.fn(async () => true),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const BASE = '284b43f';

// ── fictional world ──────────────────────────────────────────────────────────────────────────────
const BIZ_A = 'biz-ire1-aaaa';
const BIZ_B = 'biz-ire1-bbbb';
const TENANT: TemplateTenant = { name: 'Example Kitchen', email: 'hello@example.test', site: 'https://example.test', siteLabel: 'example.test' };
const APPROVED = {
    heading: 'Even More Ways to Raise Money!',
    body: [
        'In addition to our delicious freezer meal bundles, your fundraiser may also have the opportunity to offer a Sides & Dessert Bundle — giving supporters an easy way to complete their meals with delicious sides and something sweet while helping your organization earn even more.',
        "It's completely optional, and our online ordering page automatically presents the offer to eligible supporters.",
        "Add-on sales provide additional fundraising earnings without affecting your regular meal bundle goal. It's another simple way to make the most of your fundraiser!",
    ].join('\n\n'),
};

/** A tiny tenant-scoped database: businesses, system settings, inquiries. */
function makeDb(seed: { settings?: Array<{ key: string; value: string; business_id: string | null }> } = {}) {
    const settings = new Map<string, { key: string; value: string; business_id: string | null }>();
    for (const s of seed.settings ?? []) settings.set(s.key, { ...s });
    const writes: any[] = [];
    const inquiries = new Map<string, any>([
        ['inq-ire1-1', { id: 'inq-ire1-1', business_id: BIZ_A, contact_name: 'Jordan Fixture', contact_email: 'jordan@example.test', organization_name: 'Maple Grove PTO', ack_claimed_at: null, ack_sent_at: null }],
    ]);
    return {
        writes,
        settings,
        inquiries,
        business: {
            findUnique: jest.fn(async ({ where }: any) => (where.id === BIZ_A
                ? { name: 'Example Kitchen LLC', display_name: 'Example Kitchen', custom_domain: 'example.test', contact_email: 'hello@example.test', slug: 'example-kitchen' }
                : where.id === BIZ_B ? { name: 'Other Kitchen', display_name: null, custom_domain: null, contact_email: null, slug: 'other-kitchen' } : null)),
        },
        systemSetting: {
            findUnique: jest.fn(async ({ where }: any) => settings.get(where.key) ?? null),
            upsert: jest.fn(async (args: any) => {
                writes.push(args);
                const row = { key: args.where.key, value: args.create.value, business_id: args.create.business_id };
                settings.set(args.where.key, settings.has(args.where.key) ? { ...settings.get(args.where.key)!, ...args.update } : row);
                return row;
            }),
        },
        fundraiserInquiry: {
            findFirst: jest.fn(async ({ where }: any) => {
                const r = inquiries.get(where.id);
                return r && r.business_id === where.business_id ? { ...r } : null;
            }),
            findUnique: jest.fn(async ({ where }: any) => { const r = inquiries.get(where.id); return r ? { ...r } : null; }),
            updateMany: jest.fn(async ({ where, data }: any) => {
                const r = inquiries.get(where.id);
                if (!r) return { count: 0 };
                if ('ack_claimed_at' in where && where.ack_claimed_at === null && r.ack_claimed_at !== null) return { count: 0 };
                if ('ack_sent_at' in where && where.ack_sent_at === null && r.ack_sent_at !== null) return { count: 0 };
                Object.assign(r, data);
                return { count: 1 };
            }),
            update: jest.fn(async ({ where, data }: any) => { const r = inquiries.get(where.id); Object.assign(r, data); return r; }),
        },
    };
}
const stored = (businessId: string, v: { enabled: boolean; heading: string; body: string }) => ({
    key: inquiryReplyExtraKey(businessId), value: encodeInquiryReplyExtra(v), business_id: businessId,
});

/** The lead_intro generator exactly as it was at the base commit — transpiled from git history. */
function baselineTemplates(): typeof EMAIL_TEMPLATES {
    const ts = require('typescript');
    const src = execSync(`git show ${BASE}:lib/emailTemplates.ts`, { cwd: ROOT, encoding: 'utf8' });
    const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
    const mod: any = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', out)((id: string) => require(id === '@/lib/personName' ? '@/lib/personName' : id), mod, mod.exports);
    return mod.exports.EMAIL_TEMPLATES;
}

beforeEach(() => {
    sent.length = 0;
    delete process.env.EMAIL_LIVE;
    delete process.env.RESEND_API_KEY;
    (global as any).__ireSession = { user: { businessId: BIZ_A, role: 'ADMIN', isSuperAdmin: false } };
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('A · validation and tenant-scoped storage', () => {
    it('A1. enabled must be a boolean; turning it on needs a heading AND a message', () => {
        expect(parseInquiryReplyExtraInput({ enabled: 'yes', heading: 'h', body: 'b' })).toMatchObject({ ok: false, code: 'INVALID_ENABLED' });
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: '  ', body: 'b' })).toMatchObject({ ok: false, code: 'SECTION_INCOMPLETE' });
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 'h', body: '\n\n' })).toMatchObject({ ok: false, code: 'SECTION_INCOMPLETE' });
        expect(parseInquiryReplyExtraInput({ enabled: false, heading: '', body: '' })).toEqual({ ok: true, value: { enabled: false, heading: '', body: '' } });
        for (const bad of [null, [], 'x', 42]) expect(parseInquiryReplyExtraInput(bad).ok).toBe(false);
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 5, body: 'b' })).toMatchObject({ ok: false, code: 'INVALID_HEADING' });
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 'h', body: {} })).toMatchObject({ ok: false, code: 'INVALID_MESSAGE' });
    });

    it('A2. length limits: heading 80, message 1,200 (the approved Freezer Chef copy fits)', () => {
        expect(INQUIRY_REPLY_HEADING_MAX).toBe(80);
        expect(INQUIRY_REPLY_BODY_MAX).toBe(1200);
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 'x'.repeat(81), body: 'b' })).toMatchObject({ ok: false, code: 'HEADING_TOO_LONG' });
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 'h', body: 'x'.repeat(1201) })).toMatchObject({ ok: false, code: 'MESSAGE_TOO_LONG' });
        expect(parseInquiryReplyExtraInput({ enabled: true, heading: 'x'.repeat(80), body: 'x'.repeat(1200) }).ok).toBe(true);
        const approved = parseInquiryReplyExtraInput({ enabled: true, ...APPROVED });
        expect(approved.ok).toBe(true);
        expect(APPROVED.body.length).toBeLessThan(1200);
    });

    it('A3. text is cleaned, never interpreted: one-line heading, CRLF → LF, controls dropped, ≤1 blank line', () => {
        const r = parseInquiryReplyExtraInput({ enabled: true, heading: ' Big\nNews\t! ', body: 'One\r\nline\u0007\r\n\r\n\r\n\r\nTwo  \n<b>&</b>' });
        expect(r).toEqual({ ok: true, value: { enabled: true, heading: 'Big News !', body: 'One\nline\n\nTwo\n<b>&</b>' } });
    });

    it('A4. stored as versioned JSON; anything unexpected reads as "no setting" (the built-in email)', () => {
        const v = { enabled: true, heading: 'H', body: 'B' };
        expect(decodeInquiryReplyExtra(encodeInquiryReplyExtra(v))).toEqual(v);
        expect(JSON.parse(encodeInquiryReplyExtra(v))).toEqual({ v: 1, ...v });
        for (const bad of ['', 'not json', '{"v":2,"enabled":true,"heading":"H","body":"B"}', '{"v":1,"enabled":"y"}', '{"v":1,"enabled":true,"heading":"","body":"B"}', null, 7]) {
            expect(decodeInquiryReplyExtra(bad as any)).toBeNull();
        }
    });

    it('A5. tenant isolation: the key is the tenant\'s own, and a row is honoured only when its business_id matches', async () => {
        expect(inquiryReplyExtraKey(BIZ_A)).toBe(`fundraiser_inquiry_reply_extra:${BIZ_A}`);
        const db = makeDb({ settings: [
            stored(BIZ_A, { enabled: true, heading: 'A heading', body: 'A body' }),
            // A row under B's key that claims to belong to A (or nobody) is ignored for both.
            { key: inquiryReplyExtraKey(BIZ_B), value: encodeInquiryReplyExtra({ enabled: true, heading: 'B', body: 'B' }), business_id: BIZ_A },
        ] });
        expect(await readInquiryReplyExtra(db as any, BIZ_A)).toEqual({ enabled: true, heading: 'A heading', body: 'A body' });
        expect(await readInquiryReplyExtra(db as any, BIZ_B)).toBeNull();
        expect(await readInquiryReplyExtra(db as any, '')).toBeNull();
        expect(db.systemSetting.findUnique.mock.calls.map((c: any) => c[0].where.key)).toEqual([inquiryReplyExtraKey(BIZ_A), inquiryReplyExtraKey(BIZ_B)]);
    });

    it('A6. a database error reading the setting never blocks the reply — it is "no section"', async () => {
        const db = { systemSetting: { findUnique: jest.fn(async () => { throw new Error('db down'); }) } };
        const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(await readInquiryReplyExtra(db as any, BIZ_A)).toBeNull();
        spy.mockRestore();
    });

    it('A7. the write is an upsert of the tenant\'s own key with its business_id', async () => {
        const db = makeDb();
        await writeInquiryReplyExtra(db as any, BIZ_A, { enabled: true, heading: 'H', body: 'B' });
        expect(db.writes).toHaveLength(1);
        expect(db.writes[0].where).toEqual({ key: inquiryReplyExtraKey(BIZ_A) });
        expect(db.writes[0].create.business_id).toBe(BIZ_A);
        expect(db.writes[0].update.business_id).toBe(BIZ_A);
    });

    it('A8. administrator only — strict, like the financial-terms gate', () => {
        expect(mayManageInquiryReply({ role: 'ADMIN' })).toBe(true);
        expect(mayManageInquiryReply({ isSuperAdmin: true, role: 'STAFF' })).toBe(true);
        for (const u of [{ role: 'STAFF' }, { role: 'admin' }, { isSuperAdmin: 'true' }, null, undefined, {}]) {
            expect(mayManageInquiryReply(u as any)).toBe(false);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('B · rendering', () => {
    const base = baselineTemplates();

    it('B1. with no section the reply is BYTE-IDENTICAL to the built-in email at the base commit', () => {
        for (const [name, org, tenant] of [
            ['Jordan Fixture', 'Maple Grove PTO', TENANT],
            ['', undefined, undefined],
            ['Ann-Marie O\'Neil', 'Ben & Jerry\'s <Club>', { name: 'Tiny Kitchen' }],
        ] as const) {
            const before = base.lead_intro(name, org, tenant as any);
            expect(EMAIL_TEMPLATES.lead_intro(name, org, tenant as any)).toEqual(before);
            expect(EMAIL_TEMPLATES.lead_intro(name, org, tenant as any, null)).toEqual(before);
            expect(EMAIL_TEMPLATES.lead_intro(name, org, tenant as any, activeInquiryReplySection({ enabled: false, ...APPROVED }))).toEqual(before);
        }
    });

    it('B2. the section sits immediately before "Ready to get a date on the calendar?" — and nothing else moves', () => {
        const before = EMAIL_TEMPLATES.lead_intro('Jordan Fixture', 'Maple Grove PTO', TENANT).html;
        const { html, subject } = EMAIL_TEMPLATES.lead_intro('Jordan Fixture', 'Maple Grove PTO', TENANT, activeInquiryReplySection({ enabled: true, ...APPROVED }));
        expect(subject).toBe(EMAIL_TEMPLATES.lead_intro('Jordan Fixture', 'Maple Grove PTO', TENANT).subject);
        const sectionAt = html.indexOf('<h3>Even More Ways to Raise Money!</h3>');
        const readyAt = html.indexOf('<h3>Ready to get a date on the calendar?</h3>');
        const restAt = html.indexOf('<h3>Then we make the rest simple</h3>');
        expect(restAt).toBeGreaterThan(-1);
        expect(sectionAt).toBeGreaterThan(restAt);
        expect(readyAt).toBeGreaterThan(sectionAt);
        // Removing the inserted chunk gives back the built-in email exactly.
        const chunk = html.slice(sectionAt, readyAt);
        expect(html.slice(0, sectionAt) + html.slice(readyAt)).toBe(before);
        // Three paragraphs, the template's own heading level, nothing else.
        expect(chunk.match(/<p>/g)).toHaveLength(3);
        expect(chunk).not.toMatch(/<(script|a|img|style|div|span|strong)\b/);
        // The call to action is still the last section before the signature.
        expect(html.lastIndexOf('<h3>')).toBe(readyAt);
    });

    it('B3. every character of tenant text is escaped; single line breaks become <br>', () => {
        const { html } = EMAIL_TEMPLATES.lead_intro('A', 'B', TENANT, {
            heading: '<script>alert(1)</script> & "Friends"',
            body: 'Line <b>one</b>\nline two\n\n<img src=x onerror=alert(1)> \'quoted\'',
        });
        expect(html).toContain('<h3>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Friends&quot;</h3>');
        expect(html).toContain('<p>Line &lt;b&gt;one&lt;/b&gt;<br>line two</p>');
        expect(html).toContain('<p>&lt;img src=x onerror=alert(1)&gt; &#39;quoted&#39;</p>');
        expect(html).not.toMatch(/<script|<img|<b>/);
    });

    it('B4. the Freezer Chef copy is tenant DATA — no platform template or module hardcodes it', () => {
        for (const f of ['lib/emailTemplates.ts', 'lib/inquiryReplyExtra.ts', 'lib/inquiryReply.ts', 'lib/inquiryAcknowledgement.ts',
            'components/settings/FundraiserInquiryReplySettings.tsx', 'app/api/tenant/inquiry-reply/route.ts', 'app/api/tenant/inquiry-reply/preview/route.ts']) {
            const src = R(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            expect({ f, hit: /Sides & Dessert|Sides &amp; Dessert|Even More Ways/i.test(src) }).toEqual({ f, hit: false });
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('C · one rendering authority for every inquiry-reply path', () => {
    it('C1. renderInquiryReply: the tenant\'s brand + its stored section; another tenant gets its own (none)', async () => {
        const db = makeDb({ settings: [stored(BIZ_A, { enabled: true, ...APPROVED })] });
        const a = await renderInquiryReply(db, { businessId: BIZ_A, contactName: 'Jordan Fixture', organizationName: 'Maple Grove PTO' });
        expect(a.html).toContain('<h3>Even More Ways to Raise Money!</h3>');
        expect(a.html).toContain('<strong>Example Kitchen</strong>');
        const b = await renderInquiryReply(db, { businessId: BIZ_B, contactName: 'Jordan Fixture', organizationName: 'Maple Grove PTO' });
        expect(b.html).not.toContain('Even More Ways');
        const { loadInquiryReplyTenant } = require('@/lib/inquiryReply');
        expect(b).toEqual(EMAIL_TEMPLATES.lead_intro('Jordan Fixture', 'Maple Grove PTO', await loadInquiryReplyTenant(db, BIZ_B)));
        expect(b.html).toContain('<strong>Other Kitchen</strong>');
    });

    it('C2. the automatic acknowledgement sends the section — once; a replay sends nothing (claim unchanged)', async () => {
        process.env.RESEND_API_KEY = 'test-key-not-real';
        process.env.EMAIL_LIVE = 'true';
        const db = makeDb({ settings: [stored(BIZ_A, { enabled: true, ...APPROVED })] });
        (global as any).__ireDb = db;
        const { attemptInquiryAcknowledgement } = require('@/lib/inquiryAcknowledgement');
        const first = await attemptInquiryAcknowledgement('inq-ire1-1', BIZ_A);
        expect(first.outcome).toBe('sent');
        expect(sent).toHaveLength(1);
        expect(sent[0].to).toEqual(['jordan@example.test']);
        expect(sent[0].html).toContain('<h3>Even More Ways to Raise Money!</h3>');
        expect(sent[0].subject).toBe("Let's get Maple Grove PTO on the fundraiser calendar");
        const replay = await attemptInquiryAcknowledgement('inq-ire1-1', BIZ_A);
        expect(replay.outcome).toBe('skipped_already_sent');
        expect(sent).toHaveLength(1);
    });

    it('C3. safety mode still sends nothing and records nothing', async () => {
        const db = makeDb({ settings: [stored(BIZ_A, { enabled: true, ...APPROVED })] });
        (global as any).__ireDb = db;
        const { attemptInquiryAcknowledgement } = require('@/lib/inquiryAcknowledgement');
        const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        expect((await attemptInquiryAcknowledgement('inq-ire1-1', BIZ_A)).outcome).toBe('skipped_not_live');
        spy.mockRestore();
        expect(sent).toHaveLength(0);
        expect(db.inquiries.get('inq-ire1-1').ack_claimed_at).toBeNull();
    });

    it('C4. the three senders call the shared authority and none renders lead_intro itself', () => {
        const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        for (const f of ['lib/inquiryAcknowledgement.ts', 'app/api/opportunities/[id]/respond/route.ts', 'app/api/email/send/route.ts']) {
            const src = strip(R(f));
            expect({ f, shared: /renderInquiryReply\(/.test(src), direct: /\.lead_intro\(/.test(src) }).toEqual({ f, shared: true, direct: false });
        }
        expect(strip(R('lib/inquiryReply.ts'))).toMatch(/EMAIL_TEMPLATES\.lead_intro\(/);
    });

    it('C5. the Respond dialog\'s editable draft contains the section, still as editable plain text', async () => {
        const db = makeDb({ settings: [stored(BIZ_A, { enabled: true, ...APPROVED })] });
        const draft = await renderInquiryReply(db, { businessId: BIZ_A, contactName: 'Jordan Fixture', organizationName: 'Maple Grove PTO' });
        const text = htmlToEditableText(draft.html);
        expect(text).toContain('Even More Ways to Raise Money!');
        expect(text).toContain("It's completely optional, and our online ordering page automatically presents the offer to eligible supporters.");
        expect(text).toContain('Sides & Dessert Bundle');
        expect(text).not.toMatch(/&amp;|&#39;|<p>|<h3>/);
        expect(text.indexOf('Even More Ways')).toBeLessThan(text.indexOf('Ready to get a date on the calendar?'));
    });

    it('C6. the generic send route renders lead_intro through the same authority (EMAIL_LIVE, test client only)', async () => {
        process.env.RESEND_API_KEY = 'test-key-not-real';
        process.env.EMAIL_LIVE = 'true';
        const db: any = makeDb({ settings: [stored(BIZ_A, { enabled: true, heading: 'Our extra', body: 'Hello there' })] });
        (global as any).__ireDb = db;
        jest.isolateModules(() => { (global as any).__ireSend = require('@/app/api/email/send/route'); });
        const res = await (global as any).__ireSend.POST(new Request('http://localhost/api/email/send', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ to: 'jordan@example.test', template: 'lead_intro', customerName: 'Jordan Fixture', organizationName: 'Maple Grove PTO' }),
        }));
        expect(res.status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0].html).toContain('<h3>Our extra</h3>');
        expect(sent[0].html).toContain('<p>Hello there</p>');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('D · the Settings API', () => {
    const settingsRoute = () => require('@/app/api/tenant/inquiry-reply/route');
    const previewRoute = () => require('@/app/api/tenant/inquiry-reply/preview/route');
    const put = (body: unknown) => settingsRoute().PUT(new Request('http://localhost/api/tenant/inquiry-reply', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    const preview = (body: unknown) => previewRoute().POST(new Request('http://localhost/api/tenant/inquiry-reply/preview', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));

    it('D1. unauthenticated → 401; a non-administrator → 403 on GET, PUT and preview; nothing written', async () => {
        const db = makeDb();
        (global as any).__ireDb = db;
        (global as any).__ireSession = null;
        expect((await settingsRoute().GET()).status).toBe(401);
        (global as any).__ireSession = { user: { businessId: BIZ_A, role: 'STAFF' } };
        expect((await settingsRoute().GET()).status).toBe(403);
        expect((await put({ enabled: true, heading: 'H', body: 'B' })).status).toBe(403);
        expect((await preview({ enabled: true, heading: 'H', body: 'B' })).status).toBe(403);
        expect(db.writes).toHaveLength(0);
    });

    it('D2. GET returns the stored section (or the empty default) and the limits', async () => {
        (global as any).__ireDb = makeDb();
        expect(await (await settingsRoute().GET()).json()).toEqual({ enabled: false, heading: '', body: '', limits: { headingMax: 80, bodyMax: 1200 } });
        (global as any).__ireDb = makeDb({ settings: [stored(BIZ_A, { enabled: true, heading: 'H', body: 'B' })] });
        expect(await (await settingsRoute().GET()).json()).toMatchObject({ enabled: true, heading: 'H', body: 'B' });
    });

    it('D3. PUT validates, then writes ONLY the session tenant\'s key — a business id in the body is ignored', async () => {
        const db = makeDb();
        (global as any).__ireDb = db;
        expect((await put({ enabled: true, heading: '', body: 'B' })).status).toBe(400);
        expect(db.writes).toHaveLength(0);
        const ok = await put({ enabled: true, heading: 'H', body: 'B', businessId: BIZ_B, key: inquiryReplyExtraKey(BIZ_B) });
        expect(ok.status).toBe(200);
        expect(db.writes).toHaveLength(1);
        expect(db.writes[0].where.key).toBe(inquiryReplyExtraKey(BIZ_A));
        expect(JSON.stringify(db.writes[0])).not.toContain(BIZ_B);
    });

    it('D4. preview renders the COMPLETE email for a fictional inquiry with the DRAFT section — writing and sending nothing', async () => {
        process.env.RESEND_API_KEY = 'test-key-not-real';
        process.env.EMAIL_LIVE = 'true';
        const db = makeDb({ settings: [stored(BIZ_A, { enabled: false, heading: 'Saved', body: 'Saved body' })] });
        (global as any).__ireDb = db;
        const res = await preview({ enabled: true, ...APPROVED });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.sample).toEqual(INQUIRY_REPLY_PREVIEW_SAMPLE);
        expect(body.subject).toBe("Let's get Maple Grove PTO on the fundraiser calendar");
        expect(body.html).toContain('Hi Jordan!');
        expect(body.html).toContain('<h3>Even More Ways to Raise Money!</h3>');
        expect(body.html).toContain('<strong>Example Kitchen</strong>');
        expect(db.writes).toHaveLength(0);
        expect(sent).toHaveLength(0);
        expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
        // An "off" draft previews the built-in email.
        const off = await (await preview({ enabled: false, ...APPROVED })).json();
        expect(off.html).not.toContain('Even More Ways');
    });

    it('D5. the preview route imports no sender at all', () => {
        const src = R('app/api/tenant/inquiry-reply/preview/route.ts');
        expect(src).not.toMatch(/emailSafety|resend|getTenantSender|sendLeadNotificationEmail|@\/lib\/email'/);
        expect(src).not.toMatch(/\.upsert\(|\.update\(|\.create\(/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('E · Settings → Fundraisers → "Fundraiser Inquiry Reply"', () => {
    it('E1. the card is under a Fundraisers heading on the Settings page, next to the tax settings', () => {
        const page = R('app/settings/page.tsx');
        const heading = page.indexOf('id="settings-fundraisers-heading"');
        expect(heading).toBeGreaterThan(-1);
        expect(page.indexOf('<FundraiserTaxSettings />')).toBeGreaterThan(heading);
        expect(page.indexOf('<FundraiserInquiryReplySettings />')).toBeGreaterThan(page.indexOf('<FundraiserTaxSettings />'));
    });

    it('E2. the card renders its title and explains it sends nothing (static render)', () => {
        const Card = require('@/components/settings/FundraiserInquiryReplySettings').default;
        const html = renderToStaticMarkup(React.createElement(Card));
        expect(html).toContain('Fundraiser Inquiry Reply');
        expect(html).toContain('nothing is sent from this page');
        expect(html).toContain('Ready to get a date on the calendar?');
    });

    it('E3. on/off, heading, message, live preview and Save; the preview is a sandboxed frame, never injected HTML', () => {
        const src = R('components/settings/FundraiserInquiryReplySettings.tsx');
        for (const s of ['type="checkbox"', 'Section heading', 'Message', 'Email preview', 'Save settings',
            '/api/tenant/inquiry-reply/preview', "method: 'PUT'", 'sandbox=""', 'srcDoc=',
            'Only an administrator can change the fundraiser inquiry reply.']) {
            expect({ s, ok: src.includes(s) }).toEqual({ s, ok: true });
        }
        expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('F · protections preserved', () => {
    const unchanged = (rel: string) => execSync(`git diff --name-only ${BASE} -- "${rel}"`, { cwd: ROOT, encoding: 'utf8' }).trim();

    it.each([
        'app/api/public/fundraiser-request/route.ts', // intake, claim-once trigger and tenant alert
        'lib/fundraiserLead.ts', // supporter order ≠ lead
        'lib/emailSafety.ts', // Preview redirect to the test sink
        'lib/email.ts', // sender, reply-to, lead alert
        'lib/plainTextEmail.ts', // the Respond dialog's escaping contract
        'lib/supporterConsent.ts',
        'lib/tenantBrand.ts',
    ])('%s is unchanged', (rel) => {
        if (!fs.existsSync(path.join(ROOT, rel))) return;
        expect(unchanged(rel)).toBe('');
    });

    it('F2. the acknowledgement keeps its gate-before-claim, recipient-from-row and sent-only-on-acceptance rules', () => {
        const src = R('lib/inquiryAcknowledgement.ts');
        const gate = src.indexOf("process.env.EMAIL_LIVE === 'true'");
        const claim = src.indexOf('ack_claimed_at: null, ack_sent_at: null');
        const render = src.indexOf('renderInquiryReply(prisma');
        const send = src.indexOf('resend.emails.send(');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(claim);
        expect(claim).toBeLessThan(render);
        expect(render).toBeLessThan(send);
        expect(src).toMatch(/to: \[to\]/);
        expect(src.split('ack_sent_at: sentAt').length - 1).toBe(1);
    });

    it('F3. no migration: the setting lives in the existing system_settings table', () => {
        const added = execSync(`git diff --name-only ${BASE} -- prisma/migrations`, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
        expect(added.every((f) => f.includes('supporter_addon_coordinator_choice'))).toBe(true);
        expect(R('prisma/schema.prisma')).toMatch(/model SystemSetting \{\n  key         String    @id\n  value       String/);
    });
});
