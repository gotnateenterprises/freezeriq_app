/**
 * COORDINATOR-PAYMENT-METHOD-UX-1 — structured supporter payment methods.
 *
 * A coordinator chooses how supporters may pay them (Cash / Check / Venmo / PayPal / Cash App /
 * Other); supporters see exactly those before ordering, after ordering and in their email. It is a
 * description of what the coordinator ACCEPTS — never a payment record. Paid state stays
 * Order.paid_at, written only by the coordinator's explicit mark.
 *
 * Real code throughout: the pure rules, the REAL route handlers against the shared recording Prisma
 * double (tests/helpers/routeHarness), the REAL public page data path, and the REAL FundraiserClient
 * driven without a DOM (tests/helpers/hookRuntime). The email and the order route have their own
 * suites (…Email / …Order) because each needs a different module double. All data is fictional.
 *
 *  A. the rules (lib/supporterPaymentMethods) — methods, validation, projection, the one view
 *  B. coordinator setup — POST/GET /api/coordinator/bundle-selection
 *  C. Payment Settings — PUT /api/coordinator
 *  D. the coordinator panel — GET /api/coordinator and the summary card
 *  E. the public payload — toPublicCampaign, page.tsx, the sample page; campaign/org/tenant isolation
 *  F. the supporter page — before ordering, after ordering, legacy, fallback, totals
 *  G. the coordinator form — checkboxes, labels, method fields, errors
 *  H. paid stays paid-by-the-coordinator-only
 *  I. schema and migration
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { mountComponent, findAll, textOf, walk } from './helpers/hookRuntime';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    PAYMENT_METHOD_TYPES,
    PAYMENT_DUE_GUIDANCE,
    PAYMENT_CONTACT_FALLBACK,
    CASH_GUIDANCE,
    PUBLIC_PAYMENT_METHOD_KEYS,
    checkPaymentMethods,
    checkPaymentMethod,
    checkCoordinatorPaymentSettings,
    readStoredPaymentMethods,
    toPublicPaymentMethods,
    buildSupporterPaymentView,
    offersOnlinePayment,
    emptyPaymentMethodsForm,
    paymentMethodsFormFromStored,
    paymentMethodsInputFromForm,
    paymentMethodsFormErrors,
    type StoredPaymentMethods,
} from '@/lib/supporterPaymentMethods';
import { checkCoordinatorSetup } from '@/lib/coordinatorSetup';
import { toPublicCampaign, PUBLIC_CAMPAIGN_FIELDS, FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS } from '@/lib/publicFundraiserPayload';
import { buildSampleCampaign } from '@/lib/sampleFundraiser';
import { paymentTransitionData } from '@/lib/supporterPayment';
import { computeSupporterOrderTax } from '@/lib/fundraiserTax';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pmu1Prisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => ((global as any).__pmu1Authed && name === (global as any).__pmu1CookieName
            ? { name, value: 'pmu1-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// ── fictional fixtures ────────────────────────────────────────────────────────────────────────
const BIZ_A = 'biz-pmu1-a';
const BIZ_B = 'biz-pmu1-b';
const CAMPAIGN_A = 'aaaa3333-0000-4000-8000-0000000000a1';
const CAMPAIGN_B = 'aaaa3333-0000-4000-8000-0000000000b2';
const PAYEE = 'Lincoln PTO (fixture)';
const ORG = 'Maple Ridge Robotics (fixture)';

const ALL_INPUT = [
    { type: 'other', label: 'Pay at pickup', details: 'Bring cash or a check to the pickup table.', link: 'https://pay.example.test/maple' },
    { type: 'cashapp', cashtag: '$MapleFixture' },
    { type: 'paypal', account: 'paypal.me/MapleFixture' },
    { type: 'venmo', handle: '@maple-fixture' },
    { type: 'check' },
    { type: 'cash' },
];
const storedOf = (input: unknown): StoredPaymentMethods => {
    const r = checkPaymentMethods(input);
    if (!r.ok) throw new Error(`fixture invalid: ${r.error}`);
    return r.value;
};
const STORED_ALL = storedOf(ALL_INPUT);
const STORED_CASH_CHECK = storedOf([{ type: 'cash' }, { type: 'check' }]);
const STORED_VENMO_CASHAPP = storedOf([{ type: 'venmo', handle: '@maple-fixture' }, { type: 'cashapp', cashtag: '$MapleFixture' }]);

// ── coordinator-session harness ───────────────────────────────────────────────────────────────
let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__pmu1Prisma = m.client; return m; };
const sessionFor = (campaignId: string) => ({ id: 'session-pmu1', campaign_id: campaignId, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null });
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
    (global as any).__pmu1CookieName = coordinatorSessionCookieName();
    (global as any).__pmu1Authed = true;
});

// ═════════════════════════════════════════════════════════════════════════════
describe('A. the rules — lib/supporterPaymentMethods', () => {
    it('A1. each method can be selected on its own (1–6; Bank / ACH added by COORDINATOR-BANK-ACH-LINK-1)', () => {
        const single: Record<string, unknown> = {
            cash: { type: 'cash' }, check: { type: 'check' }, venmo: { type: 'venmo', handle: 'maple-fixture' },
            paypal: { type: 'paypal', account: 'maple@example.test' }, cashapp: { type: 'cashapp', cashtag: 'MapleFixture' },
            bank_ach: { type: 'bank_ach', link: 'https://pay.examplebank.test/maple' },
            other: { type: 'other', label: 'School office', details: 'Drop payment at the front office.' },
        };
        // Superseded pin: the owner-approved seventh method sits after Cash App and before Other.
        expect([...PAYMENT_METHOD_TYPES]).toEqual(['cash', 'check', 'venmo', 'paypal', 'cashapp', 'bank_ach', 'other']);
        for (const type of PAYMENT_METHOD_TYPES) {
            const r = checkPaymentMethods([single[type]]);
            expect(r.ok).toBe(true);
            expect((r as any).value.methods.map((m: any) => m.type)).toEqual([type]);
        }
    });

    it('A2. multiple methods coexist, always in the supporter order whatever order they were sent in (7)', () => {
        expect(STORED_ALL.v).toBe(1);
        expect(STORED_ALL.methods.map((m) => m.type)).toEqual(['cash', 'check', 'venmo', 'paypal', 'cashapp', 'other']);
        expect(STORED_ALL.methods).toEqual([
            { type: 'cash' }, { type: 'check' }, { type: 'venmo', handle: 'maple-fixture' }, { type: 'paypal', me: 'MapleFixture' },
            { type: 'cashapp', cashtag: 'MapleFixture' },
            { type: 'other', label: 'Pay at pickup', details: 'Bring cash or a check to the pickup table.', link: 'https://pay.example.test/maple' },
        ]);
    });

    it('A3. Venmo: @handle, bare handle and a venmo.com profile link all normalise; malformed values are refused (11)', () => {
        for (const ok of ['@maple-fixture', 'maple-fixture', 'https://venmo.com/u/maple-fixture', 'https://account.venmo.com/u/maple-fixture', 'https://venmo.com/maple-fixture', '  @maple-fixture  ']) {
            const r = checkPaymentMethod({ type: 'venmo', handle: ok });
            expect(r).toEqual({ ok: true, value: { type: 'venmo', handle: 'maple-fixture' } });
        }
        for (const bad of ['', '   ', '@abc', 'has space', 'a'.repeat(31), 'javascript:alert(1)', 'https://evil.example/u/maple-fixture',
            '<b>maple</b>', 'maple\u0000fixture', 'maple.fixture', 'https://venmo.com/u/a/b', 'data:text/html,x', null, 42, {}]) {
            expect(checkPaymentMethod({ type: 'venmo', handle: bad as any }).ok).toBe(false);
        }
    });

    it('A4. Cash App: $Cashtag, bare tag and a cash.app link normalise; a tag with no letter, too long, or with symbols is refused (12)', () => {
        for (const ok of ['$MapleFixture', 'MapleFixture', 'https://cash.app/$MapleFixture', 'https://cash.app/MapleFixture']) {
            expect(checkPaymentMethod({ type: 'cashapp', cashtag: ok })).toEqual({ ok: true, value: { type: 'cashapp', cashtag: 'MapleFixture' } });
        }
        for (const bad of ['', '$12345', '$' + 'a'.repeat(21), '$bad-tag', '$bad tag', 'javascript:alert(1)', 'https://evil.example/$MapleFixture', '$<x>', '$Maple‮exe']) {
            expect(checkPaymentMethod({ type: 'cashapp', cashtag: bad }).ok).toBe(false);
        }
    });

    it('A5. PayPal: an email is shown but never linked; only a real PayPal.Me name becomes a link; unsafe URLs are refused (13)', () => {
        expect(checkPaymentMethod({ type: 'paypal', account: 'maple@example.test' })).toEqual({ ok: true, value: { type: 'paypal', email: 'maple@example.test' } });
        for (const ok of ['paypal.me/MapleFixture', 'https://paypal.me/MapleFixture', 'https://www.paypal.com/paypalme/MapleFixture', 'MapleFixture']) {
            expect(checkPaymentMethod({ type: 'paypal', account: ok })).toEqual({ ok: true, value: { type: 'paypal', me: 'MapleFixture' } });
        }
        for (const bad of ['', 'javascript:alert(1)', 'https://evil.example/MapleFixture', 'https://paypal.com.evil.example/paypalme/x', 'paypal.me/bad name',
            'paypal.me/bad-name', 'not-an-email@', 'a@b', 'https://user:pw@paypal.me/MapleFixture', '<script>@x.com']) {
            expect(checkPaymentMethod({ type: 'paypal', account: bad }).ok).toBe(false);
        }
        const [pp] = toPublicPaymentMethods(storedOf([{ type: 'paypal', account: 'maple@example.test' }]), null)!;
        expect(pp).toEqual({ type: 'paypal', label: 'PayPal', detail: 'maple@example.test', href: null, actionLabel: null });
    });

    it('A6. Other needs BOTH a usable name and instructions; blank or whitespace never passes (9, 15)', () => {
        const base = { type: 'other', label: 'Pay at pickup', details: 'Bring cash.' };
        expect(checkPaymentMethod(base).ok).toBe(true);
        for (const over of [{ label: '' }, { label: '   ' }, { label: null }, { details: '' }, { details: ' \n ' }, { details: undefined }]) {
            const r = checkPaymentMethod({ ...base, ...over } as any) as any;
            expect(r.ok).toBe(false);
            expect(r.method).toBe('other');
        }
        expect(checkPaymentMethod({ ...base, label: 'x'.repeat(41) }).ok).toBe(false);
        expect(checkPaymentMethod({ ...base, details: 'x'.repeat(301) }).ok).toBe(false);
    });

    it('A7. an Other link must pass the shared https rule — script, data, plain http and credentials are refused', () => {
        const base = { type: 'other', label: 'School portal', details: 'Pay through the portal.' };
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'http://pay.example.test/x', 'https://user:pw@pay.example.test', 'ftp://x.example/y']) {
            expect(checkPaymentMethod({ ...base, link: bad }).ok).toBe(false);
        }
        expect(checkPaymentMethod({ ...base, link: 'https://pay.example.test/x' })).toEqual({ ok: true, value: { ...base, link: 'https://pay.example.test/x' } });
        expect(checkPaymentMethod({ ...base, link: '' })).toEqual({ ok: true, value: base });
    });

    it('A8. markup and control / invisible characters are refused; the coordinator\'s own line breaks survive (14, 15)', () => {
        const base = { type: 'other', label: 'Pickup', details: 'Line one\r\nLine two' };
        expect(checkPaymentMethod(base)).toEqual({ ok: true, value: { type: 'other', label: 'Pickup', details: 'Line one\nLine two' } });
        for (const bad of [
            { label: '<script>alert(1)</script>' }, { details: 'Pay <a href="x">here</a>' }, { label: 'Pick\u0007up' },
            { details: 'Pay\u0000now' }, { details: 'Pay ‮moc.live' }, { label: 'Pick up' }, { details: 'tab\u000Bvertical' },
        ]) {
            expect(checkPaymentMethod({ ...base, ...bad }).ok).toBe(false);
        }
        // The shared logistics rule now refuses the same characters (instructions, payee, pickup…).
        expect(checkCoordinatorSetup({ paymentInstructions: 'Pay\u0000 me' }).ok).toBe(false);
        expect(checkCoordinatorSetup({ checksPayable: 'PTO‮' }).ok).toBe(false);
        expect(checkCoordinatorSetup({ paymentInstructions: 'Line one\nLine two\tok' }).ok).toBe(true);
    });

    it('A9. unknown types, duplicates and non-lists are refused rather than silently dropped; null clears to an empty list', () => {
        expect(checkPaymentMethods([{ type: 'zelle' }]).ok).toBe(false);
        expect(checkPaymentMethods([{ type: 'credit_card' }]).ok).toBe(false);
        expect(checkPaymentMethods([{ type: 'cash' }, { type: 'cash' }]).ok).toBe(false);
        expect(checkPaymentMethods({ cash: true }).ok).toBe(false);
        expect(checkPaymentMethods('cash').ok).toBe(false);
        expect(checkPaymentMethods(new Array(7).fill({ type: 'cash' })).ok).toBe(false);
        expect(checkPaymentMethods(null)).toEqual({ ok: true, value: { v: 1, methods: [] } });
        expect(checkPaymentMethods([])).toEqual({ ok: true, value: { v: 1, methods: [] } });
    });

    it('A10. deselecting a method sends nothing for it — its typed-in fields never leave the form (8)', () => {
        const form = paymentMethodsFormFromStored(STORED_ALL);
        form.selected.venmo = false;
        form.selected.other = false;
        const sent = paymentMethodsInputFromForm(form);
        expect(sent.map((m) => m.type)).toEqual(['cash', 'check', 'paypal', 'cashapp']);
        expect(JSON.stringify(sent)).not.toContain('maple-fixture');
        expect(JSON.stringify(sent)).not.toContain('Pay at pickup');
        // …and what is stored and shown afterwards no longer mentions it anywhere.
        const shown = JSON.stringify(toPublicPaymentMethods(storedOf(sent), PAYEE));
        expect(shown).not.toMatch(/venmo|maple-fixture|Pay at pickup/i);
    });

    it('A11. the form round-trips: what was stored reloads into the form and re-saves identically (10)', () => {
        const reloaded = paymentMethodsFormFromStored(STORED_ALL);
        // COORDINATOR-BANK-ACH-LINK-1: the form carries the seventh method too (unselected here).
        expect(reloaded.selected).toEqual({ cash: true, check: true, venmo: true, paypal: true, cashapp: true, bank_ach: false, other: true });
        expect(reloaded.venmoHandle).toBe('@maple-fixture');
        expect(reloaded.cashappTag).toBe('$MapleFixture');
        expect(reloaded.paypalAccount).toBe('paypal.me/MapleFixture');
        expect(storedOf(paymentMethodsInputFromForm(reloaded))).toEqual(STORED_ALL);
        expect(paymentMethodsFormFromStored(null)).toEqual(emptyPaymentMethodsForm());
    });

    it('A12. a stored value is re-validated on read: bad entries are dropped, not rendered; anything not v1 is "never configured"', () => {
        for (const notConfig of [null, undefined, 'cash', [], {}, { v: 2, methods: [] }, { methods: [{ type: 'cash' }] }, { v: 1, methods: 'cash' }]) {
            expect(readStoredPaymentMethods(notConfig)).toBeNull();
        }
        const tampered = {
            v: 1,
            methods: [
                { type: 'other', label: 'Click', details: 'here', link: 'javascript:alert(1)' },
                { type: 'venmo', handle: '<img src=x onerror=1>' },
                { type: 'zelle', handle: 'x' },
                { type: 'cash' }, { type: 'cash' },
                { type: 'cashapp', cashtag: 'MapleFixture', extra: 'SECRET-INTERNAL' },
            ],
        };
        expect(readStoredPaymentMethods(tampered)).toEqual({ v: 1, methods: [{ type: 'cash' }, { type: 'cashapp', cashtag: 'MapleFixture' }] });
        expect(JSON.stringify(toPublicPaymentMethods(tampered, null))).not.toMatch(/javascript|onerror|SECRET-INTERNAL|zelle/);
    });

    it('A13. the supporter projection: only five public keys per method, truthful labels, links only where a format is known', () => {
        const pub = toPublicPaymentMethods(STORED_ALL, PAYEE)!;
        for (const m of pub) expect(Object.keys(m).sort()).toEqual([...PUBLIC_PAYMENT_METHOD_KEYS].sort());
        expect(pub).toEqual([
            { type: 'cash', label: 'Cash', detail: CASH_GUIDANCE, href: null, actionLabel: null },
            { type: 'check', label: 'Check', detail: `Make checks payable to ${PAYEE}`, href: null, actionLabel: null },
            { type: 'venmo', label: 'Venmo', detail: '@maple-fixture', href: 'https://venmo.com/u/maple-fixture', actionLabel: 'Open Venmo' },
            { type: 'paypal', label: 'PayPal', detail: 'paypal.me/MapleFixture', href: 'https://paypal.me/MapleFixture', actionLabel: 'Open PayPal' },
            { type: 'cashapp', label: 'Cash App', detail: '$MapleFixture', href: 'https://cash.app/$MapleFixture', actionLabel: 'Open Cash App' },
            { type: 'other', label: 'Pay at pickup', detail: 'Bring cash or a check to the pickup table.', href: 'https://pay.example.test/maple', actionLabel: 'Open link' },
        ]);
        expect(JSON.stringify(pub)).not.toMatch(/pay\s*now|paid/i);
        expect(toPublicPaymentMethods(null, PAYEE)).toBeNull();
    });

    it('A14. the Check payee is public ONLY inside a selected Check, never invented, and an unsafe payee is dropped', () => {
        expect(toPublicPaymentMethods(STORED_VENMO_CASHAPP, PAYEE)!.some((m) => (m.detail || '').includes(PAYEE))).toBe(false);
        expect(toPublicPaymentMethods(STORED_CASH_CHECK, null)![1]).toEqual({ type: 'check', label: 'Check', detail: null, href: null, actionLabel: null });
        expect(toPublicPaymentMethods(STORED_CASH_CHECK, '<b>PTO</b>')![1].detail).toBeNull();
        expect(toPublicPaymentMethods(STORED_CASH_CHECK, '   ')![1].detail).toBeNull();
    });

    it('A15. the one view: due line for configured campaigns; a legacy campaign\'s own words are never overruled (22, 23)', () => {
        const structured = buildSupporterPaymentView({ methods: toPublicPaymentMethods(STORED_CASH_CHECK, PAYEE), instructions: 'Include your swimmer\'s name.', legacyLink: null });
        expect(structured.dueLine).toBe(PAYMENT_DUE_GUIDANCE);
        expect(structured.methods.map((m) => m.type)).toEqual(['cash', 'check']);
        expect(structured.instructions).toBe('Include your swimmer\'s name.');
        expect(structured.fallback).toBeNull();

        const legacy = buildSupporterPaymentView({ methods: null, instructions: 'cash or check at pick up', legacyLink: null });
        expect(legacy.dueLine).toBeNull();
        expect(legacy.instructions).toBe('cash or check at pick up');
        expect(legacy.fallback).toBeNull();
    });

    it('A16. nothing configured is never an empty section: due line + contact fallback (37, 40)', () => {
        for (const v of [
            buildSupporterPaymentView({ methods: null, instructions: null, legacyLink: null }),
            buildSupporterPaymentView({ methods: [], instructions: '   ', legacyLink: '' }),
        ]) {
            expect(v.dueLine).toBe(PAYMENT_DUE_GUIDANCE);
            expect(v.fallback).toBe(PAYMENT_CONTACT_FALLBACK);
            expect(v.methods).toEqual([]);
        }
        expect(PAYMENT_DUE_GUIDANCE).toBe('Payment is due to the coordinator within three days.');
        expect(PAYMENT_CONTACT_FALLBACK).toBe('Please contact your fundraiser coordinator to arrange payment.');
    });

    it('A17. a legacy link is clickable only when it passes the https rule; a tampered projection cannot smuggle a link in', () => {
        expect(buildSupporterPaymentView({ methods: null, instructions: null, legacyLink: 'https://venmo.com/u/old-link' }).legacyLink)
            .toEqual({ text: 'https://venmo.com/u/old-link', href: 'https://venmo.com/u/old-link', actionLabel: 'Open payment link' });
        expect(buildSupporterPaymentView({ methods: null, instructions: null, legacyLink: 'javascript:alert(1)' }).legacyLink!.href).toBeNull();
        const forged = buildSupporterPaymentView({
            methods: [
                { type: 'venmo', label: 'Venmo', detail: '@x', href: 'javascript:alert(1)', actionLabel: 'Open Venmo' },
                { type: 'cash', label: 'Cash', detail: { evil: true }, href: null, actionLabel: 'Pay now' },
                { type: 'wire', label: 'Wire', detail: 'x', href: null, actionLabel: null },
            ] as any,
            instructions: null,
            legacyLink: null,
        });
        expect(forged.methods).toEqual([{ type: 'cash', label: 'Cash', detail: null, href: null, actionLabel: null }]);
    });

    it('A18. "online" methods are the ones a supporter could have used without the coordinator\'s hand', () => {
        expect(offersOnlinePayment(toPublicPaymentMethods(STORED_CASH_CHECK, PAYEE))).toBe(false);
        expect(offersOnlinePayment(toPublicPaymentMethods(STORED_VENMO_CASHAPP, null))).toBe(true);
        expect(offersOnlinePayment(null)).toBe(false);
    });

    it('A19. the Payment Settings validator returns only the keys sent, each checked with the setup rules', () => {
        expect(checkCoordinatorPaymentSettings({})).toEqual({ ok: true, values: {} });
        const ok = checkCoordinatorPaymentSettings({ paymentMethods: ALL_INPUT, checksPayable: PAYEE, paymentInstructions: 'Thanks!' }) as any;
        expect(ok.ok).toBe(true);
        expect(Object.keys(ok.values).sort()).toEqual(['checks_payable', 'payment_instructions', 'payment_methods']);
        expect(ok.values.payment_methods).toEqual(STORED_ALL);
        for (const bad of [
            { externalPaymentLink: 'javascript:alert(1)' }, { paymentInstructions: '<script>x</script>' },
            { paymentMethods: [{ type: 'venmo', handle: '<b>' }] }, { checksPayable: '<b>PTO</b>' }, null, [], 'x',
        ]) {
            expect(checkCoordinatorPaymentSettings(bad).ok).toBe(false);
        }
    });

    it('A20. the five-column setup contract is unchanged for a client that sends no methods', () => {
        const r = checkCoordinatorSetup({ checksPayable: 'Lincoln PTO', pickupLocation: 'Gym', deliveryTime: '4 PM', paymentInstructions: 'x', paymentLink: 'https://venmo.com/u/x' }) as any;
        expect(Object.keys(r.values).sort()).toEqual(['checks_payable', 'delivery_time', 'external_payment_link', 'payment_instructions', 'pickup_location']);
    });

    it('A21. inline form errors name the method; an untouched selection still reports what is missing', () => {
        const form = emptyPaymentMethodsForm();
        form.selected.venmo = true;
        form.selected.other = true;
        form.otherLabel = 'Pickup';
        const errors = paymentMethodsFormErrors(form);
        expect(Object.keys(errors).sort()).toEqual(['other', 'venmo']);
        expect(errors.venmo).toMatch(/Venmo username/);
        expect(errors.other).toMatch(/how to use/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('B. coordinator setup — /api/coordinator/bundle-selection', () => {
    const resolved = (over: Record<string, unknown> = {}) => ({
        id: CAMPAIGN_A, name: 'Maple Fundraiser', status: 'Active', closed_at: null,
        bundle_selection_status: 'pending', bundle_selection_at: null, bundle_selection_limit: 1,
        customer: { business_id: BIZ_A }, ...over,
    });
    const setupMock = (over: Record<string, any> = {}) => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
            'fundraiserCampaign.findFirst': resolved(),
            'fundraiserCampaign.findUnique': resolved(),
            'order.count': 0,
            'campaignBundle.findMany': [{ bundle: { id: 'b5', name: 'Fall Family (fixture)', sku: null, family_id: 'fam-1', serving_tier: 'family', business_id: BIZ_A, is_active: true } }],
            'bundle.findMany': [{ id: 'b2', name: 'Fall Family S2 (fixture)', family_id: 'fam-1', serving_tier: 'serves_2', business_id: BIZ_A, is_active: true }],
            ...over,
        },
    });
    const post = async (body: unknown) => readJson(await route('@/app/api/coordinator/bundle-selection/route').POST(request('/api/coordinator/bundle-selection', { method: 'POST', body: JSON.stringify(body) })));

    it('B1. the selected methods are validated and saved in the SAME write as the activation, for the session\'s campaign (10, 16)', async () => {
        useMock(setupMock());
        const res = await post({ familyIds: ['fam-1'], checksPayable: PAYEE, paymentInstructions: 'Thank you!', paymentMethods: ALL_INPUT });
        expect(res.status).toBe(200);
        const updates = mock.callsTo('fundraiserCampaign.update');
        expect(updates).toHaveLength(1);
        expect(updates[0].args.where).toEqual({ id: CAMPAIGN_A });
        expect(updates[0].args.data).toMatchObject({ bundle_selection_status: 'selected', payment_methods: STORED_ALL, checks_payable: PAYEE, payment_instructions: 'Thank you!' });
        // the session decides the campaign — nothing in the body can retarget the write
        expect(JSON.stringify(updates[0].args)).not.toContain(CAMPAIGN_B);
    });

    it('B2. a malformed method is refused with the reason, before any database work (11, 13)', async () => {
        for (const paymentMethods of [
            [{ type: 'venmo', handle: 'javascript:alert(1)' }], [{ type: 'cashapp', cashtag: '$123' }],
            [{ type: 'other', label: '', details: 'x' }], [{ type: 'paypal', account: 'https://evil.example/x' }], 'cash',
        ]) {
            useMock(setupMock());
            const res = await post({ familyIds: ['fam-1'], paymentMethods });
            expect(res.status).toBe(400);
            expect(typeof res.body.error).toBe('string');
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
            expect(mock.client.$transaction).not.toHaveBeenCalled();
        }
    });

    it('B3. a client that sends no methods leaves the column exactly as it was', async () => {
        useMock(setupMock());
        const res = await post({ familyIds: ['fam-1'], checksPayable: PAYEE });
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data).not.toHaveProperty('payment_methods');
    });

    it('B4. GET reloads the stored methods (re-validated) for the form (10)', async () => {
        useMock(setupMock({
            'fundraiserCampaign.findFirst': resolved({ bundle_selection_status: 'selected' }),
            'fundraiserCampaign.findUnique': {
                delivery_date: null, end_date: null, checks_payable: PAYEE, pickup_location: null, delivery_time: null,
                payment_instructions: 'Thank you!', external_payment_link: null,
                payment_methods: { v: 1, methods: [...STORED_VENMO_CASHAPP.methods, { type: 'other', label: 'x', details: 'y', link: 'javascript:1' }] },
                customer: { name: ORG },
            },
        }));
        const res = await readJson(await route('@/app/api/coordinator/bundle-selection/route').GET(request('/api/coordinator/bundle-selection')));
        expect(res.status).toBe(200);
        expect(res.body.setup.paymentMethods).toEqual(STORED_VENMO_CASHAPP);
        expect(res.body.setup.checksPayable).toBe(PAYEE);
        const select = mock.firstCall('fundraiserCampaign.findUnique')!.args;
        expect(select.where).toEqual({ id: CAMPAIGN_A });
        expect(select.select.payment_methods).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('C. Payment Settings — PUT /api/coordinator', () => {
    const settingsMock = (over: Record<string, any> = {}) => createPrismaMock({
        results: {
            'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
            'fundraiserCampaign.findFirst': { id: CAMPAIGN_A, portal_token: 'PORTAL-SECRET', customer: { business: { plan: 'PRO' } } },
            ...over,
        },
    });
    const put = async (body: unknown, headers: Record<string, string> = {}) =>
        readJson(await route('@/app/api/coordinator/route').PUT(request('/api/coordinator', { method: 'PUT', body: JSON.stringify(body), headers })));

    it('C1. saves validated values for the session\'s campaign only (10, 16)', async () => {
        useMock(settingsMock());
        const res = await put({ paymentMethods: ALL_INPUT, checksPayable: PAYEE, paymentInstructions: 'Thanks!', externalPaymentLink: '' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.where).toEqual({ id: CAMPAIGN_A });
        const upd = mock.firstCall('fundraiserCampaign.update')!.args;
        expect(upd.where).toEqual({ id: CAMPAIGN_A });
        expect(upd.data).toEqual({ payment_methods: STORED_ALL, checks_payable: PAYEE, payment_instructions: 'Thanks!', external_payment_link: null });
    });

    it('C2. no longer writes what it is sent: a script link, markup or a bad handle is refused, and nothing is written (13, 14)', async () => {
        for (const body of [
            { externalPaymentLink: 'javascript:alert(1)' }, { paymentInstructions: '<img src=x onerror=1>' },
            { paymentMethods: [{ type: 'venmo', handle: 'no' }] }, { paymentMethods: [{ type: 'other', label: '', details: '' }] }, {},
        ]) {
            useMock(settingsMock());
            const res = await put(body);
            expect(res.status).toBe(400);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
    });

    it('C3. only the keys sent are written', async () => {
        useMock(settingsMock());
        await put({ paymentInstructions: 'Only this' });
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data).toEqual({ payment_instructions: 'Only this' });
    });

    it('C4. the response no longer echoes the campaign row (portal_token stays off the wire)', async () => {
        useMock(settingsMock());
        const res = await put({ paymentMethods: [{ type: 'cash' }] });
        expect(JSON.stringify(res.body)).not.toContain('PORTAL-SECRET');
    });

    it('C5. without a coordinator session, or from another origin, nothing is written', async () => {
        useMock(settingsMock());
        (global as any).__pmu1Authed = false;
        expect((await put({ paymentMethods: [{ type: 'cash' }] })).status).toBeGreaterThanOrEqual(401);
        (global as any).__pmu1Authed = true;
        expect((await put({ paymentMethods: [{ type: 'cash' }] }, { origin: 'https://evil.example' })).status).toBeGreaterThanOrEqual(401);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('C6. describing how to pay touches no order (30)', async () => {
        useMock(settingsMock());
        await put({ paymentMethods: ALL_INPUT });
        expect(mock.calls.filter((c) => c.model === 'order')).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('D. the coordinator panel', () => {
    const portalCampaign = (id: string, over: Record<string, unknown> = {}) => ({
        id, name: 'Maple Fundraiser', status: 'Closed', closed_at: new Date('2026-10-01T00:00:00Z'), settlement_total: '0',
        end_date: new Date('2026-09-30T00:00:00Z'), delivery_date: new Date('2026-10-17T00:00:00Z'), delivery_time: null, pickup_location: null,
        external_payment_link: null, payment_instructions: 'Thanks!', checks_payable: PAYEE, payment_methods: STORED_CASH_CHECK,
        bundle_goal: 20, total_sales: '0', org_share_percent: '20.00', participant_label: 'Member', bundle_selection_status: 'selected',
        bundle_selection_limit: 1, public_token: 'public-pmu1', customer_id: 'org-pmu1', tax_status: null, tax_rate_percent: null,
        customer: { name: ORG, contact_name: 'Pat Fixture', contact_email: 'pat@example.invalid', business_id: BIZ_A,
            business: { name: 'Kitchen', display_name: 'Kitchen', slug: 'kitchen-fixture', custom_domain: null, contact_email: null, logo_url: null, plan: 'PRO', subscription_status: 'active', timezone: 'America/Chicago' } },
        orders: [], ...over,
    });

    it('D1. GET returns THIS session\'s campaign methods, re-validated (19)', async () => {
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
                'fundraiserCampaign.findFirst': (args: any) => (args?.where?.id === CAMPAIGN_A
                    ? portalCampaign(CAMPAIGN_A, { payment_methods: { v: 1, methods: [{ type: 'cash' }, { type: 'venmo', handle: 'x y' }] } })
                    : portalCampaign(CAMPAIGN_B, { payment_methods: STORED_VENMO_CASHAPP })),
                'order.findMany': [],
                'bundle.findMany': [],
            },
        }));
        const res = await readJson(await route('@/app/api/coordinator/route').GET(request('/api/coordinator')));
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.where).toEqual({ id: CAMPAIGN_A });
        expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.select).toMatchObject({ checks_payable: true, payment_methods: true });
        expect(res.body.payment_methods).toEqual({ v: 1, methods: [{ type: 'cash' }] });
        expect(res.body.checks_payable).toBe(PAYEE);
        expect(JSON.stringify(res.body)).not.toContain('MapleFixture');
    });

    it('D2. the summary shows exactly what supporters see — methods, details, instructions — and edits through Payment Settings', () => {
        const { PaymentMethodsSummary } = require('@/components/coordinator/PaymentMethodsSummary');
        const onEdit = jest.fn();
        const tree = PaymentMethodsSummary({ paymentMethods: STORED_ALL, checksPayable: PAYEE, paymentInstructions: 'Include the member name.', externalPaymentLink: null, onEdit });
        const text = textOf(tree);
        expect(text).toContain('Supporter payment methods');
        expect(text).toContain('Cash · Check · Venmo · PayPal · Cash App · Pay at pickup');
        expect(text).toContain(`Check: Make checks payable to ${PAYEE}`);
        expect(text).toContain('Venmo: @maple-fixture');
        expect(text).toContain('Include the member name.');
        expect(text).toContain(PAYMENT_DUE_GUIDANCE);
        expect(text).not.toMatch(/\bPaid\b|null|undefined/);
        findAll(tree, (el) => el.type === 'button')[0].props.onClick();
        expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it('D3. nothing configured says so, and offers to add it', () => {
        const { PaymentMethodsSummary } = require('@/components/coordinator/PaymentMethodsSummary');
        const tree = PaymentMethodsSummary({ paymentMethods: null, checksPayable: null, paymentInstructions: null, externalPaymentLink: null, onEdit: () => {} });
        expect(textOf(tree)).toContain('Not set yet');
        expect(textOf(findAll(tree, (el) => el.type === 'button')[0])).toBe('Add');
    });

    it('D4. the panel counts a selected method as payment info, and the summary is wired to the session campaign\'s own fields', () => {
        const portal = stripComments(read('app/coordinator/portal/page.tsx'));
        expect(portal).toMatch(/hasPaymentInfo = !!\(campaign\.payment_instructions \|\| campaign\.external_payment_link\s*\|\| \(toPublicPaymentMethods\(campaign\.payment_methods, campaign\.checks_payable\) \?\? \[\]\)\.length > 0\)/);
        expect(portal).toMatch(/<PaymentMethodsSummary\s+paymentMethods=\{campaign\.payment_methods \?\? null\}\s+checksPayable=\{campaign\.checks_payable \?\? null\}/);
        expect(portal).toContain('<CoordinatorPaymentFields');
        expect(portal).toContain("method: 'PUT'");
    });
});

// ═════════════════════════════════════════════════════════════════════════════
type Row = Record<string, any>;
const PAGE_SLUG = 'kitchen-a-fixture';
const pageCampaign = (id: string, businessId: string, over: Row = {}): Row => ({
    id, name: `${ORG} Fundraiser`, about_text: null, participant_label: null,
    end_date: new Date('2099-01-01T00:00:00.000Z'), delivery_date: null, pickup_location: null, delivery_time: null,
    payment_instructions: 'Thanks for supporting us!', external_payment_link: null,
    payment_methods: STORED_ALL, checks_payable: PAYEE,
    bundle_goal: 20, total_sales: '0', status: 'Active', closed_at: null, tax_status: null, tax_rate_percent: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 2,
    organization_name: ORG, customer_fundraiser_info: { checks_payable_to: 'ORG-BLOB-PAYEE' }, portal_token: 'PORTAL-SECRET',
    __business_id: businessId, ...over,
});
/** Two campaigns of tenant A (different organizations) and one of tenant B. */
const CAMPAIGN_ROWS: Row[] = [
    pageCampaign(CAMPAIGN_A, BIZ_A),
    pageCampaign(CAMPAIGN_B, BIZ_A, { organization_name: 'Other Org (fixture)', payment_methods: storedOf([{ type: 'cashapp', cashtag: '$OtherOrgOnly' }]), checks_payable: 'OTHER-ORG-PAYEE' }),
    pageCampaign('cccc3333-0000-4000-8000-0000000000c3', BIZ_B, { payment_methods: storedOf([{ type: 'venmo', handle: 'other-tenant-only' }]) }),
];
function pageMock(slugBusinessId = BIZ_A): PrismaMock {
    return createPrismaMock({
        results: {
            'business.findUnique': { id: slugBusinessId, name: 'Kitchen (fixture)', display_name: null, slug: PAGE_SLUG, logo_url: null, timezone: 'America/Chicago', custom_domain: null },
            $queryRaw: ({ sql, values }: { sql: string; values: any[] }) => {
                if (/FROM tenant_branding/.test(sql)) return [];
                if (/FROM fundraiser_campaigns fc/.test(sql)) {
                    // Honour the page's own predicate: this id AND this tenant.
                    expect(sql).toMatch(/WHERE fc\.id = \? AND c\.business_id = \?/);
                    const [id, biz] = values;
                    return CAMPAIGN_ROWS.filter((r) => r.id === id && r.__business_id === biz).map(({ __business_id, ...r }) => r);
                }
                return [];
            },
        },
    });
}
const renderPage = async (campaignId: string, slugBusinessId = BIZ_A) => {
    useMock(pageMock(slugBusinessId));
    const mod = await import('@/app/shop/[slug]/fundraiser/[fundraiserId]/page');
    try {
        const el: any = await mod.default({ params: Promise.resolve({ slug: PAGE_SLUG, fundraiserId: campaignId }) });
        return { props: el.props, notFound: false };
    } catch (e: any) {
        if (String(e?.message || e?.digest || '').includes('NEXT_HTTP_ERROR_FALLBACK;404') || String(e?.digest || '').includes('404')) return { props: null, notFound: true };
        throw e;
    }
};

describe('E. the public payload — and who can read it', () => {
    it('E1. the projection: validated methods only; the raw config and the payee column never cross (24)', () => {
        const out = toPublicCampaign({ ...pageCampaign(CAMPAIGN_A, BIZ_A), some_future_secret: 'NOPE' }) as any;
        expect(Object.keys(out).sort()).toEqual([...PUBLIC_CAMPAIGN_FIELDS].sort());
        expect(out.payment_methods).toEqual(toPublicPaymentMethods(STORED_ALL, PAYEE));
        for (const forbidden of FORBIDDEN_PUBLIC_CAMPAIGN_FIELDS) expect(out).not.toHaveProperty(forbidden);
        const json = JSON.stringify(out);
        for (const secret of ['PORTAL-SECRET', 'ORG-BLOB-PAYEE', '"v":1', '"methods"', '"handle"', '"cashtag"', 'NOPE']) expect(json).not.toContain(secret);
    });

    it('E2. a campaign that never configured methods sends null — and its payee stays private', () => {
        const out = toPublicCampaign(pageCampaign(CAMPAIGN_A, BIZ_A, { payment_methods: null })) as any;
        expect(out.payment_methods).toBeNull();
        expect(JSON.stringify(out)).not.toContain(PAYEE);
    });

    it('E3. the page serves this campaign\'s methods, from a query scoped to the slug\'s tenant (19, 24)', async () => {
        const { props } = await renderPage(CAMPAIGN_A);
        expect(props.campaign.payment_methods).toEqual(toPublicPaymentMethods(STORED_ALL, PAYEE));
        const json = JSON.stringify(props);
        expect(json).not.toContain('OtherOrgOnly');
        expect(json).not.toContain('other-tenant-only');
        expect(json).not.toContain('OTHER-ORG-PAYEE');
        expect(json).not.toContain('PORTAL-SECRET');
    });

    it('E4. another campaign of the same tenant shows ITS methods, never these (16, 17)', async () => {
        const { props } = await renderPage(CAMPAIGN_B);
        expect(props.campaign.payment_methods.map((m: any) => m.detail)).toEqual(['$OtherOrgOnly']);
        expect(JSON.stringify(props)).not.toContain('maple-fixture');
    });

    it('E5. another tenant cannot read a campaign through its own slug (18)', async () => {
        const { props, notFound } = await renderPage(CAMPAIGN_A, BIZ_B);
        expect(notFound || props === null || props?.campaign == null).toBe(true);
    });

    it('E6. the sample page shows two everyday methods and keeps the exact public allowlist', () => {
        const c = buildSampleCampaign(new Date('2026-11-02T15:00:00Z')) as any;
        expect(Object.keys(c).sort()).toEqual([...PUBLIC_CAMPAIGN_FIELDS].sort());
        expect(c.payment_methods.map((m: any) => m.type)).toEqual(['cash', 'check']);
        expect(c.payment_methods[1].detail).toBe('Make checks payable to Sample Community Organization');
        expect(JSON.stringify(c.payment_methods)).not.toMatch(/venmo|cash\.app|paypal/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
const PRIMARY = '#2f6f8f';
const BUNDLE = { id: 'b-pmu1', name: 'Harvest Bundle (fixture)', description: null, serving_tier: 'family', price: 125, image_url: null, items: [] };
const clientProps = (campaignOver: Row = {}) => ({
    business: { name: 'Kitchen (fixture)', display_name: null, slug: PAGE_SLUG, logo_url: null, branding: { primary_color: PRIMARY, logo_url: null }, bundles: [BUNDLE] },
    campaign: {
        id: CAMPAIGN_A, name: `${ORG} Fundraiser`, organization_name: ORG, about_text: null, participant_label: 'Member',
        end_date: '2026-11-20', delivery_date: '2026-12-01', pickup_location: 'Fixture Gym', delivery_time: null,
        payment_instructions: 'Please include the member\'s name.', external_payment_link: null,
        payment_methods: toPublicPaymentMethods(STORED_ALL, PAYEE),
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
function installBrowser(responseBody: any) {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { open: jest.fn(), location: { href: 'https://example.test/' }, scrollTo: jest.fn() } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: jest.fn(async () => undefined) } } });
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => responseBody }));
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
const SERVER_TOTAL = 126.25; // 125.00 + 1% food tax, as the server persists it

describe('F. the supporter page', () => {
    beforeEach(() => installBrowser({ orderId: 'ord-pmu1-000123', total: SERVER_TOTAL, paymentData: { orgName: ORG, paymentInstructions: 'Please include the member\'s name.', externalPaymentLink: null, paymentMethods: toPublicPaymentMethods(STORED_ALL, PAYEE) } }));

    it('F1. before ordering: a compact "how to pay" in the order card — configured methods, due line, instructions; no links (19, 21, 22)', () => {
        const m = mountComponent(loadClient(), clientProps());
        const s = section(m.tree, 'order');
        expect(s).not.toBeNull();
        const text = textOf(s);
        expect(text).toContain(PAYMENT_DUE_GUIDANCE);
        for (const t of ['Cash', CASH_GUIDANCE, `Make checks payable to ${PAYEE}`, '@maple-fixture', 'paypal.me/MapleFixture', '$MapleFixture', 'Pay at pickup', 'Please include the member\'s name.']) {
            expect(text).toContain(t);
        }
        expect(anchors(s)).toHaveLength(0);
        // secondary to choosing meals: it lives inside the order card, after the bundle list
        const order = textOf(m.tree);
        expect(order.indexOf('Harvest Bundle (fixture)')).toBeLessThan(order.indexOf(PAYMENT_DUE_GUIDANCE));
        expect(order.indexOf(PAYMENT_DUE_GUIDANCE)).toBeLessThan(order.indexOf('Place my order'));
    });

    it('F2. unconfigured methods do not appear (20)', () => {
        const m = mountComponent(loadClient(), clientProps({ payment_methods: toPublicPaymentMethods(STORED_CASH_CHECK, PAYEE) }));
        const text = textOf(section(m.tree, 'order'));
        expect(text).toContain('Cash');
        expect(text).toContain(`Make checks payable to ${PAYEE}`);
        expect(text).not.toMatch(/Venmo|PayPal|Cash App|Pay at pickup/);
    });

    it('F3. a legacy free-text campaign renders its own words, unchanged, with no due line stamped over them (23, 38)', () => {
        const m = mountComponent(loadClient(), clientProps({ payment_methods: null, payment_instructions: 'cash or check at pick up' }));
        const text = textOf(section(m.tree, 'order'));
        expect(text).toContain('cash or check at pick up');
        expect(text).not.toContain(PAYMENT_DUE_GUIDANCE);
        expect(text).not.toMatch(/Venmo|Check\b(?! at)/);
    });

    it('F4. nothing configured: never a crash or an empty section — the due line and the contact fallback (37, 40)', () => {
        const m = mountComponent(loadClient(), clientProps({ payment_methods: null, payment_instructions: null, external_payment_link: null }));
        const text = textOf(section(m.tree, 'order'));
        expect(text).toContain(PAYMENT_DUE_GUIDANCE);
        expect(text).toContain(PAYMENT_CONTACT_FALLBACK);
    });

    it('F5. no "null" or "undefined" ever renders, whatever is missing (39)', () => {
        for (const over of [{ payment_methods: null, payment_instructions: null }, { payment_methods: [] }, { payment_methods: toPublicPaymentMethods(STORED_CASH_CHECK, null) }, { payment_methods: [{ type: 'cash', label: 'Cash', detail: null, href: null, actionLabel: null }] }]) {
            const m = mountComponent(loadClient(), clientProps(over));
            expect(textOf(section(m.tree, 'order'))).not.toMatch(/\bnull\b|\bundefined\b/);
        }
    });

    it('F6. after ordering: the same methods with "Open …" links, the server\'s amount due, and never "Paid" (25, 26, 27)', async () => {
        const m = mountComponent(loadClient(), clientProps());
        await addAndSubmit(m);
        const s = section(m.tree, 'confirmation');
        expect(s).not.toBeNull();
        const text = textOf(s);
        expect(text).toContain('One last step — pay your coordinator');
        expect(text).toContain(`Amount due: $${SERVER_TOTAL.toFixed(2)} for order #000123`);
        expect(text).toContain(PAYMENT_DUE_GUIDANCE);
        for (const t of ['@maple-fixture', `Make checks payable to ${PAYEE}`, '$MapleFixture', 'Pay at pickup', 'Please include the member\'s name.']) expect(text).toContain(t);
        expect(anchors(s).map((a) => [textOf(a.props.children), a.props.href])).toEqual([
            ['Open Venmo ↗', 'https://venmo.com/u/maple-fixture'],
            ['Open PayPal ↗', 'https://paypal.me/MapleFixture'],
            ['Open Cash App ↗', 'https://cash.app/$MapleFixture'],
            ['Open link ↗', 'https://pay.example.test/maple'],
        ]);
        // No paid STATUS and no "pay now" claim. (The card's own note truthfully says opening an
        // app "doesn't mark your order paid" — a denial, which is the point.)
        expect(text).not.toMatch(/\bPaid\b/);
        expect(text).not.toMatch(/pay now/i);
        expect(text).toContain('doesn’t mark your order paid');
    });

    it('F7. the confirmation uses the page\'s own methods when the server response carries none (an older server)', async () => {
        installBrowser({ orderId: 'ord-pmu1-000124', total: SERVER_TOTAL, paymentData: { orgName: ORG } });
        const m = mountComponent(loadClient(), clientProps({ payment_methods: toPublicPaymentMethods(STORED_CASH_CHECK, PAYEE) }));
        await addAndSubmit(m);
        const text = textOf(section(m.tree, 'confirmation'));
        expect(text).toContain(`Make checks payable to ${PAYEE}`);
        expect(text).not.toContain('Venmo');
    });

    it('F8. payment links are plain anchors: new tab, no opener, a label naming the destination, and no click handler (28, 44)', async () => {
        const m = mountComponent(loadClient(), clientProps());
        await addAndSubmit(m);
        const fetchesAfterOrder = fetchMock.mock.calls.length;
        for (const a of anchors(section(m.tree, 'confirmation'))) {
            expect(a.props.target).toBe('_blank');
            expect(a.props.rel).toBe('noopener noreferrer');
            expect(a.props['aria-label']).toMatch(/^Open .+ \(opens in a new tab\)$/);
            expect(a.props.onClick).toBeUndefined();
            expect(a.props.style.minHeight).toBe(44);
        }
        expect(fetchMock.mock.calls.length).toBe(fetchesAfterOrder);
        expect(fetchesAfterOrder).toBe(1);   // the order itself — and nothing else, ever
    });

    it('F9. the order body, the total and the tax are exactly what they were without payment methods (32–36)', async () => {
        const withMethods = mountComponent(loadClient(), clientProps());
        await addAndSubmit(withMethods);
        const bodyWith = JSON.parse(fetchMock.mock.calls[0][1].body);

        installBrowser({ orderId: 'ord-pmu1-000125', total: SERVER_TOTAL, paymentData: { orgName: ORG } });
        const without = mountComponent(loadClient(), clientProps({ payment_methods: null, payment_instructions: null }));
        const add = findAll(without.tree, (el) => el.type === 'button' && el.props['aria-pressed'] === false)[0];
        add.props.onClick(); without.render();
        const heading = (t: any) => textOf(findAll(t, (el) => el.type === 'b' && /^Your order/.test(textOf(el.props.children)))[0]);
        expect(heading(without.tree)).toBe('Your order · $126.25');
        await addAndSubmit(mountComponent(loadClient(), clientProps({ payment_methods: null, payment_instructions: null })));
        const bodyWithout = JSON.parse(fetchMock.mock.calls[0][1].body);

        const { submissionKey: _a, ...a } = bodyWith;
        const { submissionKey: _b, ...b } = bodyWithout;
        expect(a).toEqual(b);
        expect(JSON.stringify(bodyWith)).not.toMatch(/payment|venmo|paid/i);
        expect(computeSupporterOrderTax({ subtotal: 125, snapshot: { status: 'TAXABLE', ratePercent: '1.00' } as any }).taxAmount).toBe(1.25);
    });

    it('F10. phones: the sections can never push past a 360px screen; long instructions and handles wrap (41, 45)', async () => {
        const long = 'Please bring exact change to the pickup table and include your member\'s full name on every envelope so we can match it to your order without any trouble at all. '.repeat(3);
        const m = mountComponent(loadClient(), clientProps({ payment_instructions: long.trim().slice(0, 900) }));
        const s = section(m.tree, 'order');
        expect(s.props.style).toMatchObject({ overflowWrap: 'anywhere', minWidth: 0 });
        walk(s, (el) => { if (el.props?.style?.width) expect(el.props.style.width).toBe('100%'); });
        await addAndSubmit(m);
        const c = section(m.tree, 'confirmation');
        expect(c.props.style).toMatchObject({ overflowWrap: 'anywhere', minWidth: 0 });
        for (const a of anchors(c)) expect(a.props.style).toMatchObject({ width: '100%', boxSizing: 'border-box' });
        const pre = findAll(c, (el) => el.type === 'p' && el.props.style?.whiteSpace === 'pre-wrap');
        expect(pre.length).toBeGreaterThan(0);
        for (const p of pre) expect(p.props.style.overflowWrap).toBe('anywhere');
    });

    it('F11. the order-conversion experience is untouched: bundle cards, the detail and the share card still render', () => {
        const m = mountComponent(loadClient(), clientProps());
        expect(findAll(m.tree, (el) => el.type === 'button' && el.props.className === 'fr-bundle-open').length).toBeGreaterThan(0);
        expect(findAll(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Share this fundraiser').length).toBe(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('G. the coordinator form', () => {
    const { CoordinatorPaymentFields, CoordinatorSetupFields } = require('@/components/coordinator/CoordinatorSetupFields');
    const values = (form = emptyPaymentMethodsForm(), over: Row = {}) => ({ paymentMethods: form, checksPayable: '', paymentInstructions: '', paymentLink: '', ...over });
    const render = (props: Row) => CoordinatorPaymentFields({ onChange: () => {}, ...props });

    it('G1. one real checkbox per method, each inside its own visible label, reachable by keyboard (42, 43)', () => {
        const tree = render({ values: values() });
        const boxes = findAll(tree, (el) => el.type === 'input' && el.props.type === 'checkbox');
        // Superseded pin (COORDINATOR-BANK-ACH-LINK-1): seven methods, Bank / ACH before Other.
        expect(boxes).toHaveLength(7);
        const labels = findAll(tree, (el) => el.type === 'label' && findAll(el, (x) => x.type === 'input' && x.props.type === 'checkbox').length === 1);
        expect(labels.map((l) => textOf(l))).toEqual(['Cash', 'Check', 'Venmo', 'PayPal', 'Cash App', 'Bank / ACH', 'Other']);
        for (const b of boxes) { expect(b.props.tabIndex).toBeUndefined(); expect(b.props.disabled).toBeUndefined(); }
        expect(findAll(tree, (el) => el.type === 'fieldset')).toHaveLength(1);
        expect(textOf(findAll(tree, (el) => el.type === 'legend')[0])).toBe('How should supporters pay you?');
        expect(stripComments(read('components/coordinator/CoordinatorSetupFields.tsx'))).not.toMatch(/type=["']radio["']/);
    });

    it('G2. ticking a box selects that method (1–6)', () => {
        for (const type of PAYMENT_METHOD_TYPES) {
            const onChange = jest.fn();
            const tree = render({ values: values(), onChange });
            const box = findAll(tree, (el) => el.type === 'input' && el.props.type === 'checkbox')[PAYMENT_METHOD_TYPES.indexOf(type)];
            box.props.onChange({ target: { checked: true } });
            expect(onChange.mock.calls[0][0].paymentMethods.selected[type]).toBe(true);
        }
    });

    it('G3. a method\'s own fields appear only while it is selected, each with a real label (8, 42)', () => {
        expect(findAll(render({ values: values() }), (el) => el.type === 'input' && el.props.type !== 'checkbox' && el.props.type !== 'url')).toHaveLength(0);
        const form = emptyPaymentMethodsForm();
        for (const t of PAYMENT_METHOD_TYPES) form.selected[t] = true;
        const tree = render({ values: values(form) });
        const fields = findAll(tree, (el) => (el.type === 'input' && el.props.type !== 'checkbox') || el.type === 'textarea');
        const ids = fields.map((f) => f.props.id);
        // COORDINATOR-BANK-ACH-LINK-1 adds the bank link and its optional note, between Cash App and Other.
        expect(ids).toEqual(['setup-check-payee', 'setup-venmo-handle', 'setup-paypal-account', 'setup-cashapp-tag', 'setup-bank_ach-link', 'setup-bank_ach-note', 'setup-other-label', 'setup-other-details', 'setup-other-link', 'setup-instructions']);
        for (const id of ids) expect(findAll(tree, (el) => el.type === 'label' && el.props.htmlFor === id)).toHaveLength(1);
        expect(textOf(tree)).toContain(`Supporters see: “${CASH_GUIDANCE}”`);
    });

    it('G4. a problem is shown beside its field, announced, and tied to it; empty fields complain only after a refused save', () => {
        const form = emptyPaymentMethodsForm();
        form.selected.venmo = true;
        expect(findAll(render({ values: values(form) }), (el) => el.props && el.props.role === 'alert')).toHaveLength(0);
        const tree = render({ values: values({ ...form, venmoHandle: 'no' }) });
        const alert = findAll(tree, (el) => el.props && el.props.role === 'alert')[0];
        expect(textOf(alert)).toMatch(/Venmo username/);
        const input = findAll(tree, (el) => el.type === 'input' && el.props.id === 'setup-venmo-handle')[0];
        expect(input.props['aria-invalid']).toBe(true);
        expect(input.props['aria-describedby']).toBe(alert.props.id);
        expect(findAll(render({ values: values(form), showAllErrors: true }), (el) => el.props && el.props.role === 'alert')).toHaveLength(1);
    });

    it('G5. the general instructions keep the house prompt and a non-persisted example; the legacy link field is only for campaigns that had one', () => {
        const tree = render({ values: values() });
        const ta = findAll(tree, (el) => el.type === 'textarea' && el.props.id === 'setup-instructions')[0];
        expect(ta.props.placeholder).toBe('Please add your specific payment instructions here');
        expect(textOf(tree)).toContain('Example: Please pay your coordinator within three days. Checks should be made payable to Lincoln PTO.');
        expect(textOf(render({ values: values(undefined, { paymentInstructions: 'x' }) }))).not.toContain('Example:');
        expect(findAll(tree, (el) => el.type === 'input' && el.props.id === 'setup-link')).toHaveLength(0);
        expect(findAll(render({ values: values(undefined, { paymentLink: 'https://x.example' }), showPaymentLink: true }), (el) => el.type === 'input' && el.props.id === 'setup-link')).toHaveLength(1);
    });

    it('G6. the form says plainly what supporters are told, and that a link never marks an order paid', () => {
        const text = textOf(render({ values: values() }));
        expect(text).toContain(PAYMENT_DUE_GUIDANCE);
        expect(text).toMatch(/does not mark an order paid/);
        // Superseded pin: "ACH" left this list when the owner approved the Bank / ACH payment-page link
        // (COORDINATOR-BANK-ACH-LINK-1). Everything FreezerIQ still does not offer stays forbidden.
        expect(text).not.toMatch(/credit card|Apple Pay|Google Pay|Zelle|Square/i);
    });

    it('G7. setup carries the payment checklist; the tenant\'s locked facts are untouched', () => {
        const tree = CoordinatorSetupFields({ values: { ...values(), pickupLocation: '', deliveryTime: '' }, locked: { organizationName: ORG, deliveryDate: null, orderDeadline: null }, onChange: () => {} });
        const text = textOf(tree);
        expect(text).toContain('How should supporters pay you?');
        expect(text).toContain('Pickup / delivery time');
        expect(text).toContain(ORG);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('H. paid stays the coordinator\'s explicit mark — nothing else', () => {
    const files = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
        const p = `${dir}/${f}`;
        return statSync(join(ROOT, p)).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });

    it('H1. submitting an order cannot mark it paid: the order route never writes paid_at or paid_by (29)', () => {
        const orderRoute = stripComments(read('app/api/public/order/route.ts'));
        expect(orderRoute).not.toMatch(/paid_at|paid_by/);
    });

    it('H2. the only path that writes an order\'s paid state is still the coordinator\'s mark, and nothing this phase added goes near it (31)', () => {
        const users = [...files('app'), ...files('lib'), ...files('components')]
            .filter((p) => p !== 'lib/supporterPayment.ts' && /paymentTransitionData\(/.test(stripComments(read(p))));
        expect(users).toEqual(['app/api/coordinator/route.ts']);
        expect(Object.keys(paymentTransitionData('mark_paid', { now: new Date(), actor: 'coordinator:s' })).sort()).toEqual(['paid_at', 'paid_by']);
        // the Payment Settings save, the setup route, the page and the email name no paid state at all
        const coord = stripComments(read('app/api/coordinator/route.ts'));
        const put = coord.slice(coord.indexOf('export async function PUT'), coord.indexOf('export async function DELETE'));
        expect(put).not.toMatch(/paid_at|paid_by|\border\./);
        for (const p of ['app/api/coordinator/bundle-selection/route.ts', 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx', 'lib/publicFundraiserPayload.ts', 'lib/email.ts']) {
            expect(stripComments(read(p))).not.toMatch(/paid_at|paid_by/);
        }
    });

    it('H3. the payment-method code can neither read nor write an order, and never says "paid" to a supporter (27, 28, 30)', () => {
        for (const p of ['lib/supporterPaymentMethods.ts', 'components/fundraiser/SupporterPaymentSection.tsx', 'components/coordinator/PaymentMethodsSummary.tsx']) {
            const code = stripComments(read(p));
            expect(code).not.toMatch(/paid_at|paid_by|prisma|fetch\(|\.order\b/);
            expect(code).not.toMatch(/Pay now/i);
        }
        expect(stripComments(read('components/fundraiser/SupporterPaymentSection.tsx'))).not.toMatch(/onClick/);
    });

    it('H4. the explicit mark still works exactly as before (31)', async () => {
        useMock(createPrismaMock({
            results: {
                'coordinatorSession.findUnique': sessionFor(CAMPAIGN_A),
                'order.updateMany': { count: 1 },
            },
        }));
        const res = await readJson(await route('@/app/api/coordinator/route').PATCH(request('/api/coordinator', { method: 'PATCH', body: JSON.stringify({ action: 'mark_paid', orderId: 'ord-pmu1-1' }) })));
        expect(res.status).toBe(200);
        expect(res.body.changed).toBe(true);
        const upd = mock.firstCall('order.updateMany')!.args;
        expect(upd.where).toMatchObject({ id: 'ord-pmu1-1', campaign_id: CAMPAIGN_A, source: 'fundraiser', canceled_at: null, paid_at: null });
        expect(Object.keys(upd.data).sort()).toEqual(['paid_at', 'paid_by']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('I. schema and migration', () => {
    it('I1. one additive, nullable JSONB column — no default, no backfill, no other change', () => {
        const sql = read('prisma/migrations/20261102120000_coordinator_payment_methods/migration.sql');
        const statements = sql.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trim().startsWith('--'));
        expect(statements).toEqual(['ALTER TABLE "fundraiser_campaigns" ADD COLUMN     "payment_methods" JSONB;']);
        expect(sql).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDROP\b|DEFAULT|NOT NULL/);
        expect(read('prisma/schema.prisma')).toMatch(/\n\s+payment_methods\s+Json\?\r?\n/);
    });

    it('I2. the legacy payment fields are all still there', () => {
        const schema = read('prisma/schema.prisma');
        for (const f of ['payment_instructions  String?', 'external_payment_link String?', 'checks_payable        String?']) expect(schema).toContain(f);
    });
});
