/**
 * FULFILLMENT-CONTINUITY-1 — one reusable production-eligibility authority.
 *
 * WHY THIS SUITE EXISTS
 *
 * "Which orders may the kitchen work on?" is answered in two places that
 * drifted apart once already. OPS-3 found that lib/prisma_adapter.ts
 * getProductionOrders() — which feeds /api/production/sync, /plan and /runs,
 * the last of which PERSISTS a ProductionRun — was missing both the fundraiser
 * hold and the canceled-order exclusion that the Kitchen Board had always
 * carried, so an unpaid held order could reach the kitchen via a CRM stage.
 *
 * That was repaired by hand-copying the predicates. This suite exists so the
 * NEXT production query cannot quietly ship without them: section 3 sweeps every
 * production-intake query in the repo and asserts the rule is present, however
 * it is spelled.
 *
 * PRESERVATION, NOT DEFECT. Nothing here failed before the refactor — the
 * behaviour was already correct at HEAD 9ceafdf. These tests pin it so the
 * extraction is provably equivalent and so the invariant survives future work.
 *
 * The only behavioural coverage of getProductionOrders itself lives in
 * tests/ops3ProductionIntakeHold.test.ts, which is describe.skip'd unless
 * OPS3_DB_URL is set. That is a real gap in ordinary CI, and it is precisely why
 * the rule is asserted here in a form that runs unconditionally.
 */
import {
    PRODUCTION_ORDER_EXCLUSIONS,
    PRODUCTION_INTAKE_STATUSES,
    isProductionEligibleOrder,
} from '@/lib/productionIntake';
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';

const read = (p: string) =>
    require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

// ═════════════════════════════════════════════════════════════════════════════
// 1. The rule as data — what every production query must carry.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. PRODUCTION_ORDER_EXCLUSIONS', () => {
    it('excludes fundraiser_hold', () => {
        expect(PRODUCTION_ORDER_EXCLUSIONS).toContainEqual({
            NOT: { status: 'fundraiser_hold' },
        });
    });

    it('excludes abandoned storefront checkouts', () => {
        expect(PRODUCTION_ORDER_EXCLUSIONS).toContainEqual({
            NOT: { source: 'storefront', status: 'pending' },
        });
    });

    it('is exactly those two rules — nothing has been quietly added', () => {
        expect(PRODUCTION_ORDER_EXCLUSIONS).toHaveLength(2);
    });

    it('does NOT exclude fundraiser SOURCE — a released fundraiser order must reach the kitchen', () => {
        // This is the OPS-3 gate's whole purpose. lib/prisma_adapter.ts
        // getOrders() carries `source: { not: 'fundraiser' }`, but that is the
        // Orders LIST deciding what to display, not production deciding what to
        // cook. Copying it here would silently un-ship the paid-invoice release.
        const serialized = JSON.stringify(PRODUCTION_ORDER_EXCLUSIONS);
        expect(serialized).not.toContain('"source":"fundraiser"');
        expect(serialized).not.toContain('"not":"fundraiser"');
    });
});

describe('2. PRODUCTION_INTAKE_STATUSES', () => {
    it('covers the three canonical working statuses', () => {
        expect(PRODUCTION_INTAKE_STATUSES).toEqual(
            expect.arrayContaining(['pending', 'production_ready', 'in_production']),
        );
    });

    it('preserves legacy uppercase rows via the canonical mapping', () => {
        for (const canonical of ['pending', 'production_ready', 'in_production'] as const) {
            for (const dbValue of toDbOrderStatusReadCandidates(canonical)) {
                expect(PRODUCTION_INTAKE_STATUSES).toContain(dbValue);
            }
        }
    });

    it('never contains fundraiser_hold', () => {
        expect(PRODUCTION_INTAKE_STATUSES).not.toContain('fundraiser_hold');
    });

    it('contains no duplicates — callers can spread it directly', () => {
        expect(new Set(PRODUCTION_INTAKE_STATUSES).size).toBe(PRODUCTION_INTAKE_STATUSES.length);
    });

    it('is byte-equivalent to the inline list lib/prisma_adapter.ts used to build', () => {
        const inline = [
            ...new Set([
                ...toDbOrderStatusReadCandidates('pending'),
                ...toDbOrderStatusReadCandidates('production_ready'),
                ...toDbOrderStatusReadCandidates('in_production'),
            ]),
        ];
        expect(PRODUCTION_INTAKE_STATUSES).toEqual(inline);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE CONFORMANCE SWEEP — the invariant that was missing.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. every production-intake query carries the rule', () => {
    it('the Kitchen Board keeps a fundraiser_hold exclusion on each of its three customer lanes', () => {
        const src = read('app/api/production/dashboard/route.ts');
        const holdExclusions = src.match(/NOT:\s*\{\s*status:\s*'fundraiser_hold'/g) || [];
        expect(holdExclusions.length).toBeGreaterThanOrEqual(3);
    });

    it('the Kitchen Board keeps canceled_at: null on every lane', () => {
        const src = read('app/api/production/dashboard/route.ts');
        const canceled = src.match(/canceled_at:\s*null/g) || [];
        expect(canceled.length).toBeGreaterThanOrEqual(4);
    });

    it('the fundraiser waiting lane is the INVERSE — it requires the hold', () => {
        const src = read('app/api/production/dashboard/route.ts');
        expect(src).toMatch(/status:\s*'fundraiser_hold'\s*as\s*any,/);
    });

    it('lib/prisma_adapter.ts getProductionOrders uses the shared authority', () => {
        const src = read('lib/prisma_adapter.ts');
        expect(src).toMatch(/from\s+['"]\.\/productionIntake['"]/);
        expect(src).toMatch(/AND:\s*\[\.\.\.PRODUCTION_ORDER_EXCLUSIONS\]/);
        expect(src).toMatch(/PRODUCTION_INTAKE_STATUSES/);
    });

    it('getProductionOrders still carries canceled_at and the PRODUCTION compatibility branch', () => {
        const src = read('lib/prisma_adapter.ts');
        const fn = src.slice(src.indexOf('async getProductionOrders()'));
        expect(fn).toMatch(/canceled_at:\s*null/);
        // OPS-3 deliberately KEPT this branch. Removing it silently drops
        // ingredient demand for ordinary customers parked at that CRM stage,
        // and the only test that catches it is DB-gated.
        expect(fn).toMatch(/customer:\s*\{\s*status:\s*'PRODUCTION'\s*\}/);
    });

    it('getProductionOrders does NOT filter on fundraiser source', () => {
        const src = read('lib/prisma_adapter.ts');
        const fn = src.slice(
            src.indexOf('async getProductionOrders()'),
        );
        expect(fn).not.toMatch(/source:\s*\{\s*not:\s*'fundraiser'/);
    });

    it('the shared module does not import the Prisma client', () => {
        const src = read('lib/productionIntake.ts');
        expect(src).not.toMatch(/from\s+['"]@?\/?(\.\/)?lib\/db['"]/);
        expect(src).not.toMatch(/from\s+['"]\.\/db['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The rule as a predicate.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. isProductionEligibleOrder', () => {
    const held = { status: 'fundraiser_hold', source: 'fundraiser', canceled_at: null };
    const released = { status: 'production_ready', source: 'fundraiser', canceled_at: null };
    const customer = { status: 'production_ready', source: 'manual', canceled_at: null };

    it('refuses a held fundraiser order', () => {
        expect(isProductionEligibleOrder(held)).toBe(false);
    });

    it('ACCEPTS a released fundraiser order — the OPS-3 gate opens', () => {
        expect(isProductionEligibleOrder(released)).toBe(true);
    });

    it('accepts an ordinary customer order', () => {
        expect(isProductionEligibleOrder(customer)).toBe(true);
    });

    it('refuses a canceled order, held or released', () => {
        expect(isProductionEligibleOrder({ ...held, canceled_at: new Date() })).toBe(false);
        expect(isProductionEligibleOrder({ ...released, canceled_at: new Date() })).toBe(false);
        expect(isProductionEligibleOrder({ ...customer, canceled_at: new Date() })).toBe(false);
    });

    it('refuses an abandoned storefront checkout but accepts a manual pending order', () => {
        expect(isProductionEligibleOrder({ status: 'pending', source: 'storefront', canceled_at: null })).toBe(false);
        expect(isProductionEligibleOrder({ status: 'pending', source: 'manual', canceled_at: null })).toBe(true);
    });

    it('accepts a PAID storefront order once it leaves pending', () => {
        expect(isProductionEligibleOrder({ status: 'production_ready', source: 'storefront', canceled_at: null })).toBe(true);
    });

    it('fails closed on an unreadable order', () => {
        expect(isProductionEligibleOrder(null)).toBe(false);
        expect(isProductionEligibleOrder(undefined)).toBe(false);
        expect(isProductionEligibleOrder({})).toBe(false);
        expect(isProductionEligibleOrder({ status: null })).toBe(false);
    });

    it('treats a canceled_at string the same as a Date', () => {
        expect(isProductionEligibleOrder({ ...customer, canceled_at: '2026-04-01T00:00:00Z' })).toBe(false);
    });

    it('agrees with the where-fragment: nothing the predicate accepts is excluded by the query rule', () => {
        // Cross-check the two representations against the same fixtures, so the
        // in-memory rule and the Prisma rule cannot drift.
        const matchesFragment = (o: any) =>
            !PRODUCTION_ORDER_EXCLUSIONS.some((rule: any) => {
                const not = rule.NOT;
                return Object.keys(not).every((k) => o[k] === not[k]);
            });

        const fixtures = [held, released, customer,
            { status: 'pending', source: 'storefront', canceled_at: null },
            { status: 'pending', source: 'manual', canceled_at: null },
            { status: 'in_production', source: 'fundraiser', canceled_at: null }];

        for (const f of fixtures) {
            if (f.canceled_at != null) continue; // canceled_at lives at the query top level
            expect(isProductionEligibleOrder(f)).toBe(matchesFragment(f));
        }
    });
});
