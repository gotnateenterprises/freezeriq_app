import { Uuid, Recipe } from '../types';
import { optimizeUnit, convertUnit } from './unit_converter';
import { getServingMultiplier, getMultiplierTable } from './serving_multipliers';
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

        const rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }> = new Map();
        const prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }> = new Map();
        const trace: CalculationTrace[] = [];
        const driftCollector = new DriftAlertCollector();
        this._driftCollectorRef = driftCollector;

        // 1. Explode Orders into Recipe Jobs
        //    MULTIPLIER CHAIN (LAW 2): order.quantity × bundleContent.quantity × servingMultiplier
        for (const order of orders) {
            // LAW 2: Serving multiplier MUST be applied exactly once per order
            const servingMultiplier = getServingMultiplier(order.variant_size);

            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);
            for (const item of bundleRecipes) {
                const bundleContentQty = item.quantity || 1.0;
                const multiplier = order.quantity * bundleContentQty * servingMultiplier;

                // DRIFT ALERT: Zero effective multiplier means this recipe contributes nothing
                if (multiplier === 0) {
                    driftCollector.add(alertZeroMultiplier(
                        order.bundle_id, item.recipe_id, multiplier, options?.debug ? trace : undefined
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
                        serving_multiplier: servingMultiplier,
                        variant_size: order.variant_size || 'serves_5',
                        final_multiplier: multiplier,
                    });
                }

                this.explodeRecipeSync(item.recipe_id, multiplier, rawIngredients, prepTasks);
            }
        }

        // 1b. Create Assembly Tasks (Top Level Only)
        const assemblyTasks: Record<string, { id: string, name: string, variant: string, qty: number, unit: string, allergens?: string | null, label_text?: string | null, instructions?: string | null }> = {};

        for (const order of orders) {
            const bundleInfo = await this.db.getBundleInfo(order.bundle_id);
            const tier = bundleInfo?.serving_tier || 'family';

            let variantLabel = 'Family (5)';
            const lowerTier = tier.toLowerCase();
            if (lowerTier.includes('couple') || lowerTier.includes('serves 2')) variantLabel = 'Couple (2)';
            if (lowerTier.includes('single')) variantLabel = 'Single (1)';

            if (!['family', 'couple', 'single'].includes(lowerTier)) {
                variantLabel = tier;
            }

            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);

            for (const item of bundleRecipes) {
                const recipe = this.recipeCache.get(item.recipe_id);
                if (!recipe) continue;

                const key = `${recipe.name} - ${variantLabel}`;

                if (!assemblyTasks[key]) {
                    assemblyTasks[key] = {
                        id: recipe.id,
                        name: recipe.name,
                        variant: variantLabel,
                        qty: 0,
                        unit: 'meals',
                        allergens: recipe.allergens,
                        label_text: recipe.label_text,
                        instructions: recipe.instructions
                    };
                }
                assemblyTasks[key].qty += order.quantity * (item.quantity || 1);
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
            prepTasks: Object.fromEntries(
                Array.from(prepTasks.entries()).map(([k, v]) => {
                    const optimized = optimizeUnit(v.qty, v.unit);
                    return [k, { ...v, qty: optimized.qty, unit: optimized.unit }];
                })
            ),
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
        neededAmt: number, // Represents the "amount" of the recipe output needed
        rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }>,
        prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }>,
        depth = 0
    ) {
        if (depth > 10) return; // Prevent infinite loops

        const recipe = this.recipeCache.get(recipeId);
        if (!recipe) {
            console.warn(`Recipe not found in cache: ${recipeId}`);
            return;
        }

        // SCALING FIX: 
        // If a recipe yields 5 units (servings/oz/etc) and we need 10 units, 
        // the ingredients (which are for a FULL yield) should be multiplied by (10 / 5) = 2.0.
        const baseYield = Number(recipe.base_yield_qty) || 1.0;
        const multiplier = neededAmt / baseYield;

        if (recipe.type === 'prep' || recipe.type === 'menu_item' || recipe.label_text || recipe.allergens) {
            const current = prepTasks.get(recipe.name) || { qty: 0, id: recipe.id, unit: recipe.base_yield_unit, label_text: recipe.label_text, allergens: recipe.allergens };

            if (recipe.label_text && !current.label_text) current.label_text = recipe.label_text;
            if (recipe.allergens && !current.allergens) current.allergens = recipe.allergens;

            prepTasks.set(recipe.name, {
                qty: current.qty + neededAmt, // We need this many total yield units (e.g. 10 servings)
                id: recipe.id,
                unit: recipe.base_yield_unit,
                label_text: current.label_text,
                allergens: current.allergens
            });
        }

        for (const item of recipe.items) {
            // childNeededQty is now scaled based on the batch multiplier
            const childNeededQty = item.quantity * multiplier;

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
                    onHand: item.stock_quantity || 0,
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
                    costPerUnit: Math.max(current.costPerUnit, item.cost_per_unit || 0),
                    costUnit: current.costUnit || item.cost_unit,
                    sku: current.sku || item.sku,
                    purchaseCost: current.purchaseCost || item.purchase_cost,
                    purchaseUnit: current.purchaseUnit || item.purchase_unit,
                    purchaseQuantity: current.purchaseQuantity || item.purchase_quantity
                });

            } else if (item.child_type === 'recipe') {
                this.explodeRecipeSync(item.child_item_id, childNeededQty, rawIngredients, prepTasks, depth + 1);
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
