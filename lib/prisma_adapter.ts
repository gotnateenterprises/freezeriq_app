import { DBAdapter } from './kitchen_engine';
import { prisma } from './db';
import { Recipe, Uuid, Bundle } from '../types';
import { PRODUCTION_INTAKE_STATUSES, PRODUCTION_ORDER_EXCLUSIONS } from './productionIntake';

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
                is_sub_recipe: item.is_sub_recipe || false,
                section_name: item.section_name || undefined,
                section_batch: Number(item.section_batch) || 1
            })),
            label_text: recipe.label_text || undefined,
            macros: recipe.macros || undefined,
            image_url: recipe.image_url || undefined,
            description: recipe.description || undefined,
            allergens: recipe.allergens || undefined,
            cook_time: recipe.cook_time || undefined
        }));
    }

    async getRecipe(id: Uuid): Promise<Recipe | null> {
        const recipe = await prisma.recipe.findFirst({
            where: { id, business_id: this.businessId },
            include: {
                categories: true,
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
            categories: recipe.categories.map(c => ({ id: c.id, name: c.name })),
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
                is_sub_recipe: item.is_sub_recipe || false,
                section_name: item.section_name || undefined,
                section_batch: Number(item.section_batch) || 1
            })),
            label_text: recipe.label_text || undefined,
            macros: recipe.macros || undefined,
            image_url: recipe.image_url || undefined,
            description: recipe.description || undefined,
            allergens: recipe.allergens || undefined,
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
            where: {
                business_id: this.businessId,
                // Exclude ALL fundraiser coordinator orders — both new (fundraiser_hold)
                // and historical (pending/completed). They belong in the Fundraiser Dashboard.
                status: { not: 'fundraiser_hold' as any },
                source: { not: 'fundraiser' as any },
                // Exclude abandoned storefront checkout attempts (Stripe pre-payment
                // placeholders that were never paid). Manual/Square/QB pending orders
                // are intentionally preserved for the offline "Mark Paid" workflow.
                NOT: {
                    source: 'storefront',
                    status: 'pending'
                }
            },
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
        // Phase 5G-2: the canonical -> stored status mapping (so legacy
        // IN_PRODUCTION and APPROVED rows still match) is owned by
        // lib/orderStatus.ts and re-exported, already deduplicated, as
        // PRODUCTION_INTAKE_STATUSES by lib/productionIntake.ts.
        //
        // FULFILLMENT-CONTINUITY-1: the status set and the two exclusions below
        // now come from that shared module rather than being rebuilt here. The
        // values are unchanged — this is the same list this method already
        // built inline, and the same AND-array the Kitchen Board carries.
        const orders = await prisma.order.findMany({
            where: {
                // ── OPS-3 CORRECTION: two exclusions, both COPIED from the
                //    Kitchen Board (app/api/production/dashboard/route.ts),
                //    which has always carried them on all three of its lanes.
                //    This query is the OTHER definition of "visible to
                //    production" — it feeds /sync (Manual Planner), /plan
                //    (ingredient demand) and /runs (a PERSISTED ProductionRun) —
                //    and it disagreed with the board on both points.
                //
                //    Neither rule is invented here; this makes the second
                //    intake path agree with the first.
                //
                //    1. fundraiser_hold is an ABSOLUTE hold. OPS-3 releases a
                //       campaign's orders only when its invoice is authoritatively
                //       PAID (the settle route promotes them to production_ready).
                //       Without this line the `customer.status = 'PRODUCTION'`
                //       branch below — which asserts nothing about the ORDER —
                //       silently bypassed that gate: PRODUCTION is an ordinary
                //       CRM pipeline stage (STATUS_FLOW: ACTIVE -> PRODUCTION),
                //       reachable manually or by progressStatus() on a sent
                //       email, and a fundraiser organization is an ordinary
                //       Customer row. Parking one there made every unpaid held
                //       order it owns eligible for the kitchen.
                //
                //    2. A canceled order is never cooked. HoldingArea's cancel
                //       is a soft delete (canceled_at) with a restore path; the
                //       board excludes such rows everywhere, this did not.
                //
                //    The `customer.status = 'PRODUCTION'` compatibility branch
                //    is deliberately KEPT. It is what makes an otherwise
                //    ineligible order of a customer parked at that stage visible,
                //    and ordinary-customer behaviour that depends on it is
                //    proven unchanged in tests/ops3ProductionIntakeHold.test.ts.
                //    It is narrowed by ORDER state, not removed.
                business_id: this.businessId,
                canceled_at: null,
                OR: [
                    { status: { in: [...PRODUCTION_INTAKE_STATUSES] as any } },
                    { customer: { status: 'PRODUCTION' } }
                ],
                AND: [...PRODUCTION_ORDER_EXCLUSIONS]
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
