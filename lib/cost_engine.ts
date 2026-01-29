
import { PrismaClient } from '@prisma/client';
import { convertUnit } from './unit_converter';

const prisma = new PrismaClient();

export interface CostResult {
    totalCost: number;
    costPerUnit: number;
    yieldUnit: string;
    currency: string;
    isAccurate: boolean; // False if any ingredients have 0 cost or missing conversion
}

/**
 * Recursively calculates the cost of a recipe.
 * @param recipeId ID of the recipe to cost
 * @param depth Recursion depth safe-guard
 */
export async function calculateRecipeCost(recipeId: string, depth = 0): Promise<CostResult> {
    if (depth > 5) {
        console.warn('Max recursion depth reached for cost calculation');
        return { totalCost: 0, costPerUnit: 0, yieldUnit: '?', currency: 'USD', isAccurate: false };
    }

    const recipe = await prisma.recipe.findUnique({
        where: { id: recipeId },
        include: {
            child_items: {
                include: {
                    child_ingredient: true,
                    child_recipe: true
                }
            }
        }
    });

    if (!recipe) return { totalCost: 0, costPerUnit: 0, yieldUnit: '?', currency: 'USD', isAccurate: false };

    let totalCost = 0;
    let isAccurate = true;

    for (const item of recipe.child_items) {
        let lineCost = 0;

        if (item.child_ingredient_id && item.child_ingredient) {
            // --- INGREDIENT COSTING ---
            const ing = item.child_ingredient;
            const costPerPurchaseUnit = Number(ing.cost_per_unit);

            // If cost is 0, flag as inaccurate but continue
            if (costPerPurchaseUnit === 0) isAccurate = false;

            // Determine the unit the cost is based on
            // Usually 'cost_per_unit' is price per 'unit' (e.g. $5/lb), NOT purchase_unit
            // But sometimes people enter $20 per Case (purchase_cost) and we need to derive

            // Simplification: We assume `cost_per_unit` in DB is the normalized price per `unit`
            // Example: $0.10 / oz.

            // Convert Item Qty (e.g. 1 cup) to Ingredient Unit (e.g. oz)
            const conversionRate = convertUnit(1, item.unit, ing.unit, ing.name);
            const qtyInIngUnits = Number(item.quantity) * conversionRate;

            lineCost = qtyInIngUnits * costPerPurchaseUnit;

        } else if (item.child_recipe_id && item.child_recipe) {
            // --- SUB-RECIPE COSTING ---
            // Recursively get cost of the child recipe
            const childCost = await calculateRecipeCost(item.child_recipe_id, depth + 1);
            if (!childCost.isAccurate) isAccurate = false;

            // Child Cost is for the WHOLE batch (base_yield_qty)
            // We need cost per Item Unit

            // 1. Get cost per yield unit of child (e.g. $/gal)
            const childCostPerYieldUnit = childCost.costPerUnit;

            // 2. Convert usage (e.g. 1 cup) to yield unit (e.g. gal)
            const conversionRate = convertUnit(1, item.unit, item.child_recipe.base_yield_unit, item.child_recipe.name);
            const usageInYieldUnits = Number(item.quantity) * conversionRate;

            lineCost = usageInYieldUnits * childCostPerYieldUnit;
        }

        totalCost += lineCost;
    }

    const baseYield = Number(recipe.base_yield_qty) || 1;
    const costPerUnit = totalCost / baseYield;

    return {
        totalCost: parseFloat(totalCost.toFixed(4)),
        costPerUnit: parseFloat(costPerUnit.toFixed(4)),
        yieldUnit: recipe.base_yield_unit,
        currency: 'USD',
        isAccurate
    };
}
