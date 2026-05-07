import { prisma } from './db';
import { KitchenEngine } from './kitchen_engine';
import { PrismaAdapter } from './prisma_adapter';

export class InventoryEngine {
    private kitchen: KitchenEngine;

    constructor(businessId: string) {
        const adapter = new PrismaAdapter(businessId);
        this.kitchen = new KitchenEngine(adapter);
    }

    /**
     * Calculates the maximum number of bundles that can be produced
     * based on current ingredient stock.
     */
    async calculateMaxBundles(bundleId: string, variant: 'serves_2' | 'serves_5'): Promise<{
        maxPossible: number,
        limitingIngredient: string | null
    }> {
        // 1. "Explode" the bundle in memory
        const run = await this.kitchen.generateProductionRun([
            { bundle_id: bundleId, quantity: 1, variant_size: variant }
        ]);

        // Step 2 compatibility: rawIngredients keys are now stable IDs (UUIDs), not names.
        // Extract display names from values for the Prisma query.
        const ingredientEntries = Object.entries(run.rawIngredients) as [string, any][];
        if (ingredientEntries.length === 0) return { maxPossible: 0, limitingIngredient: "No Ingredients" };

        const requiredNames = ingredientEntries.map(([_, val]) => val.displayName || '').filter(Boolean);

        // 2. Batch Fetch all required ingredients
        const ingredients = await prisma.ingredient.findMany({
            where: {
                name: { in: requiredNames, mode: 'insensitive' }
            }
        });

        const stockMap = new Map(ingredients.map(i => [i.name.toLowerCase(), Number(i.stock_quantity)]));

        let minRatio = Infinity;
        let limiter = null;

        // 3. Compare requirements vs batch-fetched stock
        for (const [_id, req] of ingredientEntries) {
            const displayName = (req as any).displayName || '';
            const stock = stockMap.get(displayName.toLowerCase()) || 0;
            const required = (req as any).qty;

            if (required <= 0) continue;

            const possible = Math.floor(stock / required);
            if (possible < minRatio) {
                minRatio = possible;
                limiter = displayName;
            }
        }

        if (minRatio === Infinity) return { maxPossible: 0, limitingIngredient: "Unknown" };

        return {
            maxPossible: minRatio,
            limitingIngredient: limiter
        };
    }
}
