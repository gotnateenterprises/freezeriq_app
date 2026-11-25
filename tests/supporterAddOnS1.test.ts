/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — S1: schema + shared add-on rules + goal-exclusion foundation.
 *
 * Owner decisions under test: D1 (no add-on-only orders), D2/D4 (one tenant-assigned add-on per
 * campaign, in campaign_add_ons — never a CampaignBundle), D3 (bundle_type meal | addon), D6 (normal
 * quantity rules), D7 (paper / manual orders use the SAME server rules), D8 (history keeps its role),
 * D9 (never a storefront product) and D11 (ANY meal bundle qualifies — Serves 5 and Serves 2 alike).
 *
 * The route sections execute the REAL handlers (supporter order, coordinator manual order, staff
 * manual order, storefront checkout, public scoreboard) against the recording Prisma double in
 * tests/helpers/routeHarness.ts, over a small fictional world in which tenant B owns a bundle that
 * tenant A's queries can never see. Assertions are on what the handler actually wrote.
 *
 * Every name, id and address here is fictional (the repository is public).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    ADDON_CHANGED_MESSAGE,
    AddOnChangedError,
    assertCampaignAddOnUnchanged,
    classifyFundraiserOrderLines,
    isAddOnChanged,
    isAddOnItemRole,
    loadCampaignAddOnAuthority,
    loadOrderBundleFacts,
    normalizeBundleType,
    type OrderBundleFact,
} from '@/lib/campaignAddOns';
import { computeBundleUnitsFromItems, computeFundraiserProgress, getBundleUnitWeight } from '@/lib/fundraiserMetrics';
import { SUPPORTER_ORDER_SELECT, toSupporterOrder } from '@/lib/coordinatorSupporterOrders';
import { aggregateBundleLines, computeCloseoutFinancials, sumLineTotals } from '@/lib/fundraiserCloseoutMath';
import { organizationShareAmount } from '@/lib/fundraiserOrgShare';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ao1Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__ao1Session ?? null) }));
jest.mock('@/lib/email', () => ({
    sendOrderConfirmationEmail: jest.fn(async () => true),
    sendFundraiserCoordinatorNotification: jest.fn(async () => true),
    sendLeadNotificationEmail: jest.fn(async () => true),
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__ao1CookieName ? { name, value: 'ao1-coordinator-secret' } : undefined),
    }),
}));
jest.mock('@/lib/stripe', () => ({ stripe: {} }));
jest.mock('@/lib/customerAuth', () => ({ getCustomerSession: jest.fn(async () => null) }));
jest.mock('@/lib/payments', () => ({
    getPaymentProvider: jest.fn(async () => ({
        type: 'square',
        provider: { createCheckout: jest.fn(async () => ({ squareConfig: { applicationId: 'sq-ao1-test' } })) },
    })),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// ── The fictional world ─────────────────────────────────────────────────────────────────────────
const TENANT_A = 'biz-ao1-aaaa';
const TENANT_B = 'biz-ao1-bbbb';
const ORG_A = 'org-ao1-riverside';
const CAMP_LEGACY = 'camp-ao1-legacy';
const CAMP_SEL = 'camp-ao1-selected';
const CAMP_OTHER = 'camp-ao1-other';

type BundleRow = {
    id: string; name: string; price: string; serving_tier: string; family_id: string | null;
    is_active: boolean; business_id: string; bundle_type: 'meal' | 'addon'; stock_on_hand?: number;
};
const B: Record<string, BundleRow> = {
    S5: { id: 'b-ao1-s5', name: 'Comfort Foods (Serves 5)', price: '125.00', serving_tier: 'family', family_id: 'fam-ao1-1', is_active: true, business_id: TENANT_A, bundle_type: 'meal' },
    S2: { id: 'b-ao1-s2', name: 'Comfort Foods (Serves 2)', price: '65.00', serving_tier: 'serves_2', family_id: 'fam-ao1-1', is_active: true, business_id: TENANT_A, bundle_type: 'meal' },
    ADDON: { id: 'b-ao1-addon', name: 'Sides & Dessert Bundle', price: '25.00', serving_tier: 'family', family_id: null, is_active: true, business_id: TENANT_A, bundle_type: 'addon' },
    OTHER_ADDON: { id: 'b-ao1-addon-2', name: 'Holiday Pie Add-On', price: '18.00', serving_tier: 'family', family_id: null, is_active: true, business_id: TENANT_A, bundle_type: 'addon' },
    OFF_LINEUP: { id: 'b-ao1-tacos', name: 'Taco Night (Serves 5)', price: '120.00', serving_tier: 'family', family_id: 'fam-ao1-2', is_active: true, business_id: TENANT_A, bundle_type: 'meal' },
    FOREIGN_ADDON: { id: 'b-ao1-foreign', name: 'Another Kitchen Add-On', price: '9.00', serving_tier: 'family', family_id: null, is_active: true, business_id: TENANT_B, bundle_type: 'addon' },
};

const campaignRow = (id: string, over: Record<string, any> = {}) => ({
    id, name: 'Riverside Boosters (fixture) Fundraiser', status: 'Active', closed_at: null, end_date: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 1,
    payment_instructions: null, external_payment_link: null, checks_payable: null, payment_methods: null,
    tax_status: null, tax_rate_percent: null,
    customer_id: ORG_A,
    customer: {
        id: ORG_A, business_id: TENANT_A, name: 'Riverside Boosters (fixture)', contact_email: 'coord@example.invalid',
        business: { timezone: 'America/Chicago', plan: 'FREE', id: TENANT_A },
    },
    ...over,
});

let mock: PrismaMock;
let campaigns: Record<string, any>;
let assignments: Record<string, { business_id: string; bundle_id: string } | null>;
/** When set, campaignAddOn.findUnique answers from this list in call order (preflight, then transaction). */
let addOnReadSequence: Array<{ business_id: string; bundle_id: string } | null> | null;

function addOnRow(a: { business_id: string; bundle_id: string } | null) {
    if (!a) return null;
    const bundle = Object.values(B).find((b) => b.id === a.bundle_id);
    return { business_id: a.business_id, bundle_id: a.bundle_id, bundle: bundle ? { ...bundle } : null };
}

function useWorld(extra: Record<string, any> = {}) {
    let addOnReads = 0;
    mock = createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A, slug: 'tenant-a', timezone: 'America/Chicago', name: 'Example Kitchen' },
            'bundle.findMany': (args: any) => Object.values(B)
                .filter((b) => !args?.where?.id?.in || args.where.id.in.includes(b.id))
                .filter((b) => args?.where?.business_id === undefined || b.business_id === args.where.business_id)
                .filter((b) => args?.where?.is_active === undefined || b.is_active === args.where.is_active)
                .map((b) => ({ ...b })),
            'campaignAddOn.findUnique': (args: any) => {
                addOnReads += 1;
                if (addOnReadSequence) return addOnRow(addOnReadSequence[Math.min(addOnReads, addOnReadSequence.length) - 1]);
                return addOnRow(assignments[args?.where?.campaign_id] ?? null);
            },
            'campaignBundle.findMany': (args: any) => (args?.where?.campaign_id === CAMP_SEL
                ? [B.S5, B.S2].map((b) => ({ bundle_id: b.id, bundle: { ...b } }))
                : []),
            'fundraiserCampaign.findUnique': (args: any) => campaigns[args?.where?.id] ?? null,
            'fundraiserCampaign.findFirst': (args: any) => campaigns[args?.where?.id] ?? null,
            'customer.findFirst': null,
            'order.findFirst': null,
            'order.create': (args: any) => ({ id: 'order-ao1-1', external_id: 'ord-ao1-1', ...args?.data, items: [] }),
            'coordinatorSession.findUnique': () => ({
                id: 'session-ao1', campaign_id: (global as any).__ao1CoordinatorCampaign ?? CAMP_LEGACY,
                expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
            }),
            $queryRaw: [],
            ...extra,
        },
    });
    (global as any).__ao1Prisma = mock.client;
}

beforeAll(() => { for (const k of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, k).mockImplementation(() => undefined); });
beforeEach(() => {
    jest.resetModules();
    campaigns = {
        [CAMP_LEGACY]: campaignRow(CAMP_LEGACY),
        [CAMP_SEL]: campaignRow(CAMP_SEL, { bundle_selection_status: 'selected', bundle_selection_limit: 1 }),
        [CAMP_OTHER]: campaignRow(CAMP_OTHER),
    };
    assignments = {
        [CAMP_LEGACY]: { business_id: TENANT_A, bundle_id: B.ADDON.id },
        [CAMP_SEL]: { business_id: TENANT_A, bundle_id: B.ADDON.id },
        [CAMP_OTHER]: { business_id: TENANT_A, bundle_id: B.OTHER_ADDON.id },
    };
    addOnReadSequence = null;
    (global as any).__ao1Session = null;
    (global as any).__ao1CookieName = coordinatorSessionCookieName();
    (global as any).__ao1CoordinatorCampaign = CAMP_LEGACY;
    useWorld();
});

const SUPPORTER = { firstName: 'Dana', lastName: 'Fields', email: 'dana.fields@example.test', phone: '(309) 555-0142' };
const line = (b: BundleRow, quantity = 1, over: Record<string, any> = {}) =>
    ({ bundleId: b.id, quantity, serving_tier: b.serving_tier, name: b.name, ...over });

async function supporterOrder(campaignId: string | null, items: any[]) {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', {
        slug: 'tenant-a', ...(campaignId ? { campaignId } : {}), customer: { ...SUPPORTER }, items,
    }) as any));
}
async function coordinatorOrder(items: any[], campaignId = CAMP_LEGACY) {
    (global as any).__ao1CoordinatorCampaign = campaignId;
    const { POST } = await import('@/app/api/coordinator/route');
    const req = new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ customerName: 'Paper Order (fixture)', participantName: 'Team A', items, totalAmount: 0.01, deliveryAddress: null, phone: null }),
    });
    return readJson(await POST(req as any));
}
async function staffOrder(items: any[]) {
    (global as any).__ao1Session = { user: { businessId: TENANT_A } };
    const { POST } = await import('@/app/api/orders/route');
    return readJson(await POST(jsonRequest('http://localhost/api/orders', { customer_name: 'Walk-in (fixture)', items }) as any));
}
async function storefrontCheckout(items: any[]) {
    const { POST } = await import('@/app/api/checkout/session/route');
    return readJson(await POST(jsonRequest('http://localhost/api/checkout/session', {
        slug: 'tenant-a', items, customerName: 'Pat Lee (fixture)', customerEmail: 'pat@example.test', fulfillmentType: 'pickup',
    })));
}
/** The order lines the handler actually wrote. */
const writtenLines = (): any[] => {
    const create = mock.firstCall('order.create');
    const lines = create?.args?.data?.items?.create ?? [];
    return Array.isArray(lines) ? lines : [lines];
};
const writtenOrder = () => mock.firstCall('order.create')?.args?.data;
const noWrites = () => {
    expect(mock.callsTo('order.create')).toHaveLength(0);
    expect(mock.callsTo('bundle.update')).toHaveLength(0);
    expect(mock.callsTo('customer.create')).toHaveLength(0);
};
const facts = (...rows: BundleRow[]) => new Map<string, OrderBundleFact>(rows.map((b) => [b.id, { id: b.id, name: b.name, bundleType: b.bundle_type }]));

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('1–5 · schema and migration: additive, defaults, database-enforced invariants', () => {
    const MIGRATION = 'prisma/migrations/20261123120000_supporter_addon_s1/migration.sql';
    const sql = R(MIGRATION);
    const schema = R('prisma/schema.prisma');
    const block = (model: string) => schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf('\n}', schema.indexOf(`model ${model} {`)));

    it('1 · an existing bundle defaults to meal (column default, schema default, reader default)', () => {
        expect(sql).toContain(`ALTER TABLE "bundles" ADD COLUMN     "bundle_type" TEXT NOT NULL DEFAULT 'meal';`);
        expect(block('Bundle')).toMatch(/bundle_type\s+String\s+@default\("meal"\)/);
        expect(normalizeBundleType(undefined)).toBe('meal');
        expect(normalizeBundleType(null)).toBe('meal');
        expect(normalizeBundleType('meal')).toBe('meal');
        expect(normalizeBundleType('addon')).toBe('addon');
    });

    it('2 · an existing order line defaults to main', () => {
        expect(sql).toContain(`ALTER TABLE "order_items" ADD COLUMN     "item_role" TEXT NOT NULL DEFAULT 'main';`);
        expect(block('OrderItem')).toMatch(/item_role\s+String\s+@default\("main"\)/);
        const legacy = toSupporterOrder({ id: 'o-legacy', items: [{ quantity: 2, variant_size: 'serves_5', item_name: 'Old', bundle_id: 'b-old' }] }, null);
        expect(legacy.items[0].item_role).toBe('main');
    });

    it('3 · an add-on bundle cannot have a family_id, and both vocabularies are closed (CHECKs)', () => {
        expect(sql).toMatch(/ADD CONSTRAINT "bundles_addon_has_no_family"\s+CHECK \("bundle_type" = 'meal' OR "family_id" IS NULL\);/);
        expect(sql).toMatch(/ADD CONSTRAINT "bundles_bundle_type_check"\s+CHECK \("bundle_type" IN \('meal', 'addon'\)\);/);
        expect(sql).toMatch(/ADD CONSTRAINT "order_items_item_role_check"\s+CHECK \("item_role" IN \('main', 'addon'\)\);/);
    });

    it('4 · at most ONE add-on per campaign (unique index on campaign_id; one index to drop for V2)', () => {
        expect(sql).toContain('CREATE UNIQUE INDEX "campaign_add_ons_one_per_campaign" ON "campaign_add_ons"("campaign_id");');
        expect(block('CampaignAddOn')).toContain('@@unique([campaign_id], map: "campaign_add_ons_one_per_campaign")');
    });

    it('5 · a cross-tenant assignment is refused BY POSTGRES (composite keys chain campaign → org → tenant → bundle)', () => {
        expect(sql).toContain('FOREIGN KEY ("customer_id", "campaign_id") REFERENCES "fundraiser_campaigns"("customer_id", "id")');
        expect(sql).toContain('FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id")');
        expect(sql).toContain('FOREIGN KEY ("business_id", "bundle_id") REFERENCES "bundles"("business_id", "id") ON DELETE RESTRICT');
        expect(sql).toContain('CREATE UNIQUE INDEX "bundles_business_id_id_key" ON "bundles"("business_id", "id");');
    });

    it('the migration is purely additive and assigns no campaign an add-on', () => {
        const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        // (Foreign keys legitimately say ON DELETE / ON UPDATE; a data statement would START with the verb.)
        expect(code).not.toMatch(/\b(DROP|RENAME|TRUNCATE)\b|ALTER COLUMN|^\s*(DELETE|UPDATE|INSERT)\b/im);
        const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
        for (const s of statements) {
            expect(s).toMatch(/^(ALTER TABLE "(bundles|order_items)" ADD COLUMN|CREATE TABLE "campaign_add_ons"|CREATE (UNIQUE )?INDEX "(campaign_add_ons_|bundles_business_id_id_key)|ALTER TABLE "(campaign_add_ons|bundles|order_items)" ADD CONSTRAINT)/);
        }
        // It directly follows SUPPORTER-CONSENT-1, and it is the only migration S1 adds.
        // SUPERSEDED PIN (FR-SUPPORTER-ADDON-UPSELL-1 S2): this said "the newest migration". S2 adds its own
        // approved, additive 20261124120000_supporter_addon_s2 after it — named here explicitly, so any
        // other later migration still fails this test.
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        const s1 = dirs.indexOf('20261123120000_supporter_addon_s1');
        expect(dirs[s1 - 1]).toBe('20261119120000_supporter_consent_1');
        // REVISED (S3): and S3's own approved, additive migration after S2.
        // REVISED (S4, owner-approved 2026-11-24): and S4's approved, additive share-display column after S3.
        // REVISED (B1/B2 remediation, owner-approved 2026-11-25): and the approved, additive campaign_add_ons.removed_at.
        expect(dirs.slice(s1 + 1)).toEqual(['20261124120000_supporter_addon_s2', '20261125120000_supporter_addon_s3', '20261126120000_supporter_addon_s4', '20261127120000_supporter_addon_b2_removed_at']);
    });

    it('the add-on is NOT a CampaignBundle and serving_tier is not its classifier', () => {
        expect(block('CampaignBundle')).not.toMatch(/role|addon/i);
        expect(R('lib/campaignAddOns.ts')).not.toMatch(/serving_tier|storefrontConfig|upsell_bundle|upsell_discount/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('shared rules · classifyFundraiserOrderLines (pure)', () => {
    const authorized = { bundleId: B.ADDON.id, name: B.ADDON.name };
    const all = facts(B.S5, B.S2, B.ADDON, B.OTHER_ADDON, B.OFF_LINEUP);
    const run = (ids: Array<string | null>, isCampaignOrder = true, auth: any = authorized, f = all) =>
        classifyFundraiserOrderLines({ lineBundleIds: ids, isCampaignOrder, bundleFacts: f, authorizedAddOn: auth });

    it('D11 · Serves 5, Serves 2, both, or several meal lines all qualify the add-on', () => {
        for (const ids of [[B.S5.id], [B.S2.id], [B.S5.id, B.S2.id], [B.S5.id, B.S2.id, B.OFF_LINEUP.id]]) {
            const r = run([...ids, B.ADDON.id]);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.roles).toEqual([...ids.map(() => 'main'), 'addon']);
                expect(r.addOnBundleIds).toEqual([B.ADDON.id]);
            }
        }
    });

    it('add-on only → 400 ADDON_REQUIRES_MEAL; an unknown id beside it does not qualify it', () => {
        expect(run([B.ADDON.id])).toMatchObject({ ok: false, status: 400, code: 'ADDON_REQUIRES_MEAL', error: 'An add-on must be ordered with at least one meal bundle.' });
        expect(run(['b-not-this-tenant', B.ADDON.id])).toMatchObject({ ok: false, code: 'ADDON_REQUIRES_MEAL' });
    });

    it('an add-on that is not THIS campaign\'s current add-on → 409, never substituted', () => {
        expect(run([B.S5.id, B.OTHER_ADDON.id])).toMatchObject({ ok: false, status: 409, code: 'ADDON_CHANGED', error: ADDON_CHANGED_MESSAGE });
        expect(run([B.S5.id, B.ADDON.id], true, null)).toMatchObject({ ok: false, status: 409, code: 'ADDON_CHANGED' });
    });

    it('a duplicate add-on line → 400; one line of quantity > 1 is the way to buy several', () => {
        expect(run([B.S5.id, B.ADDON.id, B.ADDON.id])).toMatchObject({ ok: false, status: 400, code: 'DUPLICATE_ADDON_LINE' });
    });

    it('manual_upsell on a campaign order → 400 before anything else; storefront manual upsell is left alone', () => {
        expect(run([B.S5.id, 'manual_upsell'])).toMatchObject({ ok: false, status: 400, code: 'MANUAL_UPSELL_NOT_ALLOWED' });
        expect(run([B.S5.id, 'manual_upsell'], false, null)).toMatchObject({ ok: true, roles: ['main', 'main'] });
    });

    it('outside a campaign an add-on is never sellable', () => {
        expect(run([B.S5.id, B.ADDON.id], false, null)).toMatchObject({ ok: false, status: 400, code: 'ADDON_NOT_AVAILABLE' });
    });

    it('an order with no add-on is untouched: every line main, nothing refused', () => {
        expect(run([B.S5.id, B.S2.id, 'b-unknown', null], true, null)).toEqual({ ok: true, roles: ['main', 'main', 'main', 'main'], addOnBundleIds: [] });
    });

    it('the role comes from the tenant-scoped bundle row, never from anything the client sent', () => {
        // A foreign add-on is absent from tenant A's facts, so it is a main line the lineup/price checks refuse.
        expect(run([B.S5.id, B.FOREIGN_ADDON.id])).toEqual({ ok: true, roles: ['main', 'main'], addOnBundleIds: [] });
    });
});

describe('shared rules · tenant-scoped reads and the transaction recheck', () => {
    it('loadOrderBundleFacts reads only this tenant\'s bundles and never asks for price', async () => {
        const f = await loadOrderBundleFacts(mock.client, TENANT_A, [B.S5.id, B.FOREIGN_ADDON.id, B.ADDON.id, 'manual_upsell', '', null]);
        expect([...f.keys()].sort()).toEqual([B.ADDON.id, B.S5.id].sort());
        expect(f.get(B.ADDON.id)?.bundleType).toBe('addon');
        const call = mock.callsTo('bundle.findMany')[0];
        expect(call.args.where.business_id).toBe(TENANT_A);
        expect(call.args.select).toEqual({ id: true, name: true, bundle_type: true });
    });

    it('loadCampaignAddOnAuthority: same tenant, active, typed addon — or nothing', async () => {
        expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A }))
            .toEqual({ bundleId: B.ADDON.id, name: 'Sides & Dessert Bundle' });
        // asked by another tenant
        expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_B })).toBeNull();
        // a row pointing at another tenant's bundle (the composite FK forbids it; re-checked anyway)
        assignments[CAMP_SEL] = { business_id: TENANT_A, bundle_id: B.FOREIGN_ADDON.id };
        expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A })).toBeNull();
        // inactive, or no longer typed addon
        assignments[CAMP_SEL] = { business_id: TENANT_A, bundle_id: B.ADDON.id };
        B.ADDON.is_active = false;
        try { expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A })).toBeNull(); } finally { B.ADDON.is_active = true; }
        B.ADDON.bundle_type = 'meal';
        try { expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A })).toBeNull(); } finally { B.ADDON.bundle_type = 'addon'; }
        // none assigned
        assignments[CAMP_SEL] = null;
        expect(await loadCampaignAddOnAuthority(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A })).toBeNull();
    });

    it('assertCampaignAddOnUnchanged throws the 409 marker on change or removal, and is silent when unchanged', async () => {
        await expect(assertCampaignAddOnUnchanged(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A, expectedBundleIds: [B.ADDON.id] })).resolves.toBeUndefined();
        assignments[CAMP_SEL] = { business_id: TENANT_A, bundle_id: B.OTHER_ADDON.id };
        const changed = await assertCampaignAddOnUnchanged(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A, expectedBundleIds: [B.ADDON.id] }).catch((e) => e);
        expect(isAddOnChanged(changed)).toBe(true);
        assignments[CAMP_SEL] = null;
        await expect(assertCampaignAddOnUnchanged(mock.client, { campaignId: CAMP_SEL, businessId: TENANT_A, expectedBundleIds: [B.ADDON.id] })).rejects.toBeInstanceOf(Error);
        expect(isAddOnChanged(new AddOnChangedError())).toBe(true);
        expect(isAddOnChanged(new Error('ADDON_CHANGED'))).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('6–19, 23–28, 35 · the supporter fundraiser order route (real handler)', () => {
    it('6 · a campaign order without an add-on is unchanged: all lines main, no add-on lookup', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5, 2), line(B.S2, 1)]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => [l.bundle_id, l.quantity, l.variant_size, l.item_role, l.item_name])).toEqual([
            [B.S5.id, 2, 'serves_5', 'main', B.S5.name],
            [B.S2.id, 1, 'serves_2', 'main', B.S2.name],
        ]);
        expect(writtenOrder().total_amount).toBe(315);
        expect(mock.callsTo('campaignAddOn.findUnique')).toHaveLength(0);
    });

    it('7 · manual_upsell is refused on a campaign order before pricing, inventory, any write or email', async () => {
        const email = jest.requireMock('@/lib/email');
        const res = await supporterOrder(CAMP_LEGACY, [line(B.S5), { bundleId: 'manual_upsell', quantity: 1, name: 'Mystery Extra', serving_tier: 'single' }]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MANUAL_UPSELL_NOT_ALLOWED');
        noWrites();
        expect(mock.callsTo('storefrontConfig.findUnique')).toHaveLength(0);
        expect(mock.callsTo('bundle.findMany').some((c) => c.args?.select?.price)).toBe(false);
        expect(email.sendOrderConfirmationEmail).not.toHaveBeenCalled();
        expect(email.sendFundraiserCoordinatorNotification).not.toHaveBeenCalled();
    });

    it.each([
        ['8 · Serves 5', 'S5', 150],
        ['9 · Serves 2', 'S2', 90],
    ])('%s main + the authorized add-on → accepted (selected campaign)', async (_label, key, total) => {
        const res = await supporterOrder(CAMP_SEL, [line(B[key]), line(B.ADDON)]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => [l.bundle_id, l.item_role])).toEqual([[B[key].id, 'main'], [B.ADDON.id, 'addon']]);
        expect(writtenOrder().total_amount).toBe(total);
        expect(writtenOrder().campaign_id).toBe(CAMP_SEL);
    });

    it('Serves 5 + Serves 2 + add-on, and the add-on still decrements its own stock only', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.S2), line(B.ADDON, 2)]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => l.item_role)).toEqual(['main', 'main', 'addon']);
        const decrements = mock.callsTo('bundle.update').map((c) => [c.args.where.id, c.args.data.stock_on_hand.decrement]);
        expect(decrements).toEqual([[B.S5.id, 1], [B.S2.id, 0.5], [B.ADDON.id, 2]]);
    });

    it('10 · add-on only → 400 and nothing written', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.ADDON, 2)]);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'An add-on must be ordered with at least one meal bundle.', code: 'ADDON_REQUIRES_MEAL' });
        noWrites();
    });

    it('11 · an add-on the campaign has not assigned → rejected', async () => {
        assignments[CAMP_SEL] = null;
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON)]);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ADDON_CHANGED');
        noWrites();
    });

    it('12 · another campaign\'s add-on → rejected', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.OTHER_ADDON)]);
        expect(res.status).toBe(409);
        noWrites();
    });

    it.each([
        ['selected', CAMP_SEL, 'One or more selected bundles are not available for this campaign'],
        ['legacy', CAMP_LEGACY, 'Bundle not found for this business'],
    ])('13 · another tenant\'s add-on → rejected (%s campaign)', async (_m, campaignId, error) => {
        const res = await supporterOrder(campaignId, [line(B.S5), line(B.FOREIGN_ADDON)]);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe(error);
        noWrites();
        for (const c of mock.callsTo('bundle.findMany')) expect(c.args.where.business_id).toBe(TENANT_A);
    });

    it('14 · duplicate add-on lines → 400', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON), line(B.ADDON)]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DUPLICATE_ADDON_LINE');
        noWrites();
    });

    it('15 · one add-on line with quantity > 1 → accepted', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S2), line(B.ADDON, 3)]);
        expect(res.status).toBe(200);
        expect(writtenLines()[1]).toMatchObject({ bundle_id: B.ADDON.id, quantity: 3, item_role: 'addon', unit_price: 25 });
        expect(writtenOrder().total_amount).toBe(65 + 75);
    });

    it('16 · the server controls the add-on price; 17 · the server controls its name', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON, 1, { price: 0.01, name: 'FREE BONUS DESSERT' })]);
        expect(res.status).toBe(200);
        const addOn = writtenLines()[1];
        expect(addOn.unit_price).toBe(25);
        expect(addOn.item_name).toBe('Sides & Dessert Bundle');
        expect(writtenOrder().total_amount).toBe(150);
        expect(res.body.subtotal).toBe(150);
    });

    it('18 · the saved add-on line has item_role addon; 19 · the saved meal line has item_role main', async () => {
        await supporterOrder(CAMP_SEL, [line(B.ADDON), line(B.S5)]);
        expect(writtenLines().map((l) => [l.bundle_id, l.item_role])).toEqual([[B.ADDON.id, 'addon'], [B.S5.id, 'main']]);
    });

    it('a client-supplied item_role is never trusted', async () => {
        const res = await supporterOrder(CAMP_SEL, [line(B.S5, 1, { item_role: 'addon' }), line(B.ADDON, 1, { item_role: 'main' })]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => l.item_role)).toEqual(['main', 'addon']);
    });

    it('23 · the add-on is in the taxable subtotal, at the campaign\'s frozen rate, rounded once', async () => {
        campaigns[CAMP_SEL] = campaignRow(CAMP_SEL, { bundle_selection_status: 'selected', tax_status: 'TAXABLE', tax_rate_percent: '7.00' });
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON)]);
        expect(res.status).toBe(200);
        expect(writtenOrder().total_amount).toBe(150);
        expect(writtenOrder().tax_amount).toBe(10.5);
        expect(res.body).toMatchObject({ subtotal: 150, taxAmount: 10.5, total: 160.5 });
    });

    it('24 · a tax-exempt campaign charges no tax on the add-on either', async () => {
        campaigns[CAMP_SEL] = campaignRow(CAMP_SEL, { bundle_selection_status: 'selected', tax_status: 'TAX_EXEMPT', tax_rate_percent: '0' });
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON)]);
        expect(res.status).toBe(200);
        expect(writtenOrder().tax_amount).toBe(0);
        expect(res.body.total).toBe(150);
    });

    it.each([
        ['removed', null],
        ['changed to another add-on', { business_id: TENANT_A, bundle_id: B.OTHER_ADDON.id }],
    ])('26 · an add-on %s between the preflight and the write → 409, nothing written', async (_label, inTx) => {
        addOnReadSequence = [{ business_id: TENANT_A, bundle_id: B.ADDON.id }, inTx];
        const res = await supporterOrder(CAMP_SEL, [line(B.S5), line(B.ADDON)]);
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: ADDON_CHANGED_MESSAGE, code: 'ADDON_CHANGED' });
        expect(mock.callsTo('campaignAddOn.findUnique')).toHaveLength(2);
        expect(mock.callsTo('order.create')).toHaveLength(0);
        // the recheck ran under the campaign selection lock
        const lock = mock.calls.findIndex((c) => c.model === '$executeRawUnsafe');
        const recheck = mock.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.model === 'campaignAddOn')[1].i;
        expect(lock).toBeGreaterThanOrEqual(0);
        expect(recheck).toBeGreaterThan(lock);
    });

    it('27 · a legacy (not_required) campaign rejects an add-on it has not assigned', async () => {
        assignments[CAMP_LEGACY] = null;
        const res = await supporterOrder(CAMP_LEGACY, [line(B.S5), line(B.ADDON)]);
        expect(res.status).toBe(409);
        noWrites();
    });

    it('27b · a legacy campaign with an assigned add-on obeys the same rules', async () => {
        expect((await supporterOrder(CAMP_LEGACY, [line(B.S2), line(B.ADDON)])).status).toBe(200);
        expect(writtenLines().map((l) => l.item_role)).toEqual(['main', 'addon']);
        useWorld();
        expect((await supporterOrder(CAMP_LEGACY, [line(B.ADDON)])).status).toBe(400);
    });

    it('28 · legacy meal behaviour is unchanged (any active tenant meal bundle, all main)', async () => {
        const res = await supporterOrder(CAMP_LEGACY, [line(B.OFF_LINEUP), line(B.S2, 2)]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => [l.bundle_id, l.item_role, l.unit_price])).toEqual([[B.OFF_LINEUP.id, 'main', 120], [B.S2.id, 'main', 65]]);
        expect(mock.callsTo('campaignAddOn.findUnique')).toHaveLength(0);
    });

    it('35 · the main bundle-selection rules are unchanged: an off-lineup meal is still refused, add-on or not', async () => {
        for (const items of [[line(B.OFF_LINEUP)], [line(B.OFF_LINEUP), line(B.ADDON)]]) {
            useWorld();
            const res = await supporterOrder(CAMP_SEL, items);
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('One or more selected bundles are not available for this campaign');
            noWrites();
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('29 · the ordinary storefront never sells a fundraiser add-on', () => {
    it('storefront checkout refuses an add-on bundle before pricing or any order', async () => {
        const res = await storefrontCheckout([{ bundleId: B.ADDON.id, quantity: 1, name: 'Sides', price: 25 }, { bundleId: B.S5.id, quantity: 1, name: 'x', price: 1 }]);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ADDON_NOT_AVAILABLE');
        expect(mock.callsTo('order.create')).toHaveLength(0);
        expect(mock.callsTo('bundle.findMany').some((c) => c.args?.select?.price)).toBe(false);
    });

    it('storefront checkout of meal bundles is unchanged', async () => {
        const res = await storefrontCheckout([{ bundleId: B.S5.id, quantity: 2, name: 'x', price: 1 }]);
        expect(res.status).toBe(200);
        expect(res.body.type).toBe('embedded');
        expect(writtenLines()).toEqual([expect.objectContaining({ bundle_id: B.S5.id, quantity: 2, unit_price: 125, variant_size: 'serves_5' })]);
        expect(writtenLines()[0].item_role).toBeUndefined(); // the column default, 'main'
    });

    it('a non-campaign order through the public order route refuses an add-on; meal orders are unchanged', async () => {
        const refused = await supporterOrder(null, [line(B.S5), line(B.ADDON)]);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('ADDON_NOT_AVAILABLE');
        noWrites();
        useWorld();
        const ok = await supporterOrder(null, [line(B.S5)]);
        expect(ok.status).toBe(200);
        expect(writtenOrder()).toMatchObject({ source: 'storefront', status: 'pending', campaign_id: null });
        expect(writtenLines()[0].item_role).toBe('main');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('30–33 · paper / manual and staff orders obey the SAME rules (D7)', () => {
    it.each([
        ['30 · Serves 5', 'S5'],
        ['31 · Serves 2', 'S2'],
    ])('%s + the campaign add-on → accepted on the coordinator manual-order route', async (_l, key) => {
        const res = await coordinatorOrder([{ bundleId: B[key].id, quantity: 1 }, { bundleId: B.ADDON.id, quantity: 2, name: 'FREE' }]);
        expect(res.status).toBe(200);
        expect(writtenLines().map((l) => [l.bundle_id, l.item_role, l.item_name, l.unit_price])).toEqual([
            [B[key].id, 'main', B[key].name, Number(B[key].price)],
            [B.ADDON.id, 'addon', 'Sides & Dessert Bundle', 25],
        ]);
        expect(writtenOrder().total_amount).toBe(Number(B[key].price) + 50);
        // written under the campaign lock, after the same recheck as the supporter route
        expect(mock.client.$transaction).toHaveBeenCalledTimes(1);
        expect(mock.callsTo('campaignAddOn.findUnique')).toHaveLength(2);
        const lock = mock.calls.findIndex((c) => c.model === '$executeRawUnsafe');
        const recheck = mock.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.model === 'campaignAddOn')[1].i;
        const write = mock.calls.findIndex((c) => c.model === 'order' && c.method === 'create');
        expect(lock).toBeGreaterThanOrEqual(0);
        expect(mock.calls[lock].args.values).toEqual([`freezeriq:campaign-bundle-selection:${CAMP_LEGACY}`]);
        expect(recheck).toBeGreaterThan(lock);
        expect(write).toBeGreaterThan(recheck);
    });

    it('32 · an add-on-only paper order → 400 with the safe message, nothing written', async () => {
        const res = await coordinatorOrder([{ bundleId: B.ADDON.id, quantity: 1 }]);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('An add-on must be ordered with at least one meal bundle.');
        expect(mock.callsTo('order.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('the coordinator route refuses unauthorized, cross-tenant, duplicate and manual_upsell lines too', async () => {
        assignments[CAMP_LEGACY] = null;
        expect((await coordinatorOrder([{ bundleId: B.S5.id, quantity: 1 }, { bundleId: B.ADDON.id, quantity: 1 }])).status).toBe(409);
        useWorld();
        expect((await coordinatorOrder([{ bundleId: B.S5.id, quantity: 1 }, { bundleId: B.FOREIGN_ADDON.id, quantity: 1 }])).status).toBe(400);
        useWorld();
        assignments[CAMP_LEGACY] = { business_id: TENANT_A, bundle_id: B.ADDON.id };
        expect((await coordinatorOrder([{ bundleId: B.S5.id, quantity: 1 }, { bundleId: B.ADDON.id, quantity: 1 }, { bundleId: B.ADDON.id, quantity: 1 }])).body.code).toBe('DUPLICATE_ADDON_LINE');
        useWorld();
        expect((await coordinatorOrder([{ bundleId: B.S5.id, quantity: 1 }, { bundleId: 'manual_upsell', quantity: 1 }])).body.code).toBe('MANUAL_UPSELL_NOT_ALLOWED');
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('a coordinator add-on order whose add-on changes before the write → 409, nothing written', async () => {
        addOnReadSequence = [{ business_id: TENANT_A, bundle_id: B.ADDON.id }, null];
        const res = await coordinatorOrder([{ bundleId: B.S2.id, quantity: 1 }, { bundleId: B.ADDON.id, quantity: 1 }]);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ADDON_CHANGED');
        expect(mock.callsTo('order.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('a coordinator order without an add-on keeps its unchanged path (no new transaction)', async () => {
        const res = await coordinatorOrder([{ bundleId: B.S5.id, quantity: 1 }]);
        expect(res.status).toBe(200);
        expect(mock.client.$transaction).not.toHaveBeenCalled();
        expect(writtenLines()[0].item_role).toBe('main');
    });

    it('33 · staff: the tenant manual-order route never links a campaign, so it refuses an add-on; meal orders unchanged', async () => {
        const refused = await staffOrder([{ bundle_id: B.S5.id, quantity: 1 }, { bundle_id: B.ADDON.id, quantity: 1 }]);
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe('ADDON_NOT_AVAILABLE');
        expect(mock.callsTo('order.create')).toHaveLength(0);
        useWorld();
        const ok = await staffOrder([{ bundle_id: B.S2.id, quantity: 2 }]);
        expect(ok.status).toBe(200);
        expect(writtenOrder()).toMatchObject({ source: 'manual', total_amount: 130 });
        expect(writtenOrder().campaign_id).toBeUndefined();
        // Staff entering a FUNDRAISER order do so through the coordinator portal (sections 30–32);
        // this route's POST never writes a campaign link.
        const src = R('app/api/orders/route.ts');
        const post = src.slice(src.indexOf('export async function POST'), src.indexOf('export async function DELETE'));
        expect(post).not.toMatch(/campaign_id/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('20–22, 25, 34 · goal units: the role decides; money still counts', () => {
    it('20 · an add-on line contributes 0 bundle units; 21 · Serves 5 main = 1; 22 · Serves 2 main = 0.5', () => {
        expect(computeBundleUnitsFromItems([{ quantity: 3, variant_size: 'serves_5', item_role: 'addon' }])).toBe(0);
        expect(computeBundleUnitsFromItems([{ quantity: 1, variant_size: 'serves_5', item_role: 'main' }])).toBe(1);
        expect(computeBundleUnitsFromItems([{ quantity: 1, variant_size: 'serves_2', item_role: 'main' }])).toBe(0.5);
        expect(computeBundleUnitsFromItems([
            { quantity: 2, variant_size: 'serves_5', item_role: 'main' },
            { quantity: 3, variant_size: 'serves_2', item_role: 'main' },
            { quantity: 4, variant_size: 'serves_5', item_role: 'addon' },
        ])).toBe(3.5);
        // No fake tier: the weights themselves are untouched.
        expect(getBundleUnitWeight('serves_5')).toBe(1);
        expect(getBundleUnitWeight('serves_2')).toBe(0.5);
        expect(isAddOnItemRole('addon')).toBe(true);
        expect(isAddOnItemRole('main')).toBe(false);
        expect(isAddOnItemRole(undefined)).toBe(false);
    });

    it('34 · historical rows (no role, or the default main) produce exactly the totals they always did', () => {
        const history = [
            { quantity: 4, variant_size: 'serves_5' }, { quantity: 3, variant_size: 'serves_2' },
            { quantity: 1, variant_size: null, serving_tier: 'couple' }, { quantity: 2, variant_size: null, serving_tier: 'family' },
        ];
        const legacyFormula = history.reduce((s, i) => s + i.quantity * getBundleUnitWeight(i.variant_size || i.serving_tier), 0);
        expect(computeBundleUnitsFromItems(history)).toBe(legacyFormula);
        expect(computeBundleUnitsFromItems(history.map((i) => ({ ...i, item_role: 'main' })))).toBe(legacyFormula);
        expect(legacyFormula).toBe(4 + 1.5 + 0.5 + 2);
    });

    it('25 · the add-on is organization revenue: org share, progress money and closeout include it', () => {
        const orders = [{ total_amount: 150, items: [{ quantity: 1, variant_size: 'serves_5', item_role: 'main' }, { quantity: 1, variant_size: 'serves_5', item_role: 'addon' }] }];
        const progress = computeFundraiserProgress(20, 150, orders, 20);
        expect(progress.totalBundlesSold).toBe(1);
        expect(progress.raisedAmount).toBe(30);
        expect(organizationShareAmount(150, 20)).toBe(30);
        const closeout = computeCloseoutFinancials({ grossSales: 150, orgSharePercent: 20, applyFoodTax: true, taxCollected: 10.5, taxRatePercent: 7 });
        expect(closeout).toMatchObject({ grossSales: 150, organizationAmount: 30, baseRemit: 120, taxAmount: 10.5, totalDue: 130.5 });
        const lines = aggregateBundleLines([
            { bundleId: B.S5.id, description: B.S5.name, variantSize: 'serves_5', quantity: 1, unitPrice: 125 },
            { bundleId: B.ADDON.id, description: B.ADDON.name, variantSize: 'serves_5', quantity: 1, unitPrice: 25 },
        ] as any);
        expect(sumLineTotals(lines)).toBe(150);
    });

    it('the coordinator portal data carries the role, so its progress excludes the add-on', () => {
        expect((SUPPORTER_ORDER_SELECT as any).items.select.item_role).toBe(true);
        const shaped = toSupporterOrder({
            id: 'o-1', total_amount: 150, items: [
                { quantity: 1, variant_size: 'serves_2', item_name: 'S2', bundle_id: B.S2.id, item_role: 'main' },
                { quantity: 1, variant_size: 'serves_5', item_name: 'Add-on', bundle_id: B.ADDON.id, item_role: 'addon' },
            ],
        }, null);
        expect(shaped.items.map((i) => i.item_role)).toEqual(['main', 'addon']);
        expect(computeFundraiserProgress(20, 150, [shaped as any], 20).totalBundlesSold).toBe(0.5);
    });

    it('the public scoreboard counts MAIN lines only (the database filters by role)', async () => {
        const { GET } = await import('@/app/api/fundraiser/[token]/route');
        useWorld({ 'fundraiserCampaign.findUnique': { name: 'x', bundle_goal: 20, customer: { name: 'Org' }, orders: [] } });
        const res = await GET(new Request('http://localhost/api/fundraiser/tok') as any, { params: Promise.resolve({ token: 'tok-ao1' }) });
        expect(res.status).toBe(200);
        const select = mock.firstCall('fundraiserCampaign.findUnique')?.args?.select;
        expect(select.orders.select.items.where).toEqual({ item_role: 'main' });
        expect(select.orders.select.items.select).toEqual({ quantity: true, variant_size: true });
    });

    // Every reader of the goal math is registered here with HOW its data carries the role, so a new
    // reader cannot quietly count an add-on: an unregistered caller fails this test.
    const GOAL_READERS: Record<string, { must: RegExp[]; why: string }> = {
        'lib/fundraiserMetrics.ts': { must: [/if \(isAddOnItemRole\(item\.item_role\)\) return sum;/], why: 'the rule itself' },
        'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx': { must: [/oi\.item_role/, /item_role: oi\.item_role/], why: 'public progress (raw SQL)' },
        'app/api/campaigns/route.ts': { must: [/item_role: true/, /item_role: i\.item_role/], why: 'tenant CRM weighted_bundles_sold + health pace' },
        // SUPERSEDED PIN (S2): the call now spans lines (S2 passes the add-on's recorded money as a 5th
        // argument), so the pattern allows whitespace after the parenthesis. Same three arguments first.
        'app/coordinator/portal/page.tsx': { must: [/computeFundraiserProgress\(\s*campaign\.bundle_goal, campaign\.total_sales, campaign\.orders/], why: 'coordinator progress: orders come from SUPPORTER_ORDER_SELECT, which carries item_role' },
        'app/fundraiser/[token]/ScoreboardClient.tsx': { must: [/computeFundraiserProgress\(campaign/], why: 'scoreboard: the route returns main lines only' },
        'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx': { must: [/computeBundleUnitsFromItems\(/], why: 'thank-you count from the page\'s own meal lines; the add-on card is S4' },
        'lib/supporterBundleDetail.ts': { must: [/getBundleUnitWeight\(/], why: 'a meal bundle card\'s own goal credit; add-on display is S4' },
        'components/coordinator/ProgressHero.tsx': { must: [], why: 'comment reference only' },
        'lib/bundleSummary.ts': { must: [], why: 'comment reference only (physical counts; add-on display is S3)' },
        'lib/growth/health.ts': { must: [], why: 'comment reference only; consumes weighted_bundles_sold from app/api/campaigns/route.ts' },
        'lib/serving_multipliers.ts': { must: [], why: 'comment reference only' },
        'lib/campaignAddOns.ts': { must: [], why: 'comment reference only (isAddOnItemRole, which the rule imports, lives here)' },
    };
    it('static sweep · every goal-math reader is registered and carries the role', () => {
        const found = execSync('git grep -l -E "computeBundleUnitsFromItems|computeFundraiserProgress|getBundleUnitWeight" -- app lib components', { cwd: ROOT, encoding: 'utf8' })
            .split('\n').map((s) => s.trim()).filter(Boolean).sort();
        expect(found).toEqual(Object.keys(GOAL_READERS).sort());
        for (const [rel, { must }] of Object.entries(GOAL_READERS)) {
            const src = R(rel);
            for (const re of must) expect(src).toMatch(re);
            if (must.length === 0) {
                // A comment-only reference: every line naming the goal math is a comment line.
                const naming = src.split('\n').filter((l) => /computeBundleUnitsFromItems|computeFundraiserProgress|getBundleUnitWeight/.test(l));
                for (const l of naming) expect(l.trim()).toMatch(/^(\*|\/\/|\/\*)/);
            }
        }
        // Raw SQL over order lines that feeds progress must select the role.
        const rawReaders = execSync('git grep -l -E "oi\\.variant_size" -- app lib components', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
        for (const rel of rawReaders) expect(R(rel)).toMatch(/oi\.item_role/);
        expect(R('app/api/fundraiser/[token]/route.ts')).toContain("...({ where: { item_role: 'main' } } as {})");
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('boundaries · one authority, nothing else moved', () => {
    it('every order path takes its add-on rules from lib/campaignAddOns.ts', () => {
        for (const rel of ['app/api/public/order/route.ts', 'app/api/coordinator/route.ts', 'app/api/orders/route.ts', 'app/api/checkout/session/route.ts']) {
            const src = R(rel);
            expect(src).toContain("from '@/lib/campaignAddOns'");
            expect(src).toMatch(/classifyFundraiserOrderLines\(\{/);
        }
        // The two campaign writers recheck under the lock and persist the server's role.
        expect(R('app/api/public/order/route.ts')).toMatch(/item_role: lineRoles\.roles\[index\]/);
        expect(R('app/api/coordinator/route.ts')).toMatch(/\.\.\.\(\{ item_role: item\.itemRole \} as \{\}\)/);
        for (const rel of ['app/api/public/order/route.ts', 'app/api/coordinator/route.ts']) {
            expect(R(rel)).toMatch(/assertCampaignAddOnUnchanged\(tx, \{/);
            expect(R(rel)).toMatch(/validateBundleEligibility\(bundleMode, mainBundleIds\)/);
        }
    });

    it.each([
        'lib/campaignOrderBundles.ts', 'lib/campaignBundleSelection.ts', 'lib/campaignBundleOverride.ts',
        'app/api/coordinator/bundle-selection/route.ts', 'lib/campaignSelectionLock.ts', 'lib/pricing.ts',
        'lib/serving_multipliers.ts', 'lib/kitchen_engine.ts', 'lib/fundraiserTax.ts', 'lib/fundraiserOrgShare.ts',
        'lib/orderItemTier.ts',
        // (lib/publicFundraiserPayload.ts and FundraiserClient.tsx — SUPERSEDED PINS (S4): the public supporter
        //  page now offers the add-on; checked as history below.)
    ])('%s is byte-identical to Production e9f0f4a', (rel) => {
        const out = execSync(`git diff --name-only e9f0f4a -- "${rel}"`, { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });

    // SUPERSEDED PINS (FR-SUPPORTER-ADDON-UPSELL-1 S2, owner-approved): S2 deliberately changes these three
    // — the closeout money model gains the add-on's recorded share, and the Bundle Editor gains the
    // Meal / Fundraiser add-on choice. What S1 promised still holds as history: S1 itself (e9f0f4a..4f93b3a)
    // did not touch them. tests/supporterAddOnS2.test.ts pins what S2 changed.
    it.each([
        'lib/fundraiserCloseoutMath.ts', 'components/BundleEditor.tsx', 'app/api/campaigns/[id]/closeout/route.ts',
        // SUPERSEDED PINS (FR-SUPPORTER-ADDON-UPSELL-1 S3, owner-approved 2026-11-24): S3 shows add-on lines correctly
        // in the emails, adds the add-on row to the flyer and one stable organization-share label to QuickBooks.
        'lib/quickbooks/invoicePayload.ts', 'lib/generateFlyer.ts', 'lib/email.ts',
        // SUPERSEDED PINS (FR-SUPPORTER-ADDON-UPSELL-1 S4, owner-approved 2026-11-24): S4 is the public supporter
        // card — the page receives the add-on through a new include-list and offers it inline.
        'lib/publicFundraiserPayload.ts', 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx',
    ])('%s was not changed by S1 (e9f0f4a..4f93b3a)', (rel) => {
        const out = execSync(`git diff --name-only e9f0f4a 4f93b3a -- "${rel}"`, { cwd: ROOT, encoding: 'utf8' });
        expect(out.trim()).toBe('');
    });
});
