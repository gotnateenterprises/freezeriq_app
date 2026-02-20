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

        const requiredNames = Object.keys(run.rawIngredients);
        if (requiredNames.length === 0) return { maxPossible: 0, limitingIngredient: "No Ingredients" };

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
        for (const [name, req] of Object.entries(run.rawIngredients)) {
            const stock = stockMap.get(name.toLowerCase()) || 0;
            const required = req.qty;

            if (required <= 0) continue;

            const possible = Math.floor(stock / required);
            if (possible < minRatio) {
                minRatio = possible;
                limiter = name;
            }
        }

        if (minRatio === Infinity) return { maxPossible: 0, limitingIngredient: "Unknown" };

        return {
            maxPossible: minRatio,
            limitingIngredient: limiter
        };
    }
}
