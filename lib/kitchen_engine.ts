import { Uuid, Recipe } from '../types';
import { optimizeUnit, convertUnit } from './unit_converter';

export interface DBAdapter {
    getRecipe(id: Uuid): Promise<Recipe | null>;
    getBundleContents(bundleId: Uuid): Promise<{
        recipe_id: Uuid;
        position: number;
        quantity?: number | null;
    }[]>;
    getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string } | null>;
}

export class KitchenEngine {
    constructor(private db: DBAdapter) { }

    /**
     * Main Entry Point: Converts a list of Orders (Bundles) into atomic ingredients
     */
    async generateProductionRun(orders: { bundle_id: Uuid; quantity: number; variant_size?: 'start_fresh' | 'serves_2' | 'serves_5' }[]) {
        // Map<Key, {Qty, Unit, Display, UsedIn, Supplier}>
        const rawIngredients: Map<string, { id: string, qty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string }> = new Map();
        const prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }> = new Map(); // Map<RecipeName, {Qty, ID, Unit, Label}>

        // 1. Explode Orders into Recipe Jobs
        for (const order of orders) {
            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);
            // Fetch Bundle Metadata for Serving Tier
            for (const item of bundleRecipes) {
                // 1:1 Scaling - One bundle order = One recipe batch
                const multiplier = order.quantity * (item.quantity || 1.0);

                // Recursive Explosion
                await this.explodeRecipe(item.recipe_id, multiplier, rawIngredients, prepTasks);
            }
        }

        // 1b. Create Assembly Tasks (Top Level Only)
        // User Request: "Just show me the Recipe and Serving Size I need to make"
        const assemblyTasks: Record<string, { id: string, name: string, variant: string, qty: number, unit: string, allergens?: string | null, label_text?: string | null, instructions?: string | null }> = {};

        for (const order of orders) {
            // We fetch this again or we could have cached it above. For simplicity/safety, fetching again is fine for MVP.
            const bundleInfo = await this.db.getBundleInfo(order.bundle_id);
            const tier = bundleInfo?.serving_tier || 'family';

            let variantLabel = 'Family (5)';
            const lowerTier = tier.toLowerCase();
            if (lowerTier.includes('couple') || lowerTier.includes('serves 2')) variantLabel = 'Couple (2)';
            if (lowerTier.includes('single')) variantLabel = 'Single (1)';

            // If custom tier, append name? e.g. "Family (5) - Keto"
            // For now, keep standard variant labels to group assembly tasks cleanly, 
            // OR let's append the custom string if it's not exact match?
            // User requirement: "Serving Size Tier drop down... allows user to add a tier for Keto".
            // If they create "Family Keto", we probably want the assembly task to say "Family Keto".
            if (!['family', 'couple', 'single'].includes(lowerTier)) {
                variantLabel = tier; // Simple label for custom tiers
            }

            const bundleRecipes = await this.db.getBundleContents(order.bundle_id);

            for (const item of bundleRecipes) {
                const recipe = await this.db.getRecipe(item.recipe_id);
                if (!recipe) continue;

                // Key by Name + Variant to group same items
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

        // Convert Maps to Objects (and Sets to Arrays for JSON)
        return {
            rawIngredients: Object.fromEntries(
                Array.from(rawIngredients.entries()).map(([k, v]) => {
                    // USER REQUEST: Strict Unit Adherence
                    // Do NOT optimize/upscale units (e.g. keep 'cup', don't go to 'quart').
                    // We already enforced the "Ingredient Usage Unit" during explosion if available.
                    return [k, { ...v, usedIn: Array.from(v.usedIn) }];
                })
            ),
            prepTasks: Object.fromEntries(
                Array.from(prepTasks.entries()).map(([k, v]) => {
                    // Prep tasks usually keep their unit (e.g. 5 batches), but if it's volume we can optimize
                    const optimized = optimizeUnit(v.qty, v.unit);
                    return [k, { ...v, qty: optimized.qty, unit: optimized.unit }];
                })
            ),
            assemblyTasks
        };
    }

    /**
     * Recursive function to resolve valid ingredients from a top-level recipe
     */
    private async explodeRecipe(
        // Recursive helper to explode recipe
        recipeId: Uuid,
        neededServings: number,
        rawIngredients: Map<string, { id: string, qty: number, unit: string, displayName: string, usedIn: Set<string>, supplier?: string, supplierUrl?: string, onHand: number, costPerUnit: number, costUnit?: string, sku?: string, purchaseCost?: number, purchaseUnit?: string }>,
        prepTasks: Map<string, { qty: number, id: string, unit: string, label_text?: string, allergens?: string }>
    ) {
        const recipe = await this.db.getRecipe(recipeId);
        if (!recipe) {
            console.warn(`Recipe not found: ${recipeId}`);
            return;
        }

        // Calculate Multiplier: (Needed / Base)
        // FIXED: Ignore Base Yield for top-level aggregation to ensure "1 Order = 1 Batch"
        const multiplier = neededServings;

        // Treat as Prep Task if it's explicitly 'prep' type OR if it has a label (meaning we produce a container for it)
        // OR if it has allergens (implies it's a food item we might want to label)
        // OR if we are at the top level (checking via stack trace or context would be hard, but generally if we are exploding it, it's a task)
        // REVISION: We want to label "Menu Items" too (for the final container).
        if (recipe.type === 'prep' || recipe.type === 'menu_item' || recipe.label_text || recipe.allergens) {
            // It's a Recipe (e.g. Marinara or Full Meal), track it as a Production Task
            const current = prepTasks.get(recipe.name) || { qty: 0, id: recipe.id, unit: recipe.base_yield_unit, label_text: recipe.label_text, allergens: recipe.allergens };

            // Ensure label_text is captured if missed previously
            if (recipe.label_text && !current.label_text) current.label_text = recipe.label_text;
            if (recipe.allergens && !current.allergens) current.allergens = recipe.allergens;

            prepTasks.set(recipe.name, {
                qty: current.qty + multiplier,
                id: recipe.id,
                unit: recipe.base_yield_unit,
                label_text: current.label_text,
                allergens: current.allergens
            });
        }

        // Iterate Children
        for (const item of recipe.items) {
            const childNeededQty = item.quantity * multiplier;

            if (item.child_type === 'ingredient') {
                // Atomic Ingredient: Add to Shopping List
                // FIXED: Normalize Name to merge "Ground Beef" and "ground beef" and remove artifacts
                let rawName = item.name || item.child_item_id;
                // Remove leading/trailing quotes if present (artifact from CSV)
                rawName = rawName.replace(/^["']|["']$/g, '');

                const key = rawName.toLowerCase().trim();
                const current = rawIngredients.get(key) || {
                    qty: 0,
                    unit: item.unit,
                    displayName: rawName,
                    usedIn: new Set<string>(),
                    supplier: item.supplier_name,
                    supplierUrl: item.supplier_url,
                    onHand: item.stock_quantity || 0,
                    costPerUnit: item.cost_per_unit || 0,
                    costUnit: item.cost_unit,
                    sku: item.sku,
                    purchaseCost: item.purchase_cost,
                    purchaseUnit: item.purchase_unit
                };

                // Add current recipe to usage list
                current.usedIn.add(recipe.name);

                // FORCE UNIT: Use the Ingredient's defined Usage Unit (stored in costUnit/cost_unit) if available
                const targetUnit = item.cost_unit || current.unit;

                // Convert Quantity to Target Unit
                let finalQty = childNeededQty;
                if (targetUnit !== item.unit) {
                    finalQty = convertUnit(childNeededQty, item.unit, targetUnit);
                }

                rawIngredients.set(key, {
                    id: item.child_item_id, // Capture ID for depletion
                    qty: current.qty + finalQty,
                    unit: targetUnit,
                    displayName: current.displayName, // Keep the first display variant found
                    usedIn: current.usedIn,
                    supplier: current.supplier, // Preserve original supplier
                    supplierUrl: current.supplierUrl || item.supplier_url,
                    onHand: current.onHand, // Preserve stock
                    costPerUnit: Math.max(current.costPerUnit, item.cost_per_unit || 0), // Use highest cost
                    costUnit: current.costUnit || item.cost_unit, // Preserve unit
                    sku: current.sku || item.sku,
                    purchaseCost: current.purchaseCost || item.purchase_cost,
                    purchaseUnit: current.purchaseUnit || item.purchase_unit
                });

            } else if (item.child_type === 'recipe') {
                // Sub-Recipe: Recurse!
                await this.explodeRecipe(item.child_item_id, childNeededQty, rawIngredients, prepTasks);
            }
        }
    }

    /**
     * Calculates the total food cost for a specific bundle.
     * Simulates a "Serve 5" (Family) variant production to get baseline.
     */
    async calculateBundleCost(bundleId: Uuid, variant: 'serves_2' | 'serves_5' = 'serves_5'): Promise<number> {
        // Run simulation for 1 unit
        const result = await this.generateProductionRun([
            { bundle_id: bundleId, quantity: 1, variant_size: 'start_fresh' }
        ]);

        let totalCost = 0;

        for (const ing of Object.values(result.rawIngredients)) {
            try {
                // Convert Qty (recipe unit) to Cost Unit
                let qtyInCostUnit = ing.qty;

                // If conversion needed
                if (ing.costUnit && ing.costUnit !== ing.unit) {
                    qtyInCostUnit = convertUnit(ing.qty, ing.unit, ing.costUnit);
                }

                totalCost += qtyInCostUnit * (ing.costPerUnit || 0);
            } catch (e) {
                // console.warn(`Failed to calculate cost for ${ing.displayName}: ${e}`);
            }
        }
        return totalCost;
    }
}
