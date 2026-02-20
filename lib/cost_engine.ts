import { prisma } from './db';
import { convertUnit } from './unit_converter';

export interface CostResult {
    totalCost: number;
    costPerUnit: number;
    yieldUnit: string;
    currency: string;
    isAccurate: boolean; // False if any ingredients have 0 cost or missing conversion
}

/**
 * REFACTORED: Calculates the cost of a recipe.
 * Note: For high-volume lookups (like lists), pre-fetch recipes into a Map for O(1) access.
 * This function remains for single-recipe costings but follows the same logic as the storefront.
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
                    child_recipe: {
                        include: {
                            child_items: {
                                include: {
                                    child_ingredient: true,
                                    child_recipe: true
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    if (!recipe) return { totalCost: 0, costPerUnit: 0, yieldUnit: '?', currency: 'USD', isAccurate: false };

    // Fetch Packaging in Parallel
    const packagingItems = await prisma.packagingItem.findMany({
        where: { business_id: recipe.business_id }
    });

    let totalCost = 0;
    let isAccurate = true;

    for (const item of recipe.child_items) {
        let lineCost = 0;

        if (item.child_ingredient_id && item.child_ingredient) {
            const ing = item.child_ingredient;
            const costPerPurchaseUnit = Number(ing.cost_per_unit);
            if (costPerPurchaseUnit === 0) isAccurate = false;

            const conversionRate = convertUnit(1, item.unit, ing.unit, ing.name);
            const qtyInIngUnits = Number(item.quantity) * conversionRate;
            lineCost = qtyInIngUnits * costPerPurchaseUnit;

        } else if (item.child_recipe_id && item.child_recipe) {
            const childResult = await calculateRecipeCost(item.child_recipe_id, depth + 1);
            if (!childResult.isAccurate) isAccurate = false;

            const childCostPerYieldUnit = childResult.costPerUnit;
            const conversionRate = convertUnit(1, item.unit, item.child_recipe.base_yield_unit, item.child_recipe.name);
            const usageInYieldUnits = Number(item.quantity) * conversionRate;
            lineCost = usageInYieldUnits * childCostPerYieldUnit;
        }

        totalCost += lineCost;
    }

    // Packaging Cost Calculation
    const containerType = (recipe as any).container_type || 'tray';
    const isFamily = recipe.name.toLowerCase().includes('family') || recipe.name.toLowerCase().includes('large');
    let packagingCost = 0;

    if (containerType === 'bag') {
        const bagName = isFamily ? 'Gallon' : 'Quart';
        const bag = packagingItems.find(p => p.name.includes(bagName) && (p.name.includes('Bag') || p.name.includes('Ziplock')));
        if (bag) packagingCost += Number(bag.cost_per_unit || 0);
    } else {
        const sizeName = isFamily ? 'Large' : 'Small';
        const container = packagingItems.find(p => p.name.includes(sizeName) && (p.name.includes('Tray') || p.name.includes('Container')));
        const lid = packagingItems.find(p => p.name.includes(sizeName) && p.name.includes('Lid'));
        if (container) packagingCost += Number(container.cost_per_unit || 0);
        if (lid) packagingCost += Number(lid.cost_per_unit || 0);
    }

    totalCost += packagingCost;

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
