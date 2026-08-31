/**
 * OPS-3 RELEASE-BLOCKER CORRECTION — the fundraiser hold must be absolute.
 *
 * THE BLOCKER
 *
 * OPS-3 moved fundraiser release onto the authoritative Invoice PAID event
 * and taught the Kitchen Board to keep held orders in their own waiting lane.
 * But the Kitchen Board is only ONE of two definitions of "visible to
 * production". The other is PrismaAdapter.getProductionOrders(), which feeds
 * three routes that can do real kitchen work:
 *
 *   GET  /api/production/sync  -> Manual Planner "Auto-Sync Orders"
 *   POST /api/production/plan  -> KitchenEngine ingredient demand
 *   POST /api/production/runs  -> KitchenEngine AND a PERSISTED ProductionRun
 *
 * Its where-clause was:
 *
 *   OR: [ { status: { in: [pending, production_ready, in_production, ...] } },
 *         { customer: { status: 'PRODUCTION' } } ]
 *
 * The second branch matches on the CUSTOMER's CRM pipeline stage and asserts
 * nothing about the ORDER. `PRODUCTION` is an ordinary stage in STATUS_FLOW
 * (ACTIVE -> PRODUCTION -> DELIVERY), reachable by a manual CRM advance and
 * also automatically by progressStatus() when marketing email is sent — and a
 * fundraiser organization is an ordinary Customer row, so nothing stops one
 * from reaching it. Parking an organization there therefore made EVERY order
 * it owns production-eligible, including unpaid `fundraiser_hold` orders and
 * canceled ones. That silently bypassed the invoice-paid gate OPS-3 exists to
 * enforce.
 *
 * These tests run against REAL Postgres because this is a question about what
 * a query actually returns; a mocked Prisma would only assert the mock.
 *
 * RUNNING (opt-in, same convention as tests/ops3RealDbMatrix.test.ts):
 *
 *   DATABASE_URL=postgresql://postgres:PASS@127.0.0.1:5432/disposable_db \
 *   OPS3_DB_URL=postgresql://postgres:PASS@127.0.0.1:5432/disposable_db \
 *     npx jest ops3ProductionIntakeHold
 *
 * BOTH variables are required and must match. OPS3_DB_URL gates the suite and
 * drives this file's own fixture client; DATABASE_URL is what lib/db.ts's
 * singleton reads, and that singleton is what PrismaAdapter — the code under
 * test — actually queries through. Jest loads no dotenv, so DATABASE_URL here
 * comes only from the invoking shell.
 *
 * Point them ONLY at a disposable database. Without OPS3_DB_URL the suite is
 * SKIPPED, never silently green.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaAdapter } from '@/lib/prisma_adapter';

const DB_URL = process.env.OPS3_DB_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

let db: PrismaClient;
let adapter: PrismaAdapter;

const BIZ = 'ops3b-biz';
const ORG_FUND = 'ops3b-org-fundraiser';
const ORG_CUST = 'ops3b-org-customer';
const CAMP = 'ops3b-camp';
const BUNDLE = 'ops3b-bundle';

const mkOrder = async (
    id: string,
    opts: {
        customerId: string;
        campaignId?: string | null;
        source: string;
        status: string;
        canceledAt?: Date | null;
        qty?: number;
    },
) => {
    await db.order.create({
        data: {
            id,
            external_id: id,
            source: opts.source as any,
            status: opts.status as any,
            business_id: BIZ,
            customer_id: opts.customerId,
            campaign_id: opts.campaignId ?? null,
            canceled_at: opts.canceledAt ?? null,
            total_amount: 100,
            items: {
                create: [{
                    id: id + '-item',
                    bundle_id: BUNDLE,
                    quantity: opts.qty ?? 1,
                    variant_size: 'serves_5' as any,
                    item_name: 'Fall Keto',
                    unit_price: 100,
                }],
            },
        },
    });
};

/** Total units getProductionOrders() would hand the KitchenEngine. */
const productionUnits = async () => {
    const rows = await adapter.getProductionOrders();
    return rows.reduce((s: number, r: any) => s + Number(r.quantity || 0), 0);
};

beforeAll(async () => {
    if (!DB_URL) return;
    db = new PrismaClient({ datasourceUrl: DB_URL });
    adapter = new PrismaAdapter(BIZ);

    await db.business.create({ data: { id: BIZ, name: 'OPS3B Tenant', slug: 'ops3b' } });

    // The fundraiser organization, parked at the CRM stage that triggers the
    // bypass branch. This is an ordinary, reachable pipeline stage.
    await db.customer.create({
        data: {
            id: ORG_FUND, business_id: BIZ, name: 'Held Fundraiser Org',
            external_id: ORG_FUND, type: 'fundraiser_org' as any, status: 'PRODUCTION' as any,
        },
    });
    // An ordinary customer, also at PRODUCTION — the compatibility case that
    // must KEEP working.
    await db.customer.create({
        data: {
            id: ORG_CUST, business_id: BIZ, name: 'Ordinary Customer',
            external_id: ORG_CUST, type: 'direct_customer' as any, status: 'PRODUCTION' as any,
        },
    });
    await db.bundle.create({
        data: { id: BUNDLE, business_id: BIZ, name: 'Fall Keto', sku: 'KETO', price: 100 },
    });
    await db.fundraiserCampaign.create({
        data: {
            id: CAMP, name: 'Blocker Campaign', customer_id: ORG_FUND,
            status: 'Active', portal_token: CAMP + '-token',
        },
    });
}, 120_000);

afterAll(async () => {
    if (!DB_URL || !db) return;
    await db.orderItem.deleteMany({ where: { id: { startsWith: 'ops3b-' } } });
    await db.order.deleteMany({ where: { id: { startsWith: 'ops3b-' } } });
    await db.fundraiserCampaign.deleteMany({ where: { id: CAMP } });
    await db.bundle.deleteMany({ where: { id: BUNDLE } });
    await db.customer.deleteMany({ where: { id: { in: [ORG_FUND, ORG_CUST] } } });
    await db.business.deleteMany({ where: { id: BIZ } });
    await db.$disconnect();
}, 120_000);

afterEach(async () => {
    if (!DB_URL || !db) return;
    await db.orderItem.deleteMany({ where: { id: { startsWith: 'ops3b-o-' } } });
    await db.order.deleteMany({ where: { id: { startsWith: 'ops3b-o-' } } });
});

describeIfDb('OPS-3 correction · fundraiser_hold is never production intake', () => {
    it('BLOCKER: a held, unpaid fundraiser order does NOT reach getProductionOrders even when its org is at CRM stage PRODUCTION', async () => {
        await mkOrder('ops3b-o-held', {
            customerId: ORG_FUND, campaignId: CAMP,
            source: 'fundraiser', status: 'fundraiser_hold', qty: 7,
        });
        // Before the correction this returned 7 — the org's PRODUCTION stage
        // matched the OR branch and dragged the held order into the kitchen.
        expect(await productionUnits()).toBe(0);
    });

    it('the same order DOES reach production once the invoice-paid release has promoted it', async () => {
        await mkOrder('ops3b-o-released', {
            customerId: ORG_FUND, campaignId: CAMP,
            source: 'fundraiser', status: 'production_ready', qty: 7,
        });
        expect(await productionUnits()).toBe(7);
    });

    it('a CANCELED order never reaches production, held or released', async () => {
        await mkOrder('ops3b-o-cancelled-held', {
            customerId: ORG_FUND, campaignId: CAMP, source: 'fundraiser',
            status: 'fundraiser_hold', canceledAt: new Date(), qty: 3,
        });
        await mkOrder('ops3b-o-cancelled-ready', {
            customerId: ORG_CUST, source: 'manual',
            status: 'production_ready', canceledAt: new Date(), qty: 5,
        });
        expect(await productionUnits()).toBe(0);
    });
});

describeIfDb('OPS-3 correction · ordinary customer production is preserved', () => {
    it('a production_ready customer order still reaches production', async () => {
        await mkOrder('ops3b-o-ready', { customerId: ORG_CUST, source: 'manual', status: 'production_ready', qty: 4 });
        expect(await productionUnits()).toBe(4);
    });

    it('an in_production customer order still reaches production', async () => {
        await mkOrder('ops3b-o-inprod', { customerId: ORG_CUST, source: 'manual', status: 'in_production', qty: 6 });
        expect(await productionUnits()).toBe(6);
    });

    it('a pending NON-storefront customer order still reaches production', async () => {
        await mkOrder('ops3b-o-pending-manual', { customerId: ORG_CUST, source: 'manual', status: 'pending', qty: 2 });
        expect(await productionUnits()).toBe(2);
    });

    it('a pending STOREFRONT order is still excluded, exactly as before', async () => {
        await mkOrder('ops3b-o-pending-store', { customerId: ORG_CUST, source: 'storefront', status: 'pending', qty: 9 });
        expect(await productionUnits()).toBe(0);
    });

    it('THE COMPATIBILITY CASE: an otherwise-ineligible order of a PRODUCTION-stage customer is still picked up', async () => {
        // `delivered` is not in the eligible status list. Before this pass the
        // customer.status = PRODUCTION branch is what made such a row visible.
        // That behaviour is deliberately PRESERVED for ordinary customers —
        // the correction narrows the branch by ORDER state, not by removing it.
        await mkOrder('ops3b-o-compat', { customerId: ORG_CUST, source: 'manual', status: 'delivered', qty: 8 });
        expect(await productionUnits()).toBe(8);
    });

    it('but that same compatibility branch can no longer drag a HELD fundraiser order in', async () => {
        await mkOrder('ops3b-o-compat-held', {
            customerId: ORG_FUND, campaignId: CAMP,
            source: 'fundraiser', status: 'fundraiser_hold', qty: 8,
        });
        expect(await productionUnits()).toBe(0);
    });

    it('mixed basket: only the eligible units are handed to the kitchen', async () => {
        await mkOrder('ops3b-o-mix-ready', { customerId: ORG_CUST, source: 'manual', status: 'production_ready', qty: 4 });
        await mkOrder('ops3b-o-mix-held', {
            customerId: ORG_FUND, campaignId: CAMP, source: 'fundraiser',
            status: 'fundraiser_hold', qty: 100,
        });
        await mkOrder('ops3b-o-mix-cancel', {
            customerId: ORG_CUST, source: 'manual', status: 'production_ready',
            canceledAt: new Date(), qty: 50,
        });
        expect(await productionUnits()).toBe(4);
    });
});
