/**
 * Calculation Engine — Snapshot Tests
 *
 * PURPOSE:
 *   Lock known-good production outputs so ANY change to totals,
 *   multipliers, aggregation, or debug trace triggers a test failure.
 *
 * CALCULATION CONSTITUTION COMPLIANCE:
 *   LAW 1 — Recipe ingredients are single source of truth
 *   LAW 2 — Multiplier chain: Ingredient Qty × Yield × Bundle Qty × Serving × Order Qty
 *   LAW 3 — No early rounding (full precision in snapshots)
 *   LAW 5 — Reconciliation checks verified
 *   LAW 7 — Debug trace captured in snapshot
 *   LAW 8 — Invalid inputs must throw
 *
 * SNAPSHOT UPDATE POLICY:
 *   Snapshots must ONLY be updated when:
 *   1. An intentional, reviewed change was made to the calculation engine
 *   2. The update was approved by a senior engineer
 *   3. Run: npx jest --updateSnapshot
 *   4. Review the diff in version control BEFORE committing
 *
 *   NEVER blindly update snapshots to make tests pass.
 *
 * @module production_run.snapshot.test
 */

import { KitchenEngine } from '../../../lib/kitchen_engine';
import {
    createMockDBAdapter,
    BUNDLE_SIMPLE,
    BUNDLE_COMBO,
    BUNDLE_FULL,
    BUNDLE_DOUBLE_CHICKEN,
} from '../fixtures/mock_data';

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Creates a fresh KitchenEngine with mock data for each test.
 * Each test gets a clean cache to ensure isolation.
 */
function createEngine(): KitchenEngine {
    return new KitchenEngine(createMockDBAdapter());
}

/**
 * Normalizes result for deterministic snapshot comparison.
 * - Sorts rawIngredients by key (ID)
 * - Sorts prepTasks by key (name)
 * - Sorts assemblyTasks by key (name + variant)
 * - Sorts usedIn arrays
 * - Sorts debug.trace by bundle_id + recipe_id
 */
function normalizeResult(result: any): any {
    const normalized: any = {};

    // Sort rawIngredients by key
    if (result.rawIngredients) {
        const sortedRaw: any = {};
        for (const key of Object.keys(result.rawIngredients).sort()) {
            const ing = { ...result.rawIngredients[key] };
            // Sort usedIn array for determinism
            if (Array.isArray(ing.usedIn)) {
                ing.usedIn = [...ing.usedIn].sort();
            }
            sortedRaw[key] = ing;
        }
        normalized.rawIngredients = sortedRaw;
    }

    // Sort prepTasks by key
    if (result.prepTasks) {
        const sortedPrep: any = {};
        for (const key of Object.keys(result.prepTasks).sort()) {
            sortedPrep[key] = result.prepTasks[key];
        }
        normalized.prepTasks = sortedPrep;
    }

    // Sort assemblyTasks by key
    if (result.assemblyTasks) {
        const sortedAssembly: any = {};
        for (const key of Object.keys(result.assemblyTasks).sort()) {
            sortedAssembly[key] = result.assemblyTasks[key];
        }
        normalized.assemblyTasks = sortedAssembly;
    }

    // Sort debug trace
    if (result.debug) {
        normalized.debug = {
            ...result.debug,
            trace: result.debug.trace
                ? [...result.debug.trace].sort((a: any, b: any) =>
                    `${a.bundle_id}:${a.recipe_id}`.localeCompare(`${b.bundle_id}:${b.recipe_id}`)
                )
                : [],
            bundle_contributions: result.debug.bundle_contributions
                ? [...result.debug.bundle_contributions].sort((a: any, b: any) =>
                    a.bundle_id.localeCompare(b.bundle_id)
                )
                : [],
        };
    }

    return normalized;
}

// ═══════════════════════════════════════════════════════════
// SNAPSHOT TESTS
// ═══════════════════════════════════════════════════════════

describe('KitchenEngine.generateProductionRun — Snapshot Tests', () => {

    // ─── SCENARIO 1: Single Bundle, Family Size ───────────────────────

    test('Scenario 1: Single bundle × 1, serves_5 (family baseline)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_5' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 2: Single Bundle, Couple Size ──────────────────────

    test('Scenario 2: Single bundle × 1, serves_2 (half scaling)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_2' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 3: Single Bundle, High Volume ─────────────────────

    test('Scenario 3: Single bundle × 25 (high volume)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 25, variant_size: 'serves_5' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 4: Multi-Bundle, Mixed Sizes ──────────────────────

    test('Scenario 4: Multi-bundle mixed sizes (family + couple)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [
                { bundle_id: BUNDLE_COMBO, quantity: 5, variant_size: 'serves_5' },
                { bundle_id: BUNDLE_SIMPLE, quantity: 3, variant_size: 'serves_2' },
            ],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 5: Full Bundle (3 recipes) ────────────────────────

    test('Scenario 5: Full bundle × 10 (all 3 recipes)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_FULL, quantity: 10, variant_size: 'serves_5' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 6: Double-Portion Bundle Content Qty ──────────────

    test('Scenario 6: Double-portion bundle (bundleContent.qty = 2)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_DOUBLE_CHICKEN, quantity: 5, variant_size: 'serves_5' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 7: Start Fresh (Identity Multiplier) ──────────────

    test('Scenario 7: Start fresh variant (1.0 identity multiplier)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'start_fresh' }],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });

    // ─── SCENARIO 8: Mixed Everything ───────────────────────────────

    test('Scenario 8: Realistic production day (3 bundles, mixed sizes/quantities)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [
                { bundle_id: BUNDLE_FULL, quantity: 8, variant_size: 'serves_5' },
                { bundle_id: BUNDLE_COMBO, quantity: 4, variant_size: 'serves_2' },
                { bundle_id: BUNDLE_SIMPLE, quantity: 12, variant_size: 'serves_5' },
            ],
            { debug: true }
        );
        expect(normalizeResult(result)).toMatchSnapshot();
    });
});

// ═══════════════════════════════════════════════════════════
// EDGE CASE TESTS (deterministic — not snapshot, but value-exact)
// ═══════════════════════════════════════════════════════════

describe('KitchenEngine.generateProductionRun — Edge Cases', () => {

    test('Empty orders array returns empty result', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun([], { debug: true });
        expect(Object.keys(result.rawIngredients)).toHaveLength(0);
        expect(Object.keys(result.prepTasks)).toHaveLength(0);
        expect(Object.keys(result.assemblyTasks)).toHaveLength(0);
        expect(result.debug.reconciliation.orders_received).toBe(0);
    });

    test('Zero quantity order produces no ingredients', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 0, variant_size: 'serves_5' }],
            { debug: true }
        );
        // Quantity 0 should produce 0 ingredient quantities
        for (const ing of Object.values(result.rawIngredients) as any[]) {
            expect(ing.qty).toBe(0);
        }
    });

    test('Unknown serving size throws per LAW 8', async () => {
        const engine = createEngine();
        await expect(
            engine.generateProductionRun(
                [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_10' as any }]
            )
        ).rejects.toThrow('[CALCULATION INTEGRITY]');
    });

    test('Unknown bundle ID produces empty result (no crash)', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: 'bundle-nonexistent', quantity: 5, variant_size: 'serves_5' }],
            { debug: true }
        );
        expect(Object.keys(result.rawIngredients)).toHaveLength(0);
    });

    test('Null/undefined variant_size defaults to serves_5', async () => {
        const engine = createEngine();
        const resultExplicit = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_5' }],
            { debug: true }
        );
        const resultDefault = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1 }],
            { debug: true }
        );
        // Should produce identical ingredient quantities
        for (const key of Object.keys(resultExplicit.rawIngredients)) {
            expect((resultDefault.rawIngredients as any)[key]?.qty)
                .toBe((resultExplicit.rawIngredients as any)[key]?.qty);
        }
    });
});

// ═══════════════════════════════════════════════════════════
// MULTIPLIER CHAIN VERIFICATION (exact value checks)
// ═══════════════════════════════════════════════════════════

describe('KitchenEngine — Multiplier Chain Verification (LAW 2)', () => {

    test('serves_2 produces exactly 0.5× the qty of serves_5', async () => {
        const engine = createEngine();
        const family = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_5' }]
        );
        const couple = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_2' }]
        );

        for (const key of Object.keys(family.rawIngredients)) {
            const familyQty = (family.rawIngredients as any)[key]?.qty || 0;
            const coupleQty = (couple.rawIngredients as any)[key]?.qty || 0;
            expect(coupleQty).toBeCloseTo(familyQty * 0.5, 10);
        }
    });

    test('Quantity 10 produces exactly 10× the qty of quantity 1', async () => {
        const engine = createEngine();
        const single = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 1, variant_size: 'serves_5' }]
        );
        const ten = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 10, variant_size: 'serves_5' }]
        );

        for (const key of Object.keys(single.rawIngredients)) {
            const singleQty = (single.rawIngredients as any)[key]?.qty || 0;
            const tenQty = (ten.rawIngredients as any)[key]?.qty || 0;
            expect(tenQty).toBeCloseTo(singleQty * 10, 10);
        }
    });

    test('Debug trace records correct final_multiplier', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [{ bundle_id: BUNDLE_SIMPLE, quantity: 7, variant_size: 'serves_2' }],
            { debug: true }
        );

        // Expected: order_qty(7) × bundle_content_qty(1) × serving_multiplier(0.5) = 3.5
        for (const t of result.debug.trace) {
            expect(t.serving_multiplier).toBe(0.5);
            expect(t.final_multiplier).toBe(7 * 1 * 0.5);
        }
    });

    test('Reconciliation reports correct counts', async () => {
        const engine = createEngine();
        const result = await engine.generateProductionRun(
            [
                { bundle_id: BUNDLE_COMBO, quantity: 3, variant_size: 'serves_5' },
                { bundle_id: BUNDLE_SIMPLE, quantity: 2, variant_size: 'serves_2' },
            ],
            { debug: true }
        );

        expect(result.debug.reconciliation.orders_received).toBe(2);
        expect(result.debug.reconciliation.bundles_processed).toBe(2);
        expect(result.debug.reconciliation.invalid_ingredients).toBe(0);
    });
});
