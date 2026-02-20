import { DBAdapter } from './kitchen_engine';
import { prisma } from './db';
import { Recipe, Uuid, Bundle } from '../types';

export class PrismaAdapter implements DBAdapter {
    private businessId: string;

    constructor(businessId: string) {
        this.businessId = businessId;
    }

    async getAllRecipes(): Promise<Recipe[]> {
        const recipes = await prisma.recipe.findMany({
            where: { business_id: this.businessId },
            include: {
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

        return recipes.map(recipe => ({
            id: recipe.id,
            name: recipe.name,
            type: recipe.type as 'prep' | 'menu_item',
            base_yield_qty: Number(recipe.base_yield_qty),
            base_yield_unit: recipe.base_yield_unit,
            container_type: recipe.container_type as 'tray' | 'bag',
            category_id: recipe.category_id || undefined,
            items: recipe.child_items.map(item => ({
                id: item.id,
                parent_recipe_id: item.parent_recipe_id,
                child_item_id: item.child_recipe_id || item.child_ingredient_id || '',
                child_type: item.child_recipe_id ? 'recipe' : 'ingredient',
                name: item.child_recipe?.name || item.child_ingredient?.name || 'Unknown Item',
                quantity: Number(item.quantity),
                unit: item.unit,
                supplier_name: item.child_ingredient?.supplier?.name,
                supplier_url: item.child_ingredient?.supplier?.website_url || undefined,
                stock_quantity: Number(item.child_ingredient?.stock_quantity) || 0,
                cost_per_unit: Number(item.child_ingredient?.cost_per_unit) || 0,
                cost_unit: item.child_ingredient?.unit,
                sku: item.child_ingredient?.sku || undefined,
                purchase_cost: Number(item.child_ingredient?.purchase_cost) || undefined,
                purchase_unit: item.child_ingredient?.purchase_unit || undefined,
                purchase_quantity: Number(item.child_ingredient?.purchase_quantity) || undefined,
                portal_type: item.child_ingredient?.supplier?.portal_type || undefined,
                search_url_pattern: item.child_ingredient?.supplier?.search_url_pattern || undefined,
                is_sub_recipe: (item as any).is_sub_recipe || false,
                section_name: (item as any).section_name || undefined,
                section_batch: Number((item as any).section_batch) || 1
            })),
            label_text: recipe.label_text || undefined,
            macros: recipe.macros || undefined,
            // @ts-ignore
            image_url: recipe.image_url || undefined,
            // @ts-ignore
            description: recipe.description || undefined,
            // @ts-ignore
            allergens: recipe.allergens || undefined,
            // @ts-ignore
            cook_time: recipe.cook_time || undefined
        }));
    }

    async getRecipe(id: Uuid): Promise<Recipe | null> {
        const recipe = await prisma.recipe.findFirst({
            where: { id, business_id: this.businessId },
            include: {
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

        return {
            id: recipe.id,
            name: recipe.name,
            type: recipe.type as 'prep' | 'menu_item',
            base_yield_qty: Number(recipe.base_yield_qty),
            base_yield_unit: recipe.base_yield_unit,
            container_type: recipe.container_type as 'tray' | 'bag',
            category_id: recipe.category_id || undefined,
            items: recipe.child_items.map(item => ({
                id: item.id,
                parent_recipe_id: item.parent_recipe_id,
                child_item_id: item.child_recipe_id || item.child_ingredient_id || '',
                child_type: item.child_recipe_id ? 'recipe' : 'ingredient',
                name: item.child_recipe?.name || item.child_ingredient?.name || 'Unknown Item',
                quantity: Number(item.quantity),
                unit: item.unit,
                supplier_name: item.child_ingredient?.supplier?.name,
                supplier_url: item.child_ingredient?.supplier?.website_url || undefined,
                stock_quantity: Number(item.child_ingredient?.stock_quantity) || 0,
                cost_per_unit: Number(item.child_ingredient?.cost_per_unit) || 0,
                cost_unit: item.child_ingredient?.unit,
                sku: item.child_ingredient?.sku || undefined,
                purchase_cost: Number(item.child_ingredient?.purchase_cost) || undefined,
                purchase_unit: item.child_ingredient?.purchase_unit || undefined,
                purchase_quantity: Number(item.child_ingredient?.purchase_quantity) || undefined,
                portal_type: item.child_ingredient?.supplier?.portal_type || undefined,
                search_url_pattern: item.child_ingredient?.supplier?.search_url_pattern || undefined,
                is_sub_recipe: (item as any).is_sub_recipe || false,
                section_name: (item as any).section_name || undefined,
                section_batch: Number((item as any).section_batch) || 1
            })),
            label_text: recipe.label_text || undefined,
            macros: recipe.macros || undefined,
            // @ts-ignore
            image_url: recipe.image_url || undefined,
            // @ts-ignore
            description: recipe.description || undefined,
            // @ts-ignore
            allergens: recipe.allergens || undefined,
            // @ts-ignore
            cook_time: recipe.cook_time || undefined
        };
    }

    async getCategories() {
        return await prisma.category.findMany({
            where: { business_id: this.businessId },
            include: { children: { include: { children: true } } }
        });
    }

    async createCategory(data: { name: string; parent_id?: string | null }) {
        return await prisma.category.create({
            data: {
                name: data.name,
                parent_id: data.parent_id,
                business_id: this.businessId
            }
        });
    }

    async getBundleContents(bundleId: Uuid): Promise<{ recipe_id: Uuid; position: number; quantity?: number }[]> {
        try {
            const contents = await prisma.bundleContent.findMany({
                where: { bundle_id: bundleId }
            });

            if (contents.length > 0) {
                return contents.map(c => ({
                    recipe_id: c.recipe_id,
                    position: c.position || 0,
                    quantity: c.quantity || 1.0
                }));
            }
        } catch (e) { }
        return [];
    }

    async getBundleInfo(bundleId: Uuid): Promise<{ serving_tier: string } | null> {
        const bundle = await prisma.bundle.findFirst({
            where: {
                id: bundleId,
                business_id: this.businessId
            },
            select: { serving_tier: true }
        });
        return bundle ? { serving_tier: bundle.serving_tier } : null;
    }

    async getBundles() {
        const bundles = await prisma.bundle.findMany({
            where: {
                is_active: true,
                business_id: this.businessId
            }
        });
        return bundles.map((b: any) => ({
            ...b,
            price: b.price ? Number(b.price) : 0,
            stock_on_hand: Number(b.stock_on_hand || 0)
        }));
    }

    async getOrders() {
        const orders = await prisma.order.findMany({
            where: { business_id: this.businessId },
            orderBy: { created_at: 'desc' },
            include: {
                customer: true,
                items: {
                    include: { bundle: true }
                }
            }
        });

        return orders.map(o => {
            let sourceDisplay = 'Square';
            if (o.source === 'qbo') sourceDisplay = 'QB';
            if (o.source === 'manual') sourceDisplay = 'Manual';

            return {
                id: o.external_id,
                internalId: o.id,
                date: o.created_at?.toLocaleDateString() || '',
                source: sourceDisplay,
                customer: o.customer?.name || o.customer_name || 'Unknown',
                customerEmail: o.customer?.contact_email || '',
                type: o.source === 'qbo' ? 'Fundraiser' : (o.source === 'manual' ? 'Manual' : 'Meal Prep'),
                items: o.items.map(i => `${i.quantity}x ${i.bundle?.name || 'Unknown'}`).join(', ') || 'No Items',
                total: `$${Number(o.total_amount || 0).toFixed(2)}`,
                status: o.status === 'production_ready' ? 'Confirmed' : (o.status.charAt(0).toUpperCase() + o.status.slice(1)),
                rawStatus: o.status,
                customerId: o.customer?.id || (o.customer_name ? encodeURIComponent(o.customer_name) : undefined)
            };
        });
    }

    async getProductionOrders() {
        const orders = await prisma.order.findMany({
            where: {
                OR: [
                    { status: { in: ['pending', 'production_ready', 'APPROVED', 'IN_PRODUCTION'] as any } },
                    { customer: { status: 'PRODUCTION' } }
                ],
                business_id: this.businessId
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        }) as any[];

        return orders.flatMap(o => o.items.map((item: any) => ({
            bundle_id: item.bundle_id || '',
            quantity: item.quantity,
            variant_size: item.variant_size
        })).filter((i: any) => i.bundle_id));
    }
}
