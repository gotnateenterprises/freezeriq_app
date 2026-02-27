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

    /**
     * Deducts inventory for an entire order to finalize the ERP lifecycle.
     */
    async deductOrderInventory(orderId: string): Promise<void> {
        const order = await prisma.order.findUnique({
            where: { id: orderId },
            include: { items: true }
        });

        if (!order) throw new Error("Order not found");
        if (order.inventory_deducted) {
            console.log(`Order ${orderId} inventory already deducted. Skipping.`);
            return;
        }

        const runItems = order.items
            .filter(i => i.bundle_id)
            .map(i => ({
                bundle_id: i.bundle_id!,
                quantity: i.quantity,
                variant_size: i.variant_size as any,
                item_name: i.item_name
            }));

        if (runItems.length === 0) return;

        // Use the Kitchen Engine to trace the exact deep raw math footprint of this order
        const run = await this.kitchen.generateProductionRun(runItems);

        const updatePromises: any[] = [];

        // Apply atomic stock decrements for matched raw ingredients
        for (const ing of Object.values(run.rawIngredients)) {
            // Safety check: skip if id is missing or quantity is zero/negative
            if (!ing.id || Number(ing.qty) <= 0) continue;

            updatePromises.push(
                prisma.ingredient.update({
                    where: { id: ing.id as string },
                    data: { stock_quantity: { decrement: ing.qty } }
                })
            );
        }

        // Apply atomic stock decrements for Packaging Items (Trays, Lids, Ziplocs) based on assembly tasks
        // Fetch packaging items to match by name pattern
        const packagingItems = await prisma.packagingItem.findMany({
            where: { business_id: order.business_id! }
        });

        // Track how many of each packaging item we need to deduct
        const packagingDeductions = new Map<string, number>();

        for (const task of Object.values(run.assemblyTasks)) {
            if (task.qty <= 0) continue;

            // Re-fetch recipe from DB to check container_type since it's missing from the basic task output
            const recipe = await prisma.recipe.findUnique({
                where: { id: task.id },
                select: { container_type: true }
            });
            const containerType = recipe?.container_type || 'tray';
            const isFamily = task.variant.toLowerCase().includes('family');

            if (containerType === 'bag') {
                const bagName = isFamily ? 'Gallon' : 'Quart';
                const bag = packagingItems.find(p => p.name.includes(bagName) && (p.name.includes('Bag') || p.name.includes('Ziplock')));
                if (bag) {
                    packagingDeductions.set(bag.id, (packagingDeductions.get(bag.id) || 0) + task.qty);
                }
            } else {
                const sizeName = isFamily ? 'Large' : 'Small';
                const container = packagingItems.find(p => p.name.includes(sizeName) && (p.name.includes('Tray') || p.name.includes('Container')));
                const lid = packagingItems.find(p => p.name.includes(sizeName) && p.name.includes('Lid'));

                if (container) packagingDeductions.set(container.id, (packagingDeductions.get(container.id) || 0) + task.qty);
                if (lid) packagingDeductions.set(lid.id, (packagingDeductions.get(lid.id) || 0) + task.qty);
            }
        }

        for (const [pkgId, qtyToDeduct] of Array.from(packagingDeductions.entries())) {
            updatePromises.push(
                prisma.packagingItem.update({
                    where: { id: pkgId },
                    data: { quantity: { decrement: qtyToDeduct } }
                })
            );
        }

        // Apply safety lock to the order to prevent double-counting later
        updatePromises.push(
            prisma.order.update({
                where: { id: orderId },
                data: { inventory_deducted: true }
            })
        );

        await prisma.$transaction(updatePromises);
    }
}
