
import { PrismaClient } from '@prisma/client';
import { KitchenEngine } from './kitchen_engine';
import { PrismaAdapter } from './prisma_adapter';

const prisma = new PrismaClient();
const adapter = new PrismaAdapter();
const kitchen = new KitchenEngine(adapter);

export class InventoryEngine {

    /**
     * Calculates the maximum number of bundles that can be produced
     * based on current ingredient stock.
     */
    async calculateMaxBundles(bundleId: string, variant: 'serves_2' | 'serves_5'): Promise<{
        maxPossible: number,
        limitingIngredient: string | null
    }> {
        // 1. "Explode" a single unit of this bundle to get raw requirements
        // We simulate an order of Qty: 1
        const run = await kitchen.generateProductionRun([
            { bundle_id: bundleId, quantity: 1, variant_size: variant }
        ]);

        let minRatio = Infinity;
        let limiter = null;

        // 2. Iterate through all required ingredients
        for (const [name, req] of Object.entries(run.rawIngredients)) {
            // Find the ingredient in DB to get stock
            // Note: In a real app we'd query all at once, loop for now
            const ingredient = await prisma.ingredient.findFirst({
                where: { name: { equals: name, mode: 'insensitive' } }
            });

            if (!ingredient) {
                console.warn(`Ingredient not found for inventory check: ${name}`);
                continue; // Can't limit what we don't track
            }

            const stock = Number(ingredient.stock_quantity);
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
