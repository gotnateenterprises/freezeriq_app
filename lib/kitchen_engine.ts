/**
 * CALC-1 — THE PHYSICAL-MEAL INGREDIENT DEMAND CONTRACT.
 *
 * CERTIFIED BY KITCHEN-CALCULATION-VERIFY-1 against read-only Production data:
 *
 *   RecipeItem.quantity on a MENU recipe is the full ingredient amount for ONE
 *   PHYSICAL MEAL PACKAGE at that recipe row's own tier. "Cheeseburger Soup"
 *   ("5 servings") stores 1 lb of beef = one family meal; its "(Serves 2)" row
 *   ("2 Servings") stores 0.5 lb = one couple meal. So one sold meal instance
 *   consumes exactly ONE stored ingredient list.
 *
 * THE CONTRACT
 *
 *   meals            = OrderItem.quantity x BundleContent.quantity   (mealManifest.ts)
 *   ingredient link  : demand[ingredient.id] += convertUnit(item.quantity x meals,
 *                                                item.unit -> Ingredient.unit)
 *   sub-recipe link  : childYield  = convertUnit(item.quantity x meals,
 *                                       item.unit -> child.base_yield_unit)
 *                      childCopies = childYield / child.base_yield_qty
 *                      recurse with childCopies
 *
 *   NO serving multiplier at menu depth.  NO base_yield divide at menu depth.
 *
 * WHAT WAS WRONG (both defects P0, both fixed here)
 *
 *   1. YIELD DIVIDE. explodeRecipeSync divided the physical package count by
 *      Recipe.base_yield_qty before scaling the stored quantities, so every
 *      "5 servings" row was planned at 0.200 of one tray. The divide arrived in
 *      commit e07b708 inside an unrelated CRM change; the root commit 0fb961b
 *      had deliberately coded "1 Order = 1 Batch". 154 of 157 tenant bundle
 *      contents sit on the servings convention, so the live planner asked for
 *      roughly a fifth of the food.
 *   2. SERVES-2 DOUBLE SCALE. The engine also multiplied serves_2 lines by 0.5
 *      although all 70 couple-tier BundleContents point at PRE-HALVED
 *      "(Serves 2)" recipe rows produced by the RecipeEditor clone. Tier is
 *      encoded by WHICH row a BundleContent references. Applying it again in
 *      code quartered the couple lane.
 *
 * WHY getServingMultiplier IS STILL CALLED. It validates the sold tier (LAW 8 —
 * an unknown tier must fail loudly) and it is recorded in the debug trace so an
 * auditor can still see what tier was sold. Its VALUE is never multiplied into
 * ingredient demand. lib/serving_multipliers.ts remains the locked authority for
 * fundraiser weights and label text and is untouched by this phase.
 *
 * THE UNIT OF THE RECURSION PARAMETER. explodeRecipeSync's second argument is
 * "how many full copies of THIS recipe's stored ingredient list are needed". At
 * depth 0 that is the physical meal count; at depth >= 1 it is the child batch
 * count computed by the parent AFTER unit conversion. One semantic, one unit.
 */
import { Uuid, Recipe } from '../types';
import { convertUnit } from './unit_converter';
import { getServingMultiplier, getMultiplierTable, normalizeStrictServingTier } from './serving_multipliers';
import { MEAL_UNIT, manifestKey, physicalMealCount, resolveManifestVariantSize } from './mealManifest';
import {
    DriftAlertCollector,
    DriftAlertConfig,
    flushDriftAlerts,
    alertEmptyIngredients,
    alertInvalidQuantity,
    alertReconciliationWarning,
    alertZeroMultiplier,
    alertUnitConversionFailure,
} from './drift_alert';

/** Debug trace entry — one per bundle×recipe×order for full traceability (LAW 7) */
export interface CalculationTrace {
    bundle_id: string;
    recipe_id: string;
    recipe_name: string;
    order_quantity: number;
    bundle_content_quantity: number;
    serving_multiplier: number;
    variant_size: string;
    final_multiplier: number;
}

/** Options for generateProductionRun */
export interface ProductionRunOptions {
    /** When true, returns a trace array for every multiplier application (LAW 7) */
    debug?: boolean;
    /** Drift alerting configuration. When provided, enables runtime anomaly detection. */
    driftAlertConfig?: DriftAlertConfig;
}

export interface DBAdapter {
    getRecipe(id: Uuid): Promise<Recipe | null>;
    getAllRecipes(): Promise<Recipe[]>;
    getBundleContents(bundleId: Uuid): Promise<{
        recipe_id: Uuid;
        position: number;
        quantity?: number | null;
    }[]>;
    getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string } | null>;
}

export class KitchenEngine {
    private recipeCache: Map<string, Recipe> = new Map();
    /** Temporary reference to the active drift collector for the current run (used by explodeRecipeSync) */
    private _driftCollectorRef: DriftAlertCollector | null = null;

    constructor(private db: DBAdapter) { }

    /**
     * Main Entry Point: Converts a list of Orders (Bundles) into atomic ingredients
     */
    async generateProductionRun(
        orders: { bundle_id: Uuid; quantity: number; variant_size?: 'start_fresh' | 'serves_2' | 'serves_5' }[],
        options?: ProductionRunOptions
    ) {
        // 0. Prefetch ALL recipes to prevent recursion
        if (this.recipeCache.size === 0) {
            const all = await this.db.getAllRecipes();
            all.forEach((r: Recipe) => this.recipeCache.set(r.id, r));
        }

        const rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, rawOnHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }> = new Map();
        const prepTasks: Map<string, { qty: number, id: string, name: string, unit: string, label_text?: string, allergens?: string }> = new Map();
        const trace: CalculationTrace[] = [];
        const driftCollector = new DriftAlertCollector();
        this._driftCollectorRef = driftCollector;

        // 1. Explode Orders into Recipe Jobs
        //    CALC-1 CHAIN (LAW 2): order.quantity × bundleContent.quantity
        //    The serving multiplier is NOT part of this chain — see the file header.
        for (const order of orders) {
            // LAW 8 validation + LAW 7 traceability. The value is recorded, never applied.
            const servingMultiplier = getServingMultiplier(order.variant_size);

            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);
            for (const item of bundleRecipes) {
                const bundleContentQty = item.quantity || 1.0;
                // CALC-1: ingredient demand is driven by the PHYSICAL MEAL COUNT,
                // taken from the single canonical authority (lib/mealManifest.ts)
                // that already produces the assemblyTasks manifest below. One
                // formula, one module — never a second meal-count heuristic.
                const mealInstances = physicalMealCount(order.quantity, item.quantity);

                // DRIFT ALERT: Zero effective multiplier means this recipe contributes nothing
                if (mealInstances === 0) {
                    driftCollector.add(alertZeroMultiplier(
                        order.bundle_id, item.recipe_id, mealInstances, options?.debug ? trace : undefined
                    ));
                }

                // LAW 7: Trace every multiplier application
                if (options?.debug) {
                    const recipe = this.recipeCache.get(item.recipe_id);
                    trace.push({
                        bundle_id: order.bundle_id,
                        recipe_id: item.recipe_id,
                        recipe_name: recipe?.name || 'UNKNOWN',
                        order_quantity: order.quantity,
                        bundle_content_quantity: bundleContentQty,
                        // Recorded for audit; CALC-1 does NOT apply it to demand.
                        serving_multiplier: servingMultiplier,
                        variant_size: order.variant_size || 'serves_5',
                        final_multiplier: mealInstances,
                    });
                }

                this.explodeRecipeSync(item.recipe_id, mealInstances, rawIngredients, prepTasks);
            }
        }

        // ── 1b. THE PHYSICAL MEAL MANIFEST (OPS-5A) ──────────────────────────
        //
        // This loop is NOT ingredient demand. Note what it does not multiply by:
        // `servingMultiplier`. Its unit is 'meals', and its qty is a count of
        // physical packages that need a tray, a lid and a LABEL. 3 x Serves-2
        // is 3 packages even though it is only 1.5 base-equivalent of food.
        // Nothing downstream may derive a label count from prepTasks, which is
        // the ingredient-scaled number.
        const assemblyTasks: Record<string, { id: string, name: string, variant: string, variantSize: string | null, qty: number, unit: string, allergens?: string | null, label_text?: string | null, instructions?: string | null }> = {};

        for (const order of orders) {
            // OPS-5A — TIER AUTHORITY REPAIR.
            //
            // `order.variant_size` is authoritative: for a SOLD line it is the
            // frozen OrderItem.variant_size snapshot, and for a MANUAL line
            // /api/production/plan already resolved it from the tenant-scoped
            // Bundle (OPS-4A). This loop previously read
            // `getBundleInfo(order.bundle_id).serving_tier` ALWAYS, which
            // silently re-tiered every sold order to whatever the Bundle row
            // happens to say TODAY -- the exact re-derivation OPS-4/OPS-4A
            // forbade everywhere else. The locked snapshots recorded the
            // result: a `serves_2` order labelled "Family (5)".
            //
            // The Bundle is now consulted ONLY when the line carries no tier at
            // all, which is the genuine legacy case, preserving the old
            // fallback rather than inventing a new one.
            let legacyBundleTier: string | null = null;
            if (!normalizeStrictServingTier(order.variant_size)) {
                const bundleInfo = await this.db.getBundleInfo(order.bundle_id);
                legacyBundleTier = bundleInfo?.serving_tier ?? null;
            }
            const variantSize = resolveManifestVariantSize(order.variant_size, legacyBundleTier);

            // The engine's long-standing display vocabulary, preserved as-is.
            // `variantSize` above is the canonical machine-readable field that
            // consumers should read; `variant` remains for display only.
            let variantLabel: string;
            if (variantSize === 'serves_2') variantLabel = 'Couple (2)';
            else if (variantSize === 'serves_5') variantLabel = 'Family (5)';
            else variantLabel = legacyBundleTier || 'Family (5)';

            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);

            for (const item of bundleRecipes) {
                const recipe = this.recipeCache.get(item.recipe_id);
                if (!recipe) continue;

                // OPS-5A: keyed by recipe IDENTITY + tier, not by display name.
                // A name is not unique -- two recipes a tenant named the same
                // would otherwise merge, combining their ALLERGENS onto one
                // physical food label while keeping only the first one's id.
                const key = manifestKey(recipe.id, variantSize as any);

                if (!assemblyTasks[key]) {
                    assemblyTasks[key] = {
                        id: recipe.id,
                        name: recipe.name,
                        variant: variantLabel,
                        variantSize,
                        qty: 0,
                        unit: MEAL_UNIT,
                        allergens: recipe.allergens,
                        label_text: recipe.label_text,
                        instructions: recipe.instructions
                    };
                }
                assemblyTasks[key].qty += physicalMealCount(order.quantity, item.quantity);
            }
        }

        // ── STEP 3: RECONCILIATION CHECKS (LAW 5 / LAW 8) ──────────────────────
        const ingredientCount = rawIngredients.size;

        // 3a. Verify ingredients were generated (non-empty orders should produce output)
        if (orders.length > 0 && ingredientCount === 0) {
            console.warn(
                `[RECONCILIATION WARNING] ${orders.length} order(s) produced 0 ingredients. ` +
                `Possible causes: empty bundles, missing recipes, or all-sub-recipe bundles.`
            );
            // DRIFT ALERT: Empty ingredients from non-empty orders is critical
            driftCollector.add(alertEmptyIngredients(
                orders.length,
                orders.map(o => o.bundle_id),
                options?.debug ? trace : undefined
            ));
        }

        // 3b. Check for invalid quantities (NaN, Infinity, negative)
        const invalidIngredients: string[] = [];
        for (const [key, ing] of rawIngredients) {
            if (!Number.isFinite(ing.qty) || ing.qty < 0) {
                invalidIngredients.push(`${ing.displayName} (id=${key}): qty=${ing.qty}`);
                // DRIFT ALERT: Every invalid ingredient gets its own alert for traceability
                driftCollector.add(alertInvalidQuantity(
                    ing.displayName, key, ing.qty, options?.debug ? trace : undefined
                ));
            }
        }
        if (invalidIngredients.length > 0) {
            // Flush critical alerts BEFORE throwing so operators are notified
            flushDriftAlerts(driftCollector, options?.driftAlertConfig);
            throw new Error(
                `[RECONCILIATION FAILURE] ${invalidIngredients.length} ingredient(s) have invalid quantities: ` +
                invalidIngredients.join('; ') + `. ` +
                `This indicates a broken multiplier chain or corrupt recipe data.`
            );
        }

        // 3c. Verify multiplier chain completeness — every order must have been processed
        const processedBundles = new Set(trace.map(t => t.bundle_id));
        if (options?.debug) {
            const unprocessed = orders.filter(o => !processedBundles.has(o.bundle_id));
            if (unprocessed.length > 0) {
                console.warn(
                    `[RECONCILIATION WARNING] ${unprocessed.length} order(s) had no trace entries. ` +
                    `Bundle IDs: ${unprocessed.map(o => o.bundle_id).join(', ')}`
                );
                // DRIFT ALERT: Unprocessed bundles may indicate missing recipes
                driftCollector.add(alertReconciliationWarning(
                    unprocessed.map(o => o.bundle_id),
                    orders.length,
                    trace
                ));
            }
        }

        // ── BUILD RESULT ─────────────────────────────────────────────────────────
        const result: any = {
            rawIngredients: Object.fromEntries(
                Array.from(rawIngredients.entries()).map(([k, v]) => [k, { ...v, usedIn: Array.from(v.usedIn) }])
            ),
            // CALC-1 / LAW 3: the canonical quantity leaves the engine at FULL
            // PRECISION in the recipe's own base_yield_unit. optimizeUnit's
            // parseFloat(toFixed(2)) plus its unit re-scale used to run here, and
            // that rounded, re-based number was what /api/production/runs persisted
            // as ProductionTask.total_qty_needed. Unit prettying is a render-layer
            // concern; the consumers that display it already round at their edge.
            prepTasks: Object.fromEntries(prepTasks.entries()),
            assemblyTasks
        };

        // ── STEP 5: DEBUG VALIDATION OUTPUT (LAW 7) ─────────────────────────────
        if (options?.debug) {
            // Total ingredient quantities (summed across all ingredients)
            let totalIngredientQty = 0;
            for (const ing of rawIngredients.values()) {
                totalIngredientQty += ing.qty;
            }

            // Per-bundle contribution breakdown
            const bundleContributions: Record<string, {
                bundle_id: string;
                variant_size: string;
                serving_multiplier: number;
                recipe_count: number;
                total_multiplier_sum: number;
            }> = {};
            for (const t of trace) {
                if (!bundleContributions[t.bundle_id]) {
                    bundleContributions[t.bundle_id] = {
                        bundle_id: t.bundle_id,
                        variant_size: t.variant_size,
                        serving_multiplier: t.serving_multiplier,
                        recipe_count: 0,
                        total_multiplier_sum: 0,
                    };
                }
                bundleContributions[t.bundle_id].recipe_count++;
                bundleContributions[t.bundle_id].total_multiplier_sum += t.final_multiplier;
            }

            result.debug = {
                trace,
                multiplier_table: getMultiplierTable(),
                ingredient_count: ingredientCount,
                ingredient_total_qty: totalIngredientQty,
                bundle_contributions: Object.values(bundleContributions),
                reconciliation: {
                    orders_received: orders.length,
                    bundles_processed: processedBundles.size,
                    invalid_ingredients: invalidIngredients.length,
                },
            };
        }

        // ── STEP 6: DRIFT ALERT FLUSH ────────────────────────────────────────────
        // Dispatch all collected alerts AFTER result is built but BEFORE return.
        // This ensures the production run is never blocked by alert dispatch.
        if (driftCollector.hasAlerts()) {
            const alertConfig: DriftAlertConfig = {
                ...options?.driftAlertConfig,
                includeTrace: options?.debug,
            };
            const dispatched = flushDriftAlerts(driftCollector, alertConfig);
            if (result.debug) {
                result.debug.drift_alerts = dispatched;
            }

            // If failOnCritical is enabled and we have CRITICAL alerts, throw AFTER dispatch
            if (alertConfig.failOnCritical && driftCollector.hasCritical()) {
                throw new Error(
                    `[DRIFT ALERT] ${dispatched.length} drift alert(s) dispatched, ` +
                    `including CRITICAL severity. Halting per failOnCritical policy.`
                );
            }
        }

        // Cleanup: null out the collector ref to prevent stale cross-run references
        this._driftCollectorRef = null;

        return result;
    }

    /**
     * Synchronous function to resolve ingredients using cache
     */
    private explodeRecipeSync(
        recipeId: Uuid,
        /**
         * How many FULL COPIES of this recipe's stored ingredient list are needed.
         * Depth 0: the physical meal count (order.quantity x BundleContent.quantity).
         * Depth >= 1: the child batch count the parent computed after converting
         * into this recipe's own base_yield_unit and dividing by its base_yield_qty.
         */
        copies: number,
        rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, rawOnHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }>,
        prepTasks: Map<string, { qty: number, id: string, name: string, unit: string, label_text?: string, allergens?: string }>,
        depth = 0
    ) {
        if (depth > 10) return; // Prevent infinite loops

        const recipe = this.recipeCache.get(recipeId);
        if (!recipe) {
            console.warn(`Recipe not found in cache: ${recipeId}`);
            return;
        }

        // CALC-1: NO YIELD DIVIDE HERE.
        //
        // `copies` already means "how many full copies of this recipe's stored
        // ingredient list are needed" — the physical meal count at depth 0, the
        // child batch count below that. The stored list IS one whole package, so
        // it is multiplied by `copies` directly. base_yield_qty is descriptive for
        // a menu row (cost-per-serving, the editor's batch calculator) and is used
        // as a divisor in exactly one place: the recipe-to-recipe link further
        // down, and only AFTER converting into the child's own yield unit.

        if (recipe.type === 'prep' || recipe.type === 'menu_item' || recipe.label_text || recipe.allergens) {
            // LAW 6: keyed by the stable Recipe id, never the display name. Two
            // recipes a tenant named the same are two different physical products;
            // merging them combined their quantities under one id and silently
            // dropped the other (52 duplicate-name families exist in Production).
            const current = prepTasks.get(recipe.id) || { qty: 0, id: recipe.id, name: recipe.name, unit: recipe.base_yield_unit, label_text: recipe.label_text, allergens: recipe.allergens };

            if (recipe.label_text && !current.label_text) current.label_text = recipe.label_text;
            if (recipe.allergens && !current.allergens) current.allergens = recipe.allergens;

            prepTasks.set(recipe.id, {
                // For a MENU row this is now the physical meal count (the couple
                // lane is no longer halved). For a PREP row it is the batch count.
                qty: current.qty + copies,
                id: recipe.id,
                name: recipe.name,
                unit: recipe.base_yield_unit,
                label_text: current.label_text,
                allergens: current.allergens
            });
        }

        for (const item of recipe.items) {
            // The stored quantity is for ONE full copy of this recipe.
            const childNeededQty = item.quantity * copies;

            if (item.child_type === 'ingredient') {
                let rawName = item.name || item.child_item_id;
                rawName = rawName.replace(/^["']|["']$/g, '');

                // STEP 2 (LAW 1): Aggregate by stable ID, not name.
                // This prevents silent merging of distinct ingredients with identical display names.
                const key = item.child_item_id;
                const current = rawIngredients.get(key) || {
                    qty: 0,
                    netQty: 0,
                    unit: item.unit,
                    displayName: rawName,
                    usedIn: new Set<string>(),
                    supplier: item.supplier_name,
                    supplierUrl: item.supplier_url,
                    portalType: (item as any).portal_type,
                    searchUrlPattern: (item as any).search_url_pattern,
                    // CALC-1: 41 of this tenant's 214 ingredients carry an imported
                    // NEGATIVE stock_quantity. Subtracting a negative ADDS it to the
                    // purchase requirement, which put ~56% of a real shopping list's
                    // printed units into repaying phantom deficits. Clamp for the
                    // calculation; keep the raw value so a UI can still warn. No
                    // Production row is modified by this phase.
                    onHand: Math.max(0, Number(item.stock_quantity) || 0),
                    rawOnHand: Number(item.stock_quantity) || 0,
                    costPerUnit: item.cost_per_unit || 0,
                    costUnit: item.cost_unit,
                    sku: item.sku,
                    purchaseCost: item.purchase_cost,
                    purchaseUnit: item.purchase_unit,
                    purchaseQuantity: item.purchase_quantity
                };

                current.usedIn.add(recipe.name);

                const targetUnit = item.cost_unit || current.unit;
                let finalQty = childNeededQty;
                if (targetUnit !== item.unit) {
                    // STEP 4 guard: convertUnit now throws on impossible conversions.
                    // We catch here to surface the data issue without halting the entire production run.
                    try {
                        finalQty = convertUnit(childNeededQty, item.unit, targetUnit, rawName);
                    } catch (convErr: any) {
                        console.error(`[RECONCILIATION WARNING] ${convErr.message}`);
                        // DRIFT ALERT: Unit conversion failure
                        this._driftCollectorRef?.add(alertUnitConversionFailure(
                            rawName, item.unit, targetUnit, convErr.message
                        ));
                        // Fall back to recipe unit — do NOT silently use wrong-unit qty
                        finalQty = childNeededQty;
                    }
                }

                const totalNeeded = current.qty + finalQty;
                // Subtract stock from total to get netNeeded
                const netNeeded = Math.max(0, totalNeeded - current.onHand);

                rawIngredients.set(key, {
                    id: item.child_item_id,
                    qty: totalNeeded,
                    netQty: netNeeded,
                    unit: targetUnit,
                    displayName: current.displayName,
                    usedIn: current.usedIn,
                    supplier: current.supplier,
                    supplierUrl: current.supplierUrl || item.supplier_url,
                    portalType: current.portalType || (item as any).portal_type,
                    searchUrlPattern: current.searchUrlPattern || (item.search_url_pattern as any),
                    onHand: current.onHand,
                    rawOnHand: current.rawOnHand,
                    costPerUnit: Math.max(current.costPerUnit, item.cost_per_unit || 0),
                    costUnit: current.costUnit || item.cost_unit,
                    sku: current.sku || item.sku,
                    purchaseCost: current.purchaseCost || item.purchase_cost,
                    purchaseUnit: current.purchaseUnit || item.purchase_unit,
                    purchaseQuantity: current.purchaseQuantity || item.purchase_quantity
                });

            } else if (item.child_type === 'recipe') {
                // CALC-1 SUB-RECIPE CONTRACT — convert, THEN divide.
                //
                // `childNeededQty` is expressed in the PARENT item's unit. The
                // child's base_yield_qty is expressed in the CHILD's yield unit.
                // Dividing one by the other without converting first treated 4 tsp
                // as 4 tbsp against a 144-tbsp seasoning yield — a real 3x error on
                // 17 of this tenant's 42 sub-recipe links. Convert into the child's
                // yield unit, then divide, then recurse with a batch count.
                const child = this.recipeCache.get(item.child_item_id);
                if (!child) {
                    console.warn(`Recipe not found in cache: ${item.child_item_id}`);
                    continue;
                }

                let neededInChildYieldUnit = childNeededQty;
                const childYieldUnit = child.base_yield_unit;
                if (
                    childYieldUnit && item.unit &&
                    childYieldUnit.toLowerCase().trim() !== item.unit.toLowerCase().trim()
                ) {
                    try {
                        neededInChildYieldUnit = convertUnit(childNeededQty, item.unit, childYieldUnit, child.name);
                    } catch (convErr: any) {
                        console.error(`[RECONCILIATION WARNING] ${convErr.message}`);
                        this._driftCollectorRef?.add(alertUnitConversionFailure(
                            child.name, item.unit, childYieldUnit, convErr.message
                        ));
                        // Fall back to the unconverted amount rather than halting the
                        // run — the same posture the ingredient branch above takes.
                        neededInChildYieldUnit = childNeededQty;
                    }
                }

                const childBaseYield = Number(child.base_yield_qty) || 1.0;
                const childCopies = neededInChildYieldUnit / childBaseYield;
                this.explodeRecipeSync(item.child_item_id, childCopies, rawIngredients, prepTasks, depth + 1);
            }
        }
    }

    /**
     * Calculates the total food cost for a specific bundle.
     */
    async calculateBundleCost(bundleId: Uuid, variant: 'serves_2' | 'serves_5' = 'serves_5'): Promise<number> {
        const result = await this.generateProductionRun([
            { bundle_id: bundleId, quantity: 1, variant_size: variant }
        ]);

        let totalCost = 0;
        for (const _ing of Object.values(result.rawIngredients)) {
            const ing = _ing as any;
            try {
                let qtyInCostUnit = ing.qty;
                if (ing.costUnit && ing.costUnit !== ing.unit) {
                    // convertUnit now throws on failure — catch per-ingredient
                    qtyInCostUnit = convertUnit(ing.qty, ing.unit, ing.costUnit, ing.displayName);
                }
                totalCost += qtyInCostUnit * (ing.costPerUnit || 0);
            } catch (e: any) {
                console.error(`[COST CALCULATION] Skipping cost for "${ing.displayName}": ${e.message}`);
                // Skip this ingredient's cost contribution rather than corrupt the total
            }
        }
        return totalCost;
    }
}
