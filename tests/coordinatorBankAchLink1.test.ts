/**
 * COORDINATOR-BANK-ACH-LINK-1 — Bank / ACH: the organization's own bank or payment-provider page as a
 * seventh supporter payment method, and the shared payment-link rule's stored-length fix.
 *
 * An external link and nothing more. FreezerIQ stores the coordinator's https payment-page link and an
 * optional note — never a routing number, account number or bank login — offers the link only after an
 * order exists, opens it in a new tab, and learns that a supporter paid only when the coordinator marks
 * the order paid. Real code throughout, with the harnesses of tests/coordinatorPaymentMethodUx1.test.ts
 * (the email and the order route have their own suites). All data is fictional.
 *
 *  A. the method contract              B. the stored-length fix (the shared link rule)
 *  C. the public projection            D. the supporter page — before and after ordering
 *  E. the coordinator form             F. the coordinator summary and routes
 *  G. paid stays the coordinator's explicit mark                H. campaign / tenant isolation
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { mountComponent, findAll, textOf } from './helpers/hookRuntime';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    PAYMENT_METHOD_TYPES,
    PAYMENT_METHOD_LABELS,
    PUBLIC_PAYMENT_METHOD_KEYS,
    BANK_ACH_GUIDANCE,
    BANK_ACH_ACTION,
    BANK_ACH_AFTER_ORDER,
    BANK_ACH_NOTE_MAX,
    checkPaymentMethods,
    checkPaymentMethod,
    checkCoordinatorPaymentSettings,
    readStoredPaymentMethods,
    toPublicPaymentMethods,
    buildSupporterPaymentView,
    legacyPaymentLinkView,
    offersOnlinePayment,
    paymentLinkDestination,
    emptyPaymentMethodsForm,
    paymentMethodsFormFromStored,
    paymentMethodsInputFromForm,
    type StoredPaymentMethods,
} from '@/lib/supporterPaymentMethods';
import { checkPaymentLink, checkCoordinatorSetup, PAYMENT_LINK_MAX } from '@/lib/coordinatorSetup';
import { toPublicCampaign } from '@/lib/publicFundraiserPayload';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__bach1Prisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__bach1Authed && name === (global as any).__bach1CookieName
            ? { name, value: 'bach1-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));

type Row = Record<string, any>;
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// ── fictional fixtures ────────────────────────────────────────────────────────────────────────
const BIZ_A = 'biz-bach1-a';
const BIZ_B = 'biz-bach1-b';
const CAMPAIGN_A = 'bbbb4444-0000-4000-8000-0000000000a1';
const CAMPAIGN_B = 'bbbb4444-0000-4000-8000-0000000000b2';
const PAYEE = 'Lincoln PTO (fixture)';
const ORG = 'Maple Ridge Robotics (fixture)';
const BANK_LINK = 'https://pay.examplebank.test/pto/maple?campaign=fall&ref=a1';
const BANK_HOST = 'pay.examplebank.test';
const BANK_NOTE = "Enter your order total on the bank's payment page.";
const BASE = 'https://pay.examplebank.test/'; // 29 characters

const storedOf = (input: unknown): StoredPaymentMethods => {
    const r = checkPaymentMethods(input);
    if (!r.ok) throw new Error(`fixture invalid: ${r.error}`);
    return r.value;
};
const BANK_ONLY = storedOf([{ type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }]);
const BANK_CASH_CHECK = storedOf([{ type: 'check' }, { type: 'bank_ach', link: BANK_LINK }, { type: 'cash' }]);
const BANK_VENMO_OTHER = storedOf([
    { type: 'other', label: 'School office', details: 'Drop payment at the front office.', link: 'https://pay.example.test/office' },
    { type: 'venmo', handle: '@maple-fixture' },
    { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE },
]);
/** Claims FreezerIQ cannot make about an outside page. ("Paid" is checked case-sensitively and separately:
 *  the existing footer truthfully says opening a payment app "doesn't mark your order paid".) */
const UNTRUTHFUL = /securely|instant|verified|payment complete|pay now/i;
const PAID_CLAIM = /\bPaid\b/;

// ── coordinator-session harness ───────────────────────────────────────────────────────────────
let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__bach1Prisma = m.client; return m; };
const sessionFor = (campaignId: string) => ({ id: 'session-bach1', campaign_id: campaignId, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null });
const request = (url: string, init: RequestInit = {}) =>
    new Request(`http://localhost${url}`, { ...init, headers: { origin: 'http://localhost', 'content-type': 'application/json', ...(init.headers || {}) } }) as any;
const route = (p: string) => require(p);

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
});
beforeEach(() => {
    jest.clearAllMocks();
    (global as any).__bach1CookieName = coordinatorSessionCookieName();
    (global as any).__bach1Authed = true;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('A. the method contract', () => {
    it('A1. Bank / ACH is a method of its own, stored as { type, link, note? }, always after Cash App and before Other', () => {
        expect([...PAYMENT_METHOD_TYPES]).toEqual(['cash', 'check', 'venmo', 'paypal', 'cashapp', 'bank_ach', 'other']);
        expect(PAYMENT_METHOD_LABELS.bank_ach).toBe('Bank / ACH');
        const r = checkPaymentMethods([
            { type: 'other', label: 'School office', details: 'Front desk.' },
            { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE },
            { type: 'cashapp', cashtag: '$MapleFixture' },
            { type: 'cash' },
        ]) as any;
        expect(r.ok).toBe(true);
        expect(r.value.v).toBe(1);
        expect(r.value.methods.map((m: any) => m.type)).toEqual(['cash', 'cashapp', 'bank_ach', 'other']);
        expect(r.value.methods[2]).toEqual({ type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE });
        // no note → no note key at all
        expect(storedOf([{ type: 'bank_ach', link: BANK_LINK }]).methods[0]).toEqual({ type: 'bank_ach', link: BANK_LINK });
    });

    it('A2. a second Bank / ACH entry is refused; unknown and look-alike types are still refused', () => {
        expect(checkPaymentMethods([{ type: 'bank_ach', link: BANK_LINK }, { type: 'bank_ach', link: 'https://other.examplebank.test/x' }]))
            .toMatchObject({ ok: false, code: 'payment_methods_duplicate' });
        for (const type of ['ach', 'bank', 'BANK_ACH', 'plaid', 'stripe_ach', 'square_ach', 'wire']) {
            expect(checkPaymentMethod({ type, link: BANK_LINK } as any)).toMatchObject({ ok: false, code: 'payment_method_invalid' });
        }
        expect(checkPaymentMethods(new Array(PAYMENT_METHOD_TYPES.length + 1).fill({ type: 'cash' })))
            .toMatchObject({ ok: false, code: 'payment_methods_invalid' });
    });

    it('A3. the link is required: missing, null, empty or blank is refused with a reason that names the bank link', () => {
        for (const link of [undefined, null, '', '   ']) {
            const r = checkPaymentMethod({ type: 'bank_ach', link, note: BANK_NOTE }) as any;
            expect(r).toMatchObject({ ok: false, code: 'bank_ach_link_required', method: 'bank_ach' });
            expect(r.error).toMatch(/bank payment link/i);
        }
        expect(checkPaymentMethod({ type: 'bank_ach', link: 'https://pay.examplebank.test/x' }))
            .toEqual({ ok: true, value: { type: 'bank_ach', link: 'https://pay.examplebank.test/x' } });
    });

    it('A4. the shared https rule decides the link: http, script/data/file schemes, credentials and malformed links are refused', () => {
        const unsafe: Array<[string, string]> = [
            ['http://pay.examplebank.test/x', 'payment_link_scheme'],
            ['javascript:alert(document.cookie)', 'payment_link_scheme'],
            ['  JaVaScRiPt:alert(1)', 'payment_link_scheme'],
            ['data:text/html,<script>alert(1)</script>', 'payment_link_scheme'],
            ['vbscript:msgbox(1)', 'payment_link_scheme'],
            ['file:///C:/statement.pdf', 'payment_link_scheme'],
            ['https://user:secret@pay.examplebank.test/x', 'payment_link_credentials'],
            ['https://evil.example@pay.examplebank.test/x', 'payment_link_credentials'],
            ['not a link', 'payment_link_invalid'],
            ['pay.examplebank.test/x', 'payment_link_invalid'],
            ['https://localhost/pay', 'payment_link_invalid'],
            ['https://pay.example\u202Ebank.test/x', 'payment_link_invalid'],
        ];
        for (const [link, code] of unsafe) {
            expect(checkPaymentMethod({ type: 'bank_ach', link })).toMatchObject({ ok: false, code, method: 'bank_ach' });
        }
        // Markup, controls and invisible characters in a path never survive as such — they are stored inert.
        const r = checkPaymentMethod({ type: 'bank_ach', link: 'https://pay.examplebank.test/"><script>x</script>?n=\u0000\u202E\u200B' }) as any;
        expect(r.ok).toBe(true);
        expect(r.value.link).not.toMatch(/[<>"'\s\u0000-\u001f\u007f-\u009f\u200b\u202a-\u202e]/);
    });

    it('A5. the note is optional, plain text, line breaks kept, bounded — and ordinary numbers are NOT blocked', () => {
        const ok = checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: '  Line one\r\nLine two  ' }) as any;
        expect(ok.value.note).toBe('Line one\nLine two');
        expect((checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: '   ' }) as any).value).not.toHaveProperty('note');
        for (const note of ['<b>pay</b>', 'a > b', 'bell\u0007', 'flip\u202Eme', 'sep\u2028x']) {
            expect(checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note })).toMatchObject({ ok: false, code: 'bank_ach_note_unsafe', method: 'bank_ach' });
        }
        expect(BANK_ACH_NOTE_MAX).toBe(300);
        expect(checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: 'x'.repeat(300) }).ok).toBe(true);
        expect(checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: 'x'.repeat(301) })).toMatchObject({ ok: false, code: 'bank_ach_note_too_long' });
        expect(checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: 42 })).toMatchObject({ ok: false, code: 'bank_ach_note_invalid' });
        // Owner decision: guidance, not digit-blocking — phone numbers, references and dates are legitimate.
        const digits = 'Questions? Call 555-010-0000. Reference 123456789012. Due 11/20/2026.';
        expect((checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: digits }) as any).value.note).toBe(digits);
    });

    it('A6. nothing but the link and the note is ever stored — a forged routing / account / login field is dropped', () => {
        const r = checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE, routing: '999999990', account: '000123456789', login: 'pto', password: 'x' } as any) as any;
        expect(Object.keys(r.value).sort()).toEqual(['link', 'note', 'type']);
        expect(JSON.stringify(r.value)).not.toMatch(/999999990|000123456789|password|login/);
    });

    it('A7. a stored value is re-validated on read: a bad bank entry is dropped; an unknown future type is dropped and the rest kept', () => {
        expect(readStoredPaymentMethods({ v: 1, methods: [{ type: 'cash' }, { type: 'bank_ach', link: 'http://pay.examplebank.test/x' }] }))
            .toEqual({ v: 1, methods: [{ type: 'cash' }] });
        expect(readStoredPaymentMethods({ v: 1, methods: [{ type: 'bank_ach', link: 'javascript:alert(1)' }, { type: 'bank_ach' }] })).toEqual({ v: 1, methods: [] });
        expect(readStoredPaymentMethods({ v: 1, methods: [{ type: 'bank_ach', link: BANK_LINK, note: '<i>x</i>' }] })).toEqual({ v: 1, methods: [] });
        expect(readStoredPaymentMethods({ v: 1, methods: [{ type: 'future_wallet', handle: 'x' }, { type: 'bank_ach', link: BANK_LINK }] }))
            .toEqual({ v: 1, methods: [{ type: 'bank_ach', link: BANK_LINK }] });
        for (const s of [BANK_ONLY, BANK_CASH_CHECK, BANK_VENMO_OTHER]) expect(readStoredPaymentMethods(s)).toEqual(s);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('B. the stored-length fix — in the shared link rule, for every link', () => {
    // 'é' is 1 character typed and 6 stored (%C3%A9).
    const GROWS = BASE + '\u00e9'.repeat(100);                       // 129 typed → 629 stored
    const EXACT = BASE + '\u00e9'.repeat(78) + 'abc';                // 110 typed → exactly 500 stored
    const OVER_BY_ONE = EXACT + 'd';                                  // 111 typed → 501 stored

    it('B1. a link under the limit as typed but over it once normalised is REFUSED on write (it used to save, then vanish on read)', () => {
        expect(GROWS.length).toBeLessThan(PAYMENT_LINK_MAX);
        expect(new URL(GROWS).toString().length).toBeGreaterThan(PAYMENT_LINK_MAX);
        expect(checkPaymentLink(GROWS)).toMatchObject({ ok: false, code: 'payment_link_too_long' });
        expect(checkPaymentLink(OVER_BY_ONE)).toMatchObject({ ok: false, code: 'payment_link_too_long' });
    });

    it('B2. the same refusal reaches Bank / ACH, Other, Payment Settings\' legacy link and the setup form — no Bank-only workaround', () => {
        expect(checkPaymentMethod({ type: 'bank_ach', link: GROWS })).toMatchObject({ ok: false, code: 'payment_link_too_long', method: 'bank_ach' });
        expect(checkPaymentMethod({ type: 'other', label: 'Online', details: 'Pay online.', link: GROWS })).toMatchObject({ ok: false, code: 'payment_link_too_long', method: 'other' });
        expect(checkCoordinatorPaymentSettings({ externalPaymentLink: GROWS })).toMatchObject({ ok: false, code: 'payment_link_too_long' });
        expect(checkCoordinatorSetup({ paymentLink: GROWS })).toMatchObject({ ok: false, code: 'payment_link_too_long' });
    });

    it('B3. a long but valid link whose stored form is exactly the limit is accepted — and write and read agree', () => {
        const r = checkPaymentLink(EXACT) as any;
        expect(r.ok).toBe(true);
        expect(r.value.length).toBe(PAYMENT_LINK_MAX);
        expect(checkPaymentLink(r.value)).toEqual({ ok: true, value: r.value });          // idempotent
        const stored = storedOf([{ type: 'bank_ach', link: EXACT }, { type: 'other', label: 'Online', details: 'Pay online.', link: EXACT }]);
        expect(readStoredPaymentMethods(stored)).toEqual(stored);                           // nothing vanishes on read
        expect(legacyPaymentLinkView(r.value)?.href).toBe(r.value);
        const ascii = BASE + 'a'.repeat(PAYMENT_LINK_MAX - BASE.length);
        expect(checkPaymentLink(ascii)).toEqual({ ok: true, value: ascii });
        expect(checkPaymentLink(ascii + 'a')).toMatchObject({ ok: false, code: 'payment_link_too_long' });
    });

    it('B4. a stored legacy link that is too long once normalised is shown as text, never as a link', () => {
        expect(legacyPaymentLinkView(GROWS)).toEqual({ text: GROWS, href: null, actionLabel: 'Open payment link' });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('C. the public projection', () => {
    it('C1. five keys, the fixed truthful wording, the note on its own line, the link, and "Open bank payment"', () => {
        const [withNote] = toPublicPaymentMethods(BANK_ONLY, PAYEE)!;
        expect(withNote).toEqual({ type: 'bank_ach', label: 'Bank / ACH', detail: `${BANK_ACH_GUIDANCE}\n${BANK_NOTE}`, href: BANK_LINK, actionLabel: 'Open bank payment' });
        expect(Object.keys(withNote).sort()).toEqual([...PUBLIC_PAYMENT_METHOD_KEYS].sort());
        expect(BANK_ACH_GUIDANCE).toBe("Pay from your bank account on your organization's payment page.");
        expect(BANK_ACH_ACTION).toBe('Open bank payment');
        const [plain] = toPublicPaymentMethods(storedOf([{ type: 'bank_ach', link: BANK_LINK }]), null)!;
        expect(plain.detail).toBe(BANK_ACH_GUIDANCE);
        for (const s of [withNote.label, withNote.detail, withNote.actionLabel, BANK_ACH_AFTER_ORDER]) {
            expect(s).not.toMatch(UNTRUTHFUL);
            expect(s).not.toMatch(/paid/i);
        }
    });

    it('C2. the destination is the HOST of the validated link — never its path, query, fragment or credentials', () => {
        expect(paymentLinkDestination(BANK_LINK)).toBe(BANK_HOST);
        expect(paymentLinkDestination('https://pay.examplebank.test:8443/x?acct=1#frag')).toBe('pay.examplebank.test:8443');
        expect(paymentLinkDestination('HTTPS://Pay.ExampleBank.TEST/X')).toBe(BANK_HOST);
        expect(paymentLinkDestination('https://pay.ex\u0430mplebank.test/x')).toMatch(/^pay\.xn--/);      // a look-alike shows as xn--
        for (const bad of ['http://pay.examplebank.test/x', 'javascript:alert(1)', 'https://u:p@pay.examplebank.test/', '', null, undefined, 42]) {
            expect(paymentLinkDestination(bad)).toBeNull();
        }
        expect(paymentLinkDestination(BANK_LINK)).not.toMatch(/[/?#@]/);
    });

    it('C3. the one view drops a forged bank entry: a bad link, or none at all, leaves nothing to show', () => {
        const valid = toPublicPaymentMethods(BANK_ONLY, null)![0];
        const view = buildSupporterPaymentView({
            methods: [
                { ...valid, href: 'javascript:alert(1)' },
                { ...valid, href: null },
                { ...valid, href: 'https://pay.examplebank.test/"><x>' },
                valid,
            ] as any,
            instructions: null,
            legacyLink: null,
        });
        expect(view.methods).toEqual([valid]);
    });

    it('C4. Bank / ACH counts as a way a supporter may already have paid (the coordinator is told to verify)', () => {
        expect(offersOnlinePayment(toPublicPaymentMethods(storedOf([{ type: 'bank_ach', link: BANK_LINK }]), null))).toBe(true);
        expect(offersOnlinePayment(toPublicPaymentMethods(BANK_CASH_CHECK, PAYEE))).toBe(true);
        expect(offersOnlinePayment(toPublicPaymentMethods(storedOf([{ type: 'cash' }, { type: 'check' }]), PAYEE))).toBe(false);
        expect(offersOnlinePayment(null)).toBe(false);
    });

    it('C5. the public campaign payload carries the projection, never the stored object', () => {
        const out = toPublicCampaign({ id: CAMPAIGN_A, name: 'x', payment_methods: BANK_VENMO_OTHER, checks_payable: PAYEE, portal_token: 'PORTAL-SECRET' }) as any;
        expect(out.payment_methods).toEqual(toPublicPaymentMethods(BANK_VENMO_OTHER, PAYEE));
        const json = JSON.stringify(out);
        for (const secret of ['"v":1', '"methods"', '"link"', '"note"', '"handle"', 'PORTAL-SECRET']) expect(json).not.toContain(secret);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
const PAGE_SLUG = 'kitchen-bach1-fixture';
const PRIMARY = '#2f6f8f';
const BUNDLE = { id: 'b-bach1', name: 'Harvest Bundle (fixture)', description: null, serving_tier: 'family', price: 125, image_url: null, items: [] };
const SERVER_TOTAL = 126.25; // 125.00 + 1% food tax, as the server persists it
const clientProps = (methods: unknown, campaignOver: Row = {}) => ({
    business: { name: 'Kitchen (fixture)', display_name: null, slug: PAGE_SLUG, logo_url: null, branding: { primary_color: PRIMARY, logo_url: null }, bundles: [BUNDLE] },
    campaign: {
        id: CAMPAIGN_A, name: `${ORG} Fundraiser`, organization_name: ORG, about_text: null, participant_label: 'Member',
        end_date: '2026-11-20', delivery_date: '2026-12-01', pickup_location: 'Fixture Gym', delivery_time: null,
        payment_instructions: null, external_payment_link: null, payment_methods: methods,
        tax_status: 'TAXABLE', tax_rate_percent: '1.00',
        customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
        ...campaignOver,
    },
    bundleProgress: { totalBundlesSold: 3, bundleGoal: 20 },
    orderMode: { allowed: true, mode: 'selected' },
    slug: PAGE_SLUG,
    fundraiserId: CAMPAIGN_A,
    shareUrl: `https://www.freezeriqapp.com/shop/${PAGE_SLUG}/fundraiser/${CAMPAIGN_A}`,
    deadline: { kind: 'days', days: 18 },
});
let fetchMock: jest.Mock;
function installBrowser(methods: unknown) {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { open: jest.fn(), location: { href: 'https://example.test/' }, scrollTo: jest.fn() } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: jest.fn(async () => undefined) } } });
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ orderId: 'ord-bach1-000123', total: SERVER_TOTAL, paymentData: { orgName: ORG, paymentInstructions: null, externalPaymentLink: null, paymentMethods: methods } }) }));
    (globalThis as any).fetch = fetchMock;
}
const loadClient = () => require('@/app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient').default;
const section = (tree: any, which: 'order' | 'confirmation') => findAll(tree, (el) => el.props && el.props['data-payment-section'] === which)[0] ?? null;
const anchors = (node: any) => findAll(node, (el) => el.type === 'a');
const inputByLabel = (tree: any, label: string) => findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === label)[0];
async function addAndSubmit(m: ReturnType<typeof mountComponent>) {
    const add = findAll(m.tree, (el) => el.type === 'button' && el.props['aria-pressed'] === false && /^Add/.test(textOf(el.props.children)))[0];
    add.props.onClick(); m.render();
    for (const [label, value] of [['First Name', 'Ada'], ['Last Name', 'Fixturely'], ['Email', 'ada.fixture@example.test'], ['Phone Number', '555-0100']]) {
        inputByLabel(m.tree, label).props.onChange({ target: { value } }); m.render();
    }
    const place = findAll(m.tree, (el) => el.type === 'button' && /^Place my order/.test(textOf(el.props.children)))[0];
    await place.props.onClick(); m.render();
}

describe('D. the supporter page', () => {
    const PUBLIC_BANK = toPublicPaymentMethods(BANK_ONLY, PAYEE);
    beforeEach(() => installBrowser(PUBLIC_BANK));

    it('D1. before ordering: Bank / ACH, what it is and when its link appears — and no bank link anywhere on the page', () => {
        const m = mountComponent(loadClient(), clientProps(PUBLIC_BANK));
        const s = section(m.tree, 'order');
        const text = textOf(s);
        for (const t of ['Bank / ACH', BANK_ACH_GUIDANCE, BANK_NOTE, BANK_ACH_AFTER_ORDER]) expect(text).toContain(t);
        expect(text).not.toContain(BANK_ACH_ACTION);
        expect(anchors(s)).toHaveLength(0);
        expect(findAll(m.tree, (el) => el.type === 'a' && String(el.props.href || '').includes('examplebank'))).toHaveLength(0);
        expect(text).not.toMatch(UNTRUTHFUL);
        expect(text).not.toMatch(PAID_CLAIM);
        // ordering stays primary: the order button is there, and the payment note is not a button
        expect(findAll(m.tree, (el) => el.type === 'button' && /^Place my order/.test(textOf(el.props.children)))).toHaveLength(1);
        expect(findAll(s, (el) => el.type === 'button')).toHaveLength(0);
    });

    it('D2. after ordering: "Open bank payment ↗" opens the configured page in a new tab, named by its host, beside the note and the server total', async () => {
        const m = mountComponent(loadClient(), clientProps(PUBLIC_BANK));
        await addAndSubmit(m);
        const c = section(m.tree, 'confirmation');
        const [a] = anchors(c);
        expect(anchors(c)).toHaveLength(1);
        expect(a.props.href).toBe(BANK_LINK);
        expect(a.props.target).toBe('_blank');
        expect(a.props.rel).toBe('noopener noreferrer');
        expect(textOf(a)).toBe('Open bank payment ↗');
        expect(a.props['aria-label']).toBe(`Open bank payment, opens ${BANK_HOST} in a new tab`);
        expect(a.props.onClick).toBeUndefined();
        const dest = findAll(c, (el) => el.props && el.props['data-payment-destination'] !== undefined);
        expect(dest).toHaveLength(1);
        expect(textOf(dest[0])).toBe(`Opens ${BANK_HOST}`);
        const text = textOf(c);
        for (const t of ['Bank / ACH', BANK_ACH_GUIDANCE, BANK_NOTE, '$126.25']) expect(text).toContain(t);
        expect(text).not.toContain(BANK_ACH_AFTER_ORDER);
        expect(text).not.toContain('/pto/maple');
        expect(text).not.toMatch(UNTRUTHFUL);
        expect(text).not.toMatch(PAID_CLAIM);
        expect(text).toMatch(/doesn.t mark your order paid/);
    });

    it('D3. a long note and a long host wrap inside the card; the button keeps its 44px, full-width tap target', async () => {
        const longHost = `https://${'pay-'.repeat(15)}examplebank.test/x`;
        const methods = toPublicPaymentMethods(storedOf([{ type: 'bank_ach', link: longHost, note: 'W'.repeat(300) }]), null);
        installBrowser(methods);
        const m = mountComponent(loadClient(), clientProps(methods));
        await addAndSubmit(m);
        const c = section(m.tree, 'confirmation');
        expect(c.props.style).toMatchObject({ overflowWrap: 'anywhere', minWidth: 0 });
        const [a] = anchors(c);
        expect(a.props.style).toMatchObject({ minHeight: 44, width: '100%', boxSizing: 'border-box' });
        const dest = findAll(c, (el) => el.props && el.props['data-payment-destination'] !== undefined)[0];
        expect(dest.props.style.overflowWrap).toBe('anywhere');
        const detail = findAll(c, (el) => el.type === 'span' && el.props.style?.whiteSpace === 'pre-wrap')[0];
        expect(detail.props.style.overflowWrap).toBe('anywhere');
    });

    it('D4. Bank / ACH beside Cash and Check: every selected method shows, in the supporter order, and only Bank links out', async () => {
        const methods = toPublicPaymentMethods(BANK_CASH_CHECK, PAYEE);
        installBrowser(methods);
        const m = mountComponent(loadClient(), clientProps(methods));
        const rows = (node: any) => findAll(node, (el) => el.type === 'li').map((li) => textOf(findAll(li, (x) => x.type === 'b')[0]));
        expect(rows(section(m.tree, 'order'))).toEqual(['Cash', 'Check', 'Bank / ACH']);
        await addAndSubmit(m);
        const c = section(m.tree, 'confirmation');
        expect(rows(c)).toEqual(['Cash', 'Check', 'Bank / ACH']);
        expect(anchors(c).map((a) => a.props.href)).toEqual([BANK_LINK]);
        expect(textOf(c)).toContain(`Make checks payable to ${PAYEE}`);
    });

    it('D5. Bank / ACH beside Venmo and Other keeps each one\'s own action wording', async () => {
        const methods = toPublicPaymentMethods(BANK_VENMO_OTHER, null);
        installBrowser(methods);
        const m = mountComponent(loadClient(), clientProps(methods));
        await addAndSubmit(m);
        const c = section(m.tree, 'confirmation');
        expect(anchors(c).map((a) => [textOf(a), a.props.href])).toEqual([
            ['Open Venmo ↗', 'https://venmo.com/u/maple-fixture'],
            ['Open bank payment ↗', BANK_LINK],
            ['Open link ↗', 'https://pay.example.test/office'],
        ]);
        // only the bank row names a destination
        expect(findAll(c, (el) => el.props && el.props['data-payment-destination'] !== undefined)).toHaveLength(1);
    });

    it('D6. ordering talks to the order route only — nothing on this page can reach a paid-state route', async () => {
        const m = mountComponent(loadClient(), clientProps(PUBLIC_BANK));
        await addAndSubmit(m);
        expect(fetchMock).toHaveBeenCalled();
        for (const call of fetchMock.mock.calls) expect(String(call[0])).toBe('/api/public/order');
        for (const src of ['components/fundraiser/SupporterPaymentSection.tsx', 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx']) {
            expect(stripComments(read(src))).not.toMatch(/\/api\/coordinator|mark_paid|paid_at|useSearchParams|searchParams/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('E. the coordinator form', () => {
    const { CoordinatorPaymentFields, BANK_ACH_LINK_HELP, BANK_ACH_SAFETY_WARNING } = require('@/components/coordinator/CoordinatorSetupFields');
    const values = (form = emptyPaymentMethodsForm()) => ({ paymentMethods: form, checksPayable: '', paymentInstructions: '', paymentLink: '' });
    const render = (props: Row) => CoordinatorPaymentFields({ onChange: () => {}, ...props });
    const bankForm = (over: Partial<ReturnType<typeof emptyPaymentMethodsForm>> = {}) => {
        const f = emptyPaymentMethodsForm();
        f.selected.bank_ach = true;
        return { ...f, ...over };
    };

    it('E1. Bank / ACH is a real checkbox, between Cash App and Other', () => {
        const tree = render({ values: values() });
        const labels = findAll(tree, (el) => el.type === 'label' && findAll(el, (x) => x.type === 'input' && x.props.type === 'checkbox').length === 1);
        expect(labels.map((l) => textOf(l))).toEqual(['Cash', 'Check', 'Venmo', 'PayPal', 'Cash App', 'Bank / ACH', 'Other']);
        const onChange = jest.fn();
        const box = findAll(render({ values: values(), onChange }), (el) => el.type === 'input' && el.props.type === 'checkbox')[5];
        box.props.onChange({ target: { checked: true } });
        expect(onChange.mock.calls[0][0].paymentMethods.selected.bank_ach).toBe(true);
    });

    it('E2. selected: a required, labelled bank link with its help, an optional labelled note, and the banking-safety warning', () => {
        const tree = render({ values: values(bankForm()) });
        const link = findAll(tree, (el) => el.type === 'input' && el.props.id === 'setup-bank_ach-link')[0];
        expect(link.props.type).toBe('url');
        expect(link.props['aria-required']).toBe('true');
        expect(link.props.placeholder).toBe('https://');
        const linkLabel = findAll(tree, (el) => el.type === 'label' && el.props.htmlFor === 'setup-bank_ach-link');
        expect(linkLabel).toHaveLength(1);
        expect(textOf(linkLabel[0])).toBe('Bank payment link (required)');
        const note = findAll(tree, (el) => el.type === 'textarea' && el.props.id === 'setup-bank_ach-note')[0];
        expect(note.props.placeholder).toBe("Enter your order total on the bank's payment page.");
        expect(textOf(findAll(tree, (el) => el.type === 'label' && el.props.htmlFor === 'setup-bank_ach-note')[0])).toBe('Note for supporters (optional)');
        expect(BANK_ACH_LINK_HELP).toBe('Paste the payment-page link your bank or payment provider gave your organization. It must start with https://.');
        expect(BANK_ACH_SAFETY_WARNING).toBe('Never enter a routing number, account number, or bank login. FreezerIQ only needs the secure payment-page link.');
        const help = findAll(tree, (el) => el.props && el.props.id === 'setup-bank_ach-help')[0];
        const warning = findAll(tree, (el) => el.props && el.props.id === 'setup-bank_ach-warning')[0];
        expect(textOf(help)).toBe(BANK_ACH_LINK_HELP);
        expect(textOf(warning)).toBe(BANK_ACH_SAFETY_WARNING);
        expect(link.props['aria-describedby'].split(' ')).toEqual(expect.arrayContaining(['setup-bank_ach-help', 'setup-bank_ach-warning']));
        for (const cls of [help.props.className, warning.props.className]) expect(cls).toContain('break-words');
    });

    it('E3. there is no field for a routing number, account number, username or password — anywhere in the form', () => {
        const all = emptyPaymentMethodsForm();
        for (const t of PAYMENT_METHOD_TYPES) all.selected[t] = true;
        const tree = render({ values: values(all) });
        const fields = findAll(tree, (el) => (el.type === 'input' && el.props.type !== 'checkbox') || el.type === 'textarea');
        for (const f of fields) {
            const label = findAll(tree, (el) => el.type === 'label' && el.props.htmlFor === f.props.id)[0];
            // ("Venmo username" is a public handle, not a credential — so "username" alone is not the test.)
            expect(`${f.props.id} ${f.props.name ?? ''} ${f.props.type ?? ''} ${label ? textOf(label) : ''}`).not.toMatch(/routing|account number|password|\blogin\b|online banking/i);
        }
        expect(fields.some((f) => f.props.type === 'password')).toBe(false);
    });

    it('E4. an empty bank link complains only after a refused save; a wrong link complains beside its field', () => {
        expect(findAll(render({ values: values(bankForm()) }), (el) => el.props && el.props.role === 'alert')).toHaveLength(0);
        const refused = render({ values: values(bankForm()), showAllErrors: true });
        const alert = findAll(refused, (el) => el.props && el.props.role === 'alert')[0];
        expect(textOf(alert)).toMatch(/Paste your bank payment link/);
        const link = findAll(refused, (el) => el.type === 'input' && el.props.id === 'setup-bank_ach-link')[0];
        expect(link.props['aria-invalid']).toBe(true);
        expect(link.props['aria-describedby'].split(' ')).toContain(alert.props.id);
        const http = render({ values: values(bankForm({ bankLink: 'http://pay.examplebank.test/x' })) });
        expect(textOf(findAll(http, (el) => el.props && el.props.role === 'alert')[0])).toMatch(/must start with https/);
    });

    it('E5. the form round-trips; deselecting Bank / ACH sends nothing for it and leaves the other methods intact', () => {
        const reloaded = paymentMethodsFormFromStored(BANK_VENMO_OTHER);
        expect(reloaded.selected.bank_ach).toBe(true);
        expect(reloaded.bankLink).toBe(BANK_LINK);
        expect(reloaded.bankNote).toBe(BANK_NOTE);
        expect(storedOf(paymentMethodsInputFromForm(reloaded))).toEqual(BANK_VENMO_OTHER);
        const off = { ...reloaded, selected: { ...reloaded.selected, bank_ach: false } };
        const wire = paymentMethodsInputFromForm(off);
        expect(wire.map((m) => m.type)).toEqual(['venmo', 'other']);
        expect(JSON.stringify(wire)).not.toContain('examplebank');
        expect(storedOf(wire)).toEqual({ v: 1, methods: BANK_VENMO_OTHER.methods.filter((m) => m.type !== 'bank_ach') });
    });

    it('E6. the form says plainly that a bank link only opens a page and never marks an order paid', () => {
        const text = textOf(render({ values: values() }));
        expect(text).toContain('bank payment links only open another app or website');
        expect(text).toMatch(/does not mark an order paid/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('F. the coordinator summary and routes', () => {
    it('F1. the summary names Bank / ACH by where it goes and shows the coordinator\'s note — not the whole link', () => {
        const { PaymentMethodsSummary } = require('@/components/coordinator/PaymentMethodsSummary');
        const tree = PaymentMethodsSummary({ paymentMethods: storedOf([{ type: 'cash' }, { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }]), checksPayable: null, paymentInstructions: null, externalPaymentLink: null, onEdit: () => {} });
        const text = textOf(tree);
        expect(text).toContain('Cash · Bank / ACH');
        expect(text).toContain(`Bank / ACH: Opens ${BANK_HOST}`);
        expect(text).toContain(BANK_NOTE);
        for (const hidden of [BANK_LINK, '/pto/maple', 'campaign=fall', 'https://']) expect(text).not.toContain(hidden);
        expect(text).not.toMatch(/\bPaid\b|null|undefined/);
    });

    const settingsMock = () => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
            'fundraiserCampaign.findFirst': { id: CAMPAIGN_A, portal_token: 'PORTAL-SECRET', customer: { business: { plan: 'PRO' } } },
        },
    });
    const put = async (body: unknown) =>
        readJson(await route('@/app/api/coordinator/route').PUT(request('/api/coordinator', { method: 'PUT', body: JSON.stringify(body) })));

    it('F2. Payment Settings saves Bank / ACH for the session\'s campaign — a campaign id in the body cannot retarget it', async () => {
        useMock(settingsMock());
        const res = await put({ campaignId: CAMPAIGN_B, paymentMethods: [{ type: 'cash' }, { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        const upd = mock.firstCall('fundraiserCampaign.update')!.args;
        expect(upd.where).toEqual({ id: CAMPAIGN_A });
        expect(upd.data).toEqual({ payment_methods: { v: 1, methods: [{ type: 'cash' }, { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }] } });
        expect(JSON.stringify(upd)).not.toContain(CAMPAIGN_B);
        expect(mock.calls.filter((c) => c.model === 'order')).toEqual([]);
    });

    it('F3. Payment Settings refuses a missing, unsafe or too-long bank link and an unsafe note — and writes nothing', async () => {
        const GROWS = BASE + '\u00e9'.repeat(100);
        for (const bank of [
            { type: 'bank_ach' }, { type: 'bank_ach', link: '' }, { type: 'bank_ach', link: 'http://pay.examplebank.test/x' },
            { type: 'bank_ach', link: 'javascript:alert(1)' }, { type: 'bank_ach', link: 'https://u:p@pay.examplebank.test/' },
            { type: 'bank_ach', link: GROWS }, { type: 'bank_ach', link: BANK_LINK, note: '<script>x</script>' },
        ]) {
            useMock(settingsMock());
            const res = await put({ paymentMethods: [{ type: 'cash' }, bank] });
            expect(res.status).toBe(400);
            expect(typeof res.body.error).toBe('string');
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
    });

    it('F4. setup saves Bank / ACH in the activation write, and refuses one without a link before any database work', async () => {
        const resolved = { id: CAMPAIGN_A, name: 'Maple Fundraiser', status: 'Active', closed_at: null, bundle_selection_status: 'pending', bundle_selection_at: null, bundle_selection_limit: 1, customer: { business_id: BIZ_A } };
        const setupMock = () => createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
                'fundraiserCampaign.findFirst': resolved,
                'fundraiserCampaign.findUnique': resolved,
                'order.count': 0,
                'campaignBundle.findMany': [{ bundle: { id: 'b5', name: 'Fall Family (fixture)', sku: null, family_id: 'fam-1', serving_tier: 'family', business_id: BIZ_A, is_active: true } }],
                'bundle.findMany': [{ id: 'b2', name: 'Fall Family S2 (fixture)', family_id: 'fam-1', serving_tier: 'serves_2', business_id: BIZ_A, is_active: true }],
            },
        });
        const post = async (body: unknown) => readJson(await route('@/app/api/coordinator/bundle-selection/route').POST(request('/api/coordinator/bundle-selection', { method: 'POST', body: JSON.stringify(body) })));
        useMock(setupMock());
        const ok = await post({ familyIds: ['fam-1'], paymentMethods: [{ type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }, { type: 'cash' }] });
        expect(ok.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data).toMatchObject({ bundle_selection_status: 'selected', payment_methods: { v: 1, methods: [{ type: 'cash' }, { type: 'bank_ach', link: BANK_LINK, note: BANK_NOTE }] } });
        useMock(setupMock());
        const refused = await post({ familyIds: ['fam-1'], paymentMethods: [{ type: 'bank_ach', note: BANK_NOTE }] });
        expect(refused.status).toBe(400);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        expect(mock.client.$transaction).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('G. paid stays the coordinator\'s explicit mark — nothing else', () => {
    const CHANGED = [
        'lib/supporterPaymentMethods.ts', 'lib/coordinatorSetup.ts', 'lib/email.ts',
        'components/coordinator/CoordinatorSetupFields.tsx', 'components/coordinator/PaymentMethodsSummary.tsx',
        'components/fundraiser/SupporterPaymentSection.tsx',
    ];
    const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
        const p = `${dir}/${f}`;
        return statSync(join(ROOT, p)).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });

    it('G1. nothing this phase touched writes or reads a paid mark, or writes any order', () => {
        for (const f of CHANGED) {
            expect(stripComments(read(f))).not.toMatch(/paid_at|paid_by|mark_paid|mark_unpaid|markSupporterPayment|paymentTransitionData|\.order\.(create|update|updateMany|upsert)\(/);
        }
    });

    it('G2. the only code that writes a supporter paid mark is still the coordinator\'s explicit action', () => {
        const writers = [...files('app'), ...files('lib')].filter((f) => /paymentTransitionData\(/.test(stripComments(read(f))));
        expect(writers.sort()).toEqual(['app/api/coordinator/route.ts', 'lib/supporterPayment.ts']);
    });

    it('G3. no return or callback: the link is stored and offered exactly as the coordinator gave it, and no bank route exists', () => {
        const r = checkPaymentMethod({ type: 'bank_ach', link: BANK_LINK }) as any;
        expect(r.value.link).toBe(BANK_LINK);
        expect(toPublicPaymentMethods(storedOf([{ type: 'bank_ach', link: BANK_LINK }]), null)![0].href).toBe(BANK_LINK);
        expect(files('app/api').filter((f) => /bank|ach|plaid|nacha/i.test(f.replace(/^app\/api\//, '')))).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('H. campaign / tenant isolation', () => {
    const LINK_A = 'https://pay.examplebank.test/campaign-a';
    const LINK_B = 'https://pay.othercu.test/campaign-b';
    const LINK_T = 'https://pay.otherkitchen.test/tenant-b';
    const pageCampaign = (id: string, businessId: string, link: string, over: Row = {}): Row => ({
        id, name: `${ORG} Fundraiser`, about_text: null, participant_label: null,
        end_date: new Date('2099-01-01T00:00:00.000Z'), delivery_date: null, pickup_location: null, delivery_time: null,
        payment_instructions: null, external_payment_link: null,
        payment_methods: storedOf([{ type: 'bank_ach', link }]), checks_payable: PAYEE,
        bundle_goal: 20, total_sales: '0', status: 'Active', closed_at: null, tax_status: null, tax_rate_percent: null,
        bundle_selection_status: 'not_required', bundle_selection_limit: 2,
        organization_name: ORG, customer_fundraiser_info: {}, portal_token: 'PORTAL-SECRET',
        __business_id: businessId, ...over,
    });
    const ROWS: Row[] = [
        pageCampaign(CAMPAIGN_A, BIZ_A, LINK_A),
        pageCampaign(CAMPAIGN_B, BIZ_A, LINK_B, { organization_name: 'Other Org (fixture)' }),
        pageCampaign('cccc4444-0000-4000-8000-0000000000c3', BIZ_B, LINK_T),
    ];
    const renderPage = async (campaignId: string, slugBusinessId = BIZ_A) => {
        useMock(createPrismaMock({
            results: {
                'business.findUnique': { id: slugBusinessId, name: 'Kitchen (fixture)', display_name: null, slug: PAGE_SLUG, logo_url: null, timezone: 'America/Chicago', custom_domain: null },
                $queryRaw: ({ sql, values }: { sql: string; values: any[] }) => {
                    if (/FROM tenant_branding/.test(sql)) return [];
                    if (/FROM fundraiser_campaigns fc/.test(sql)) {
                        expect(sql).toMatch(/WHERE fc\.id = \? AND c\.business_id = \?/);
                        const [id, biz] = values;
                        return ROWS.filter((r) => r.id === id && r.__business_id === biz).map(({ __business_id, ...r }) => r);
                    }
                    return [];
                },
            },
        }));
        const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
        try {
            const el: any = await mod.default({ params: Promise.resolve({ slug: PAGE_SLUG, fundraiserId: campaignId }) });
            return { props: el.props, notFound: false };
        } catch (e: any) {
            if (String(e?.message || e?.digest || '').includes('NEXT_HTTP_ERROR_FALLBACK;404') || String(e?.digest || '').includes('404')) return { props: null, notFound: true };
            throw e;
        }
    };

    it('H1. each campaign\'s page offers ITS bank link only; another tenant cannot read it through its own slug', async () => {
        const a = await renderPage(CAMPAIGN_A);
        expect(a.props.campaign.payment_methods.map((m: any) => m.href)).toEqual([LINK_A]);
        expect(JSON.stringify(a.props)).not.toMatch(/othercu|otherkitchen|PORTAL-SECRET/);
        const b = await renderPage(CAMPAIGN_B);
        expect(b.props.campaign.payment_methods.map((m: any) => m.href)).toEqual([LINK_B]);
        expect(JSON.stringify(b.props)).not.toContain('campaign-a');
        const t = await renderPage(CAMPAIGN_A, BIZ_B);
        expect(t.notFound || t.props === null || t.props?.campaign == null).toBe(true);
    });

    it('H2. the coordinator panel reads THIS session\'s campaign bank link only', async () => {
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
                'fundraiserCampaign.findFirst': (args: any) => {
                    const id = args?.where?.id;
                    return {
                        id, name: 'Maple Fundraiser', status: 'Active', closed_at: null, settlement_total: '0',
                        end_date: new Date('2099-01-01T00:00:00Z'), delivery_date: null, delivery_time: null, pickup_location: null,
                        external_payment_link: null, payment_instructions: null, checks_payable: null,
                        payment_methods: storedOf([{ type: 'bank_ach', link: id === CAMPAIGN_A ? LINK_A : LINK_B }]),
                        bundle_goal: 20, total_sales: '0', org_share_percent: '20.00', participant_label: 'Member', bundle_selection_status: 'selected',
                        bundle_selection_limit: 1, public_token: 'public-bach1', customer_id: 'org-bach1', tax_status: null, tax_rate_percent: null,
                        customer: { name: ORG, contact_name: 'Pat Fixture', contact_email: 'pat@example.invalid', business_id: BIZ_A,
                            business: { name: 'Kitchen', display_name: 'Kitchen', slug: 'kitchen-fixture', custom_domain: null, contact_email: null, logo_url: null, plan: 'PRO', subscription_status: 'active', timezone: 'America/Chicago' } },
                        orders: [],
                    };
                },
                'order.findMany': [],
                'bundle.findMany': [],
            },
        }));
        const res = await readJson(await route('@/app/api/coordinator/route').GET(request('/api/coordinator')));
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.where).toEqual({ id: CAMPAIGN_A });
        expect(res.body.payment_methods).toEqual({ v: 1, methods: [{ type: 'bank_ach', link: LINK_A }] });
        expect(JSON.stringify(res.body)).not.toContain('othercu');
    });
});
