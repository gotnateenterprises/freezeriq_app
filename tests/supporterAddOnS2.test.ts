/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — S2: Bundle Editor add-on type, campaign add-on assignment, the tenant's
 * campaign-specific MARGINAL add-on share schedule, the share each order EARNS (frozen per tier slice),
 * closeout, the coordinator's read-only display and the coordinator's paper-order add-on row.
 *
 * The route sections execute the REAL handlers (tenant add-on route, supporter order, coordinator order
 * and portal read, closeout, bundle create / update / delete / Make Serves 2, lineup writer) against the
 * recording Prisma double in tests/helpers/routeHarness.ts, backed here by a small in-memory fictional
 * world so a sequence of orders really accumulates add-on units and recorded slices.
 *
 * Every name, id and address is fictional (the repository is public).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    defaultShareTiers,
    describeShareScheduleForCoordinator,
    describeShareTierRanges,
    nextAddOnRate,
    parseShareTierSchedule,
    percentForUnit,
    shareAmountCents,
    splitAddOnLineIntoSlices,
    validateShareScheduleEdit,
} from '@/lib/campaignAddOnShare';
import { computeCloseoutFinancials, summarizeAddOnEarnings } from '@/lib/fundraiserCloseoutMath';
import { computeFundraiserProgress } from '@/lib/fundraiserMetrics';
import { organizationShareAmount } from '@/lib/fundraiserOrgShare';
import { parseRequestedBundleType, shapeBundleWriteForType } from '@/lib/bundleTypeRules';
import { bundleDeletionRefusal } from '@/lib/bundleDeletion';
import { countCampaignAddOnUnitsSold, loadCoordinatorAddOnView } from '@/lib/campaignAddOnEarnings';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ao2Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__ao2Session ?? null) }));
jest.mock('@/lib/email', () => ({
    sendOrderConfirmationEmail: jest.fn(async () => true),
    sendFundraiserCoordinatorNotification: jest.fn(async () => true),
    sendLeadNotificationEmail: jest.fn(async () => true),
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__ao2CookieName ? { name, value: 'ao2-coordinator-secret' } : undefined),
    }),
}));
jest.mock('@/lib/stripe', () => ({ stripe: {} }));
jest.mock('@/lib/customerAuth', () => ({ getCustomerSession: jest.fn(async () => null) }));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const S1_HEAD = '4f93b3a';
const atS1 = (p: string) => execSync(`git show ${S1_HEAD}:"${p}"`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).replace(/\r\n/g, '\n');

// ── The fictional world ─────────────────────────────────────────────────────────────────────────
const TENANT_A = 'biz-ao2-aaaa';
const TENANT_B = 'biz-ao2-bbbb';
const ORG_A = 'org-ao2-riverside';
const ORG_B = 'org-ao2-elsewhere';
const CAMP_A = 'camp-ao2-a';
const CAMP_A2 = 'camp-ao2-a2';
const CAMP_CLOSED = 'camp-ao2-closed';
const CAMP_FOREIGN = 'camp-ao2-foreign';

type BundleRow = {
    id: string; name: string; price: string | null; serving_tier: string; family_id: string | null; is_active: boolean;
    business_id: string; bundle_type: 'meal' | 'addon'; show_on_storefront: boolean; contentCount: number; sku: string;
};
const bundle = (o: Partial<BundleRow> & { id: string; name: string }): BundleRow => ({
    price: '125.00', serving_tier: 'family', family_id: null, is_active: true, business_id: TENANT_A,
    bundle_type: 'meal', show_on_storefront: true, contentCount: 3, sku: o.id.toUpperCase(), ...o,
});
const B = {
    S5: bundle({ id: 'b-ao2-s5', name: 'Comfort Foods (Serves 5)', family_id: 'fam-ao2-1' }),
    S2: bundle({ id: 'b-ao2-s2', name: 'Comfort Foods (Serves 2)', price: '65.00', serving_tier: 'serves_2', family_id: 'fam-ao2-1' }),
    SOLO: bundle({ id: 'b-ao2-solo', name: 'Soup Sampler', price: '40.00', show_on_storefront: false }),
    ADDON: bundle({ id: 'b-ao2-addon', name: 'Sides & Dessert Bundle', price: '25.00', bundle_type: 'addon', show_on_storefront: false }),
    ADDON2: bundle({ id: 'b-ao2-addon-2', name: 'Holiday Pie Add-On', price: '18.00', bundle_type: 'addon', show_on_storefront: false }),
    ADDON_NOPRICE: bundle({ id: 'b-ao2-addon-np', name: 'Unpriced Add-On', price: null, bundle_type: 'addon', show_on_storefront: false }),
    ADDON_EMPTY: bundle({ id: 'b-ao2-addon-empty', name: 'Empty Add-On', price: '12.00', bundle_type: 'addon', show_on_storefront: false, contentCount: 0 }),
    ADDON_OFF: bundle({ id: 'b-ao2-addon-off', name: 'Retired Add-On', price: '10.00', bundle_type: 'addon', show_on_storefront: false, is_active: false }),
    FOREIGN_ADDON: bundle({ id: 'b-ao2-foreign', name: 'Another Kitchen Add-On', price: '9.00', bundle_type: 'addon', show_on_storefront: false, business_id: TENANT_B }),
};
const ALL_BUNDLES: BundleRow[] = Object.values(B);
const findBundle = (id: string) => ALL_BUNDLES.find((b) => b.id === id) ?? null;

const campaignRow = (id: string, over: Record<string, any> = {}) => ({
    id, name: 'Riverside Boosters (fixture) Fundraiser', status: 'Active', closed_at: null, end_date: null,
    bundle_selection_status: 'not_required', bundle_selection_limit: 1, org_share_percent: '20.00',
    payment_instructions: null, external_payment_link: null, checks_payable: null, payment_methods: null,
    tax_status: null, tax_rate_percent: null, settlement_total: null, total_sales: 0, bundle_goal: 50,
    customer_id: ORG_A,
    customer: {
        id: ORG_A, business_id: TENANT_A, name: 'Riverside Boosters (fixture)', contact_email: 'coord@example.invalid',
        business: { timezone: 'America/Chicago', plan: 'FREE', id: TENANT_A, name: 'Example Kitchen', slug: 'tenant-a' },
    },
    orders: [],
    ...over,
});

interface World {
    campaigns: Record<string, any>;
    assignments: Array<{ id: string; business_id: string; customer_id: string; campaign_id: string; bundle_id: string }>;
    tiers: Array<{ campaign_add_on_id: string; starting_quantity: number; percent: number }>;
    orders: Array<{ id: string; campaign_id: string | null; canceled_at: Date | null; total_amount: number; tax_amount: number }>;
    items: Array<{ id: string; order_id: string; bundle_id: string | null; quantity: number; unit_price: number; item_role: string; variant_size: string; item_name: string | null }>;
    slices: Array<{ order_item_id: string; first_unit: number; quantity: number; percent: number; unit_price: number; share_amount: number }>;
    lineups: Array<{ campaign_id: string; bundle_id: string; state: string }>;
}
let W: World;
let mock: PrismaMock;
let seq = 0;
const nextId = (p: string) => `${p}-ao2-${++seq}`;

const tiersOf = (addOnId: string) => W.tiers
    .filter((t) => t.campaign_add_on_id === addOnId)
    .sort((a, b) => a.starting_quantity - b.starting_quantity)
    .map((t) => ({ starting_quantity: t.starting_quantity, percent: t.percent }));
const orderOf = (orderId: string) => W.orders.find((o) => o.id === orderId);
const itemShape = (it: World['items'][number]) => ({
    ...it,
    bundle: it.bundle_id ? { ...findBundle(it.bundle_id)!, name: findBundle(it.bundle_id)!.name } : null,
    add_on_shares: W.slices.filter((s) => s.order_item_id === it.id),
});
const itemMatches = (it: World['items'][number], where: any): boolean => {
    if (where?.order_id !== undefined && it.order_id !== where.order_id) return false;
    if (where?.item_role !== undefined && it.item_role !== where.item_role) return false;
    if (where?.order) {
        const o = orderOf(it.order_id);
        if (!o) return false;
        if (where.order.campaign_id !== undefined && o.campaign_id !== where.order.campaign_id) return false;
        if (where.order.canceled_at === null && o.canceled_at !== null) return false;
        if (where.order.id?.not !== undefined && o.id === where.order.id.not) return false;
    }
    return true;
};
const bundleView = (b: BundleRow) => ({ ...b, _count: { contents: b.contentCount } });

function useWorld(extra: Record<string, any> = {}) {
    mock = createPrismaMock({
        results: {
            'business.findFirst': { id: TENANT_A, slug: 'tenant-a', timezone: 'America/Chicago', name: 'Example Kitchen' },
            'user.findFirst': { id: 'user-ao2-admin' },
            'bundle.findMany': (args: any) => ALL_BUNDLES
                .filter((b) => !args?.where?.id?.in || args.where.id.in.includes(b.id))
                .filter((b) => args?.where?.business_id === undefined || b.business_id === args.where.business_id)
                .filter((b) => args?.where?.is_active === undefined || b.is_active === args.where.is_active)
                .filter((b) => args?.where?.bundle_type === undefined || b.bundle_type === args.where.bundle_type)
                .filter((b) => args?.where?.show_on_storefront === undefined || b.show_on_storefront === args.where.show_on_storefront)
                .map(bundleView),
            'bundle.findFirst': (args: any) => {
                const b = findBundle(args?.where?.id);
                if (!b || (args?.where?.business_id !== undefined && b.business_id !== args.where.business_id)) return null;
                return bundleView(b);
            },
            'bundle.findUnique': (args: any) => { const b = findBundle(args?.where?.id); return b ? { ...bundleView(b), contents: [] } : null; },
            'campaignAddOn.findUnique': (args: any) => {
                const a = W.assignments.find((x) => x.campaign_id === args?.where?.campaign_id);
                if (!a) return null;
                const b = findBundle(a.bundle_id);
                return { ...a, bundle: b ? { ...b } : null, share_tiers: tiersOf(a.id) };
            },
            'campaignAddOn.create': (args: any) => {
                const d = args.data;
                const row = { id: nextId('cao'), business_id: d.business_id, customer_id: d.customer_id, campaign_id: d.campaign_id, bundle_id: d.bundle_id };
                W.assignments.push(row);
                for (const t of d.share_tiers?.create ?? []) W.tiers.push({ campaign_add_on_id: row.id, starting_quantity: t.starting_quantity, percent: Number(t.percent) });
                return row;
            },
            'campaignAddOn.update': (args: any) => {
                const a = W.assignments.find((x) => x.id === args.where.id)!;
                Object.assign(a, args.data);
                return a;
            },
            'campaignAddOn.deleteMany': (args: any) => {
                const gone = W.assignments.filter((x) => x.campaign_id === args.where.campaign_id && x.business_id === args.where.business_id);
                W.assignments = W.assignments.filter((x) => !gone.includes(x));
                W.tiers = W.tiers.filter((t) => !gone.some((g) => g.id === t.campaign_add_on_id));
                return { count: gone.length };
            },
            'campaignAddOn.count': (args: any) => W.assignments.filter((x) => x.bundle_id === args?.where?.bundle_id).length,
            'campaignAddOnShareTier.deleteMany': (args: any) => {
                const before = W.tiers.length;
                W.tiers = W.tiers.filter((t) => !(t.campaign_add_on_id === args.where.campaign_add_on_id && args.where.starting_quantity.in.includes(t.starting_quantity)));
                return { count: before - W.tiers.length };
            },
            'campaignAddOnShareTier.create': (args: any) => {
                W.tiers.push({ campaign_add_on_id: args.data.campaign_add_on_id, starting_quantity: args.data.starting_quantity, percent: Number(args.data.percent) });
                return args.data;
            },
            'campaignAddOnShareTier.updateMany': (args: any) => {
                const hit = W.tiers.filter((t) => t.campaign_add_on_id === args.where.campaign_add_on_id && t.starting_quantity === args.where.starting_quantity);
                for (const t of hit) t.percent = Number(args.data.percent);
                return { count: hit.length };
            },
            'campaignBundle.count': (args: any) => W.lineups.filter((l) => {
                if (l.bundle_id !== args?.where?.bundle_id) return false;
                const c = W.campaigns[l.campaign_id];
                return Boolean(c) && c.closed_at === null && !['Closed', 'Settled', 'Completed', 'Archived'].includes(c.status);
            }).length,
            'campaignBundle.findMany': [],
            'fundraiserCampaign.findUnique': (args: any) => W.campaigns[args?.where?.id] ?? null,
            'fundraiserCampaign.findFirst': (args: any) => W.campaigns[args?.where?.id] ?? null,
            'fundraiserCampaign.updateMany': { count: 1 },
            'customer.findFirst': null,
            'order.findFirst': null,
            'order.create': (args: any) => {
                const d = args.data;
                const id = nextId('order');
                W.orders.push({ id, campaign_id: d.campaign_id ?? null, canceled_at: null, total_amount: Number(d.total_amount) || 0, tax_amount: Number(d.tax_amount) || 0 });
                const lines = Array.isArray(d.items?.create) ? d.items.create : [d.items?.create].filter(Boolean);
                const created = lines.map((l: any) => {
                    const it = {
                        id: nextId('item'), order_id: id, bundle_id: l.bundle_id ?? null, quantity: l.quantity,
                        unit_price: Number(l.unit_price) || 0, item_role: l.item_role ?? 'main', variant_size: l.variant_size ?? 'serves_5', item_name: l.item_name ?? null,
                    };
                    W.items.push(it);
                    return it;
                });
                return { id, external_id: `ext-${id}`, ...d, items: created.map(itemShape) };
            },
            'order.findMany': (args: any) => W.orders
                .filter((o) => args?.where?.campaign_id === undefined || o.campaign_id === args.where.campaign_id)
                .filter((o) => args?.where?.canceled_at !== null || o.canceled_at === null)
                .map((o) => ({ ...o, items: W.items.filter((it) => it.order_id === o.id).map(itemShape) })),
            'orderItem.findMany': (args: any) => W.items.filter((it) => itemMatches(it, args?.where)).map(itemShape),
            'orderItem.aggregate': (args: any) => ({
                _sum: { quantity: W.items.filter((it) => itemMatches(it, args?.where)).reduce((s, it) => s + it.quantity, 0) || null },
            }),
            'orderItemAddOnShare.createMany': (args: any) => {
                for (const s of args.data) W.slices.push({ ...s, percent: Number(s.percent), unit_price: Number(s.unit_price), share_amount: Number(s.share_amount) });
                return { count: args.data.length };
            },
            'coordinatorSession.findUnique': () => ({
                id: 'session-ao2', campaign_id: (global as any).__ao2CoordinatorCampaign ?? CAMP_A,
                expires_at: new Date(Date.now() + 3_600_000), revoked_at: null,
            }),
            'fundraiserCampaignCoordinator.findUnique': null,
            $queryRaw: [],
            ...extra,
        },
    });
    // Closeout writes the campaign's DRAFT invoice; the shared harness has no invoice model.
    const invoiceCalls: any[] = [];
    mock.client.invoice = {
        create: jest.fn(async (args: any) => { invoiceCalls.push(args); mock.calls.push({ model: 'invoice', method: 'create', args }); return { id: 'inv-ao2-1' }; }),
        findFirst: jest.fn(async () => null),
    };
    // Bundle deletion counts invoice lines that point at the bundle (none in this world).
    mock.client.invoiceItem = { count: jest.fn(async () => 0) };
    (global as any).__ao2Prisma = mock.client;
}

beforeAll(() => { for (const k of ['log', 'warn', 'error', 'info'] as const) jest.spyOn(console, k).mockImplementation(() => undefined); });
beforeEach(() => {
    jest.resetModules();
    seq = 0;
    W = {
        campaigns: {
            [CAMP_A]: campaignRow(CAMP_A),
            [CAMP_A2]: campaignRow(CAMP_A2, { org_share_percent: '25.00' }),
            [CAMP_CLOSED]: campaignRow(CAMP_CLOSED, { status: 'Closed', closed_at: new Date('2026-11-01T00:00:00Z') }),
            [CAMP_FOREIGN]: campaignRow(CAMP_FOREIGN, {
                customer_id: ORG_B,
                customer: { id: ORG_B, business_id: TENANT_B, name: 'Elsewhere Club (fixture)', business: { timezone: 'America/Chicago', plan: 'FREE', id: TENANT_B } },
            }),
        },
        assignments: [], tiers: [], orders: [], items: [], slices: [], lineups: [],
    };
    (global as any).__ao2Session = { user: { businessId: TENANT_A, role: 'ADMIN', id: 'user-ao2-admin' } };
    (global as any).__ao2CookieName = coordinatorSessionCookieName();
    (global as any).__ao2CoordinatorCampaign = CAMP_A;
    useWorld();
});

/** Assign an add-on directly in the world (fixture setup, not under test). */
function seedAssignment(campaignId: string, bundleId: string, tiers: Array<[number, number]>) {
    const id = nextId('cao');
    W.assignments.push({ id, business_id: TENANT_A, customer_id: W.campaigns[campaignId].customer_id, campaign_id: campaignId, bundle_id: bundleId });
    for (const [start, pct] of tiers) W.tiers.push({ campaign_add_on_id: id, starting_quantity: start, percent: pct });
    return id;
}

// ── Route helpers ───────────────────────────────────────────────────────────────────────────────
async function addOnRoute(method: 'GET' | 'PUT' | 'DELETE' | 'PATCH', campaignId: string, body?: unknown) {
    const mod: any = await import('@/app/api/campaigns/[id]/add-on/route');
    const req = new Request(`http://localhost/api/campaigns/${campaignId}/add-on`, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return readJson(await mod[method](req, { params: Promise.resolve({ id: campaignId }) }));
}
const SUPPORTER = { firstName: 'Dana', lastName: 'Fields', email: 'dana.fields@example.test', phone: '(309) 555-0142' };
const line = (b: BundleRow, quantity = 1, over: Record<string, any> = {}) =>
    ({ bundleId: b.id, quantity, serving_tier: b.serving_tier, name: b.name, ...over });
async function supporterOrder(campaignId: string, items: any[]) {
    const { POST } = await import('@/app/api/public/order/route');
    return readJson(await POST(jsonRequest('http://localhost/api/public/order', {
        slug: 'tenant-a', campaignId, customer: { ...SUPPORTER }, items,
    }) as any));
}
async function coordinatorOrder(items: any[], campaignId = CAMP_A) {
    (global as any).__ao2CoordinatorCampaign = campaignId;
    const { POST } = await import('@/app/api/coordinator/route');
    const req = new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ customerName: 'Paper Order (fixture)', participantName: 'Team A', items, totalAmount: 0.01, deliveryAddress: null, phone: null }),
    });
    return readJson(await POST(req as any));
}
async function closeout(campaignId: string) {
    const { POST } = await import('@/app/api/campaigns/[id]/closeout/route');
    const req = new Request(`http://localhost/api/campaigns/${campaignId}/closeout`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ applyFoodTax: false }),
    });
    return readJson(await POST(req, { params: Promise.resolve({ id: campaignId }) }));
}
const slicesOf = (orderId: string) => W.slices
    .filter((s) => W.items.find((it) => it.id === s.order_item_id)?.order_id === orderId)
    .map((s) => ({ first_unit: s.first_unit, quantity: s.quantity, percent: s.percent, share_amount: s.share_amount }));
const writes = () => mock.calls.filter((c) =>
    ['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].includes(c.method)
    && ['campaignAddOn', 'campaignAddOnShareTier', 'orderItemAddOnShare', 'order', 'invoice', 'bundle'].includes(c.model));
const lockIndex = (campaignId: string) => mock.calls.findIndex((c) =>
    c.model === '$executeRawUnsafe' && JSON.stringify(c.args.values).includes(`freezeriq:campaign-bundle-selection:${campaignId}`));
const firstIndex = (pred: (c: any) => boolean) => mock.calls.findIndex(pred);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('schema / migration · additive, relational, database-enforced', () => {
    const MIGRATION = 'prisma/migrations/20261124120000_supporter_addon_s2/migration.sql';
    const sql = R(MIGRATION);
    const schema = R('prisma/schema.prisma');
    const block = (model: string) => schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf('\n}', schema.indexOf(`model ${model} {`)));
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

    it('creates exactly two tables, two indexes, two foreign keys and five CHECKs — nothing else', () => {
        expect(code).not.toMatch(/\b(DROP|RENAME|TRUNCATE)\b|ALTER COLUMN|^\s*(DELETE|UPDATE|INSERT)\b/im);
        const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
        expect(statements).toHaveLength(11);
        for (const s of statements) {
            expect(s).toMatch(/^(CREATE TABLE "(campaign_add_on_share_tiers|order_item_add_on_shares)"|CREATE UNIQUE INDEX "(campaign_add_on_share_tiers_one_per_start|order_item_add_on_shares_one_per_slice)"|ALTER TABLE "(campaign_add_on_share_tiers|order_item_add_on_shares|bundles)" ADD CONSTRAINT)/);
        }
    });

    it('the tier and earnings CHECKs match the org-share range; an add-on can never be on the storefront', () => {
        expect(sql).toMatch(/"campaign_add_on_share_tiers_start_check"\s+CHECK \("starting_quantity" >= 1\)/);
        expect(sql).toMatch(/"campaign_add_on_share_tiers_percent_check"\s+CHECK \("percent" >= 0 AND "percent" <= 100\)/);
        expect(sql).toMatch(/"order_item_add_on_shares_slice_check"\s+CHECK \("first_unit" >= 1 AND "quantity" >= 1\)/);
        expect(sql).toMatch(/"order_item_add_on_shares_money_check"\s+CHECK \("percent" >= 0 AND "percent" <= 100 AND "unit_price" >= 0 AND "share_amount" >= 0\)/);
        expect(sql).toMatch(/"bundles_addon_not_on_storefront"\s+CHECK \("bundle_type" = 'meal' OR "show_on_storefront" = false\)/);
        expect(sql).toContain('"percent" DECIMAL(5,2) NOT NULL');
        expect(block('FundraiserCampaign')).toContain('org_share_percent     Decimal    @default(20.00) @db.Decimal(5, 2)');
    });

    it('3 · the schedule belongs to the CAMPAIGN add-on (cascade with its assignment), never to the Bundle', () => {
        const tier = block('CampaignAddOnShareTier');
        expect(tier).toContain('campaign_add_on CampaignAddOn @relation(fields: [campaign_add_on_id], references: [id], onDelete: Cascade)');
        expect(tier).not.toMatch(/bundle_id|Bundle\s+@relation/);
        expect(sql).toContain('FOREIGN KEY ("campaign_add_on_id") REFERENCES "campaign_add_ons"("id") ON DELETE CASCADE');
        // No share or percent FIELD on Bundle (a comment saying "Shared opaque key" is not a field).
        expect(block('Bundle')).not.toMatch(/^\s+\w*(share|percent)\w*\s+(Decimal|Int|String|Float)/im);
    });

    it('earnings are a relational per-slice record on the order line — not JSON, not one percent per line', () => {
        const share = block('OrderItemAddOnShare');
        for (const col of ['first_unit    Int', 'quantity      Int', 'percent       Decimal  @db.Decimal(5, 2)', 'unit_price    Decimal  @db.Decimal(10, 2)', 'share_amount  Decimal  @db.Decimal(10, 2)']) {
            expect(share).toContain(col);
        }
        expect(share).not.toMatch(/Json/);
        expect(block('OrderItem')).not.toMatch(/percent|share_amount/);
        expect(sql).toContain('FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE');
    });

    it('it is the newest migration; S1\'s migration is byte-identical to S1', () => {
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        expect(dirs.slice(-2)).toEqual(['20261123120000_supporter_addon_s1', '20261124120000_supporter_addon_s2']);
        const s1 = 'prisma/migrations/20261123120000_supporter_addon_s1/migration.sql';
        expect(R(s1)).toBe(atS1(s1));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('the schedule · parse, marginal resolution, slicing, locking (pure)', () => {
    const T = (...pairs: Array<[number, number]>) => pairs.map(([startingQuantity, percent]) => ({ startingQuantity, percent }));

    it('5/6 · one tier and several tiers parse, sorted by start', () => {
        expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 20 }])).toEqual({ ok: true, tiers: T([1, 20]) });
        expect(parseShareTierSchedule([{ startingQuantity: '11', percent: '15' }, { startingQuantity: 1, percent: '10.00' }, { startingQuantity: 21, percent: 20 }]))
            .toEqual({ ok: true, tiers: T([1, 10], [11, 15], [21, 20]) });
    });

    it('7 · the first tier must start at 1', () => {
        expect(parseShareTierSchedule([{ startingQuantity: 2, percent: 10 }])).toMatchObject({ ok: false, status: 400, code: 'INVALID_SHARE_TIERS', error: 'The first tier must start at add-on 1.' });
        expect(parseShareTierSchedule([])).toMatchObject({ ok: false, code: 'INVALID_SHARE_TIERS' });
        expect(parseShareTierSchedule(null)).toMatchObject({ ok: false, code: 'INVALID_SHARE_TIERS' });
    });

    it('8 · a duplicate starting number is refused', () => {
        expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }, { startingQuantity: '11', percent: 20 }]))
            .toMatchObject({ ok: false, code: 'INVALID_SHARE_TIERS', error: expect.stringContaining('both start at add-on 11') });
    });

    it('9 · an invalid percentage is refused (range, type, blank) — same rule as org_share_percent', () => {
        for (const percent of [101, -1, 'abc', '', null, true, [10], Infinity]) {
            expect(parseShareTierSchedule([{ startingQuantity: 1, percent }])).toMatchObject({ ok: false, code: 'INVALID_SHARE_TIERS' });
        }
        expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 12.345 }])).toEqual({ ok: true, tiers: T([1, 12.35]) });
        expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 0 }])).toEqual({ ok: true, tiers: T([1, 0]) });
        expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 100 }])).toEqual({ ok: true, tiers: T([1, 100]) });
    });

    it('10 · starting numbers must be positive whole numbers', () => {
        for (const startingQuantity of [0, -3, 1.5, '7a', '2.0', null, undefined, 100_001]) {
            expect(parseShareTierSchedule([{ startingQuantity: 1, percent: 10 }, { startingQuantity, percent: 15 }])).toMatchObject({ ok: false, code: 'INVALID_SHARE_TIERS' });
        }
        expect(parseShareTierSchedule(Array.from({ length: 11 }, (_, i) => ({ startingQuantity: i * 5 + 1, percent: 10 })))).toMatchObject({ ok: false });
    });

    it('11/12 · resolution is MARGINAL: 1–10 @10%, 11+ @15% — reaching a tier never re-rates earlier units', () => {
        const tiers = T([1, 10], [11, 15]);
        expect([1, 9, 10].map((u) => percentForUnit(tiers, u))).toEqual([10, 10, 10]);
        expect([11, 12, 500].map((u) => percentForUnit(tiers, u))).toEqual([15, 15, 15]);
        // Ten add-ons, then five more: the first ten stay at 10% — no retroactive 15%.
        const first = splitAddOnLineIntoSlices({ tiers, soldBefore: 0, quantity: 10, unitPrice: 25 });
        const later = splitAddOnLineIntoSlices({ tiers, soldBefore: 10, quantity: 5, unitPrice: 25 });
        expect(first).toEqual([{ firstUnit: 1, quantity: 10, percent: 10, unitPrice: 25, shareAmount: 25 }]);
        expect(later).toEqual([{ firstUnit: 11, quantity: 5, percent: 15, unitPrice: 25, shareAmount: 18.75 }]);
        // Total for 15 is 10×2.50 + 5×3.75 — never 15 × 3.75 (all-or-nothing) and never 15 × 2.50.
        expect(first[0].shareAmount + later[0].shareAmount).toBe(43.75);
    });

    it('13/14 · one line crossing a threshold is split: 9 sold, then 3 → unit 10 @10%, units 11–12 @15%', () => {
        const tiers = T([1, 10], [11, 15]);
        expect(splitAddOnLineIntoSlices({ tiers, soldBefore: 9, quantity: 3, unitPrice: 25 })).toEqual([
            { firstUnit: 10, quantity: 1, percent: 10, unitPrice: 25, shareAmount: 2.5 },
            { firstUnit: 11, quantity: 2, percent: 15, unitPrice: 25, shareAmount: 7.5 },
        ]);
        // Boundaries exactly: 10 then 1, and a line spanning three tiers.
        expect(splitAddOnLineIntoSlices({ tiers, soldBefore: 0, quantity: 10, unitPrice: 25 })).toHaveLength(1);
        expect(splitAddOnLineIntoSlices({ tiers, soldBefore: 10, quantity: 1, unitPrice: 25 })[0]).toMatchObject({ firstUnit: 11, percent: 15 });
        expect(splitAddOnLineIntoSlices({ tiers: T([1, 10], [11, 15], [21, 20]), soldBefore: 8, quantity: 15, unitPrice: 25 })
            .map((s) => [s.firstUnit, s.quantity, s.percent])).toEqual([[9, 2, 10], [11, 10, 15], [21, 3, 20]]);
    });

    it('share cents are exact integer math, rounded half-up', () => {
        expect(shareAmountCents(3, 24.99, 15)).toBe(1125);   // 11.2455 → $11.25
        expect(shareAmountCents(1, 0.05, 10)).toBe(1);       // 0.005 → $0.01
        expect(shareAmountCents(1, 0.04, 10)).toBe(0);       // 0.004 → $0.00
        expect(shareAmountCents(7, 25, 12.5)).toBe(2188);    // 21.875 → $21.88
    });

    it('16/17/18 · locking: tiers reached by sold add-ons are frozen; future tiers are free', () => {
        const current = T([1, 10], [11, 15]);
        // 7 sold: tier 1 is in use.
        expect(validateShareScheduleEdit({ current, next: T([1, 5], [11, 15]), unitsSold: 7 })).toMatchObject({ ok: false, status: 409, code: 'SHARE_TIER_LOCKED' });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [11, 20]), unitsSold: 7 })).toMatchObject({ ok: true });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [8, 12], [11, 15]), unitsSold: 7 })).toMatchObject({ ok: true });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [5, 12], [11, 15]), unitsSold: 7 })).toMatchObject({ ok: false, code: 'SHARE_TIER_LOCKED' });
        expect(validateShareScheduleEdit({ current, next: T([1, 10]), unitsSold: 7 })).toMatchObject({ ok: true });
        // 14 sold: 1–10 AND 11+ are both in use; 21+ may be added.
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [11, 12]), unitsSold: 14 })).toMatchObject({ ok: false, code: 'SHARE_TIER_LOCKED' });
        expect(validateShareScheduleEdit({ current, next: T([1, 10]), unitsSold: 14 })).toMatchObject({ ok: false, code: 'SHARE_TIER_LOCKED' });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [11, 15], [21, 20]), unitsSold: 14 })).toMatchObject({ ok: true });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [11, 15], [15, 20]), unitsSold: 14 })).toMatchObject({ ok: true });
        expect(validateShareScheduleEdit({ current, next: T([1, 10], [11, 15], [14, 20]), unitsSold: 14 })).toMatchObject({ ok: false });
        // Nothing sold: everything is editable.
        expect(validateShareScheduleEdit({ current, next: T([1, 5]), unitsSold: 0 })).toMatchObject({ ok: true });
    });

    it('ranges, lock labels, the next rate and the coordinator sentence are plain language', () => {
        const rows = describeShareTierRanges(T([1, 10], [11, 15], [21, 20]), 18);
        expect(rows.map((r) => [r.rangeLabel, r.lock])).toEqual([['1–10 sold', 'locked'], ['11–20 sold', 'locked_for_sold'], ['21+ sold', 'editable']]);
        expect(describeShareTierRanges(T([1, 10], [11, 15], [12, 20]), 0).map((r) => r.rangeLabel)).toEqual(['1–10 sold', '11 sold', '12+ sold']);
        expect(nextAddOnRate(T([1, 10], [11, 15], [21, 20]), 18)).toEqual({ nextUnit: 19, percent: 15, nextTierStart: 21, nextTierPercent: 20 });
        expect(describeShareScheduleForCoordinator(T([1, 10]))).toBe('Your organization earns 10% on this add-on.');
        expect(describeShareScheduleForCoordinator(T([1, 10], [11, 15]))).toBe('Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11.');
        expect(describeShareScheduleForCoordinator(T([1, 10], [11, 15], [21, 20]))).toBe('Your organization earns 10% on the first 10 add-ons, 15% on add-ons 11–20 and 20% beginning with add-on 21.');
        expect(describeShareScheduleForCoordinator(T([1, 10], [2, 12.5]))).toBe('Your organization earns 10% on the first add-on and 12.5% beginning with add-on 2.');
        for (const text of [describeShareScheduleForCoordinator(T([1, 10], [11, 15])), ...rows.map((r) => r.rangeLabel)]) {
            expect(text).not.toMatch(/tier|starting quantity|threshold/i);
        }
    });

    it('1 · the default schedule is ONE tier at the campaign\'s current meal share', () => {
        expect(defaultShareTiers('20.00')).toEqual(T([1, 20]));
        expect(defaultShareTiers(12.5)).toEqual(T([1, 12.5]));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('campaign add-on assignment · the tenant route', () => {
    it('1 · first assignment inherits the campaign\'s CURRENT meal share as one tier (unit 1+)', async () => {
        const r = await addOnRoute('PUT', CAMP_A2, { bundleId: B.ADDON.id });
        expect(r.status).toBe(200);
        const create = mock.firstCall('campaignAddOn.create')!.args.data;
        expect(create).toMatchObject({ business_id: TENANT_A, customer_id: ORG_A, campaign_id: CAMP_A2, bundle_id: B.ADDON.id, created_by: 'user-ao2-admin' });
        expect(create.share_tiers.create).toEqual([{ starting_quantity: 1, percent: 25 }]);
        expect(r.body.addOn).toMatchObject({ bundleId: B.ADDON.id, name: 'Sides & Dessert Bundle', price: 25, sellable: true });
        expect(r.body.addOn.tiers).toEqual([{ startingQuantity: 1, percent: 25, endQuantity: null, rangeLabel: '1+ sold', lock: 'editable' }]);
        expect(r.body.mealSharePercent).toBe(25);
        expect(r.body.canManage).toBe(true);
    });

    it('2 · the tenant can set an add-on share different from the meal share; the meal share is untouched', async () => {
        await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        const r = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }] });
        expect(r.status).toBe(200);
        expect(r.body.addOn.tiers.map((t: any) => [t.rangeLabel, t.percent])).toEqual([['1–10 sold', 10], ['11+ sold', 15]]);
        expect(r.body.mealSharePercent).toBe(20);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('3/4 · the share is campaign-specific: one Bundle pays 10% on one campaign and 15% on another', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10]]);
        seedAssignment(CAMP_A2, B.ADDON.id, [[1, 15]]);
        const a = await coordinatorOrder([line(B.S5), line(B.ADDON, 2)], CAMP_A);
        const b = await coordinatorOrder([line(B.S5), line(B.ADDON, 2)], CAMP_A2);
        expect(slicesOf(a.body.id)).toEqual([{ first_unit: 1, quantity: 2, percent: 10, share_amount: 5 }]);
        expect(slicesOf(b.body.id)).toEqual([{ first_unit: 1, quantity: 2, percent: 15, share_amount: 7.5 }]);
    });

    it('replace keeps the schedule; remove deletes it (earned history stays on the orders)', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]);
        const replaced = await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON2.id });
        expect(replaced.status).toBe(200);
        expect(mock.firstCall('campaignAddOn.update')!.args.data).toEqual({ bundle_id: B.ADDON2.id });
        expect(mock.callsTo('campaignAddOn.create')).toHaveLength(0);
        expect(replaced.body.addOn.tiers.map((t: any) => t.percent)).toEqual([10, 15]);
        const removed = await addOnRoute('DELETE', CAMP_A);
        expect(removed.status).toBe(200);
        expect(removed.body.addOn).toBeNull();
        expect(W.tiers).toHaveLength(0);
    });

    it('only an eligible add-on can be assigned: typed addon, active, priced, with recipes, same tenant', async () => {
        const cases: Array<[string, number, RegExp]> = [
            [B.S5.id, 400, /Fundraiser add-on/],
            [B.ADDON_NOPRICE.id, 400, /price above \$0\.00/],
            [B.ADDON_EMPTY.id, 400, /at least one recipe/],
            [B.ADDON_OFF.id, 400, /turned off/],
            [B.FOREIGN_ADDON.id, 404, /not found/],
            ['', 400, /Choose an add-on/],
        ];
        for (const [bundleId, status, error] of cases) {
            const r = await addOnRoute('PUT', CAMP_A, { bundleId });
            expect(r.status).toBe(status);
            expect(r.body.error).toMatch(error);
        }
        expect(mock.callsTo('campaignAddOn.create')).toHaveLength(0);
        expect(mock.callsTo('bundle.findFirst').every((c) => c.args.where.business_id === TENANT_A)).toBe(true);
    });

    it('29 · cross-tenant: another tenant\'s campaign is not found, and nothing is locked or written', async () => {
        for (const [method, body] of [['GET', undefined], ['PUT', { bundleId: B.ADDON.id }], ['PATCH', { tiers: [{ startingQuantity: 1, percent: 5 }] }], ['DELETE', undefined]] as const) {
            const r = await addOnRoute(method, CAMP_FOREIGN, body);
            expect(r.status).toBe(404);
        }
        expect(lockIndex(CAMP_FOREIGN)).toBe(-1);
        expect(writes()).toHaveLength(0);
    });

    it('a non-administrator can READ (canManage false) but every write is 403 before any lock or write', async () => {
        (global as any).__ao2Session = { user: { businessId: TENANT_A, role: 'CHEF', id: 'user-ao2-chef' } };
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10]]);
        const read = await addOnRoute('GET', CAMP_A);
        expect(read.status).toBe(200);
        expect(read.body.canManage).toBe(false);
        for (const [method, body] of [['PUT', { bundleId: B.ADDON2.id }], ['PATCH', { tiers: [{ startingQuantity: 1, percent: 5 }] }], ['DELETE', undefined]] as const) {
            const r = await addOnRoute(method, CAMP_A, body);
            expect(r).toMatchObject({ status: 403, body: { code: 'ADDON_ADMIN_ONLY' } });
        }
        expect(lockIndex(CAMP_A)).toBe(-1);
        expect(writes()).toHaveLength(0);
        (global as any).__ao2Session = null;
        expect((await addOnRoute('GET', CAMP_A)).status).toBe(401);
    });

    it('30 · every assignment and tier write takes the campaign lock FIRST, then rechecks closed, then writes', async () => {
        const ops: Array<[string, 'PUT' | 'PATCH' | 'DELETE', any, string]> = [
            ['assign', 'PUT', { bundleId: B.ADDON.id }, 'campaignAddOn.create'],
            ['replace', 'PUT', { bundleId: B.ADDON2.id }, 'campaignAddOn.update'],
            ['edit percent', 'PATCH', { tiers: [{ startingQuantity: 1, percent: 12 }] }, 'campaignAddOnShareTier.updateMany'],
            ['add future tier', 'PATCH', { tiers: [{ startingQuantity: 1, percent: 12 }, { startingQuantity: 11, percent: 15 }] }, 'campaignAddOnShareTier.create'],
            ['remove future tier', 'PATCH', { tiers: [{ startingQuantity: 1, percent: 12 }] }, 'campaignAddOnShareTier.deleteMany'],
            ['remove', 'DELETE', undefined, 'campaignAddOn.deleteMany'],
        ];
        for (const [label, method, body, writeKey] of ops) {
            useWorld();
            const r = await addOnRoute(method, CAMP_A, body);
            expect({ label, status: r.status }).toEqual({ label, status: 200 });
            const lock = lockIndex(CAMP_A);
            const recheck = firstIndex((c) => c.model === 'fundraiserCampaign' && c.method === 'findUnique' && c.args?.select?.closed_at === true && mock.calls.indexOf(c) > lock);
            const write = firstIndex((c) => `${c.model}.${c.method}` === writeKey);
            expect({ label, lockFirst: lock > -1 && lock < recheck && recheck < write }).toEqual({ label, lockFirst: true });
        }
    });

    it('31 · a closed-out campaign refuses every add-on and tier change (409), even if it closed after the preflight', async () => {
        seedAssignment(CAMP_CLOSED, B.ADDON.id, [[1, 10]]);
        for (const [method, body] of [['PUT', { bundleId: B.ADDON2.id }], ['PATCH', { tiers: [{ startingQuantity: 1, percent: 5 }] }], ['DELETE', undefined]] as const) {
            const r = await addOnRoute(method, CAMP_CLOSED, body);
            expect(r).toMatchObject({ status: 409, body: { code: 'CAMPAIGN_CLOSED' } });
        }
        expect(writes()).toHaveLength(0);
        // Open at the preflight read, closed by the time the lock is held.
        let reads = 0;
        useWorld({
            'fundraiserCampaign.findUnique': (args: any) => {
                reads += 1;
                const c = W.campaigns[args?.where?.id];
                return reads === 1 ? c : { ...c, status: 'Closed', closed_at: new Date() };
            },
        });
        const late = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 5 }] });
        expect(late).toMatchObject({ status: 409, body: { code: 'CAMPAIGN_CLOSED' } });
        expect(writes()).toHaveLength(0);
        // The read view says it is final.
        const view = await addOnRoute('GET', CAMP_CLOSED);
        expect(view.body.closed).toBe(true);
    });

    it('a refused tier edit leaves nothing behind (the transaction throws before any partial write)', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]);
        W.orders.push({ id: 'o-seed', campaign_id: CAMP_A, canceled_at: null, total_amount: 300, tax_amount: 0 });
        W.items.push({ id: 'i-seed', order_id: 'o-seed', bundle_id: B.ADDON.id, quantity: 12, unit_price: 25, item_role: 'addon', variant_size: 'serves_5', item_name: B.ADDON.name });
        const r = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 18 }, { startingQuantity: 40, percent: 20 }] });
        expect(r).toMatchObject({ status: 409, body: { code: 'SHARE_TIER_LOCKED' } });
        expect(mock.callsTo('campaignAddOnShareTier.create')).toHaveLength(0);
        expect(mock.callsTo('campaignAddOnShareTier.updateMany')).toHaveLength(0);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent])).toEqual([[1, 10], [11, 15]]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('earned share · recorded once, in the order transaction, by the campaign\'s cumulative count', () => {
    beforeEach(() => { seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]); });

    it('14 · 9 sold (supporter), then a paper order of 3 → unit 10 @10%, units 11–12 @15%', async () => {
        const first = await supporterOrder(CAMP_A, [line(B.S5), line(B.ADDON, 9)]);
        expect(first.status).toBe(200);
        expect(slicesOf(first.body.order?.id ?? first.body.id ?? W.orders[0].id)).toEqual([{ first_unit: 1, quantity: 9, percent: 10, share_amount: 22.5 }]);
        const second = await coordinatorOrder([line(B.S2), line(B.ADDON, 3)]);
        expect(second.status).toBe(200);
        expect(slicesOf(second.body.id)).toEqual([
            { first_unit: 10, quantity: 1, percent: 10, share_amount: 2.5 },
            { first_unit: 11, quantity: 2, percent: 15, share_amount: 7.5 },
        ]);
    });

    it('15 · past earned share is never touched by a later schedule edit; new orders use the new schedule', async () => {
        await coordinatorOrder([line(B.S5), line(B.ADDON, 12)]);
        const recorded = JSON.stringify(W.slices);
        const r = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }, { startingQuantity: 13, percent: 20 }] });
        expect(r.status).toBe(200);
        expect(JSON.stringify(W.slices)).toBe(recorded);
        expect(mock.calls.filter((c) => c.model === 'orderItemAddOnShare' && c.method !== 'createMany')).toHaveLength(0);
        const next = await coordinatorOrder([line(B.S5), line(B.ADDON, 1)]);
        expect(slicesOf(next.body.id)).toEqual([{ first_unit: 13, quantity: 1, percent: 20, share_amount: 5 }]);
    });

    it('16 · with 7 sold, the 1–10 rate cannot be reduced from 10% to 5% (409); 17 · an 11+ tier can be added', async () => {
        await coordinatorOrder([line(B.S5), line(B.ADDON, 7)]);
        W.tiers = W.tiers.filter((t) => t.starting_quantity === 1);
        const reduce = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 5 }] });
        expect(reduce).toMatchObject({ status: 409, body: { code: 'SHARE_TIER_LOCKED' } });
        expect(reduce.body.error).toMatch(/7 add-ons have already sold/);
        const add = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }] });
        expect(add.status).toBe(200);
        expect(add.body.addOn.tiers.map((t: any) => [t.rangeLabel, t.lock])).toEqual([['1–10 sold', 'locked_for_sold'], ['11+ sold', 'editable']]);
        const tooLow = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 5, percent: 12 }, { startingQuantity: 11, percent: 15 }] });
        expect(tooLow).toMatchObject({ status: 409, body: { code: 'SHARE_TIER_LOCKED' } });
    });

    it('18 · a future, unreached tier can be edited and removed', async () => {
        await coordinatorOrder([line(B.S5), line(B.ADDON, 7)]);
        const edit = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 18 }] });
        expect(edit.status).toBe(200);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent])).toEqual([[1, 10], [11, 18]]);
        const move = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 9, percent: 18 }] });
        expect(move.status).toBe(200);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent]).sort((a, b) => a[0] - b[0])).toEqual([[1, 10], [9, 18]]);
        const drop = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }] });
        expect(drop.status).toBe(200);
        expect(W.tiers.map((t) => t.starting_quantity)).toEqual([1]);
    });

    it('25 · add-ons sold counts add-on units on non-cancelled campaign orders — not goal units, not meals', async () => {
        await supporterOrder(CAMP_A, [line(B.S5, 2), line(B.ADDON, 4)]);
        await coordinatorOrder([line(B.S2), line(B.ADDON, 3)]);
        await coordinatorOrder([line(B.S5)]);
        let view = await addOnRoute('GET', CAMP_A);
        expect(view.body.unitsSold).toBe(7);
        expect(view.body.grossSales).toBe(175);
        expect(view.body.earnedShare).toBe(17.5);
        W.orders[0].canceled_at = new Date();
        view = await addOnRoute('GET', CAMP_A);
        expect(view.body.unitsSold).toBe(3);
        expect(await countCampaignAddOnUnitsSold(mock.client, CAMP_A)).toBe(3);
        const agg = mock.callsTo('orderItem.aggregate').pop()!.args;
        expect(agg.where).toEqual({ item_role: 'addon', order: { campaign_id: CAMP_A, canceled_at: null } });
        expect(agg._sum).toEqual({ quantity: true });
    });

    it('the recorder runs under the campaign lock, after the order insert, inside the same transaction (both routes)', async () => {
        await supporterOrder(CAMP_A, [line(B.S5), line(B.ADDON, 2)]);
        const lock = lockIndex(CAMP_A);
        const insert = firstIndex((c) => c.model === 'order' && c.method === 'create');
        const count = firstIndex((c) => c.model === 'orderItem' && c.method === 'aggregate');
        const record = firstIndex((c) => c.model === 'orderItemAddOnShare' && c.method === 'createMany');
        expect(lock).toBeGreaterThan(-1);
        expect(lock < insert && insert < count && count < record).toBe(true);
        // It counted everything BEFORE this order, never this order itself.
        expect(mock.callsTo('orderItem.aggregate')[0].args.where.order.id).toEqual({ not: W.orders[0].id });
        useWorld();
        await coordinatorOrder([line(B.S5), line(B.ADDON, 2)]);
        const cLock = lockIndex(CAMP_A);
        const cInsert = firstIndex((c) => c.model === 'order' && c.method === 'create');
        const cRecord = firstIndex((c) => c.model === 'orderItemAddOnShare' && c.method === 'createMany');
        expect(cLock > -1 && cLock < cInsert && cInsert < cRecord).toBe(true);
    });

    it('an add-on order with no usable schedule is refused 409 ADDON_CHANGED and nothing is recorded as earned', async () => {
        W.tiers = [];
        const r = await coordinatorOrder([line(B.S5), line(B.ADDON, 1)]);
        expect(r).toMatchObject({ status: 409, body: { code: 'ADDON_CHANGED' } });
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(0);
    });

    it('an order without an add-on records no share and reads no schedule (existing behaviour)', async () => {
        const r = await coordinatorOrder([line(B.S5), line(B.S2)]);
        expect(r.status).toBe(200);
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(0);
        expect(mock.callsTo('orderItem.aggregate')).toHaveLength(0);
        expect(lockIndex(CAMP_A)).toBe(-1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('coordinator · manual / paper orders and the read-only add-on display', () => {
    beforeEach(() => { seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]); });

    it('26 · manual Serves 5 + add-on is accepted; the server prices it, names it and records its share', async () => {
        const r = await coordinatorOrder([line(B.S5), line(B.ADDON, 2, { price: 0.01, name: 'FREE', item_role: 'main', percent: 100 })]);
        expect(r.status).toBe(200);
        const addOnLine = W.items.find((it) => it.item_role === 'addon')!;
        expect(addOnLine).toMatchObject({ bundle_id: B.ADDON.id, quantity: 2, unit_price: 25, item_name: 'Sides & Dessert Bundle' });
        expect(slicesOf(r.body.id)).toEqual([{ first_unit: 1, quantity: 2, percent: 10, share_amount: 5 }]);
    });

    it('27 · manual Serves 2 + add-on is accepted (no Family-Size-only rule)', async () => {
        const r = await coordinatorOrder([line(B.S2), line(B.ADDON, 1)]);
        expect(r.status).toBe(200);
        expect(W.items.map((it) => it.item_role).sort()).toEqual(['addon', 'main']);
    });

    it('28 · add-on only is refused before any write', async () => {
        const r = await coordinatorOrder([line(B.ADDON, 2)]);
        expect(r).toMatchObject({ status: 400, body: { code: 'ADDON_REQUIRES_MEAL', error: 'An add-on must be ordered with at least one meal bundle.' } });
        expect(writes()).toHaveLength(0);
    });

    it('23 · the coordinator sees the add-on and its share READ-ONLY, in plain words', async () => {
        await coordinatorOrder([line(B.S5), line(B.ADDON, 4)]);
        const view = await loadCoordinatorAddOnView(mock.client, { campaignId: CAMP_A, businessId: TENANT_A });
        expect(view).toEqual({
            bundleId: B.ADDON.id, name: 'Sides & Dessert Bundle', price: 25,
            shareSummary: 'Your organization earns 10% on the first 10 add-ons and 15% beginning with add-on 11.',
            shareTiers: [{ rangeLabel: '1–10 sold', percent: 10 }, { rangeLabel: '11+ sold', percent: 15 }],
            unitsSold: 4, grossSales: 100, earnedShare: 10,
        });
        // The portal GET carries it as `addOn`; the portal renders it with no input and no write path.
        const route = R('app/api/coordinator/route.ts');
        expect(route).toMatch(/addOn = businessId \? await loadCoordinatorAddOnView\(prisma, \{ campaignId: campaign\.id, businessId \}\) : null;/);
        expect(route).toMatch(/\.\.\.campaignResponse,\n\s+addOn,/);
        const card = R('components/coordinator/AddOnShareCard.tsx');
        expect(card).not.toMatch(/<input|<button|<select|fetch\(|onChange/);
        // A turned-off add-on is not shown or orderable from the portal.
        const off = await loadCoordinatorAddOnView({
            ...mock.client,
            campaignAddOn: { findUnique: async () => ({ business_id: TENANT_A, bundle: { ...B.ADDON, is_active: false }, share_tiers: [{ starting_quantity: 1, percent: 10 }] }) },
        }, { campaignId: CAMP_A, businessId: TENANT_A });
        expect(off).toBeNull();
    });

    it('24 · a coordinator cannot edit the add-on or its share: no coordinator route writes either', async () => {
        const dirs = ['app/api/coordinator', 'app/api/coordinator-actions', 'app/coordinator', 'components/coordinator'];
        const files: string[] = [];
        const walk = (d: string) => {
            for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
                const p = `${d}/${e.name}`;
                if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
            }
        };
        dirs.forEach(walk);
        for (const f of files) {
            const src = R(f);
            expect({ f, hit: /campaignAddOnShareTier|share_tiers|updateCampaignAddOnShareTiers|assignCampaignAddOn|removeCampaignAddOn|\/add-on['`]/.test(src) }).toEqual({ f, hit: false });
        }
        // The portal's add-on row sends a bundle and a quantity — never a role, share or percentage.
        const portal = R('app/coordinator/portal/page.tsx');
        expect(portal).toContain('[{ bundleId: campaign.addOn.bundleId, quantity: addOnQty, name: campaign.addOn.name, price: campaign.addOn.price }]');
        expect(portal).not.toMatch(/item_role|percent:|shareAmount/);
    });

    it('raised-for amount: meal share on meal sales + the add-on share as earned (portal arithmetic)', () => {
        const plain = computeFundraiserProgress(10, 150, [], 20);
        expect(plain.raisedAmount).toBe(30);
        const withAddOn = computeFundraiserProgress(10, 150, [], 20, { grossSales: 25, earnedShare: 2.5 });
        expect(withAddOn.raisedAmount).toBe(27.5);
        expect(computeFundraiserProgress(10, 150, [], 20, null).raisedAmount).toBe(organizationShareAmount(150, 20));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('closeout · meal share at the campaign rate + the add-on share as recorded', () => {
    it('20/21/22 · $125 meal + $25 add-on @10% → $25.00 + $2.50 = $27.50 on the invoice QuickBooks reads', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]);
        await coordinatorOrder([line(B.S5), line(B.ADDON, 1)]);
        useWorld();
        const r = await closeout(CAMP_A);
        expect(r.status).toBe(200);
        expect(r.body.financials).toMatchObject({
            gross_sales: 150, org_share_percent: 20,
            main_gross_sales: 125, main_organization_amount: 25,
            add_on_gross_sales: 25, add_on_organization_amount: 2.5,
            organization_amount: 27.5, base_remit: 122.5, total_due: 122.5,
        });
        const inv = mock.firstCall('invoice.create')!.args.data;
        expect(inv.fundraiser_profit_amount).toBe(27.5);
        expect(inv.fundraiser_profit_percent).toBe(20);
        expect(inv.total_amount).toBe(122.5);
        expect(inv.items.create.map((l: any) => [l.description, l.quantity, l.unit_price])).toEqual(
            expect.arrayContaining([['Comfort Foods (Serves 5)', 1, 125], ['Sides & Dessert Bundle', 1, 25]]));
    });

    it('a threshold-crossing campaign closes on the recorded slices: 9 @10% then 3 split 1@10% + 2@15%', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]);
        await coordinatorOrder([line(B.S5), line(B.ADDON, 9)]);
        await coordinatorOrder([line(B.S2), line(B.ADDON, 3)]);
        // A later edit to an unreached tier changes nothing already earned.
        await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 11, percent: 15 }, { startingQuantity: 40, percent: 30 }] });
        useWorld();
        const r = await closeout(CAMP_A);
        // Meals: 125 + 65 = 190 × 20% = 38.00. Add-ons: 22.50 + 2.50 + 7.50 = 32.50 — not 12 × 25 × 15% (45.00), not × 20%.
        expect(r.body.financials).toMatchObject({ main_gross_sales: 190, main_organization_amount: 38, add_on_gross_sales: 300, add_on_organization_amount: 32.5, organization_amount: 70.5 });
    });

    it('closeout refuses (409, nothing claimed) when an add-on line\'s recorded share does not cover what it sold', async () => {
        W.orders.push({ id: 'o-bad', campaign_id: CAMP_A, canceled_at: null, total_amount: 150, tax_amount: 0 });
        W.items.push({ id: 'i-bad-1', order_id: 'o-bad', bundle_id: B.S5.id, quantity: 1, unit_price: 125, item_role: 'main', variant_size: 'serves_5', item_name: 'x' });
        W.items.push({ id: 'i-bad-2', order_id: 'o-bad', bundle_id: B.ADDON.id, quantity: 1, unit_price: 25, item_role: 'addon', variant_size: 'serves_5', item_name: 'y' });
        const r = await closeout(CAMP_A);
        expect(r).toMatchObject({ status: 409, body: { code: 'ADDON_SHARE_DOES_NOT_RECONCILE' } });
        expect(r.body.add_on_reconciliation.offenders).toEqual([{ orderId: 'o-bad', detail: 'add-on quantity 1 has no recorded share' }]);
        expect(mock.callsTo('fundraiserCampaign.updateMany')).toHaveLength(0);
        expect(mock.callsTo('invoice.create')).toHaveLength(0);
    });

    it('32 · a campaign with no add-on closes exactly as before (gross × campaign %)', async () => {
        await coordinatorOrder([line(B.S5, 3), line(B.S2)]);
        useWorld();
        const r = await closeout(CAMP_A);
        expect(r.body.financials).toMatchObject({ gross_sales: 440, organization_amount: 88, base_remit: 352, add_on_gross_sales: 0, add_on_organization_amount: 0, main_gross_sales: 440 });
        for (const [gross, pct] of [[440, 20], [6420, 20], [845.55, 17.5], [0.05, 33.33], [0, 20]]) {
            const f = computeCloseoutFinancials({ grossSales: gross, orgSharePercent: pct, applyFoodTax: false });
            expect(f.organizationAmount).toBe(organizationShareAmount(gross, pct));
            expect(computeCloseoutFinancials({ grossSales: gross, orgSharePercent: pct, applyFoodTax: false, addOn: { grossSales: 0, earnedShare: 0 } })).toEqual(f);
        }
    });

    it('33 · an add-on left on its default single tier earns the meal rate, so the total equals gross × %', async () => {
        await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        await coordinatorOrder([line(B.S5), line(B.ADDON, 2)]);
        expect(W.slices).toEqual([expect.objectContaining({ first_unit: 1, quantity: 2, percent: 20, share_amount: 10 })]);
        useWorld();
        const r = await closeout(CAMP_A);
        expect(r.body.financials.organization_amount).toBe(35);
        expect(r.body.financials.organization_amount).toBe(organizationShareAmount(175, 20));
    });

    it('19 · changing the campaign\'s meal share never rewrites an add-on schedule', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10], [11, 15]]);
        const { PATCH } = await import('@/app/api/campaigns/[id]/route');
        const res = await readJson(await PATCH(new Request(`http://localhost/api/campaigns/${CAMP_A}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgSharePercent: 30 }),
        }), { params: Promise.resolve({ id: CAMP_A }) }));
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.update')!.args.data.org_share_percent).toBe(30);
        expect(mock.calls.filter((c) => c.model === 'campaignAddOnShareTier' || c.model === 'campaignAddOn')).toHaveLength(0);
        expect(W.tiers.map((t) => t.percent)).toEqual([10, 15]);
        expect(R('app/api/campaigns/[id]/route.ts')).not.toMatch(/campaignAddOn|share_tiers/);
    });

    it('summarizeAddOnEarnings sums recorded cents and names offenders (quantity or price mismatch)', () => {
        expect(summarizeAddOnEarnings([
            { orderId: 'a', quantity: 3, unitPrice: 25, slices: [{ quantity: 1, unitPrice: 25, shareAmount: 2.5 }, { quantity: 2, unitPrice: 25, shareAmount: 7.5 }] },
        ])).toEqual({ grossSales: 75, earnedShare: 10, offenders: [] });
        expect(summarizeAddOnEarnings([
            { orderId: 'q', quantity: 3, unitPrice: 25, slices: [{ quantity: 2, unitPrice: 25, shareAmount: 5 }] },
            { orderId: 'p', quantity: 1, unitPrice: 25, slices: [{ quantity: 1, unitPrice: 20, shareAmount: 2 }] },
        ]).offenders.map((o) => o.orderId)).toEqual(['q', 'p']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('Bundle Editor · Meal bundle / Fundraiser add-on, enforced on the server', () => {
    const admin = () => { (global as any).__ao2Session = { user: { businessId: TENANT_A, role: 'ADMIN', id: 'user-ao2-admin' } }; };
    async function bundlePut(id: string, body: any) {
        const { PUT } = await import('@/app/api/bundles/[id]/route');
        return readJson(await PUT(new Request(`http://localhost/api/bundles/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }));
    }
    async function bundlePost(body: any) {
        const { POST } = await import('@/app/api/bundles/route');
        return readJson(await POST(jsonRequest('http://localhost/api/bundles', body)));
    }
    beforeEach(admin);

    it('parse + shape: an add-on is one size and never on the storefront; contradictions are refused', () => {
        expect(parseRequestedBundleType({})).toEqual({ ok: true, value: undefined });
        expect(parseRequestedBundleType({ bundle_type: 'addon' })).toEqual({ ok: true, value: 'addon' });
        expect(parseRequestedBundleType({ bundle_type: 'side' })).toMatchObject({ ok: false });
        expect(shapeBundleWriteForType({ price: 25 } as any, 'addon')).toEqual({ ok: true, data: { price: 25, serving_tier: 'family', show_on_storefront: false } });
        expect(shapeBundleWriteForType({ show_on_storefront: true }, 'addon')).toMatchObject({ ok: false });
        expect(shapeBundleWriteForType({ serving_tier: 'couple' }, 'addon')).toMatchObject({ ok: false });
        expect(shapeBundleWriteForType({ serving_tier: 'couple', show_on_storefront: true }, 'meal')).toEqual({ ok: true, data: { serving_tier: 'couple', show_on_storefront: true } });
    });

    it('create: an add-on is saved typed addon, single size, off the storefront — contents/image/price kept', async () => {
        const r = await bundlePost({ name: 'Sides', sku: 'SIDES-AO', bundle_type: 'addon', price: 25, image_url: 'https://example.test/s.png', description: 'd' });
        expect(r.status).toBe(200);
        const data = mock.firstCall('bundle.create')!.args.data;
        expect(data).toMatchObject({ bundle_type: 'addon', serving_tier: 'family', show_on_storefront: false, price: 25, image_url: 'https://example.test/s.png', description: 'd' });
        for (const body of [{ bundle_type: 'addon', show_on_storefront: true }, { bundle_type: 'addon', serving_tier: 'couple' }, { bundle_type: 'dessert' }]) {
            useWorld();
            const bad = await bundlePost({ name: 'x', sku: 'X', ...body });
            expect(bad.status).toBe(400);
            expect(mock.callsTo('bundle.create')).toHaveLength(0);
        }
        useWorld();
        await bundlePost({ name: 'Meal', sku: 'MEAL', serving_tier: 'couple', show_on_storefront: true });
        expect(mock.firstCall('bundle.create')!.args.data).toMatchObject({ bundle_type: 'meal', serving_tier: 'couple', show_on_storefront: true });
    });

    it('Meal → Add-on is refused for a family member or a bundle on an open lineup; allowed otherwise, under a row lock', async () => {
        const fam = await bundlePut(B.S5.id, { bundle_type: 'addon' });
        expect(fam).toMatchObject({ status: 409, body: { code: 'BUNDLE_TYPE_CHANGE_REFUSED' } });
        expect(fam.body.error).toMatch(/Serves 2 version/);
        W.lineups.push({ campaign_id: CAMP_A, bundle_id: B.SOLO.id, state: 'active' });
        useWorld();
        const lineup = await bundlePut(B.SOLO.id, { bundle_type: 'addon' });
        expect(lineup).toMatchObject({ status: 409 });
        expect(lineup.body.error).toMatch(/open fundraiser's meal lineup/);
        expect(mock.callsTo('bundle.update')).toHaveLength(0);
        // Only a CLOSED campaign's lineup → allowed.
        W.lineups = [{ campaign_id: CAMP_CLOSED, bundle_id: B.SOLO.id, state: 'active' }];
        useWorld();
        const ok = await bundlePut(B.SOLO.id, { bundle_type: 'addon', price: 40 });
        expect(ok.status).toBe(200);
        expect(mock.firstCall('bundle.update')!.args.data).toEqual({ price: 40, serving_tier: 'family', show_on_storefront: false, bundle_type: 'addon' });
        expect(mock.rawQueries[0]).toMatch(/SELECT id FROM "bundles" WHERE id = \? FOR UPDATE/);
        expect(mock.calls.findIndex((c) => c.model === '$queryRaw')).toBeLessThan(mock.calls.findIndex((c) => c.model === 'bundle' && c.method === 'update'));
    });

    it('Add-on → Meal is refused while the bundle is a campaign\'s assigned add-on; allowed after removal', async () => {
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10]]);
        const r = await bundlePut(B.ADDON.id, { bundle_type: 'meal' });
        expect(r).toMatchObject({ status: 409, body: { code: 'BUNDLE_TYPE_CHANGE_REFUSED' } });
        expect(r.body.error).toMatch(/supporter add-on/);
        W.assignments = [];
        useWorld();
        const ok = await bundlePut(B.ADDON.id, { bundle_type: 'meal' });
        expect(ok.status).toBe(200);
        expect(mock.firstCall('bundle.update')!.args.data).toEqual({ bundle_type: 'meal' });
    });

    it('an add-on\'s storefront switch is refused in words; a meal bundle save is untouched', async () => {
        const r = await bundlePut(B.ADDON.id, { show_on_storefront: true });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/can't be shown on the storefront/);
        useWorld();
        await bundlePut(B.S5.id, { price: 130, bundle_type: 'meal' });
        expect(mock.firstCall('bundle.update')!.args.data).toEqual({ price: 130 });
        // An ordinary save (no type change) takes no new lock — meal-bundle saves behave exactly as before.
        expect(mock.rawQueries).toEqual([]);
    });

    it('Make Serves 2 is refused for an add-on; delete of an assigned add-on is a friendly 409', async () => {
        const { POST } = await import('@/app/api/bundles/[id]/duplicate-serves-2/route');
        const dup = await readJson(await POST(new Request(`http://localhost/api/bundles/${B.ADDON.id}/duplicate-serves-2`, { method: 'POST' }) as any, { params: Promise.resolve({ id: B.ADDON.id }) } as any));
        expect(dup).toMatchObject({ status: 409, body: { code: 'ADDON_HAS_NO_SERVES_2' } });
        expect(mock.callsTo('bundle.create')).toHaveLength(0);
        seedAssignment(CAMP_A, B.ADDON.id, [[1, 10]]);
        useWorld();
        const { DELETE } = await import('@/app/api/bundles/[id]/route');
        const del = await readJson(await DELETE(new Request(`http://localhost/api/bundles/${B.ADDON.id}`, { method: 'DELETE' }), { params: Promise.resolve({ id: B.ADDON.id }) }));
        expect(del).toMatchObject({ status: 409, body: { code: 'BUNDLE_IN_USE' } });
        expect(del.body.error).toBe('This bundle can\'t be deleted because it is used by 1 fundraiser as its supporter add-on. Turn off "Active" to retire it instead.');
        expect(mock.callsTo('bundle.delete')).toHaveLength(0);
        expect(bundleDeletionRefusal({ orderItems: 0, invoiceItems: 0, campaignBundles: 0 })).toBeNull();
    });

    it('the lineup writer refuses an add-on as a meal bundle; candidate families can never contain one', async () => {
        const { PUT } = await import('@/app/api/campaigns/[id]/bundles/route');
        const r = await readJson(await PUT(new Request(`http://localhost/api/campaigns/${CAMP_A}/bundles`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundleIds: [B.S5.id, B.ADDON.id] }),
        }), { params: Promise.resolve({ id: CAMP_A }) }));
        expect(r).toMatchObject({ status: 400, body: { code: 'ADDON_NOT_A_MEAL_BUNDLE' } });
        expect(lockIndex(CAMP_A)).toBe(-1);
        expect(mock.callsTo('campaignBundle.createMany')).toHaveLength(0);
        // Family-based selection reads only bundles WITH a family; an add-on never has one (S1 CHECK).
        expect(R('lib/campaignBundleSelection.ts')).toContain("where: { business_id: businessId, is_active: true, family_id: { not: null } },");
    });

    it('the editor offers the choice, hides what does not apply to an add-on, and sends bundle_type', () => {
        const ed = R('components/BundleEditor.tsx');
        expect(ed).toContain("{ value: 'addon', label: 'Fundraiser add-on'");
        expect(ed).toContain("bundle_type: initialData.bundle_type === 'addon' ? 'addon' : 'meal',");
        expect(ed).toContain('{!isNew && !isAddOn && (');
        expect(ed).toMatch(/\{isAddOn \? \(\s*<p[^>]*>\s*One size — a fundraiser add-on has no Serves 2 version\./);
        expect(ed).toMatch(/\{isAddOn \? \(\s*<p[^>]*>\s*Not on the storefront/);
        expect(ed).not.toMatch(/serving_tier', ['"](none|zero|0)['"]/);
        const list = R('app/bundles/page.tsx');
        expect(list).toContain("bundle.bundle_type === 'addon' ? (");
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('CRM Campaign Details · the Supporter Add-On card', () => {
    const card = R('components/crm2/CampaignAddOnCard.tsx');
    it('reads and writes ONLY the tenant add-on route; shows meal share, sold count, ranges and lock states', () => {
        expect(card).toContain('fetch(`/api/campaigns/${campaignId}/add-on`');
        for (const text of ['Supporter Add-On', 'Main meal share:', 'Organization share on add-on', 'Add tier', 'Locked for add-ons already sold', '> Locked', 'Only an administrator can change the add-on or its share.', 'Closed out — the add-on and its share are final.']) {
            expect(card).toContain(text);
        }
        expect(card).toContain('parseShareTierSchedule(');
        // Never shown to the tenant (the file's own doc comment may say what it avoids).
        const rendered = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(rendered).not.toMatch(/starting quantity|threshold/i);
    });
    it('is mounted in the Campaign Context drawer (Campaign Details), not in global Settings', () => {
        expect(R('components/crm2/CampaignContextDrawer.tsx')).toMatch(/<CampaignAddOnCard key=\{c\.id\} campaignId=\{c\.id\} \/>/);
        const settingsFiles = execSync('git ls-files -- "app/settings" "components/settings"', { cwd: ROOT, encoding: 'utf8' })
            .split('\n').filter((f) => /\.(ts|tsx)$/.test(f));
        for (const f of settingsFiles) expect({ f, hit: R(f).includes('CampaignAddOnCard') }).toEqual({ f, hit: false });
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('boundaries · storefront, public supporter page, money and kitchen engines untouched', () => {
    const unchangedFromS1 = [
        // 34 · the normal storefront
        'app/api/checkout/session/route.ts', 'app/api/public/tenant/[slug]/route.ts', 'lib/storefrontEligibility.ts', 'components/storefront/RoundOutRow.tsx',
        // 35 · the public supporter page and scoreboard
        'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx', 'lib/publicFundraiserPayload.ts', 'app/api/fundraiser/[token]/route.ts',
        // money / kitchen / tax / status
        'lib/pricing.ts', 'lib/serving_multipliers.ts', 'lib/kitchen_engine.ts', 'lib/cost_engine.ts', 'lib/fundraiserTax.ts', 'lib/statusWorkflow.ts',
        'lib/fundraiserOrgShare.ts', 'lib/quickbooks/invoicePayload.ts', 'lib/quickbooks/invoiceSend.ts', 'app/invoices/page.tsx',
        'app/api/orders/route.ts', 'lib/campaignAddOns.ts', 'lib/campaignSelectionLock.ts', 'lib/coordinatorSupporterOrders.ts',
    ];
    it('these files are byte-identical to S1 (one git call, so a busy machine cannot flake it)', () => {
        const changed = execSync(`git diff --name-only ${S1_HEAD} -- ${unchangedFromS1.map((p) => `"${p}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' })
            .split('\n').map((s) => s.trim()).filter(Boolean);
        expect(changed).toEqual([]);
        // and each path really exists (a typo would otherwise pass vacuously)
        for (const p of unchangedFromS1) expect(fs.existsSync(path.join(ROOT, p))).toBe(true);
    });

    it('35 · no public supporter surface reads the add-on yet (no card, no popup, no copy)', () => {
        const publicFiles = execSync('git ls-files -- "app/shop" "app/fundraiser" "components/fundraiser" "components/storefront" "app/api/public"', { cwd: ROOT, encoding: 'utf8' })
            .split('\n').filter((f) => /\.(ts|tsx)$/.test(f));
        expect(publicFiles.length).toBeGreaterThan(10);
        for (const f of publicFiles) {
            if (f === 'app/api/public/order/route.ts') continue; // the order WRITE path (rules + earnings only)
            const src = R(f);
            expect({ f, hit: /campaignAddOn|addOnShare|CampaignAddOn|Supporter Add-On/.test(src) }).toEqual({ f, hit: false });
        }
        // The supporter order route gained ONE call — the earnings recorder — and nothing user-visible.
        const diff = execSync(`git diff ${S1_HEAD} -- app/api/public/order/route.ts`, { cwd: ROOT, encoding: 'utf8' });
        const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1).trim()).filter((l) => l && !l.startsWith('//'));
        expect(added).toEqual([
            "import { recordAddOnShareEarnings } from '@/lib/campaignAddOnEarnings';",
            'if (campaign && lineRoles.addOnBundleIds.length > 0) {',
            'await recordAddOnShareEarnings(tx, { campaignId: campaign.id, businessId, orderId: order.id });',
            '}',
        ]);
    });

    it('34 · add-ons cannot reach any storefront lineup: every lineup query requires show_on_storefront = true, which the CHECK forbids for an add-on', () => {
        for (const f of ['app/api/coordinator/route.ts', 'app/api/tracker/download/route.ts', 'app/api/tracker/pickup-sheet/route.ts', 'lib/storefrontEligibility.ts']) {
            expect(R(f)).toMatch(/show_on_storefront: true/);
        }
        for (const f of ['app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx', 'app/api/flyer/download/route.ts', 'app/api/flyer/generate/route.ts', 'app/api/packet/download/route.ts', 'app/api/promo-scripts/route.ts']) {
            expect(R(f)).toMatch(/AND show_on_storefront = true/);
        }
    });
});
