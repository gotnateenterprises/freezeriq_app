/**
 * COORDINATOR-PAYMENT-METHOD-UX-1A — the last legacy payment writers and the public scoreboard.
 *
 * After COORDINATOR-PAYMENT-METHOD-UX-1 the coordinator's setup and Payment Settings validated
 * every payment value, but two TENANT paths still wrote `payment_instructions` and
 * `external_payment_link` raw (PATCH /api/campaigns/[id], and the organization-profile save's sync
 * into the latest open campaign), and the public scoreboard rendered `external_payment_link`
 * straight into an href. Now every writer goes through checkCoordinatorPaymentSettings (the Payment
 * Settings rule), the payee through checkChecksPayable, and every render through
 * legacyPaymentLinkView — no second validator anywhere.
 *
 * REAL handlers against the shared recording Prisma double (tests/helpers/routeHarness) with the
 * session doubled; the REAL scoreboard payment box. All data is fictional.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { findAll, textOf } from './helpers/hookRuntime';
import { legacyPaymentLinkView, buildSupporterPaymentView, checkCoordinatorPaymentSettings } from '@/lib/supporterPaymentMethods';
import { decideOperationalDetailsChange, operationalFillFromOrgProfile } from '@/lib/campaignOperationalDetails';
import { PUBLIC_SCOREBOARD_FIELDS } from '@/lib/publicFundraiserPayload';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__pmu1aPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__pmu1aSession) }));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const TENANT_A = 'biz-pmu1a-a';
const TENANT_B = 'biz-pmu1a-b';
const CAMPAIGN = 'aaaa4444-0000-4000-8000-0000000000a1';
const ORG = 'aaaa4444-0000-4000-8000-0000000000c1';

let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__pmu1aPrisma = m.client; return m; };
const signIn = (businessId: string | null) => { (global as any).__pmu1aSession = businessId ? { user: { businessId, role: 'OWNER', email: 'owner@example.test' } } : null; };

beforeAll(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});
beforeEach(() => { jest.clearAllMocks(); signIn(TENANT_A); });

// ── the tenant campaign editor ────────────────────────────────────────────────────────────────
const campaignRow = (businessId = TENANT_A, over: Record<string, unknown> = {}) => ({
    id: CAMPAIGN, name: 'Maple Fundraiser (fixture)', status: 'Active', closed_at: null,
    delivery_date: new Date('2026-12-01T00:00:00Z'), delivery_time: '4 PM', end_date: new Date('2026-11-20T00:00:00Z'),
    pickup_location: 'Gym', checks_payable: 'Lincoln PTO (fixture)', payment_instructions: 'old text', external_payment_link: null,
    payment_methods: null, tax_status: 'TAXABLE', tax_rate_percent: '1.00', org_share_percent: '20.00', total_sales: '0',
    customer: { id: ORG, business_id: businessId, name: 'Maple Ridge Robotics (fixture)', tax_status: 'TAXABLE' },
    ...over,
});
const editorMock = (businessId = TENANT_A) => useMock(createPrismaMock({ results: { 'fundraiserCampaign.findUnique': campaignRow(businessId) } }));
const patchCampaign = async (body: unknown) => {
    const { PATCH } = await import('@/app/api/campaigns/[id]/route');
    return readJson(await PATCH(new Request(`http://localhost/api/campaigns/${CAMPAIGN}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: CAMPAIGN }) }) as any);
};

describe('A. the tenant campaign editor — PATCH /api/campaigns/[id]', () => {
    it('A1. an unsafe legacy link is refused, and nothing is written (1)', async () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'http://pay.example.test/x', 'https://user:pw@pay.example.test/x', 'vbscript:msgbox(1)', 'not a url', 'https://nodot']) {
            editorMock();
            const res = await patchCampaign({ external_payment_link: bad });
            expect(res.status).toBe(400);
            expect(res.body.code).toMatch(/^payment_link_/);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
    });

    it('A2. a valid https link is accepted (normalised by the shared rule), and blank still clears it (2)', async () => {
        editorMock();
        expect((await patchCampaign({ external_payment_link: 'https://pay.example.test/maple?a=1&b=2' })).status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data.external_payment_link).toBe('https://pay.example.test/maple?a=1&b=2');
        for (const blank of ['', null, '   ']) {
            editorMock();
            expect((await patchCampaign({ external_payment_link: blank })).status).toBe(200);
            expect(mock.firstCall('fundraiserCampaign.update')!.args.data).toHaveProperty('external_payment_link', null);
        }
    });

    it('A3. instructions: plain text within the setup bound; markup, control and invisible characters are refused; line breaks survive (3)', async () => {
        for (const bad of ['<script>alert(1)</script>', 'Pay <b>me</b>', 'Pay\u0000now', 'Pay ‮moc', 'x'.repeat(1001), { evil: true }]) {
            editorMock();
            const res = await patchCampaign({ payment_instructions: bad });
            expect(res.status).toBe(400);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
        editorMock();
        expect((await patchCampaign({ payment_instructions: '  Cash or check at pickup.\nThank you!  ' })).status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data.payment_instructions).toBe('Cash or check at pickup.\nThank you!');
    });

    it('A4. PATCH semantics are unchanged: an absent key leaves its column alone', async () => {
        editorMock();
        expect((await patchCampaign({ name: 'Renamed (fixture)' })).status).toBe(200);
        const data = mock.firstCall('fundraiserCampaign.update')!.args.data;
        expect(data).not.toHaveProperty('payment_instructions');
        expect(data).not.toHaveProperty('external_payment_link');
        expect(data).not.toHaveProperty('payment_methods');
    });

    it('A5. the payee passes the same payee rule as the coordinator form (no markup / control characters)', async () => {
        for (const bad of ['<b>PTO</b>', 'PTO\u0007', 'PTO‮']) {
            editorMock();
            expect((await patchCampaign({ checks_payable: bad })).status).toBe(400);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
        editorMock();
        expect((await patchCampaign({ checks_payable: "St. John's PTO" })).status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data.checks_payable).toBe("St. John's PTO");
    });

    it('A6. another tenant cannot alter a campaign\'s payment information (5)', async () => {
        editorMock(TENANT_B);   // the campaign belongs to tenant B; the session is tenant A
        const res = await patchCampaign({ payment_instructions: 'Hijacked', external_payment_link: 'https://evil.example.test/' });
        expect(res.status).toBe(403);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        signIn(null);
        editorMock();
        expect((await patchCampaign({ payment_instructions: 'x' })).status).toBe(401);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('A7. the editor cannot set structured methods, money, tax or paid state through the payment keys (10, 11)', async () => {
        editorMock();
        await patchCampaign({ payment_instructions: 'ok', external_payment_link: 'https://pay.example.test/x', payment_methods: { v: 1, methods: [{ type: 'venmo', handle: 'x' }] }, paid_at: new Date().toISOString() });
        const data = mock.firstCall('fundraiserCampaign.update')!.args.data;
        for (const k of ['payment_methods', 'paid_at', 'paid_by', 'total_sales', 'tax_status', 'tax_rate_percent', 'org_share_percent', 'settlement_total']) {
            expect(data).not.toHaveProperty(k);
        }
        expect(mock.calls.filter((c) => c.model === 'order' && c.method !== 'count')).toEqual([]);
    });
});

// ── the organization-profile save ─────────────────────────────────────────────────────────────
const orgMock = (businessId = TENANT_A) => useMock(createPrismaMock({
    results: {
        'customer.findUnique': { business_id: businessId },
        'fundraiserCampaign.findFirst': {
            id: CAMPAIGN, closed_at: null, status: 'Active', delivery_date: null, delivery_time: null,
            end_date: null, pickup_location: null, checks_payable: null,
        },
    },
}));
const putOrg = async (body: unknown) => {
    const { PUT } = await import('@/app/api/customers/[id]/route');
    return readJson(await PUT(new Request(`http://localhost/api/customers/${ORG}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: ORG }) }) as any);
};

describe('B. the organization-profile save — PUT /api/customers/[id]', () => {
    it('B1. an unsafe link or markup in the blob is refused BEFORE the organization or any campaign is written (4)', async () => {
        for (const fi of [
            { external_payment_link: 'javascript:alert(1)' }, { external_payment_link: 'http://pay.example.test/x' },
            { payment_instructions: '<img src=x onerror=1>' }, { payment_instructions: 'Pay\u0000now' },
        ]) {
            orgMock();
            const res = await putOrg({ name: 'Maple Ridge Robotics (fixture)', fundraiser_info: { pickup_location: 'Gym', ...fi } });
            expect(res.status).toBe(400);
            expect(mock.callsTo('customer.update')).toHaveLength(0);
            expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        }
    });

    // LEGACY-WRITER-GUARDS-1 superseded B2–B4's campaign half: the organization profile save no
    // longer writes any campaign. Valid values are still accepted and saved on the organization
    // (the blob); they simply stop there. The campaign's payment text is owned by coordinator
    // setup and Payment Settings.
    it('B2. valid values are accepted and saved on the organization — no campaign is written', async () => {
        orgMock();
        expect((await putOrg({ name: 'Maple (fixture)', fundraiser_info: { payment_instructions: '  Thanks!  ', external_payment_link: 'https://pay.example.test/x' } })).status).toBe(200);
        expect(mock.callsTo('customer.update')).toHaveLength(1);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.updateMany')).toHaveLength(0);

        orgMock();
        expect((await putOrg({ name: 'Maple (fixture)', fundraiser_info: { payment_instructions: '', external_payment_link: '', pickup_location: 'Gym' } })).status).toBe(200);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('B3. the CRM forms\' own saves (no payment keys) still succeed and still leave every campaign alone', async () => {
        orgMock();
        const res = await putOrg({ name: 'Maple (fixture)', fundraiser_info: { pickup_location: 'Gym', checks_payable_to: 'Maple Ridge Robotics (fixture)', delivery_time: '4 PM' } });
        expect(res.status).toBe(200);
        expect(mock.firstCall('customer.update')!.args.data.fundraiser_info).toMatchObject({ pickup_location: 'Gym', delivery_time: '4 PM' });
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('B4. an unsafe payee default never reaches a campaign (the save still succeeds); the fill rule is unchanged', async () => {
        orgMock();
        expect((await putOrg({ name: 'Maple (fixture)', fundraiser_info: { checks_payable_to: '<b>Maple</b>' } })).status).toBe(200);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
        expect(operationalFillFromOrgProfile({ campaign: { delivery_date: null, delivery_time: null, end_date: null, pickup_location: null, checks_payable: null } as any, info: { checks_payable_to: 'Maple‮' } })).toEqual({});
        expect(operationalFillFromOrgProfile({ campaign: { delivery_date: null, delivery_time: null, end_date: null, pickup_location: null, checks_payable: null } as any, info: { checks_payable_to: 'Maple PTO' } })).toEqual({ checks_payable: 'Maple PTO' });
    });

    it('B5. another tenant\'s organization cannot be used to push payment information (5)', async () => {
        orgMock(TENANT_B);
        const res = await putOrg({ name: 'x', fundraiser_info: { payment_instructions: 'Hijacked', external_payment_link: 'https://evil.example.test/' } });
        expect(res.status).toBe(403);
        expect(mock.callsTo('customer.update')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('B6. a closed campaign is still never written by the profile save (existing rule unchanged)', async () => {
        useMock(createPrismaMock({
            results: {
                'customer.findUnique': { business_id: TENANT_A },
                'fundraiserCampaign.findFirst': { id: CAMPAIGN, closed_at: new Date(), status: 'Closed', delivery_date: null, delivery_time: null, end_date: null, pickup_location: null, checks_payable: null },
            },
        }));
        expect((await putOrg({ name: 'x', fundraiser_info: { payment_instructions: 'Thanks!' } })).status).toBe(200);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });
});

// ── the public scoreboard ─────────────────────────────────────────────────────────────────────
describe('C. the public scoreboard', () => {
    const { ScoreboardPaymentInfo } = require('@/app/fundraiser/[token]/ScoreboardClient');
    const box = (instructions: unknown, externalPaymentLink: unknown) => ScoreboardPaymentInfo({ instructions, externalPaymentLink });
    const anchors = (tree: any) => findAll(tree, (el) => el.type === 'a');

    it('C1. an unsafe legacy link never becomes an href — it is shown as inert text (6)', () => {
        for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox(1)', 'http://pay.example.test/x', 'https://user:pw@pay.example.test/x', 'not a url']) {
            const tree = box(null, bad);
            expect(anchors(tree)).toHaveLength(0);
            expect(textOf(tree)).toContain(`Payment link: ${bad}`);
        }
    });

    it('C2. a valid https legacy link stays usable — new tab, no opener, a truthful label (7)', () => {
        const tree = box('Cash or check at pickup.', 'https://pay.example.test/maple');
        const [a] = anchors(tree);
        expect(a.props.href).toBe('https://pay.example.test/maple');
        expect(a.props.target).toBe('_blank');
        expect(a.props.rel).toBe('noopener noreferrer');
        expect(a.props['aria-label']).toBe('Open payment link (opens in a new tab)');
        expect(textOf(a)).toBe('Open payment link');
        expect(textOf(tree)).not.toMatch(/Take Me to Payment|pay now|\bPaid\b/i);
    });

    it('C3. legacy instructions remain visible as wrapping plain text; markup stays text (8)', () => {
        const tree = box('Line one\nLine two <b>not bold</b>', null);
        const p = findAll(tree, (el) => el.type === 'p')[0];
        expect(p.props.className).toContain('whitespace-pre-wrap break-words');
        expect(p.props.children).toBe('Line one\nLine two <b>not bold</b>');
        expect(findAll(tree, (el) => el.type === 'b')).toHaveLength(0);
        expect(anchors(tree)).toHaveLength(0);
    });

    it('C4. nothing to show → no box at all', () => {
        expect(box(null, null)).toBeNull();
        expect(box('   ', '')).toBeNull();
    });

    it('C5. the scoreboard renders through the shared box, never a raw href', () => {
        const src = strip(read('app/fundraiser/[token]/ScoreboardClient.tsx'));
        expect(src).not.toMatch(/href=\{campaign\.external_payment_link\}/);
        expect(src).toMatch(/<ScoreboardPaymentInfo\s+instructions=\{campaign\.payment_instructions\}\s+externalPaymentLink=\{campaign\.external_payment_link\}/);
        expect(src).toMatch(/const link = legacyPaymentLinkView\(externalPaymentLink\);/);
        expect(src).toMatch(/href=\{link\.href\}/);
    });

    it('C6. the scoreboard API never carries the structured methods or their raw JSON (9)', async () => {
        useMock(createPrismaMock({
            results: {
                'fundraiserCampaign.findUnique': {
                    id: 'camp-INTERNAL', name: 'Maple (fixture)', status: 'Active', bundle_goal: 20, bundle_selection_status: 'not_required',
                    about_text: null, mission_text: null, payment_instructions: 'Cash please', external_payment_link: 'javascript:alert(1)',
                    payment_methods: { v: 1, methods: [{ type: 'venmo', handle: 'secret-handle-pmu1a' }] }, checks_payable: 'PAYEE-INTERNAL',
                    customer: { name: 'Maple Ridge Robotics (fixture)' }, orders: [],
                },
            },
        }));
        const { GET } = await import('@/app/api/fundraiser/[token]/route');
        const res = await GET(new Request('http://localhost/api/fundraiser/pub') as any, { params: Promise.resolve({ token: 'pub' }) } as any);
        const body = await res.json();
        expect(Object.keys(body).sort()).toEqual([...PUBLIC_SCOREBOARD_FIELDS, 'customer', 'orders'].sort());
        expect(JSON.stringify(body)).not.toMatch(/payment_methods|secret-handle-pmu1a|"v":1|PAYEE-INTERNAL/);
        // and what it does carry, the box renders safely
        expect(anchors(box(body.payment_instructions, body.external_payment_link))).toHaveLength(0);
    });
});

// ── one rule everywhere ───────────────────────────────────────────────────────────────────────
describe('D. one rule, everywhere', () => {
    it('D1. the view and the scoreboard share the SAME legacy-link function', () => {
        for (const raw of ['https://pay.example.test/x', 'javascript:alert(1)', '', null, 'http://x.example']) {
            expect(buildSupporterPaymentView({ methods: null, instructions: null, legacyLink: raw }).legacyLink).toEqual(legacyPaymentLinkView(raw));
        }
    });

    it('D2. every legacy writer calls the Payment Settings validator — no second validator exists', () => {
        for (const p of ['app/api/campaigns/[id]/route.ts', 'app/api/customers/[id]/route.ts', 'app/api/coordinator/route.ts']) {
            expect(strip(read(p))).toMatch(/checkCoordinatorPaymentSettings\(/);
        }
        expect(strip(read('app/api/campaigns/[id]/route.ts'))).not.toMatch(/(payment_instructions|external_payment_link):\s*body\./);
        expect(strip(read('app/api/customers/[id]/route.ts'))).not.toMatch(/(payment_instructions|external_payment_link):\s*fi\./);
    });

    it('D3. the shared rules are the ones the coordinator\'s Payment Settings uses, unchanged (12)', () => {
        expect(checkCoordinatorPaymentSettings({ externalPaymentLink: 'javascript:alert(1)' }).ok).toBe(false);
        expect(checkCoordinatorPaymentSettings({ paymentInstructions: 'Thanks!', externalPaymentLink: 'https://pay.example.test/x' }))
            .toEqual({ ok: true, values: { payment_instructions: 'Thanks!', external_payment_link: 'https://pay.example.test/x' } });
        expect(decideOperationalDetailsChange({ requested: { checks_payable: '<b>x</b>' }, campaign: {} as any, campaignClosed: false } as any)).toMatchObject({ rejected: true, status: 400 });
    });

    it('D4. no legacy path writes paid state, and none of the touched files mentions it (10)', () => {
        for (const p of ['app/api/campaigns/[id]/route.ts', 'app/api/customers/[id]/route.ts', 'app/fundraiser/[token]/ScoreboardClient.tsx', 'lib/campaignOperationalDetails.ts']) {
            expect(strip(read(p))).not.toMatch(/paid_at|paid_by|mark_paid/);
        }
    });
});
