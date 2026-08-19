/**
 * FR-FLOW-3 — the first-order / reselection race, proven against a REAL database.
 *
 * WHY THIS ONE IS NOT A MOCK
 * Every other suite here deliberately avoids a database: they assert on the query
 * a handler builds, which is the right tool for scoping and validation bugs. It
 * is the wrong tool for this. The invariant under test is that two concurrent
 * transactions cannot both win, and a recording double has no transactions, no
 * isolation level and no lock manager — it would report success no matter what
 * the code did. So this suite talks to PostgreSQL.
 *
 * HOW TO RUN IT
 *   FR_FLOW3_RACE_DB_URL=postgresql://postgres@127.0.0.1:55438/flow3 npx jest frFlow3Concurrency
 *
 * With that variable unset the suite SKIPS rather than fails, so an ordinary
 * `npx jest` on a machine with no database still passes. It is skipped, never
 * silently green: `describe.skip` reports the count.
 */

import { PrismaClient } from '@prisma/client';
import { campaignSelectionLockKey, CAMPAIGN_SELECTION_LOCK_SQL } from '@/lib/campaignSelectionLock';

const RACE_DB_URL = process.env.FR_FLOW3_RACE_DB_URL;
const describeIfDb = RACE_DB_URL ? describe : describe.skip;

/** One isolated fixture per test, so schedules cannot leak into each other. */
let db: PrismaClient;
let seq = 0;
/** Unique per test-process run, so a re-run never collides with earlier fixture rows. */
const RUN = Math.random().toString(36).slice(2, 8);

interface Fixture {
    campaignId: string;
    bundleA5: string;
    bundleB5: string;
    familyA: string;
    familyB: string;
}

async function makeFixture(): Promise<Fixture> {
    // Unique per test-process run, so re-running never collides with fixture rows
    // an earlier run left behind.
    const n = `${RUN}-${++seq}`;
    const biz = `race-biz-${n}`;
    const org = `race-org-${n}`;
    const campaignId = `race-camp-${n}`;
    const familyA = `race-famA-${n}`;
    const familyB = `race-famB-${n}`;
    const bundleA5 = `race-a5-${n}`;
    const bundleB5 = `race-b5-${n}`;

    await db.business.create({ data: { id: biz, name: `Race ${n}`, slug: `race-${n}` } });
    await db.customer.create({ data: { id: org, business_id: biz, name: `Org ${n}` } });
    await db.fundraiserCampaign.create({
        data: {
            id: campaignId, name: `Race campaign ${n}`, customer_id: org,
            status: 'Active', bundle_selection_status: 'selected', bundle_selection_limit: 1,
        },
    });
    for (const [id, family, tier] of [
        [bundleA5, familyA, 'serves_5'], [`${bundleA5}-s2`, familyA, 'serves_2'],
        [bundleB5, familyB, 'serves_5'], [`${bundleB5}-s2`, familyB, 'serves_2'],
    ] as const) {
        await db.bundle.create({
            data: { id, business_id: biz, name: id, sku: id, serving_tier: tier, family_id: family, is_active: true },
        });
    }
    // Family A is the campaign's current live selection; both families are candidates.
    await db.campaignBundle.createMany({
        data: [
            { campaign_id: campaignId, bundle_id: bundleA5, state: 'candidate', position: 0 },
            { campaign_id: campaignId, bundle_id: bundleB5, state: 'candidate', position: 1 },
            { campaign_id: campaignId, bundle_id: bundleA5, state: 'active', position: 0 },
        ],
    });
    return { campaignId, bundleA5, bundleB5, familyA, familyB };
}

/** Take the SAME advisory lock the two production paths take. */
async function takeLock(tx: any, campaignId: string) {
    await tx.$executeRawUnsafe(CAMPAIGN_SELECTION_LOCK_SQL, campaignSelectionLockKey(campaignId));
}

/**
 * The coordinator's reselection, reduced to its ordering-critical shape:
 * lock, count live orders, refuse if any, otherwise replace the active set.
 */
async function reselect(f: Fixture, opts: { onAfterLock?: () => Promise<void> } = {}) {
    return db.$transaction(async (tx) => {
        await takeLock(tx, f.campaignId);
        if (opts.onAfterLock) await opts.onAfterLock();
        const live = await tx.order.count({ where: { campaign_id: f.campaignId, canceled_at: null } });
        if (live > 0) return { ok: false as const, reason: 'orders_started' };
        await tx.campaignBundle.deleteMany({ where: { campaign_id: f.campaignId, state: 'active' } });
        await tx.campaignBundle.create({
            data: { campaign_id: f.campaignId, bundle_id: f.bundleB5, state: 'active', position: 0 },
        });
        return { ok: true as const };
    }, { isolationLevel: 'ReadCommitted', timeout: 20000 });
}

/**
 * A supporter order, reduced to its ordering-critical shape:
 * lock, re-read the sellable set, refuse if the basket no longer matches, insert.
 */
async function placeOrder(f: Fixture, bundleId: string, opts: { onAfterLock?: () => Promise<void> } = {}) {
    return db.$transaction(async (tx) => {
        await takeLock(tx, f.campaignId);
        if (opts.onAfterLock) await opts.onAfterLock();
        const active = await tx.campaignBundle.findMany({
            where: { campaign_id: f.campaignId, state: 'active' }, select: { bundle_id: true },
        });
        const sellable = new Set(active.map((r) => r.bundle_id));
        if (!sellable.has(bundleId)) return { ok: false as const, reason: 'selection_changed' };
        const order = await tx.order.create({
            data: {
                business_id: (await tx.fundraiserCampaign.findUnique({
                    where: { id: f.campaignId }, select: { customer: { select: { business_id: true } } },
                }))!.customer.business_id!,
                customer_id: (await tx.fundraiserCampaign.findUnique({
                    where: { id: f.campaignId }, select: { customer_id: true },
                }))!.customer_id,
                customer_name: 'Race supporter',
                source: 'fundraiser',
                status: 'fundraiser_hold',
                campaign_id: f.campaignId,
                total_amount: 10,
                external_id: `race_${f.campaignId}_${Math.random().toString(36).slice(2)}`,
                items: { create: [{ bundle_id: bundleId, quantity: 1, item_name: 'x', unit_price: 10 }] },
            } as any,
        });
        return { ok: true as const, orderId: order.id };
    }, { timeout: 20000 });
}

/** Resolve once both sides have settled, whichever order they settle in. */
function deferred() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    return { gate, release };
}

beforeAll(() => {
    db = new PrismaClient({ datasourceUrl: RACE_DB_URL });
});
afterAll(async () => { if (db) await db.$disconnect(); });

describeIfDb('FR-FLOW-3 · first order vs coordinator reselection', () => {
    it('CASE A — reselection wins the lock: it commits, and the order is then refused against the stale basket', async () => {
        const f = await makeFixture();
        const { gate, release } = deferred();

        // The coordinator gets the lock first and holds it while the order starts.
        const reselection = reselect(f, { onAfterLock: async () => { release(); await new Promise((r) => setTimeout(r, 250)); } });
        await gate;
        const order = placeOrder(f, f.bundleA5); // basket built from the OLD selection

        const [rSel, rOrd] = await Promise.all([reselection, order]);

        expect(rSel.ok).toBe(true);
        expect(rOrd.ok).toBe(false);
        expect((rOrd as any).reason).toBe('selection_changed');

        // Exactly one truth survives: family B is live, and no order exists at all.
        const active = await db.campaignBundle.findMany({ where: { campaign_id: f.campaignId, state: 'active' } });
        expect(active.map((a) => a.bundle_id)).toEqual([f.bundleB5]);
        expect(await db.order.count({ where: { campaign_id: f.campaignId } })).toBe(0);
    }, 60000);

    it('CASE B — the order wins the lock: it commits, and the reselection is then refused', async () => {
        const f = await makeFixture();
        const { gate, release } = deferred();

        const order = placeOrder(f, f.bundleA5, { onAfterLock: async () => { release(); await new Promise((r) => setTimeout(r, 250)); } });
        await gate;
        const reselection = reselect(f);

        const [rOrd, rSel] = await Promise.all([order, reselection]);

        expect(rOrd.ok).toBe(true);
        expect(rSel.ok).toBe(false);
        expect((rSel as any).reason).toBe('orders_started');

        // The order stands, and the selection it was placed against is untouched.
        const active = await db.campaignBundle.findMany({ where: { campaign_id: f.campaignId, state: 'active' } });
        expect(active.map((a) => a.bundle_id)).toEqual([f.bundleA5]);
        expect(await db.order.count({ where: { campaign_id: f.campaignId, canceled_at: null } })).toBe(1);
    }, 60000);

    it('THE FORBIDDEN OUTCOME never occurs: an order accepted on the old selection AND a new selection committed', async () => {
        // Run the schedule repeatedly with no artificial delay, so the interleaving
        // is genuinely up to PostgreSQL rather than to a timer.
        for (let i = 0; i < 6; i++) {
            const f = await makeFixture();
            const [rSel, rOrd] = await Promise.all([reselect(f), placeOrder(f, f.bundleA5)]);

            const orderCommitted = rOrd.ok === true;
            const reselectionCommitted = rSel.ok === true;
            // At most one may win. Both winning is precisely the inconsistency.
            expect(orderCommitted && reselectionCommitted).toBe(false);

            const active = await db.campaignBundle.findMany({
                where: { campaign_id: f.campaignId, state: 'active' }, select: { bundle_id: true },
            });
            const orders = await db.order.findMany({
                where: { campaign_id: f.campaignId, canceled_at: null },
                select: { items: { select: { bundle_id: true } } },
            });
            // Every accepted order names a bundle the campaign still sells.
            const sellable = new Set(active.map((a) => a.bundle_id));
            for (const o of orders) {
                for (const item of o.items) {
                    expect(sellable.has(item.bundle_id!)).toBe(true);
                }
            }
        }
    }, 120000);

    it('MUTATION — without the shared lock the forbidden outcome DOES occur', async () => {
        // Same two operations with the lock removed from both sides. If this ever
        // stops reproducing, the test above has stopped proving anything and this
        // one says so loudly.
        const raceWithoutLock = async (f: Fixture) => {
            const unlockedReselect = db.$transaction(async (tx) => {
                const live = await tx.order.count({ where: { campaign_id: f.campaignId, canceled_at: null } });
                await new Promise((r) => setTimeout(r, 150)); // the TOCTOU window
                if (live > 0) return { ok: false as const };
                await tx.campaignBundle.deleteMany({ where: { campaign_id: f.campaignId, state: 'active' } });
                await tx.campaignBundle.create({
                    data: { campaign_id: f.campaignId, bundle_id: f.bundleB5, state: 'active', position: 0 },
                });
                return { ok: true as const };
            }, { timeout: 20000 });

            const unlockedOrder = (async () => {
                await new Promise((r) => setTimeout(r, 40));
                return db.$transaction(async (tx) => {
                    const biz = (await tx.fundraiserCampaign.findUnique({
                        where: { id: f.campaignId }, select: { customer_id: true, customer: { select: { business_id: true } } },
                    }))!;
                    await tx.order.create({
                        data: {
                            business_id: biz.customer.business_id!, customer_id: biz.customer_id,
                            customer_name: 'Unlocked supporter', source: 'fundraiser', status: 'fundraiser_hold',
                            campaign_id: f.campaignId, total_amount: 10,
                            external_id: `nolock_${f.campaignId}_${Math.random().toString(36).slice(2)}`,
                            items: { create: [{ bundle_id: f.bundleA5, quantity: 1, item_name: 'x', unit_price: 10 }] },
                        } as any,
                    });
                    return { ok: true as const };
                }, { timeout: 20000 });
            })();

            return Promise.all([unlockedReselect, unlockedOrder]);
        };

        let sawForbidden = false;
        for (let i = 0; i < 4 && !sawForbidden; i++) {
            const f = await makeFixture();
            const [rSel, rOrd] = await raceWithoutLock(f);
            if (rSel.ok && rOrd.ok) {
                const active = await db.campaignBundle.findMany({
                    where: { campaign_id: f.campaignId, state: 'active' }, select: { bundle_id: true },
                });
                const sellable = new Set(active.map((a) => a.bundle_id));
                // An accepted order naming a bundle the campaign no longer sells.
                if (!sellable.has(f.bundleA5)) sawForbidden = true;
            }
        }
        expect(sawForbidden).toBe(true);
    }, 120000);
});
