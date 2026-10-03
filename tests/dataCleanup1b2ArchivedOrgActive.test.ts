/**
 * DATA-CLEANUP-1B.2 — an ARCHIVED organization never counts as an active operational one.
 *
 * WHAT WAS SUSPECTED, AND WHAT THE CODE ACTUALLY DID
 * The owner rule: archived organizations must not count as active operational organizations. The
 * suspect was the home dashboard's "Active Orders" metric. Audited, that metric (metrics.activeOrders,
 * shown as "Weekly In Progress" on both "/" and "/dashboard") counts ORDERS — the in-progress,
 * non-fundraiser orders created in the last 7 days — and never read an organization. The dashboard
 * route DID compute a count of organizations at CRM stage PRODUCTION, archived ones included, and
 * then discarded it. That dead count is removed; the metric's own meaning is unchanged, and asserted.
 *
 * The one LIVE place an organization's PRODUCTION stage still decides something is the kitchen
 * intake: PrismaAdapter.getProductionOrders() takes every eligible order of a customer parked at
 * PRODUCTION. That branch now also requires the customer to be unarchived.
 *
 * Nothing here writes data, and no persisted status is rewritten to make a number come out right.
 */
import fs from 'fs';
import path from 'path';
import { createPrismaMock, readJson } from './helpers/routeHarness';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__dc1b2Prisma; },
}));
const authMock = jest.fn(async () => null as any);
jest.mock('@/auth', () => ({ auth: (...a: any[]) => authMock(...(a as [])) }));
// The dashboard builds a KitchenEngine for food cost; these fixtures carry no bundle lines, so it is
// never asked anything — stubbed only so the real planner is not dragged into a metrics test.
jest.mock('@/lib/kitchen_engine', () => ({ KitchenEngine: class { async calculateBundleCost() { return 0; } } }));

const TENANT = 'biz-dc1b2-0001';
const session = { user: { businessId: TENANT, email: 'owner@tenant.invalid', plan: 'ENTERPRISE' } };

const order = (id: string, status: string) => ({
    id, external_id: id, status, total_amount: 60, created_at: new Date(), items: [],
});

/** The dashboard over one week of orders, with an organization count that must never be asked for. */
async function dashboard() {
    const mock = createPrismaMock({
        results: {
            'business.findUnique': { plan: 'ULTIMATE', google_calendar_url: null },
            // Were the old organization count still here it would see 7 — none of which are orders.
            'customer.count': 7,
            'order.findMany': (args: any) => {
                const created = args?.where?.created_at;
                // This week's orders: one per status, so the tile's status rule is what is measured.
                if (created?.gte && !created?.lt && !created?.lte && args?.where?.status?.not === 'fundraiser_hold') {
                    return ['pending', 'production_ready', 'delivered', 'in_production', 'completed']
                        .map((s, i) => order(`this-week-${i}`, s));
                }
                // Last week: a single in-progress order, for the growth figure.
                if (created?.lt) return [order('last-week-0', 'production_ready')];
                return [];
            },
        },
    });
    (global as any).__dc1b2Prisma = mock.client;
    authMock.mockResolvedValue(session as any);
    const { GET } = await import('@/app/api/dashboard/route');
    const { status, body } = await readJson(await GET());
    return { mock, status, body };
}

describe('the "Weekly In Progress" tile (metrics.activeOrders) counts orders, never organizations', () => {
    it('counts this week\'s in-progress orders exactly as before (pending, production_ready, delivered)', async () => {
        const { status, body } = await dashboard();
        expect(status).toBe(200);
        expect(body.metrics.activeOrders).toBe(3);
        expect(body.metrics.activeOrdersGrowth).toBe(200); // 3 this week against 1 last week
    });

    it('asks for no organization count at all — so an archived organization cannot reach it', async () => {
        const { mock } = await dashboard();
        expect(mock.callsTo('customer.count')).toHaveLength(0);
        const byStage = mock.calls.filter((c) => c.model === 'customer' && c.args?.where?.status === 'PRODUCTION');
        expect(byStage).toHaveLength(0);
    });

    it('both dashboard pages still render the metric under the same title', () => {
        for (const page of ['app/page.tsx', 'app/DashboardClient.tsx']) {
            const src = R(page);
            expect(src).toMatch(/title="Weekly In Progress"\s+value=\{data\?\.metrics\?\.activeOrders/);
        }
    });

    it('the route no longer computes a PRODUCTION-stage organization count, and never writes a status', () => {
        const src = R('app/api/dashboard/route.ts');
        expect(src).not.toMatch(/activeOrdersCount/);
        expect(src).not.toMatch(/customer\.count\(/);
        expect(src).toMatch(/activeOrders:\s*inProgressThisWeek/);
        expect(src).not.toMatch(/customer\.(update|updateMany)\(/);
    });
});

describe('kitchen intake: a customer parked at PRODUCTION counts only while it is not archived', () => {
    async function intakeWhere() {
        const mock = createPrismaMock();
        (global as any).__dc1b2Prisma = mock.client;
        const { PrismaAdapter } = await import('@/lib/prisma_adapter');
        await new PrismaAdapter(TENANT).getProductionOrders();
        const call = mock.firstCall('order.findMany');
        expect(call).toBeDefined();
        return call!.args.where;
    }

    it('the stage branch requires an unarchived customer', async () => {
        const where = await intakeWhere();
        const stageBranch = where.OR.find((b: any) => b.customer);
        expect(stageBranch).toEqual({ customer: { status: 'PRODUCTION', archived: false } });
    });

    it('everything else about the intake is unchanged: tenant, canceled, status allowlist, exclusions', async () => {
        const where = await intakeWhere();
        const { PRODUCTION_INTAKE_STATUSES, PRODUCTION_ORDER_EXCLUSIONS } = await import('@/lib/productionIntake');
        expect(where.business_id).toBe(TENANT);
        expect(where.canceled_at).toBeNull();
        expect(where.OR).toHaveLength(2);
        expect(where.OR).toContainEqual({ status: { in: [...PRODUCTION_INTAKE_STATUSES] } });
        expect(where.AND).toEqual([...PRODUCTION_ORDER_EXCLUSIONS]);
    });

    it('decides on the organization\'s archive flag only — its persisted status is read, never rewritten', () => {
        const src = R('lib/prisma_adapter.ts');
        const fn = src.slice(src.indexOf('async getProductionOrders()'));
        expect(fn).toMatch(/customer:\s*\{\s*status:\s*'PRODUCTION',\s*archived:\s*false\s*\}/);
        expect(fn).not.toMatch(/customer\.(update|updateMany)\(/);
    });
});
