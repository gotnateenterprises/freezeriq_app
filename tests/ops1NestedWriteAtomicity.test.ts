/**
 * OPS-1 PART G — atomicity of Order + OrderItem creation, proven against a
 * REAL database, not the recording double.
 *
 * WHY THIS ONE IS NOT A MOCK
 * The invariant under test is a database-engine guarantee: that a Prisma
 * nested write (`order.create` with a nested `items: { create: [...] }`) either
 * commits every row or none of them. A recording double has no transaction, no
 * constraint enforcement and no rollback — it would report success no matter
 * what the code did. tests/frFlow3Concurrency.test.ts established the same
 * principle for the campaign-selection race; this applies it to OPS-1's
 * narrower question.
 *
 * WHY THIS TARGETS THE MAIN LOCAL DEV DB, NOT A SEPARATE RACE DB
 * FR-FLOW-3's suite points at its own throwaway Postgres via
 * FR_FLOW3_RACE_DB_URL because it runs a real concurrent schedule many times.
 * This suite runs a single transaction attempt per test and cleans up exactly
 * what it creates, so it reuses the SAME local dev database OPS-0 already
 * reconciled and safety-gated — one fewer undocumented DB target, not a
 * second one.
 *
 * SAFETY GATE (OPS-0 / Part B of this phase): classifyDbWriteTarget runs
 * BEFORE any PrismaClient is constructed. If DATABASE_URL is unset, malformed,
 * or resolves to anything other than localhost/127.0.0.1, the whole suite
 * SKIPS — never runs, never connects, never bypasses the gate. This mirrors
 * lib/dbSafetyCli.ts's own refusal, just as a Jest guard instead of a CLI exit.
 */
import { classifyDbWriteTarget } from '@/lib/dbSafety';

const TARGET = classifyDbWriteTarget(process.env.DATABASE_URL);

// Part B: redacted target print, before any write-capable code path runs.
// eslint-disable-next-line no-console
console.log(
    'DATABASE HOST:', TARGET.host ?? '(unresolved)', '\n' +
    'PORT:', TARGET.port ?? '(default)', '\n' +
    'DATABASE NAME:', TARGET.database ?? '(unresolved)', '\n' +
    'SOURCE ENV VARIABLE: DATABASE_URL\n' +
    'SOURCE ENV FILE/MECHANISM: whatever the Jest process inherited\n' +
    'LOCAL/REMOTE CLASSIFICATION:', TARGET.ok ? 'LOCAL — allowed' : `REFUSED — ${TARGET.reason}`,
);

const describeIfLocalDb = TARGET.ok ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;

describeIfLocalDb('OPS-1 Part G · Order + OrderItem nested-write atomicity (real Postgres)', () => {
    // Imported inside the guarded block so an ungated/misconfigured environment
    // never even loads the Prisma client for a write-capable connection.
    const { PrismaClient } = require('@prisma/client');
    let db: InstanceType<typeof PrismaClient>;

    beforeAll(() => {
        db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    });
    afterAll(async () => { if (db) await db.$disconnect(); });

    async function makeFixture() {
        const n = `${RUN}-${++seq}`;
        const bizId = `ops1-atom-biz-${n}`;
        const custId = `ops1-atom-org-${n}`;
        const realBundleId = `ops1-atom-bundle-${n}`;

        await db.business.create({ data: { id: bizId, name: `OPS1 Atomicity ${n}`, slug: `ops1-atom-${n}` } });
        await db.customer.create({ data: { id: custId, business_id: bizId, name: `Org ${n}` } });
        await db.bundle.create({
            data: { id: realBundleId, business_id: bizId, name: `Bundle ${n}`, sku: `ops1-atom-sku-${n}`, price: 10 },
        });

        return { bizId, custId, realBundleId };
    }

    async function cleanupFixture(f: { bizId: string; custId: string; realBundleId: string }) {
        // Deliberately unconditional deletes, not "only if the test failed":
        // proves the fixture rows themselves (created OUTSIDE the attempt under
        // test) are exactly what's left behind, regardless of which branch ran.
        await db.order.deleteMany({ where: { business_id: f.bizId } });
        await db.bundle.deleteMany({ where: { id: f.realBundleId } });
        await db.customer.deleteMany({ where: { id: f.custId } });
        await db.business.deleteMany({ where: { id: f.bizId } });
    }

    it('a nested create with one valid item and one FK-violating item persists NEITHER the Order nor either OrderItem', async () => {
        const f = await makeFixture();
        const externalId = `ops1-atom-order-${RUN}-${seq}`;

        try {
            let threw = false;
            try {
                await db.order.create({
                    data: {
                        external_id: externalId,
                        source: 'fundraiser',
                        status: 'fundraiser_hold',
                        total_amount: 10,
                        business_id: f.bizId,
                        customer_id: f.custId,
                        items: {
                            create: [
                                // Valid on its own — if the write were NOT atomic,
                                // this row could survive the second item's failure.
                                { bundle_id: f.realBundleId, quantity: 1, item_name: 'valid item', unit_price: 10 },
                                // References a bundle_id that does not exist:
                                // violates the OrderItem.bundle_id -> Bundle.id
                                // foreign key at the database level.
                                { bundle_id: `${f.realBundleId}-does-not-exist`, quantity: 1, item_name: 'fk violation', unit_price: 10 },
                            ],
                        },
                    } as any,
                });
            } catch {
                threw = true;
            }

            // The write engine must have refused the FK violation.
            expect(threw).toBe(true);

            // THE PROOF: no Order row exists at all — not even the one carrying
            // the item that was individually valid. Nested-create either commits
            // every row or none of them.
            const survivingOrders = await db.order.findMany({ where: { external_id: externalId } });
            expect(survivingOrders).toHaveLength(0);

            // And no OrderItem naming the VALID bundle was left orphaned either —
            // the first item's insert did not "partially succeed" ahead of the
            // second item's failure.
            const orphanedItems = await db.orderItem.findMany({ where: { bundle_id: f.realBundleId } });
            expect(orphanedItems).toHaveLength(0);
        } finally {
            await cleanupFixture(f);
        }
    }, 30000);

    it('a nested create with two valid items persists the Order and BOTH items together', async () => {
        const f = await makeFixture();
        const externalId = `ops1-atom-ok-${RUN}-${seq}-2`;

        try {
            const order = await db.order.create({
                data: {
                    external_id: externalId,
                    source: 'fundraiser',
                    status: 'fundraiser_hold',
                    total_amount: 20,
                    business_id: f.bizId,
                    customer_id: f.custId,
                    items: {
                        create: [
                            { bundle_id: f.realBundleId, quantity: 1, item_name: 'item A', unit_price: 10 },
                            { bundle_id: f.realBundleId, quantity: 1, item_name: 'item B', unit_price: 10 },
                        ],
                    },
                } as any,
                include: { items: true },
            });

            expect(order.items).toHaveLength(2);
            const persisted = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
            expect(persisted?.items).toHaveLength(2);
        } finally {
            await db.order.deleteMany({ where: { external_id: externalId } });
            await cleanupFixture(f);
        }
    }, 30000);
});
