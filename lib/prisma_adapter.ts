import { DBAdapter } from './kitchen_engine';
import { prisma } from './db';
import { Recipe, Uuid, Bundle } from '../types';

export class PrismaAdapter implements DBAdapter {

    async getRecipe(id: Uuid): Promise<Recipe | null> {
        // Fetch from Postgres
        const recipe = await prisma.recipe.findUnique({
            where: { id },
            include: {
                parent_items: true,
                child_items: {
                    include: {
                        child_recipe: true,
                        child_ingredient: {
                            include: { supplier: true }
                        }
                    }
                }
            }
        });

        if (!recipe) return null;

        // Map Prisma Model to App Type
        return {
            id: recipe.id,
            name: recipe.name,
            type: recipe.type as 'prep' | 'menu_item',
            base_yield_qty: Number(recipe.base_yield_qty),
            base_yield_unit: recipe.base_yield_unit,
            // @ts-ignore
            category_id: recipe.category_id || undefined,
            items: recipe.child_items.map(item => ({
                id: item.id,
                parent_recipe_id: item.parent_recipe_id, // Added to match interface
                // Determine Logical Type/ID
                child_item_id: item.child_recipe_id || item.child_ingredient_id || '',
                child_type: item.child_recipe_id ? 'recipe' : 'ingredient',
                name: item.child_recipe?.name || item.child_ingredient?.name || 'Unknown Item',
                quantity: Number(item.quantity),
                unit: item.unit,
                supplier_name: item.child_ingredient?.supplier?.name,
                supplier_url: item.child_ingredient?.supplier?.website_url || undefined,
                stock_quantity: Number(item.child_ingredient?.stock_quantity) || 0,
                cost_per_unit: Number(item.child_ingredient?.cost_per_unit) || 0,
                cost_unit: item.child_ingredient?.unit, // Unit for the cost price
                sku: item.child_ingredient?.sku || undefined,
                purchase_cost: Number(item.child_ingredient?.purchase_cost) || undefined,
                purchase_unit: item.child_ingredient?.purchase_unit || undefined,
                purchase_quantity: Number(item.child_ingredient?.purchase_quantity) || undefined,

                // NEW
                is_sub_recipe: (item as any).is_sub_recipe || false,
                section_name: (item as any).section_name || undefined,
                section_batch: Number((item as any).section_batch) || 1
            })),
            // @ts-ignore
            label_text: recipe.label_text || undefined,
            // @ts-ignore
            allergens: recipe.allergens || undefined
        };
    }

    async getCategories() {
        // Fetch full tree - simplified to flat list for MVP, recursion handled by frontend or simple join
        // @ts-ignore - Prisma types might be stale in IDE but correct at runtime
        return await prisma.category.findMany({
            include: { children: { include: { children: true } } }
        });
    }

    async createCategory(data: { name: string; parent_id?: string | null }) {
        // @ts-ignore
        return await prisma.category.create({
            data: {
                name: data.name,
                parent_id: data.parent_id
            }
        });
    }

    async getBundleContents(bundleId: Uuid): Promise<{ recipe_id: Uuid; position: number; quantity?: number }[]> {
        // If ID starts with 'bun_comfort', for MVP demo we return ALL recipes if real bundle not found
        // But let's try to query first.
        try {
            const contents = await prisma.bundleContent.findMany({
                where: { bundle_id: bundleId }
            });

            if (contents.length > 0) {
                return contents.map(c => ({
                    recipe_id: c.recipe_id,
                    position: c.position || 0,
                    quantity: c.quantity || 1.0,
                    mult_serves_2: null,
                    mult_serves_5: null
                }));
            }
        } catch (e) { }

        // Fallback for Demo - REMOVED
        // If no contents, return empty.
        return [];
    }

    async getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string } | null> {
        const bundle = await prisma.bundle.findUnique({
            where: { id: bundleId },
            select: { serving_tier: true }
        });
        return bundle ? { serving_tier: bundle.serving_tier } : null;
    }
    async getBundles() {
        const bundles = await prisma.bundle.findMany({
            where: { is_active: true }
        });
        return bundles.map(b => ({
            ...b,
            price: b.price ? Number(b.price) : 0
        }));
    }

    async getOrders() {
        const orders = await prisma.order.findMany({
            orderBy: { created_at: 'desc' },
            include: {
                organization: true,
                items: {
                    include: { bundle: true }
                }
            }
        });

        return orders.map(o => {
            let sourceDisplay = 'Square';
            if (o.source === 'qbo') sourceDisplay = 'QB';
            // @ts-ignore - Manual not in generated types yet
            if (o.source === 'manual') sourceDisplay = 'Manual';

            return {
                id: o.external_id,
                date: o.created_at?.toLocaleDateString() || '',
                source: sourceDisplay,
                customer: o.organization?.name || o.customer_name || 'Unknown',
                // @ts-ignore
                type: o.source === 'qbo' ? 'Fundraiser' : (o.source === 'manual' ? 'Manual' : 'Meal Prep'),
                items: o.items.map(i => `${i.quantity}x ${i.bundle?.name || 'Unknown'}`).join(', ') || 'No Items',
                // @ts-ignore
                total: `$${Number(o.total_amount || 0).toFixed(2)}`,
                status: o.status === 'production_ready' ? 'Confirmed' : (o.status.charAt(0).toUpperCase() + o.status.slice(1)),
                customerId: o.organization?.id || (o.customer_name ? encodeURIComponent(o.customer_name) : undefined)
            };
        });
    }

    async getProductionOrders() {
        const orders = await prisma.order.findMany({
            where: {
                status: { in: ['pending', 'production_ready'] }
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        return orders.flatMap(o => o.items.map(item => ({
            bundle_id: item.bundle_id || '',
            quantity: item.quantity,
            variant_size: item.variant_size
        })).filter(i => i.bundle_id));
    }
}
