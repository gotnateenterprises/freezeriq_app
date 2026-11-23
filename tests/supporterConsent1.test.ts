/**
 * SUPPORTER-CONSENT-1 — explicit, durable, per-organization permission for future fundraiser EMAIL
 * and SMS, captured on the supporter order page with a successfully placed order.
 *
 * The REAL order page (FundraiserClient, driven without a DOM through tests/helpers/hookRuntime),
 * the REAL public order route (against the recording Prisma double, with a transaction that really
 * discards its writes on failure), and the REAL consent authority (against an in-memory table) run.
 * Fictional names, addresses and numbers only; the repository is public.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { mountComponent, findAll, textOf, walk } from './helpers/hookRuntime';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    EMAIL_CONSENT_NEEDS_EMAIL_MESSAGE, SMS_CONSENT_NEEDS_PHONE_MESSAGE, SUPPORTER_CONSENT_OPTIONAL_NOTE,
    SUPPORTER_EMAIL_CONSENT_VERSION, SUPPORTER_SMS_CONSENT_VERSION, buildSupporterConsentRows,
    normalizeConsentEmail, normalizeConsentPhone, planSupporterConsent, readSupporterConsentIntent,
    supporterEmailConsentText, supporterSmsConsentText,
} from '@/lib/supporterConsentText';
import { currentlyGranted, loadSupporterEmailConsent, loadSupporterSmsConsent } from '@/lib/supporterConsent';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__sc1Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => null) }));
jest.mock('@/lib/email', () => ({
    sendLeadNotificationEmail: jest.fn(async () => undefined),
    sendOrderConfirmationEmail: jest.fn(async () => undefined),
    sendFundraiserCoordinatorNotification: jest.fn(async () => undefined),
    getTenantSender: async () => ({ from: 'tenant@example.invalid' }),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// ── fictional world ─────────────────────────────────────────────────────────────────────────────
const TENANT_A = 'biz-sc1-aaaa';
const TENANT_B = 'biz-sc1-bbbb';
const ORG_A = 'org-sc1-riverside';
const ORG_B = 'org-sc1-lakeview';
const ORG_A_NAME = 'Riverside Boosters (fixture)';
const BUNDLE = 'bundle-sc1';
const SUPPORTER = { firstName: 'Dana', lastName: 'Fields', email: '  Dana.Fields@Example.TEST ', phone: '(309) 555-1111' };
const DANA = 'dana.fields@example.test';
const DANA_SMS = '+13095551111';

const campaignRow = (id: string, over: { businessId?: string; orgId?: string; orgName?: string } = {}) => ({
    id, name: `${over.orgName ?? ORG_A_NAME} Fundraiser`, status: 'Active', closed_at: null, end_date: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 2, payment_instructions: 'Pay the coordinator',
    external_payment_link: null, profit_percentage: '20',
    customer_id: over.orgId ?? ORG_A,
    customer: { id: over.orgId ?? ORG_A, business_id: over.businessId ?? TENANT_A, name: over.orgName ?? ORG_A_NAME, contact_email: 'coord@example.invalid', business: { timezone: 'America/Chicago' } },
});

let mock: PrismaMock;
let committed: any[];
/** A transaction that, like Postgres, keeps its writes only when the whole callback succeeds. */
function useWorld(extra: Record<string, any> = {}, fail: 'order' | 'commit' | null = null) {
    mock = createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A, slug: 'tenant-a', timezone: 'America/Chicago', name: 'Example Kitchen' },
            'bundle.findMany': (args: any) => (args?.where?.is_active === false ? [] : [{ id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT_A }]),
            'bundle.findUnique': { id: BUNDLE, name: 'Family Friendly', price: '62.50', serving_tier: 'serves_5', is_active: true, business_id: TENANT_A },
            'campaignBundle.findMany': [],
            'customer.findFirst': null,
            'order.create': (args: any) => ({ id: 'order-sc1-1', ...args?.data, items: [] }),
            'order.findFirst': null,
            'fundraiserCampaign.findUnique': campaignRow('camp-sc1'),
            $queryRaw: [],
            ...extra,
        },
    });
    committed = [];
    mock.client.$transaction = jest.fn(async (fn: any) => {
        const staged: any[] = [];
        const tx = {
            ...mock.client,
            supporterContactConsent: { ...mock.client.supporterContactConsent, createMany: jest.fn(async ({ data }: any) => { staged.push(...data); return { count: data.length }; }) },
            order: fail === 'order' ? { ...mock.client.order, create: jest.fn(async () => { throw new Error('insert failed'); }) } : mock.client.order,
        };
        const result = await fn(tx);
        if (fail === 'commit') throw new Error('could not serialize access due to concurrent update');
        committed.push(...staged);
        return result;
    });
    (global as any).__sc1Prisma = mock.client;
}
const postOrder = async (body: unknown) => {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', body)));
};
const orderBody = (consent?: unknown, over: Record<string, unknown> = {}) => ({
    slug: 'tenant-a', campaignId: 'camp-sc1', customer: { ...SUPPORTER }, items: [{ bundleId: BUNDLE, quantity: 1 }],
    ...(consent === undefined ? {} : { marketingConsent: consent }), ...over,
});

beforeAll(() => { for (const k of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, k).mockImplementation(() => undefined); });
beforeEach(() => { jest.resetModules(); useWorld(); });

// ── the order page (no DOM) ─────────────────────────────────────────────────────────────────────
const clientProps = () => ({
    business: { name: 'Example Kitchen', display_name: null, slug: 'tenant-a', logo_url: null, branding: { primary_color: '#2f7d5b', logo_url: null }, bundles: [{ id: BUNDLE, name: 'Family Friendly', description: null, serving_tier: 'family', price: 62.5, image_url: null, items: [] }] },
    campaign: {
        id: 'camp-sc1', name: `${ORG_A_NAME} Fundraiser`, organization_name: ORG_A_NAME, about_text: null, participant_label: 'Swimmer',
        end_date: '2026-12-20', delivery_date: '2027-01-05', pickup_location: 'Gym', delivery_time: null,
        payment_instructions: 'Pay the coordinator', external_payment_link: null, tax_status: null, tax_rate_percent: null,
        customer_fundraiser_info: { delivery_date: null, delivery_time: null, pickup_location: null },
    },
    bundleProgress: { totalBundlesSold: 0, bundleGoal: 20 },
    orderMode: { allowed: true, mode: 'all' },
    slug: 'tenant-a', fundraiserId: 'camp-sc1', shareUrl: null, deadline: null,
});
let fetchMock: jest.Mock;
function browser() {
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { open: jest.fn(), location: { href: 'https://example.test/', hostname: 'example.test' }, scrollTo: jest.fn() } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: jest.fn(async () => undefined) } } });
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ orderId: 'order-sc1-1', total: 62.5, paymentData: { orgName: ORG_A_NAME } }) }));
    (globalThis as any).fetch = fetchMock;
}
// beforeEach resets the module registry, so the page and the hook runtime are loaded fresh TOGETHER.
const mountPage = (): ReturnType<typeof mountComponent> => {
    browser();
    const runtime = require('./helpers/hookRuntime');
    return runtime.mountComponent(require('@/app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient').default, clientProps());
};
const input = (tree: any, label: string) => findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === label)[0];
const EMAIL_BOX = 'Email updates about future fundraisers';
const SMS_BOX = 'Text messages about future fundraisers';
async function fillAndOrder(m: ReturnType<typeof mountComponent>, phone = SUPPORTER.phone, tick: { email?: boolean; sms?: boolean } = {}) {
    const add = findAll(m.tree, (el) => el.type === 'button' && /^Add /.test(String(el.props['aria-label'] ?? '')))[0];
    add.props.onClick({ stopPropagation: () => undefined }); m.render();
    for (const [label, value] of [['First Name', 'Dana'], ['Last Name', 'Fields'], ['Email', 'dana.fields@example.test'], ['Phone Number', phone]]) {
        input(m.tree, label).props.onChange({ target: { value } }); m.render();
    }
    if (tick.email) { input(m.tree, EMAIL_BOX).props.onChange({ target: { checked: true } }); m.render(); }
    if (tick.sms) { input(m.tree, SMS_BOX).props.onChange({ target: { checked: true } }); m.render(); }
    const place = findAll(m.tree, (el) => el.type === 'button' && /^Place my order/.test(textOf(el.props.children)))[0];
    await place.props.onClick(); m.render();
}
const lastBody = () => JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('1–3 · the order page: two separate, optional, unticked choices', () => {
    it('1 · 2 · both boxes start unchecked, each names the organization, under the email and phone fields', () => {
        const m = mountPage();
        const email = input(m.tree, EMAIL_BOX);
        const sms = input(m.tree, SMS_BOX);
        expect(email.props.type).toBe('checkbox');
        expect(sms.props.type).toBe('checkbox');
        expect(email.props.checked).toBe(false);
        expect(sms.props.checked).toBe(false);
        expect(email.props.required).toBeUndefined();
        expect(sms.props.required).toBeUndefined();
        const text = textOf(m.tree);
        expect(text).toContain(`Yes, I’d like to receive occasional email updates about future fundraisers from ${ORG_A_NAME}. I can unsubscribe at any time.`);
        expect(text).toContain(`Yes, I agree to receive occasional text messages about future fundraisers from ${ORG_A_NAME} at the mobile number I provided. Consent is not required to make a purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.`);
        expect(text).toContain(SUPPORTER_CONSENT_OPTIONAL_NOTE);
        expect(text).not.toMatch(/do not sell|never sell/i);
        // Order on the page: email field, phone field, then the email box, then the SMS box — before ordering.
        const order: string[] = [];
        walk(m.tree, (el) => { if (el.type === 'input' && el.props['aria-label']) order.push(el.props['aria-label']); if (el.type === 'button' && /^Place my order/.test(textOf(el.props.children))) order.push('PLACE'); });
        const at = (k: string) => order.indexOf(k);
        expect(at('Email')).toBeLessThan(at('Phone Number'));
        expect(at('Phone Number')).toBeLessThan(at(EMAIL_BOX));
        expect(at(EMAIL_BOX)).toBeLessThan(at(SMS_BOX));
        expect(at(SMS_BOX)).toBeLessThan(at('PLACE'));
    });

    it('3 · an order with neither box ticked is sent, saying neither', async () => {
        const m = mountPage();
        await fillAndOrder(m);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(lastBody().marketingConsent).toEqual({ email: false, sms: false });
    });

    it('ticking the boxes sends only the two booleans — never wording or a version', async () => {
        const m = mountPage();
        await fillAndOrder(m, SUPPORTER.phone, { email: true, sms: true });
        expect(lastBody().marketingConsent).toEqual({ email: true, sms: true });
        expect(JSON.stringify(lastBody())).not.toMatch(/supporter-future|Reply STOP/);
    });

    it('17 · the SMS box with no usable mobile number stops the order with a clear message (nothing is sent)', async () => {
        const m = mountPage();
        await fillAndOrder(m, '555-0100', { sms: true });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(textOf(m.tree)).toContain(SMS_CONSENT_NEEDS_PHONE_MESSAGE);
        // The same short number is fine when the SMS box is NOT ticked — phone rules are unchanged.
        const m2 = mountPage();
        await fillAndOrder(m2, '555-0100');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('3–5, 8–11, 17–19 · the order route records permission only with a committed order', () => {
    it('3 · neither box → the order succeeds and no permission is recorded', async () => {
        for (const consent of [undefined, { email: false, sms: false }]) {
            useWorld();
            const res = await postOrder(orderBody(consent));
            expect(res.status).toBe(200);
            expect(committed).toEqual([]);
        }
    });

    it('4 · 8 · 10 · email only → ONE email row: this organization, tenant, campaign, order and supporter; the normalized address; version, wording, source', async () => {
        const res = await postOrder(orderBody({ email: true, sms: false }));
        expect(res.status).toBe(200);
        expect(committed).toEqual([{
            business_id: TENANT_A, customer_id: ORG_A, campaign_id: 'camp-sc1', order_id: 'order-sc1-1', supporter_customer_id: 'customer-generated-id',
            channel: 'email', action: 'granted', destination: DANA,
            consent_version: 'supporter-future-email-v1', disclosure_text: supporterEmailConsentText(ORG_A_NAME), source: 'supporter_order_checkout',
        }]);
        // Timestamp: set by the database default (created_at DEFAULT CURRENT_TIMESTAMP) at commit.
        expect(R('prisma/schema.prisma')).toMatch(/model SupporterContactConsent \{[\s\S]*?created_at\s+DateTime\s+@default\(now\(\)\)/);
    });

    it('5 · 9 · 18 · SMS only → ONE sms row with the +1 number; email stays unrecorded', async () => {
        const res = await postOrder(orderBody({ email: false, sms: true }));
        expect(res.status).toBe(200);
        expect(committed).toHaveLength(1);
        expect(committed[0]).toMatchObject({ channel: 'sms', destination: DANA_SMS, consent_version: 'supporter-future-sms-v1', disclosure_text: supporterSmsConsentText(ORG_A_NAME) });
        expect(committed.some((r) => r.channel === 'email')).toBe(false);
    });

    it('D · 18 · both boxes → two independent rows, one per channel', async () => {
        await postOrder(orderBody({ email: true, sms: true }));
        expect(committed.map((r) => [r.channel, r.destination])).toEqual([['email', DANA], ['sms', DANA_SMS]]);
    });

    it('6 · the permission is for the CAMPAIGN\'s organization in the campaign\'s tenant', async () => {
        useWorld({ 'fundraiserCampaign.findUnique': campaignRow('camp-sc1', { orgId: ORG_B, orgName: 'Lakeview PTA (fixture)' }) });
        await postOrder(orderBody({ email: true }));
        expect(committed[0]).toMatchObject({ business_id: TENANT_A, customer_id: ORG_B, disclosure_text: supporterEmailConsentText('Lakeview PTA (fixture)') });
    });

    it('11 · a failed order records nothing — an insert failure or a failed commit discards the permission with the order', async () => {
        for (const fail of ['order', 'commit'] as const) {
            useWorld({}, fail);
            const res = await postOrder(orderBody({ email: true, sms: true }));
            expect(res.status).toBe(500);
            expect(res.body.success).toBeUndefined();
            expect(committed).toEqual([]);
        }
        // …and it is written through the transaction, never the root client.
        useWorld();
        await postOrder(orderBody({ email: true }));
        expect(mock.callsTo('supporterContactConsent.createMany')).toHaveLength(0);
        expect(committed).toHaveLength(1);
    });

    it('11 · an order refused before the transaction (closed / unknown campaign) records nothing', async () => {
        useWorld({ 'fundraiserCampaign.findUnique': campaignRow('camp-sc1', { businessId: TENANT_B }) });
        const res = await postOrder(orderBody({ email: true }));
        expect(res.status).toBe(404);
        expect(committed).toEqual([]);
    });

    it('17 · the SMS box with an unusable number → 400 before anything is written; same for the email box', async () => {
        for (const [phone, email, consent, code] of [
            ['555-0100', SUPPORTER.email, { sms: true }, 'SMS_CONSENT_NEEDS_PHONE'],
            ['+44 20 7946 0958', SUPPORTER.email, { sms: true }, 'SMS_CONSENT_NEEDS_PHONE'],
            [SUPPORTER.phone, 'dana-at-example', { email: true }, 'EMAIL_CONSENT_NEEDS_EMAIL'],
        ] as const) {
            useWorld();
            const res = await postOrder(orderBody(consent, { customer: { ...SUPPORTER, phone, email } }));
            expect(res.status).toBe(400);
            expect(res.body.code).toBe(code);
            expect(mock.client.$transaction).not.toHaveBeenCalled();
            expect(mock.callsTo('order.create')).toHaveLength(0);
            expect(committed).toEqual([]);
        }
        expect(SMS_CONSENT_NEEDS_PHONE_MESSAGE).toMatch(/uncheck the text message box/);
        expect(EMAIL_CONSENT_NEEDS_EMAIL_MESSAGE).toMatch(/uncheck the email updates box/);
    });

    it('19 · the client cannot choose the wording or version: only a literal true counts, and the server writes its own', async () => {
        await postOrder(orderBody({ email: 'yes', sms: 1, version: 'supporter-future-email-v99' }));
        expect(committed).toEqual([]);
        useWorld();
        await postOrder(orderBody({ email: true, consent_version: 'supporter-future-email-v99', disclosure_text: 'I agree to everything', source: 'admin_import' }));
        expect(committed[0]).toMatchObject({ consent_version: SUPPORTER_EMAIL_CONSENT_VERSION, disclosure_text: supporterEmailConsentText(ORG_A_NAME), source: 'supporter_order_checkout' });
        expect(readSupporterConsentIntent(['email'])).toEqual({ email: false, sms: false });
        expect(readSupporterConsentIntent(null)).toEqual({ email: false, sms: false });
    });

    it('a storefront order (no fundraiser) records nothing even if a client sends the flags', async () => {
        useWorld({ 'fundraiserCampaign.findUnique': null });
        const res = await postOrder(orderBody({ email: true }, { campaignId: undefined }));
        expect(res.status).toBe(200);
        expect(committed).toEqual([]);
    });

    it('a replayed submission (same idempotency key) records nothing new', async () => {
        const key = 'a5a5a5a5-0000-4000-8000-0000000000a1';
        useWorld({ 'order.findFirst': { id: 'order-sc1-1', submission_fingerprint: null, total_amount: 62.5, tax_amount: 0, items: [] } });
        const res = await postOrder(orderBody({ email: true }, { submissionKey: key }));
        expect([200, 409]).toContain(res.status);
        expect(committed).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// the authority, against an in-memory supporter_contact_consents + marketing_preferences
let clock = 0;
const ev = (over: Partial<{ business_id: string; customer_id: string; channel: 'email' | 'sms'; destination: string; action: 'granted' | 'revoked' }>) => ({
    business_id: TENANT_A, customer_id: ORG_A, channel: 'email' as const, destination: DANA, action: 'granted' as const,
    created_at: new Date(Date.UTC(2026, 10, 1) + (clock++) * 60_000), id: `ev-${clock}`, ...over,
});
function consentDb(rows: any[], prefs: any[] = []) {
    const reads: any[] = [];
    return {
        reads,
        supporterContactConsent: {
            findMany: async (args: any) => {
                reads.push(args);
                return rows.filter((r) => r.business_id === args.where.business_id && r.customer_id === args.where.customer_id && r.channel === args.where.channel)
                    .sort((a, b) => +a.created_at - +b.created_at)
                    .map(({ destination, action, created_at }) => ({ destination, action, created_at }));
            },
        },
        marketingPreference: {
            findMany: async (args: any) => prefs.filter((p) => p.business_id === args.where.business_id && p.scope === args.where.scope
                && p.status === args.where.status && args.where.normalized_email.in.includes(p.normalized_email)),
        },
    };
}
const scopeA = { businessId: TENANT_A, organizationCustomerId: ORG_A };

describe('6–7, 12–16, 20 · the consent authority', () => {
    it('6 · 7 · 20 · scoped to ONE organization inside ONE tenant: Organization A\'s permission never authorizes B, nor another tenant', async () => {
        const db = consentDb([ev({}), ev({ customer_id: ORG_B, destination: 'other@example.test' }), ev({ business_id: TENANT_B, destination: 'tenantb@example.test' })]);
        expect([...await loadSupporterEmailConsent(scopeA, db)]).toEqual([DANA]);
        expect([...await loadSupporterEmailConsent({ businessId: TENANT_A, organizationCustomerId: ORG_B }, db)]).toEqual(['other@example.test']);
        expect([...await loadSupporterEmailConsent({ businessId: TENANT_B, organizationCustomerId: ORG_A }, db)]).toEqual(['tenantb@example.test']);
        expect([...await loadSupporterEmailConsent({ businessId: TENANT_B, organizationCustomerId: ORG_B }, db)]).toEqual([]);
        // Both ids are in every query; a missing one reads nothing at all.
        expect(db.reads.every((a) => a.where.business_id && a.where.customer_id)).toBe(true);
        const before = db.reads.length;
        expect([...await loadSupporterEmailConsent({ businessId: '', organizationCustomerId: ORG_A }, db)]).toEqual([]);
        expect([...await loadSupporterEmailConsent({ businessId: TENANT_A, organizationCustomerId: null }, db)]).toEqual([]);
        expect(db.reads.length).toBe(before);
    });

    it('12 · a later order with the box unticked does not revoke: no row is written, the earlier grant stands', async () => {
        await postOrder(orderBody({ email: true }));
        const first = [...committed];
        useWorld();
        await postOrder(orderBody({ email: false, sms: false }));
        expect(committed).toEqual([]);
        const db = consentDb(first.map((r) => ev(r)));
        expect([...await loadSupporterEmailConsent(scopeA, db)]).toEqual([DANA]);
    });

    it('13 · an unsubscribe overrides an earlier permission (and a later checkbox does not undo the unsubscribe); a revocation row withdraws; a later grant re-affirms', async () => {
        const unsub = [{ business_id: TENANT_A, scope: 'email_address', status: 'unsubscribed', normalized_email: DANA }];
        expect([...await loadSupporterEmailConsent(scopeA, consentDb([ev({})], unsub))]).toEqual([]);
        expect([...await loadSupporterEmailConsent(scopeA, consentDb([ev({}), ev({})], unsub))]).toEqual([]);
        expect([...await loadSupporterEmailConsent(scopeA, consentDb([ev({}), ev({ action: 'revoked' })]))]).toEqual([]);
        expect([...await loadSupporterEmailConsent(scopeA, consentDb([ev({}), ev({ action: 'revoked' }), ev({})]))]).toEqual([DANA]);
        // A resubscribed (released) preference is no longer a veto.
        expect([...await loadSupporterEmailConsent(scopeA, consentDb([ev({})], [{ ...unsub[0], status: 'subscribed' }]))]).toEqual([DANA]);
    });

    it('permission is tied to the exact destination accepted — a new number or address inherits nothing', async () => {
        const db = consentDb([ev({ channel: 'sms', destination: '+13095551111' }), ev({ channel: 'email', destination: 'old@example.test' })]);
        expect([...await loadSupporterSmsConsent(scopeA, db)]).toEqual(['+13095551111']);
        expect((await loadSupporterSmsConsent(scopeA, db)).has('+13095552222')).toBe(false);
        expect((await loadSupporterEmailConsent(scopeA, db)).has('new@example.test')).toBe(false);
        // Email and SMS never answer for each other.
        expect([...await loadSupporterEmailConsent(scopeA, db)]).toEqual(['old@example.test']);
    });

    it('14 · 15 · 16 · Previous Supporters: recorded permission makes a supporter eligible — but only with the organization mailing address; none → "not recorded"', async () => {
        const { loadExplicitEmailConsent, describeAutomatedSend } = await import('@/lib/previousSupporterAuthorities');
        const { countConsented } = await import('@/lib/previousSupporterInvitation');
        const audience: any = { supporters: [
            { email: DANA, reachable: true }, { email: 'casey@example.test', reachable: true },
        ] };
        const address = { line1: '742 Fixture Lane', city: 'Maple Grove', state: 'IL', postalCode: '61944' };
        const consent = await loadExplicitEmailConsent(scopeA, consentDb([ev({})]));
        expect([...consent]).toEqual([DANA]);
        expect(countConsented(audience, consent)).toBe(1);
        expect(describeAutomatedSend({ mailingAddress: address, consentedCount: countConsented(audience, consent) })).toMatchObject({ available: true, code: 'available' });
        expect(describeAutomatedSend({ mailingAddress: null, consentedCount: 1 })).toMatchObject({ available: false, code: 'mailing_address_required' });
        const none = await loadExplicitEmailConsent(scopeA, consentDb([]));
        expect(describeAutomatedSend({ mailingAddress: address, consentedCount: countConsented(audience, none) })).toMatchObject({ available: false, code: 'consent_not_recorded' });
    });

    it('the latest event per destination wins', () => {
        expect([...currentlyGranted([{ destination: 'a', action: 'granted', created_at: '1' }, { destination: 'a', action: 'revoked', created_at: '2' }, { destination: 'b', action: 'granted', created_at: '3' }])]).toEqual(['b']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('wording, versions, normalization and storage', () => {
    it('the wording is server-defined, versioned, and names the organization', () => {
        expect([SUPPORTER_EMAIL_CONSENT_VERSION, SUPPORTER_SMS_CONSENT_VERSION]).toEqual(['supporter-future-email-v1', 'supporter-future-sms-v1']);
        expect(supporterEmailConsentText('  Jasper   County Farm Bureau ')).toBe('Yes, I’d like to receive occasional email updates about future fundraisers from Jasper County Farm Bureau. I can unsubscribe at any time.');
        expect(supporterSmsConsentText(null)).toContain('from this organization at the mobile number I provided');
        expect(SUPPORTER_CONSENT_OPTIONAL_NOTE).toBe('These choices are optional and are not needed to place your order. You can opt out at any time.');
    });

    it.each([
        ['(309) 555-1111', '+13095551111'], ['309.555.1111', '+13095551111'], ['+1 309 555 1111', '+13095551111'], ['13095551111', '+13095551111'],
        ['555-0100', null], ['309-555-111', null], ['+44 20 7946 0958', null], ['109-555-1111', null], ['309-155-1111', null],
        ['309-555-1111 ext 2', null], ['call me', null], ['', null],
    ])('9 · SMS destination %s → %s', (raw, expected) => {
        expect(normalizeConsentPhone(raw)).toBe(expected);
    });

    it('8 · email destination is the Previous Supporters normalization', () => {
        expect(normalizeConsentEmail('  Dana.Fields@Example.TEST ')).toBe(DANA);
        expect(normalizeConsentEmail('dana-at-example')).toBeNull();
        expect(planSupporterConsent({ email: false, sms: false }, { email: 'x', phone: 'y' })).toEqual({ ok: true, email: null, sms: null });
    });

    it('rows carry exactly the table\'s columns (id and created_at are the database\'s)', () => {
        const schema = R('prisma/schema.prisma');
        const block = schema.slice(schema.indexOf('model SupporterContactConsent {'), schema.indexOf('\n}', schema.indexOf('model SupporterContactConsent {')));
        const columns = [...block.matchAll(/^\s{2}(\w+)\s+(String|DateTime|SupporterConsent\w+)\??\s/gm)].map((m) => m[1]).sort();
        const row = buildSupporterConsentRows({ businessId: 'b', organizationCustomerId: 'c', organizationName: 'O', campaignId: null, orderId: null, supporterCustomerId: null, plan: { email: 'a@b.co', sms: null } })[0];
        expect(columns).toEqual([...Object.keys(row), 'created_at', 'id'].sort());
    });

    it('the migration only adds: one table, two enums, its indexes, foreign keys and checks', () => {
        const sql = R('prisma/migrations/20261119120000_supporter_consent_1/migration.sql');
        const statements = sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements.map((s) => s.split('\n')[0].replace(/\s+/g, ' ').slice(0, 40))).toEqual([
            'CREATE TYPE "SupporterConsentChannel" AS',
            'CREATE TYPE "SupporterConsentAction" AS ',
            'CREATE TABLE "supporter_contact_consents',
            'CREATE INDEX "supporter_contact_consents',
            'CREATE INDEX "supporter_contact_consents',
            ...Array(7).fill('ALTER TABLE "supporter_contact_consents" ').map((s) => s.slice(0, 40)),
        ]);
        // No destructive or data-changing statement (ON DELETE / ON UPDATE inside a FK clause are fine).
        expect(statements.join(';\n')).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|^(UPDATE|DELETE|INSERT)\b/im);
        expect(statements.filter((s) => /^ALTER TABLE/.test(s)).every((s) => /^ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT/.test(s))).toBe(true);
        expect(sql).toContain('"destination" ~ \'^\\+1[2-9][0-9]{2}[2-9][0-9]{6}$\'');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('nothing is sent, and SMS stays locked', () => {
    const files = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);

    it('only the order route writes permission; only the authority reads it; no sender reads SMS permission', () => {
        const all = [...files('app'), ...files('lib'), ...files('components')];
        const writers = all.filter((f) => /recordSupporterConsents\(/.test(R(f)));
        expect(writers.map((f) => f.replace(/\\/g, '/')).sort()).toEqual(['app/api/public/order/route.ts', 'lib/supporterConsent.ts']);
        const smsReaders = all.filter((f) => /loadSupporterSmsConsent/.test(R(f)));
        expect(smsReaders.map((f) => f.replace(/\\/g, '/'))).toEqual(['lib/supporterConsent.ts']);
        const tableUsers = all.filter((f) => /supporterContactConsent/.test(R(f)));
        expect(tableUsers.map((f) => f.replace(/\\/g, '/'))).toEqual(['lib/supporterConsent.ts']);
    });

    it('the unsubscribe path is byte-identical to Production 7c9c048', () => {
        for (const p of ['lib/outreachUnsubscribeWrite.ts', 'lib/outreachUnsubscribeToken.ts', 'app/api/unsubscribe/[token]/route.ts', 'lib/outreachSend.ts']) {
            expect(R(p)).toBe(execSync(`git show 7c9c048:"${p}"`, { cwd: ROOT, encoding: 'utf8' }).replace(/\r\n/g, '\n'));
        }
    });

    // SUPERSEDED PIN (TWILIO-SMS-ROUTE-RETIRE-1, owner-approved 2026-11-23). This release pinned the
    // legacy Twilio relay byte-identical, to prove consent capture added no sender. The relay has
    // since been retired to an inert 410, so the guarantee is now stated directly: SUPPORTER-CONSENT-1
    // itself never touched it (its own commits, 7c9c048..95dff83), and no SMS sender exists anywhere —
    // no Twilio import, no messages.create — so SMS consent stays capture-only.
    it('SMS stays capture-only: consent never changed the legacy relay, and no SMS sender exists in the app', () => {
        expect(execSync('git diff --name-only 7c9c048 95dff83 -- app/api/public/send-text', { cwd: ROOT, encoding: 'utf8' }).trim()).toBe('');
        const code = [...files('app'), ...files('lib'), ...files('components')]
            .map((f) => R(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''));
        expect(code.filter((s) => /from ['"]twilio['"]|require\(['"]twilio['"]\)/.test(s))).toEqual([]);
        expect(code.filter((s) => /\.messages\.create\(/.test(s))).toEqual([]);
    });
});
