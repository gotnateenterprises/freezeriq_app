import { Uuid, Recipe } from '../types';
import { optimizeUnit, convertUnit } from './unit_converter';

export interface DBAdapter {
    getRecipe(id: Uuid): Promise<Recipe | null>;
    getAllRecipes(): Promise<Recipe[]>;
    getBundleContents(bundleId: Uuid): Promise<{
        recipe_id: Uuid;
        position: number;
        quantity?: number | null;
    }[]>;
    getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string, name?: string } | null>;
}

export class KitchenEngine {
    private recipeCache: Map<string, Recipe> = new Map();

    constructor(private db: DBAdapter) { }

    /**
     * Main Entry Point: Converts a list of Orders (Bundles) into atomic ingredients
     */
    async generateProductionRun(orders: { bundle_id: Uuid; quantity: number; variant_size?: 'start_fresh' | 'serves_2' | 'serves_5' }[]) {
        // 0. Prefetch ALL recipes to prevent recursion
        if (this.recipeCache.size === 0) {
            const all = await this.db.getAllRecipes();
            all.forEach((r: Recipe) => this.recipeCache.set(r.id, r));
        }

        const rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }> = new Map();
        const prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }> = new Map();

        // 1. Explode Orders into Recipe Jobs
        for (const order of orders) {
            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);
            for (const item of bundleRecipes) {
                const recipe = this.recipeCache.get(item.recipe_id);
                if (!recipe) continue;

                const baseYield = Number(recipe.base_yield_qty) || 1.0;

                // item.quantity in BundleContent represents the number of BATCHES of this recipe per bundle.
                // order.quantity is the number of times this Bundle was ordered.
                // explodeRecipeSync expects `neededAmt` to be in the Recipe's YIELD units.
                const neededAmt = order.quantity * (item.quantity || 1.0) * baseYield;

                const bundleInfo = await this.db.getBundleInfo(order.bundle_id);
                const bundleName = bundleInfo?.name || 'Unknown Bundle';

                this.explodeRecipeSync(item.recipe_id, neededAmt, rawIngredients, prepTasks, 0, bundleName);
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

        return {
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
    }

    /**
     * Synchronous function to resolve ingredients using cache
     */
    private explodeRecipeSync(
        recipeId: Uuid,
        neededAmt: number, // Represents the "amount" of the recipe output needed
        rawIngredients: Map<string, { id: string, qty: number, netQty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, portalType?: string, searchUrlPattern?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string, purchaseQuantity?: number }>,
        prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }>,
        depth = 0,
        bundleName = 'Unknown Bundle'
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

        // OR if we are at the top level (checking via stack trace or context would be hard, but generally if we are exploding it, it's a task)
        if (recipe.type === 'prep' || recipe.type === 'menu_item' || recipe.label_text || recipe.allergens) {
            const prepKey = `${bundleName} - ${recipe.name}`;
            const current = prepTasks.get(prepKey) || { qty: 0, id: recipe.id, unit: recipe.base_yield_unit, label_text: recipe.label_text, allergens: recipe.allergens };

            if (recipe.label_text && !current.label_text) current.label_text = recipe.label_text;
            if (recipe.allergens && !current.allergens) current.allergens = recipe.allergens;

            prepTasks.set(prepKey, {
                qty: current.qty + multiplier, // Reverted to use multiplier (Batches) instead of neededAmt (Servings)
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

                const key = rawName.toLowerCase().trim();
                const current = rawIngredients.get(key) || {
                    id: item.child_item_id,
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
                    finalQty = convertUnit(childNeededQty, item.unit, targetUnit);
                }

                current.qty += finalQty;
                current.netQty = Math.max(0, current.qty - current.onHand);
                current.unit = targetUnit;

                // Keep the largest cost/best info
                current.costPerUnit = Math.max(current.costPerUnit, item.cost_per_unit || 0);
                if (!current.supplier) current.supplier = item.supplier_name;
                if (!current.supplierUrl) current.supplierUrl = item.supplier_url;
                if (!current.portalType) current.portalType = (item as any).portal_type;
                if (!current.sku) current.sku = item.sku;
                if (!current.purchaseCost) current.purchaseCost = item.purchase_cost;
                if (!current.purchaseUnit) current.purchaseUnit = item.purchase_unit;
                if (!current.purchaseQuantity) current.purchaseQuantity = item.purchase_quantity;

                rawIngredients.set(key, current);

            } else if (item.child_type === 'recipe') {
                this.explodeRecipeSync(item.child_item_id, childNeededQty, rawIngredients, prepTasks, depth + 1, bundleName);
            }
        }
    }

    /**
     * Calculates the total food cost for a specific bundle.
     */
    async calculateBundleCost(bundleId: Uuid, variant: 'serves_2' | 'serves_5' = 'serves_5'): Promise<number> {
        const result = await this.generateProductionRun([
            { bundle_id: bundleId, quantity: 1, variant_size: 'start_fresh' }
        ]);

        let totalCost = 0;
        for (const ing of Object.values(result.rawIngredients)) {
            try {
                let qtyInCostUnit = ing.qty;
                if (ing.costUnit && ing.costUnit !== ing.unit) {
                    qtyInCostUnit = convertUnit(ing.qty, ing.unit, ing.costUnit);
                }
                totalCost += qtyInCostUnit * (ing.costPerUnit || 0);
            } catch (e) { }
        }
        return totalCost;
    }
}
