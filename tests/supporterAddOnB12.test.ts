/**
 * FR-SUPPORTER-ADDON-UPSELL-1 — B1/B2 accounting remediation (owner-approved 2026-11-25).
 *
 *  B1  Permanent tier positions and immutable earnings. Every add-on unit takes a permanent, campaign-scoped
 *      tier position when sold; positions are never re-used (cancelled orders keep theirs); cancellation only
 *      excludes an order's recorded slices from ACTIVE totals; restoration re-activates those same slices
 *      (no new positions, no new records); a reached tier never unlocks. Cancel and restore take the campaign
 *      lock and re-check "open" inside it.
 *  B2  The campaign keeps its add-on share schedule. Removing an add-on disables it (campaign_add_ons.removed_at)
 *      and keeps its schedule, locked tiers and positions; re-assigning the same add-on or a replacement
 *      resumes the schedule; the meal share is inherited only by a genuinely new program.
 *
 * The route sections execute the REAL handlers (tenant add-on route, supporter and coordinator orders,
 * coordinator cancel / restore, closeout) against the recording Prisma double in tests/helpers/routeHarness.ts,
 * backed by the same small in-memory fictional world as tests/supporterAddOnS2.test.ts.
 *
 * Every name, id and address is fictional (the repository is public).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { describeTierProgressGap, validateShareScheduleEdit, describeShareTierRanges, nextAddOnRate } from '@/lib/campaignAddOnShare';
import {
    countCampaignAddOnPositionsAllocated,
    loadCampaignAddOnMoney,
    loadCoordinatorAddOnView,
    recordAddOnShareEarnings,
} from '@/lib/campaignAddOnEarnings';
import { loadCampaignAddOnAuthority, isOfferedAddOnRow } from '@/lib/campaignAddOns';
import { loadPublicCampaignAddOn } from '@/lib/publicCampaignAddOn';
import { bundleTypeChangeRefusal } from '@/lib/bundleTypeRules';
import { computeFundraiserProgress } from '@/lib/fundraiserMetrics';
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__b12Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__b12Session ?? null) }));
jest.mock('@/lib/email', () => ({
    sendOrderConfirmationEmail: jest.fn(async () => true),
    sendFundraiserCoordinatorNotification: jest.fn(async () => true),
    sendLeadNotificationEmail: jest.fn(async () => true),
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__b12CookieName ? { name, value: 'b12-coordinator-secret' } : undefined),
    }),
}));
jest.mock('@/lib/stripe', () => ({ stripe: {} }));
jest.mock('@/lib/customerAuth', () => ({ getCustomerSession: jest.fn(async () => null) }));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// ── The fictional world ─────────────────────────────────────────────────────────────────────────
const TENANT_A = 'biz-b12-aaaa';
const TENANT_B = 'biz-b12-bbbb';
const ORG_A = 'org-b12-riverside';
const ORG_B = 'org-b12-elsewhere';
const CAMP_A = 'camp-b12-a';
const CAMP_A2 = 'camp-b12-a2';
const CAMP_CLOSED = 'camp-b12-closed';
const CAMP_FOREIGN = 'camp-b12-foreign';

type BundleRow = {
    id: string; name: string; price: string | null; serving_tier: string; family_id: string | null; is_active: boolean;
    business_id: string; bundle_type: 'meal' | 'addon'; show_on_storefront: boolean; contentCount: number; sku: string;
};
const bundle = (o: Partial<BundleRow> & { id: string; name: string }): BundleRow => ({
    price: '125.00', serving_tier: 'family', family_id: null, is_active: true, business_id: TENANT_A,
    bundle_type: 'meal', show_on_storefront: true, contentCount: 3, sku: o.id.toUpperCase(), ...o,
});
const B = {
    S5: bundle({ id: 'b-b12-s5', name: 'Comfort Foods (Serves 5)', family_id: 'fam-b12-1' }),
    S2: bundle({ id: 'b-b12-s2', name: 'Comfort Foods (Serves 2)', price: '65.00', serving_tier: 'serves_2', family_id: 'fam-b12-1' }),
    SOLO: bundle({ id: 'b-b12-solo', name: 'Soup Sampler', price: '40.00', show_on_storefront: false }),
    ADDON: bundle({ id: 'b-b12-addon', name: 'Sides & Dessert Bundle', price: '25.00', bundle_type: 'addon', show_on_storefront: false }),
    ADDON2: bundle({ id: 'b-b12-addon-2', name: 'Holiday Pie Add-On', price: '18.00', bundle_type: 'addon', show_on_storefront: false }),
    ADDON_NOPRICE: bundle({ id: 'b-b12-addon-np', name: 'Unpriced Add-On', price: null, bundle_type: 'addon', show_on_storefront: false }),
    ADDON_EMPTY: bundle({ id: 'b-b12-addon-empty', name: 'Empty Add-On', price: '12.00', bundle_type: 'addon', show_on_storefront: false, contentCount: 0 }),
    ADDON_OFF: bundle({ id: 'b-b12-addon-off', name: 'Retired Add-On', price: '10.00', bundle_type: 'addon', show_on_storefront: false, is_active: false }),
    FOREIGN_ADDON: bundle({ id: 'b-b12-foreign', name: 'Another Kitchen Add-On', price: '9.00', bundle_type: 'addon', show_on_storefront: false, business_id: TENANT_B }),
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
const nextId = (p: string) => `${p}-b12-${++seq}`;

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
            'user.findFirst': { id: 'user-b12-admin' },
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
            // B2 remediation: remove is a soft remove (removed_at), and only OFFERED rows block a retype.
            'campaignAddOn.updateMany': (args: any) => {
                const hit = W.assignments.filter((x) => x.campaign_id === args.where.campaign_id && x.business_id === args.where.business_id
                    && (args.where.removed_at !== null || x.removed_at === null || x.removed_at === undefined));
                for (const a of hit) Object.assign(a, args.data);
                return { count: hit.length };
            },
            'campaignAddOn.count': (args: any) => W.assignments.filter((x) => x.bundle_id === args?.where?.bundle_id
                && (args?.where?.removed_at !== null || x.removed_at === null || x.removed_at === undefined)).length,
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
            // B1 remediation: lifetime tier positions read EVERY recorded slice on the campaign (canceled orders too).
            'orderItemAddOnShare.findMany': (args: any) => W.slices
                .filter((s) => {
                    const it = W.items.find((i) => i.id === s.order_item_id);
                    const o = it ? W.orders.find((x) => x.id === it.order_id) : null;
                    return Boolean(o) && o!.campaign_id === args?.where?.order_item?.order?.campaign_id;
                })
                .map((s) => ({ first_unit: s.first_unit, quantity: s.quantity })),
            'orderItemAddOnShare.count': (args: any) => W.slices.filter((s) => (args?.where?.order_item_id?.in ?? []).includes(s.order_item_id)).length,
            'coordinatorSession.findUnique': () => ({
                id: 'session-b12', campaign_id: (global as any).__b12CoordinatorCampaign ?? CAMP_A,
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
        create: jest.fn(async (args: any) => { invoiceCalls.push(args); mock.calls.push({ model: 'invoice', method: 'create', args }); return { id: 'inv-b12-1' }; }),
        findFirst: jest.fn(async () => null),
    };
    // Bundle deletion counts invoice lines that point at the bundle (none in this world).
    mock.client.invoiceItem = { count: jest.fn(async () => 0) };
    (global as any).__b12Prisma = mock.client;
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
    (global as any).__b12Session = { user: { businessId: TENANT_A, role: 'ADMIN', id: 'user-b12-admin' } };
    (global as any).__b12CookieName = coordinatorSessionCookieName();
    (global as any).__b12CoordinatorCampaign = CAMP_A;
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
    (global as any).__b12CoordinatorCampaign = campaignId;
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

// ── B1/B2 additions to the world ────────────────────────────────────────────────────────────────
/** The coordinator route's guarded cancel / restore write (id + campaign + canceled-state guards). */
const ORDER_UPDATE_MANY = {
    'order.updateMany': (args: any) => {
        const w = args.where ?? {};
        const hit = W.orders.filter((o) => o.id === w.id && o.campaign_id === w.campaign_id
            && (w.canceled_at !== null || o.canceled_at === null)
            && (w.NOT?.canceled_at !== null || o.canceled_at !== null));
        for (const o of hit) o.canceled_at = args.data.canceled_at ?? null;
        return { count: hit.length };
    },
};
const world = (extra: Record<string, any> = {}) => useWorld({ ...ORDER_UPDATE_MANY, ...extra });

async function coordinatorCancel(orderId: string, campaignId = CAMP_A) {
    (global as any).__b12CoordinatorCampaign = campaignId;
    const { DELETE } = await import('@/app/api/coordinator/route');
    const req = new Request('http://localhost/api/coordinator', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ orderId }),
    });
    return readJson(await DELETE(req as any));
}
async function coordinatorRestore(orderId: string, campaignId = CAMP_A) {
    (global as any).__b12CoordinatorCampaign = campaignId;
    const { PATCH } = await import('@/app/api/coordinator/route');
    const req = new Request('http://localhost/api/coordinator', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify({ action: 'restore', orderId }),
    });
    return readJson(await PATCH(req as any));
}
const orderIdOfItem = (itemId: string) => W.items.find((i) => i.id === itemId)?.order_id ?? null;
/** Every recorded tier position on CAMP_A, one entry per unit, canceled orders included. */
const allPositions = () => W.slices
    .filter((s) => W.orders.find((o) => o.id === orderIdOfItem(s.order_item_id))?.campaign_id === CAMP_A)
    .flatMap((s) => Array.from({ length: s.quantity }, (_, k) => s.first_unit + k))
    .sort((a, b) => a - b);
const activeEarnedCents = () => W.slices
    .filter((s) => W.orders.find((o) => o.id === orderIdOfItem(s.order_item_id))?.canceled_at === null)
    .reduce((c, s) => c + Math.round(s.share_amount * 100), 0);
const paper = async (addOns: number, meal: BundleRow = B.S5, addOn: BundleRow = B.ADDON) => {
    const r = await coordinatorOrder([line(meal), line(addOn, addOns)]);
    expect(r.status).toBe(200);
    return r.body.id as string;
};
const TIERS_1_3_AT_10_THEN_15: Array<[number, number]> = [[1, 10], [4, 15]];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('B1 · permanent tier positions and immutable earnings', () => {
    beforeEach(() => { world(); seedAssignment(CAMP_A, B.ADDON.id, TIERS_1_3_AT_10_THEN_15); });

    it('1–8 · the S5 reproduction: cancel keeps earnings, the next order never re-uses positions, restore reinstates them exactly once', async () => {
        const A = await paper(3);
        const Bo = await paper(2, B.S2);
        expect(slicesOf(A)).toEqual([{ first_unit: 1, quantity: 3, percent: 10, share_amount: 7.5 }]);
        expect(slicesOf(Bo)).toEqual([{ first_unit: 4, quantity: 2, percent: 15, share_amount: 7.5 }]);

        // 1 · cancel keeps the recorded earnings
        const before = JSON.stringify(W.slices);
        expect((await coordinatorCancel(A)).status).toBe(200);
        expect(JSON.stringify(W.slices)).toBe(before);
        // 2 · …but they are out of every ACTIVE total
        let view = await addOnRoute('GET', CAMP_A);
        expect([view.body.unitsSold, view.body.earnedShare, view.body.grossSales]).toEqual([2, 7.5, 50]);
        expect(view.body.tierPositionsReached).toBe(5);
        expect(view.body.tierProgressNote).toBe('Tier progress is at add-on #5: 3 add-ons on canceled orders keep their tier positions, so the next add-on sold is #6.');
        expect(view.body.addOn.next).toEqual({ nextUnit: 6, percent: 15, nextTierStart: null, nextTierPercent: null });

        // 3/4 · a new order after the cancellation starts AFTER every allocated position
        const C = await paper(3);
        expect(slicesOf(C)).toEqual([{ first_unit: 6, quantity: 3, percent: 15, share_amount: 11.25 }]);

        // 5/6 · restore reinstates A's ORIGINAL slices: no new positions, no new records
        const recordsBefore = mock.callsTo('orderItemAddOnShare.createMany').length;
        expect((await coordinatorRestore(A)).status).toBe(200);
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(recordsBefore);
        expect(slicesOf(A)).toEqual([{ first_unit: 1, quantity: 3, percent: 10, share_amount: 7.5 }]);

        // 7 · a second restore matches nothing and changes nothing
        const again = await coordinatorRestore(A);
        expect(again.status).toBe(404);
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(recordsBefore);

        const T = await paper(1);
        expect(slicesOf(T)).toEqual([{ first_unit: 9, quantity: 1, percent: 15, share_amount: 3.75 }]);

        // 8 · no duplicate positions, none skipped: 1..9 exactly once each
        expect(allPositions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // and the organization earns exactly the schedule: 3 × $2.50 + 6 × $3.75 = $30.00 (S5 recorded $28.75)
        view = await addOnRoute('GET', CAMP_A);
        expect([view.body.unitsSold, view.body.earnedShare, view.body.tierPositionsReached, view.body.tierProgressNote]).toEqual([9, 30, 9, null]);
        expect(activeEarnedCents()).toBe(3000);
    });

    it('9 · cancel and restore can never unlock a tier that tier progress has reached', async () => {
        const A = await paper(3);
        const Bo = await paper(2);
        await coordinatorCancel(A);
        await coordinatorCancel(Bo);
        const view = await addOnRoute('GET', CAMP_A);
        expect([view.body.unitsSold, view.body.tierPositionsReached]).toEqual([0, 5]);
        expect(view.body.addOn.tiers.map((t: any) => [t.rangeLabel, t.lock])).toEqual([['1–3 sold', 'locked'], ['4+ sold', 'locked_for_sold']]);
        const lowerFirst = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 5 }, { startingQuantity: 4, percent: 15 }] });
        expect(lowerFirst).toMatchObject({ status: 409, body: { code: 'SHARE_TIER_LOCKED' } });
        expect(lowerFirst.body.error).toBe('Tier progress has reached add-on #5, so the tier starting at add-on 1 (10%) is locked. Add a new tier starting at add-on 6 or later instead.');
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 20 }] })).status).toBe(409);
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 3, percent: 15 }] })).status).toBe(409);
        await coordinatorRestore(A);
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 5 }, { startingQuantity: 4, percent: 15 }] })).status).toBe(409);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent])).toEqual([[1, 10], [4, 15]]);
    });

    it('a threshold-crossing line splits at its PERMANENT positions (after a cancellation it is not renumbered from 1)', async () => {
        const A = await paper(2);
        await coordinatorCancel(A);
        const Bo = await paper(3);
        // positions 3–5: 3 @10%, 4–5 @15% — the old rule would have numbered B 1–3, all at 10%.
        expect(slicesOf(Bo)).toEqual([
            { first_unit: 3, quantity: 1, percent: 10, share_amount: 2.5 },
            { first_unit: 4, quantity: 2, percent: 15, share_amount: 7.5 },
        ]);
    });

    it('10/11 · order creation interleaved with a cancel and with a restore: every position stays unique', async () => {
        const A = await paper(3);
        const [created, canceled] = await Promise.all([coordinatorOrder([line(B.S5), line(B.ADDON, 2)]), coordinatorCancel(A)]);
        expect([created.status, canceled.status]).toEqual([200, 200]);
        const [created2, restored] = await Promise.all([coordinatorOrder([line(B.S2), line(B.ADDON, 2)]), coordinatorRestore(A)]);
        expect([created2.status, restored.status]).toEqual([200, 200]);
        expect(allPositions()).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(new Set(allPositions()).size).toBe(allPositions().length);
    });

    it('cancel and restore take the campaign lock FIRST, re-check "open" inside it, then write', async () => {
        const A = await paper(1);
        for (const [label, run] of [['cancel', () => coordinatorCancel(A)], ['restore', () => coordinatorRestore(A)]] as const) {
            world();
            expect((await run()).status).toBe(200);
            const lock = lockIndex(CAMP_A);
            const recheck = firstIndex((c) => c.model === 'fundraiserCampaign' && c.method === 'findUnique' && mock.calls.indexOf(c) > lock);
            const write = firstIndex((c) => c.model === 'order' && c.method === 'updateMany');
            expect({ label, order: lock > -1 && lock < recheck && recheck < write }).toEqual({ label, order: true });
        }
    });

    it('cancel and restore on a closed campaign are refused — including one that closed after the first read', async () => {
        const A = await paper(1);
        world({
            'fundraiserCampaign.findUnique': (args: any) => ({ ...W.campaigns[args?.where?.id], status: 'Closed', closed_at: new Date() }),
        });
        for (const run of [() => coordinatorCancel(A), () => coordinatorRestore(A)]) {
            const r = await run();
            expect(r).toMatchObject({ status: 400, body: { error: 'Campaign is closed. Order changes are no longer permitted.' } });
        }
        expect(mock.callsTo('order.updateMany')).toHaveLength(0);
    });

    it('the recorder never records the same order twice (a second call would allocate new positions)', async () => {
        const A = await paper(2);
        world();
        await expect(recordAddOnShareEarnings(mock.client, { campaignId: CAMP_A, businessId: TENANT_A, orderId: A })).rejects.toThrow(/already recorded/);
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(0);
        expect(allPositions()).toEqual([1, 2]);
    });

    it('lifetime positions read every recorded slice on the campaign (canceled orders INCLUDED) and are 0 with none', async () => {
        expect(await countCampaignAddOnPositionsAllocated(mock.client, CAMP_A)).toBe(0);
        const A = await paper(3);
        await paper(2);
        await coordinatorCancel(A);
        expect(await countCampaignAddOnPositionsAllocated(mock.client, CAMP_A)).toBe(5);
        expect(mock.callsTo('orderItemAddOnShare.findMany').pop()!.args.where).toEqual({ order_item: { order: { campaign_id: CAMP_A } } });
        expect(await countCampaignAddOnPositionsAllocated(mock.client, CAMP_A2)).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('B2 · removing an add-on keeps the campaign\'s share schedule', () => {
    beforeEach(() => { world(); seedAssignment(CAMP_A, B.ADDON.id, TIERS_1_3_AT_10_THEN_15); });

    it('13/14 · removed after sales: offered nowhere; schedule, locks, positions and earnings all kept', async () => {
        await paper(3);
        await paper(2);
        const removed = await addOnRoute('DELETE', CAMP_A);
        expect(removed.status).toBe(200);
        expect(mock.callsTo('campaignAddOn.deleteMany')).toHaveLength(0);
        expect(mock.callsTo('campaignAddOnShareTier.deleteMany')).toHaveLength(0);
        expect(removed.body.addOn).toBeNull();
        expect(removed.body.removedAddOn).toMatchObject({ name: 'Sides & Dessert Bundle' });
        expect(removed.body.removedAddOn.tiers.map((t: any) => [t.rangeLabel, t.percent, t.lock])).toEqual([['1–3 sold', 10, 'locked'], ['4+ sold', 15, 'locked_for_sold']]);
        expect([removed.body.unitsSold, removed.body.earnedShare, removed.body.tierPositionsReached]).toEqual([5, 15, 5]);
        expect(W.tiers.map((t) => [t.starting_quantity, t.percent])).toEqual([[1, 10], [4, 15]]);
        // not offered: paper and supporter add-on orders are refused; the coordinator sees no add-on card
        expect(await coordinatorOrder([line(B.S5), line(B.ADDON, 1)])).toMatchObject({ status: 409, body: { code: 'ADDON_CHANGED' } });
        expect(await supporterOrder(CAMP_A, [line(B.S5), line(B.ADDON, 1)])).toMatchObject({ status: 409, body: { code: 'ADDON_CHANGED' } });
        expect(await loadCoordinatorAddOnView(mock.client, { campaignId: CAMP_A, businessId: TENANT_A })).toBeNull();
        // …but the money already earned is still the organization's
        expect(await loadCampaignAddOnMoney(mock.client, CAMP_A)).toEqual({ unitsSold: 5, grossSales: 125, earnedShare: 15 });
        // schedule and display edits wait until an add-on is offered again
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 15 }, { startingQuantity: 20, percent: 20 }] })).body.code).toBe('NO_ADDON_ASSIGNED');
        expect((await addOnRoute('PATCH', CAMP_A, { showSharePercent: true })).body.code).toBe('NO_ADDON_ASSIGNED');
        // a repeat remove changes nothing
        const repeat = await addOnRoute('DELETE', CAMP_A);
        expect([repeat.status, repeat.body.changed]).toEqual([200, false]);
    });

    it('15 · re-assigning the SAME add-on resumes the schedule at the next position', async () => {
        await paper(3);
        await paper(2);
        await addOnRoute('DELETE', CAMP_A);
        const resumed = await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        expect(resumed.status).toBe(200);
        expect(mock.callsTo('campaignAddOn.create')).toHaveLength(0);
        expect(resumed.body.removedAddOn).toBeNull();
        expect(resumed.body.addOn.tiers.map((t: any) => [t.rangeLabel, t.percent, t.lock])).toEqual([['1–3 sold', 10, 'locked'], ['4+ sold', 15, 'locked_for_sold']]);
        expect(resumed.body.addOn.next).toEqual({ nextUnit: 6, percent: 15, nextTierStart: null, nextTierPercent: null });
        const next = await paper(1);
        expect(slicesOf(next)).toEqual([{ first_unit: 6, quantity: 1, percent: 15, share_amount: 3.75 }]);
    });

    it('16 · a REPLACEMENT add-on continues the same schedule and the same positions', async () => {
        await paper(3);
        await paper(2);
        await addOnRoute('DELETE', CAMP_A);
        const replaced = await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON2.id });
        expect(replaced.status).toBe(200);
        expect(replaced.body.addOn).toMatchObject({ bundleId: B.ADDON2.id, name: 'Holiday Pie Add-On' });
        expect(replaced.body.addOn.tiers.map((t: any) => [t.startingQuantity, t.percent])).toEqual([[1, 10], [4, 15]]);
        const next = await paper(2, B.S5, B.ADDON2);
        // $18 × 2 × 15% = $5.40 at positions 6–7
        expect(slicesOf(next)).toEqual([{ first_unit: 6, quantity: 2, percent: 15, share_amount: 5.4 }]);
        // while offered, a direct replace keeps it too
        const back = await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        expect(back.body.addOn.tiers.map((t: any) => [t.startingQuantity, t.percent])).toEqual([[1, 10], [4, 15]]);
        expect(allPositions()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    it('17 · changing the normal meal share never resets the add-on schedule', async () => {
        await paper(2);
        W.campaigns[CAMP_A].org_share_percent = '30.00';
        await addOnRoute('DELETE', CAMP_A);
        const resumed = await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        expect(resumed.body.mealSharePercent).toBe(30);
        expect(resumed.body.addOn.tiers.map((t: any) => [t.startingQuantity, t.percent])).toEqual([[1, 10], [4, 15]]);
        // the add-on schedule has exactly one writer, and the meal share is read only to start a NEW program
        const hits = execSync('git grep -l -E "campaignAddOnShareTier\\.(create|update|updateMany|delete|deleteMany|upsert)|share_tiers: \\{ create" -- app lib components', { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        expect(hits).toEqual(['lib/campaignAddOnEarnings.ts']);
        const earnings = R('lib/campaignAddOnEarnings.ts');
        const assign = earnings.slice(earnings.indexOf('export async function assignCampaignAddOn'), earnings.indexOf('export async function removeCampaignAddOn'));
        expect(assign.indexOf('defaultShareTiers(params.campaign.org_share_percent)')).toBeGreaterThan(assign.indexOf('if (existing) {'));
    });

    it('18/19 · after a resume, future tiers stay editable and reached tiers stay locked', async () => {
        await paper(5);
        await addOnRoute('DELETE', CAMP_A);
        await addOnRoute('PUT', CAMP_A, { bundleId: B.ADDON.id });
        const future = await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 15 }, { startingQuantity: 21, percent: 20 }] });
        expect(future.status).toBe(200);
        expect(future.body.addOn.tiers.map((t: any) => [t.rangeLabel, t.lock])).toEqual([['1–3 sold', 'locked'], ['4–20 sold', 'locked_for_sold'], ['21+ sold', 'editable']]);
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 15 }, { startingQuantity: 21, percent: 25 }] })).status).toBe(200);
        expect((await addOnRoute('PATCH', CAMP_A, { tiers: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 12 }] })).body.code).toBe('SHARE_TIER_LOCKED');
    });

    it('a genuinely NEW program inherits the meal share; recorded positions without a schedule are refused, never guessed', async () => {
        const fresh = await addOnRoute('PUT', CAMP_A2, { bundleId: B.ADDON.id });
        expect(fresh.body.addOn.tiers.map((t: any) => [t.startingQuantity, t.percent])).toEqual([[1, 25]]);
        // pre-B2 data: CAMP_A2 has a recorded position but its row is gone (old remove deleted it)
        W.assignments = W.assignments.filter((a) => a.campaign_id !== CAMP_A2);
        W.orders.push({ id: 'o-legacy', campaign_id: CAMP_A2, canceled_at: null, total_amount: 150, tax_amount: 0 });
        W.items.push({ id: 'i-legacy', order_id: 'o-legacy', bundle_id: B.ADDON.id, quantity: 1, unit_price: 25, item_role: 'addon', variant_size: 'serves_5', item_name: B.ADDON.name });
        W.slices.push({ order_item_id: 'i-legacy', first_unit: 1, quantity: 1, percent: 10, unit_price: 25, share_amount: 2.5 });
        world();
        const refused = await addOnRoute('PUT', CAMP_A2, { bundleId: B.ADDON.id });
        expect(refused).toMatchObject({ status: 409, body: { code: 'ADDON_HISTORY_WITHOUT_SCHEDULE' } });
        expect(mock.callsTo('campaignAddOn.create')).toHaveLength(0);
    });

    it('every reader treats a removed row as "no add-on": order authority, supporter page, retype rule', async () => {
        const bundleRow = { id: B.ADDON.id, name: 'Sides & Dessert Bundle', description: 'Fictional sides.', image_url: null, price: '25.00', business_id: TENANT_A, is_active: true, bundle_type: 'addon', contents: [{ quantity: 1, recipe: { name: 'Green Beans (fixture)' } }] };
        const db = (removed_at: Date | null) => ({
            campaignAddOn: {
                findUnique: async () => ({ business_id: TENANT_A, bundle_id: B.ADDON.id, show_share_percent: false, removed_at, bundle: bundleRow, share_tiers: [{ starting_quantity: 1, percent: 10 }] }),
                count: async (args: any) => (args?.where?.removed_at === null && removed_at !== null ? 0 : 1),
            },
            campaignBundle: { count: async () => 0 },
        });
        expect(await loadCampaignAddOnAuthority(db(null), { campaignId: CAMP_A, businessId: TENANT_A })).toEqual({ bundleId: B.ADDON.id, name: 'Sides & Dessert Bundle' });
        expect(await loadCampaignAddOnAuthority(db(new Date()), { campaignId: CAMP_A, businessId: TENANT_A })).toBeNull();
        expect(await loadPublicCampaignAddOn(db(null), { campaignId: CAMP_A, businessId: TENANT_A, orderable: true })).not.toBeNull();
        expect(await loadPublicCampaignAddOn(db(new Date()), { campaignId: CAMP_A, businessId: TENANT_A, orderable: true })).toBeNull();
        // retyping the bundle back to a meal: refused while offered, allowed once removed
        expect(await bundleTypeChangeRefusal(db(null), { bundleId: B.ADDON.id, from: 'addon', to: 'meal', familyId: null })).toMatch(/supporter add-on/);
        expect(await bundleTypeChangeRefusal(db(new Date()), { bundleId: B.ADDON.id, from: 'addon', to: 'meal', familyId: null })).toBeNull();
        expect([isOfferedAddOnRow({ removed_at: null }), isOfferedAddOnRow({ removed_at: new Date() }), isOfferedAddOnRow(null)]).toEqual([true, false, false]);
        // every reader of the assignment selects removed_at (an unselected column would read as "offered")
        // SUPERSEDED PIN (FR-ADDON-LAUNCH-FLOW-1 1B, owner-approved 2026-11-25): readers may select removed_at through
        // OFFER_STATE_SELECT / OFFER_STATE_WITH_DECIDED_AT_SELECT, which both include it (pinned in addonLaunchFlow1).
        for (const f of ['lib/campaignAddOns.ts', 'lib/publicCampaignAddOn.ts', 'lib/campaignAddOnEarnings.ts']) {
            const src = R(f);
            const finds = src.split('campaignAddOn.findUnique(').length - 1;
            const selects = (src.match(/\.\.\.(REMOVED_AT_SELECT|OFFER_STATE_SELECT|OFFER_STATE_WITH_DECIDED_AT_SELECT)\b/g) || []).length;
            expect({ f, ok: finds > 0 && selects >= finds }).toEqual({ f, ok: true });
        }
    });

    it('the coordinator\'s "raised" figure keeps the RECORDED add-on money after a removal (not the meal % on add-on sales)', async () => {
        await paper(3);
        await paper(2);
        await addOnRoute('DELETE', CAMP_A);
        const money = await loadCampaignAddOnMoney(mock.client, CAMP_A);
        const orders = W.orders.map((o) => ({ items: W.items.filter((i) => i.order_id === o.id).map(itemShape) }));
        const totalSales = 2 * 125 + 5 * 25;
        const exact = computeFundraiserProgress(50, totalSales, orders as any, '20.00', { grossSales: money.grossSales, earnedShare: money.earnedShare });
        const withoutMoney = computeFundraiserProgress(50, totalSales, orders as any, '20.00', null);
        expect(exact.raisedAmount).toBe(50 + 15);       // $250 meals × 20% + $15 recorded add-on share
        expect(withoutMoney.raisedAmount).toBe(75);     // what the portal showed before: $375 × 20%
        const route = R('app/api/coordinator/route.ts');
        expect(route).toMatch(/const money = await loadCampaignAddOnMoney\(prisma, campaign\.id\);/);
        expect(route).toMatch(/\.\.\.campaignResponse,\n\s+addOn,\n\s+addOnMoney,/);
        expect(R('app/coordinator/portal/page.tsx')).toMatch(/campaign\.addOnMoney\n\s+\?\? \(campaign\.addOn \?/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('20/21 · closeout counts canceled earnings never and restored earnings exactly once', () => {
    beforeEach(() => { world(); seedAssignment(CAMP_A, B.ADDON.id, TIERS_1_3_AT_10_THEN_15); });

    it('cancel A, sell C, restore A, cancel B, then close: A and C counted once each, B not at all; totals exact', async () => {
        const A = await paper(3);            // positions 1–3 @10%  = $7.50
        const Bo = await paper(2, B.S2);     // positions 4–5 @15%  = $7.50
        await coordinatorCancel(A);
        await paper(3);                      // C: positions 6–8 @15% = $11.25
        await coordinatorRestore(A);
        await coordinatorCancel(Bo);
        world();
        const r = await closeout(CAMP_A);
        expect(r.status).toBe(200);
        // Active: A (S5 + 3) and C (S5 + 3). Meals $250 × 20% = $50. Add-ons $150 earned $7.50 + $11.25 = $18.75.
        expect(r.body.financials).toMatchObject({
            main_gross_sales: 250, main_organization_amount: 50,
            add_on_gross_sales: 150, add_on_organization_amount: 18.75,
            organization_amount: 68.75,
        });
        const f = r.body.financials;
        // the invoice-total invariant: gross − organization share = what the organization owes
        expect(Math.round((f.gross_sales - f.organization_amount) * 100)).toBe(Math.round(f.base_remit * 100));
        expect(f.base_remit).toBe(331.25);
        // the drafted invoice: lines at their own prices, the one share line equal to the organization amount
        const inv = mock.callsTo('invoice.create')[0].args.data;
        const lines = inv.items.create as Array<{ total: number | string; item_role?: string }>;
        const lineCents = lines.reduce((c, l) => c + Math.round(Number(l.total) * 100), 0);
        expect(lineCents).toBe(40000);
        expect(Math.round(Number(inv.total_amount) * 100)).toBe(Math.round(f.base_remit * 100) + Math.round(Number(inv.tax_amount ?? 0) * 100));
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('22 · campaigns without an add-on are unchanged', () => {
    beforeEach(() => { world(); });

    it('a meal-only order reads no positions and records nothing; the view has no add-on, no removed add-on, no note', async () => {
        const r = await coordinatorOrder([line(B.S5), line(B.S2)]);
        expect(r.status).toBe(200);
        expect(mock.callsTo('orderItemAddOnShare.findMany')).toHaveLength(0);
        expect(mock.callsTo('orderItemAddOnShare.count')).toHaveLength(0);
        expect(mock.callsTo('orderItemAddOnShare.createMany')).toHaveLength(0);
        const view = await addOnRoute('GET', CAMP_A);
        expect([view.body.addOn, view.body.removedAddOn, view.body.unitsSold, view.body.tierPositionsReached, view.body.tierProgressNote]).toEqual([null, null, 0, 0, null]);
        // cancel / restore of a meal-only order behave exactly as before
        expect((await coordinatorCancel(r.body.id)).status).toBe(200);
        expect((await coordinatorRestore(r.body.id)).status).toBe(200);
    });

    it('the transparency note appears only when canceled add-ons hold positions, in plain words', () => {
        expect(describeTierProgressGap({ activeSold: 9, positionsReached: 9 })).toBeNull();
        expect(describeTierProgressGap({ activeSold: 0, positionsReached: 0 })).toBeNull();
        expect(describeTierProgressGap({ activeSold: 4, positionsReached: 5 })).toBe('Tier progress is at add-on #5: 1 add-on on canceled orders keeps its tier position, so the next add-on sold is #6.');
        expect(describeTierProgressGap({ activeSold: 2, positionsReached: 5 })).toBe('Tier progress is at add-on #5: 3 add-ons on canceled orders keep their tier positions, so the next add-on sold is #6.');
    });

    it('pure rules take LIFETIME positions: locks, ranges and the next rate never fall back after a cancel', () => {
        const T = [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 15 }];
        expect(validateShareScheduleEdit({ current: T, next: [{ startingQuantity: 1, percent: 5 }, { startingQuantity: 4, percent: 15 }], positionsReached: 5 })).toMatchObject({ ok: false, code: 'SHARE_TIER_LOCKED' });
        // the boundary: tier progress sitting exactly on a tier's FIRST position has reached that tier
        expect(validateShareScheduleEdit({ current: T, next: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 20 }], positionsReached: 4 })).toMatchObject({ ok: false, code: 'SHARE_TIER_LOCKED' });
        expect(validateShareScheduleEdit({ current: T, next: [{ startingQuantity: 1, percent: 10 }, { startingQuantity: 4, percent: 20 }], positionsReached: 3 })).toMatchObject({ ok: true });
        expect(describeShareTierRanges(T, 4).map((r) => r.lock)).toEqual(['locked', 'locked_for_sold']);
        expect(describeShareTierRanges(T, 5).map((r) => r.lock)).toEqual(['locked', 'locked_for_sold']);
        expect(nextAddOnRate(T, 5)).toEqual({ nextUnit: 6, percent: 15, nextTierStart: null, nextTierPercent: null });
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe('migration and scope', () => {
    const B2 = 'prisma/migrations/20261127120000_supporter_addon_b2_removed_at/migration.sql';

    it('B2 adds exactly one nullable column; no committed migration is modified', () => {
        const code = R(B2).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
        expect(code.split(';').map((s) => s.trim()).filter(Boolean)).toEqual(['ALTER TABLE "campaign_add_ons" ADD COLUMN "removed_at" TIMESTAMP(3)']);
        expect(R('prisma/schema.prisma')).toMatch(/model CampaignAddOn \{[\s\S]*?removed_at DateTime\?\n[\s\S]*?@@map\("campaign_add_ons"\)/);
        const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
        // SUPERSEDED PIN (FR-ADDON-LAUNCH-FLOW-1 1B, owner-approved 2026-11-25): followed only by the approved, additive
        // coordinator-participation migration.
        expect(dirs.slice(-6)).toEqual([
            '20261123120000_supporter_addon_s1', '20261124120000_supporter_addon_s2', '20261125120000_supporter_addon_s3',
            '20261126120000_supporter_addon_s4', '20261127120000_supporter_addon_b2_removed_at', '20261128120000_supporter_addon_coordinator_choice',
        ]);
        // Every migration that existed at dd928f0 is unchanged (modified or deleted); the B2 file is the only addition.
        const touched = execSync('git diff --name-only --diff-filter=MDR dd928f0 -- prisma/migrations', { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(touched).toBe('');
        const added = execSync('git diff --name-only --diff-filter=A dd928f0 -- prisma/migrations', { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(added).toBe('prisma/migrations/20261127120000_supporter_addon_b2_removed_at/migration.sql');
    });

    it('the protected order routes, closeout, invoice and QuickBooks code are untouched by the remediation', () => {
        const files = [
            'app/api/public/order/route.ts', 'lib/statusWorkflow.ts', 'app/api/orders/route.ts', 'app/api/campaigns/[id]/closeout/route.ts',
            'lib/fundraiserCloseoutMath.ts', 'lib/quickbooks/invoiceSend.ts', 'lib/pricing.ts', 'lib/kitchen_engine.ts', 'lib/orderDeletion.ts',
        ].filter((f) => fs.existsSync(path.join(ROOT, f)));
        expect(files.length).toBeGreaterThanOrEqual(8);
        const changed = execSync(`git diff --name-only dd928f0 -- ${files.map((f) => `"${f}"`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' }).trim();
        expect(changed).toBe('');
    });
});
