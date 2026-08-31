/**
 * OPS-3 Part O — the fundraiser batch/release matrix, against REAL Postgres.
 *
 * WHY THIS EXISTS ALONGSIDE tests/ops3FundraiserBatchProduction.test.ts
 *
 * That suite proves the LOGIC (pure aggregation) and the WIRING (the real
 * route handlers over recording doubles). This one proves the QUERIES: that
 * the exact Prisma predicates OPS-3 relies on actually behave against the
 * real schema — the mutual exclusion between held and released orders, the
 * exact-once release, campaign-level grouping, and the fact that archiving a
 * campaign cannot pull released work back out of the kitchen.
 *
 * RUNNING IT (opt-in, exactly like tests/frFlow3Concurrency.test.ts):
 *
 *   OPS3_DB_URL=postgresql://postgres:PASS@127.0.0.1:5432/freezer_iq_ops3_disposable \
 *     npx jest ops3RealDbMatrix
 *
 * Point it ONLY at a disposable database. It creates and deletes its own
 * fixtures and never reads or writes anything it did not create. Without the
 * variable the suite is SKIPPED, never silently green — `describe.skip`
 * reports the count — so a bare `npx jest` on a machine with no database is
 * unaffected.
 */
import { PrismaClient } from '@prisma/client';
import { buildFundraiserBatches } from '@/lib/fundraiserProductionBatch';

const DB_URL = process.env.OPS3_DB_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

let db: PrismaClient;

/** Everything this run creates, so teardown removes exactly its own rows. */
const BIZ = 'ops3-biz-A';
const BIZ_OTHER = 'ops3-biz-B';
const ORG = 'ops3-org-X';
const CAMP_A = 'ops3-camp-A';
const CAMP_B = 'ops3-camp-B';
const BUNDLE_KETO = 'ops3-bundle-keto';
const BUNDLE_PALEO = 'ops3-bundle-paleo';
const INVOICE_A = 'ops3-invoice-A';

/** The EXACT release statement shipped in the settle route's campaign branch. */
async function releaseCampaign(campaignId: string, businessId: string) {
    return db.order.updateMany({
        where: {
            campaign_id: campaignId,
            business_id: businessId,
            source: 'fundraiser' as any,
            status: 'fundraiser_hold' as any,
            canceled_at: null,
        },
        data: { status: 'production_ready' as any },
    });
}

/** The EXACT fundraiser-waiting query shipped in the production dashboard. */
async function fundraiserWaiting(businessId: string) {
    const rows = await db.order.findMany({
        where: {
            business_id: businessId,
            canceled_at: null,
            status: 'fundraiser_hold' as any,
            campaign_id: { not: null },
        },
        select: {
            id: true, campaign_id: true, total_amount: true,
            items: {
                select: {
                    id: true, bundle_id: true, quantity: true,
                    variant_size: true, item_name: true,
                    bundle: { select: { id: true, name: true } },
                },
            },
            campaign: {
                select: {
                    id: true, name: true, delivery_date: true, end_date: true,
                    customer: { select: { name: true } },
                    invoices: { select: { id: true, status: true, paid_at: true } },
                },
            },
        },
        orderBy: { created_at: 'desc' },
    });
    return buildFundraiserBatches(rows as any);
}

/** The EXACT customer "To Prep" predicate shipped in the dashboard. */
async function customerPrepOrders(businessId: string) {
    return db.order.findMany({
        where: {
            business_id: businessId,
            canceled_at: null,
            status: { in: ['production_ready', 'APPROVED', 'in_production', 'IN_PRODUCTION'] as any },
            NOT: { status: 'fundraiser_hold' as any },
        },
        select: { id: true, source: true, campaign_id: true },
    });
}

const mkOrder = async (
    id: string,
    campaignId: string | null,
    source: string,
    status: string,
    items: { id: string; bundleId: string | null; qty: number; variant: string; name: string }[],
    businessId = BIZ,
) => {
    await db.order.create({
        data: {
            id,
            external_id: id,
            source: source as any,
            status: status as any,
            business_id: businessId,
            customer_id: ORG,
            campaign_id: campaignId,
            total_amount: 100,
            items: {
                create: items.map((i) => ({
                    id: i.id,
                    bundle_id: i.bundleId,
                    quantity: i.qty,
                    variant_size: i.variant as any,
                    item_name: i.name,
                    unit_price: 50,
                })),
            },
        },
    });
};

beforeAll(async () => {
    if (!DB_URL) return;
    db = new PrismaClient({ datasourceUrl: DB_URL });

    await db.business.create({ data: { id: BIZ, name: 'OPS3 Tenant A', slug: 'ops3-a' } });
    await db.business.create({ data: { id: BIZ_OTHER, name: 'OPS3 Tenant B', slug: 'ops3-b' } });
    await db.customer.create({
        data: { id: ORG, business_id: BIZ, name: 'Organization X', external_id: ORG, type: 'fundraiser_org' as any },
    });
    await db.bundle.create({ data: { id: BUNDLE_KETO, business_id: BIZ, name: 'Fall Keto', sku: 'KETO', price: 125 } });
    await db.bundle.create({ data: { id: BUNDLE_PALEO, business_id: BIZ, name: 'Clean Eating/Paleo', sku: 'PALEO', price: 125 } });

    // Two campaigns for the SAME organization — the separation case.
    for (const [id, name] of [[CAMP_A, 'Brew Test 4'], [CAMP_B, 'Spring Sale']] as const) {
        await db.fundraiserCampaign.create({
            data: {
                id, name, customer_id: ORG, status: 'Active',
                portal_token: id + '-token',
                delivery_date: new Date('2026-10-17T00:00:00.000Z'),
                end_date: new Date('2026-10-01T00:00:00.000Z'),
            },
        });
    }

    // Campaign A: two public supporter orders + one coordinator-added order.
    await mkOrder('ops3-o-public-1', CAMP_A, 'fundraiser', 'fundraiser_hold',
        [{ id: 'ops3-i-1', bundleId: BUNDLE_KETO, qty: 5, variant: 'serves_5', name: 'Fall Keto' }]);
    await mkOrder('ops3-o-public-2', CAMP_A, 'fundraiser', 'fundraiser_hold',
        [{ id: 'ops3-i-2', bundleId: BUNDLE_KETO, qty: 6, variant: 'serves_5', name: 'Fall Keto' },
         { id: 'ops3-i-3', bundleId: BUNDLE_KETO, qty: 4, variant: 'serves_2', name: 'Fall Keto' }]);
    await mkOrder('ops3-o-coord-1', CAMP_A, 'fundraiser', 'fundraiser_hold',
        [{ id: 'ops3-i-4', bundleId: BUNDLE_PALEO, qty: 8, variant: 'serves_5', name: 'Clean Eating/Paleo' }]);

    // Campaign B for the same org — must never merge with A.
    await mkOrder('ops3-o-campB-1', CAMP_B, 'fundraiser', 'fundraiser_hold',
        [{ id: 'ops3-i-5', bundleId: BUNDLE_KETO, qty: 2, variant: 'serves_5', name: 'Fall Keto' }]);

    // An ordinary customer order — must stay in customer intake.
    await mkOrder('ops3-o-customer-1', null, 'storefront', 'production_ready',
        [{ id: 'ops3-i-6', bundleId: BUNDLE_KETO, qty: 1, variant: 'serves_5', name: 'Fall Keto' }]);

    // Campaign A's invoice, created UNPAID exactly as closeout creates it.
    await db.invoice.create({
        data: {
            id: INVOICE_A, business_id: BIZ, customer_id: ORG, campaign_id: CAMP_A,
            status: 'DRAFT' as any, total_amount: 500,
        },
    });
}, 120_000);

afterAll(async () => {
    if (!DB_URL || !db) return;
    await db.orderItem.deleteMany({ where: { id: { startsWith: 'ops3-i-' } } });
    await db.order.deleteMany({ where: { id: { startsWith: 'ops3-o-' } } });
    await db.invoice.deleteMany({ where: { id: INVOICE_A } });
    await db.fundraiserCampaign.deleteMany({ where: { id: { in: [CAMP_A, CAMP_B] } } });
    await db.bundle.deleteMany({ where: { id: { in: [BUNDLE_KETO, BUNDLE_PALEO] } } });
    await db.customer.deleteMany({ where: { id: ORG } });
    await db.business.deleteMany({ where: { id: { in: [BIZ, BIZ_OTHER] } } });
    await db.$disconnect();
}, 120_000);

describeIfDb('OPS-3 real database matrix', () => {
    it('before payment: ONE waiting group for Campaign A, correctly aggregated, and nothing released', async () => {
        const batches = await fundraiserWaiting(BIZ);
        const a = batches.find((b) => b.campaignId === CAMP_A)!;

        expect(a).toBeDefined();
        expect(a.orderCount).toBe(3);                    // 2 public + 1 coordinator, ONE group
        expect(a.campaignName).toBe('Brew Test 4');
        expect(a.organizationName).toBe('Organization X');
        expect(a.invoicePaid).toBe(false);
        expect(a.invoiceStatus).toBe('DRAFT');

        // Aggregate: Keto S5 5+6=11, Keto S2 4, Paleo S5 8.
        const byKey = Object.fromEntries(a.lines.map((l) => [`${l.bundleName}|${l.variantSize}`, l.quantity]));
        expect(byKey['Fall Keto|serves_5']).toBe(11);
        expect(byKey['Fall Keto|serves_2']).toBe(4);
        expect(byKey['Clean Eating/Paleo|serves_5']).toBe(8);
        expect(a.totalUnitCount).toBe(23);

        // Nothing from Campaign A is in the customer prep lane.
        const prep = await customerPrepOrders(BIZ);
        expect(prep.map((o) => o.id)).not.toContain('ops3-o-public-1');
    });

    it('5. Campaign B (same organization) is a SEPARATE waiting group', async () => {
        const batches = await fundraiserWaiting(BIZ);
        expect(batches.map((b) => b.campaignId).sort()).toEqual([CAMP_A, CAMP_B].sort());
        const b = batches.find((x) => x.campaignId === CAMP_B)!;
        expect(b.orderCount).toBe(1);
        expect(b.organizationName).toBe('Organization X'); // same org, still separate
    });

    it('6/7. the ordinary customer order sits in customer intake and NOT in any fundraiser group', async () => {
        const prep = await customerPrepOrders(BIZ);
        expect(prep.map((o) => o.id)).toContain('ops3-o-customer-1');

        const batches = await fundraiserWaiting(BIZ);
        const allBatchOrderIds = batches.flatMap((b) => b.sourceOrderIds);
        expect(allBatchOrderIds).not.toContain('ops3-o-customer-1');
    });

    it('14/26. recording payment releases Campaign A exactly once', async () => {
        // Mirror the real settle route: the invoice becomes PAID, then the
        // winner-only branch runs the release.
        await db.invoice.update({ where: { id: INVOICE_A }, data: { status: 'PAID' as any, paid_at: new Date() } });

        const first = await releaseCampaign(CAMP_A, BIZ);
        expect(first.count).toBe(3);

        // Campaign A leaves the waiting lane entirely...
        const batches = await fundraiserWaiting(BIZ);
        expect(batches.map((b) => b.campaignId)).not.toContain(CAMP_A);

        // ...and its orders arrive in the customer-visible prep lane.
        const prep = await customerPrepOrders(BIZ);
        const ids = prep.map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining(['ops3-o-public-1', 'ops3-o-public-2', 'ops3-o-coord-1']));
    });

    it('27/28/29/30/31. repeating the release promotes NOTHING — the status predicate is the durable claim', async () => {
        const second = await releaseCampaign(CAMP_A, BIZ);
        expect(second.count).toBe(0);
        const third = await releaseCampaign(CAMP_A, BIZ);
        expect(third.count).toBe(0);

        // Still exactly three released orders for A — no duplicates were created.
        const released = await db.order.count({
            where: { campaign_id: CAMP_A, status: 'production_ready' as any },
        });
        expect(released).toBe(3);
    });

    it('Campaign B was NOT released by Campaign A\'s payment', async () => {
        const batches = await fundraiserWaiting(BIZ);
        expect(batches.map((b) => b.campaignId)).toContain(CAMP_B);
        const stillHeld = await db.order.count({
            where: { campaign_id: CAMP_B, status: 'fundraiser_hold' as any },
        });
        expect(stillHeld).toBe(1);
    });

    it('34/35. archiving Campaign A does NOT remove its released production work', async () => {
        await db.fundraiserCampaign.update({ where: { id: CAMP_A }, data: { status: 'Archived' } });

        const prep = await customerPrepOrders(BIZ);
        const ids = prep.map((o) => o.id);
        expect(ids).toEqual(expect.arrayContaining(['ops3-o-public-1', 'ops3-o-public-2', 'ops3-o-coord-1']));

        const released = await db.order.count({
            where: { campaign_id: CAMP_A, status: 'production_ready' as any },
        });
        expect(released).toBe(3);
    });

    it('36/37/38. tenant isolation: Tenant B sees no Tenant A fundraiser work, and cannot release it', async () => {
        const otherBatches = await fundraiserWaiting(BIZ_OTHER);
        expect(otherBatches).toHaveLength(0);

        // Even holding Campaign B's real id, a Tenant B release matches nothing.
        const crossTenant = await releaseCampaign(CAMP_B, BIZ_OTHER);
        expect(crossTenant.count).toBe(0);

        const stillHeld = await db.order.count({
            where: { campaign_id: CAMP_B, status: 'fundraiser_hold' as any },
        });
        expect(stillHeld).toBe(1);
    });
});
