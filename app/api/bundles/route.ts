import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { calculateRecipeCost } from '@/lib/cost_engine';

export async function GET(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(req.url);
        const fullDetails = searchParams.get('full') === 'true';

        const bundles = await prisma.bundle.findMany({
            where: { business_id: session.user.businessId },
            include: {
                _count: {
                    select: { contents: true }
                },
                contents: {
                    include: {
                        recipe: { select: { id: true, sku: true, name: true } }
                    }
                }
            },
            orderBy: { name: 'asc' }
        });

        // Enrich with Financials
        const enriched = await Promise.all(bundles.map(async (b) => {
            // Calculate cost by summing recipe costs (same as editor)
            let baseCost = 0;
            for (const content of b.contents) {
                try {
                    const recipeCostResult = await calculateRecipeCost(content.recipe_id);
                    const quantity = Number(content.quantity) || 1;
                    baseCost += recipeCostResult.totalCost * quantity;
                } catch (e) {
                    console.error(`Failed to calculate cost for recipe ${content.recipe_id}:`, e);
                }
            }

            // Apply Serves 2 adjustment
            const tierLower = (b.serving_tier || '').toLowerCase();
            const isServes2 = tierLower.includes('couple') || tierLower.includes('serves 2') || tierLower === 'couple';
            const cost = isServes2 ? (baseCost / 5) * 2 : baseCost;

            // Use stored price if set, otherwise fallback to defaults
            const price = b.price ? Number(b.price) : (isServes2 ? 60.00 : 125.00);

            return {
                ...b,
                total_food_cost: cost,
                menu_price: price,
                food_cost_pct: price > 0 ? (cost / price) * 100 : 0,
                margin: price - cost
            };
        }));

        // If full export, include catalogs
        if (fullDetails) {
            const catalogs = await prisma.catalog.findMany({
                where: { business_id: session.user.businessId }
            });
            return NextResponse.json({
                bundles: enriched,
                catalogs
            });
        }

        return NextResponse.json(enriched);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const data = await req.json();

        // Basic Validation
        if (!data.name || !data.sku) {
            return NextResponse.json({ error: 'Name and SKU are required' }, { status: 400 });
        }

        // Create Bundle
        const bundle = await prisma.bundle.create({
            data: {
                name: data.name,
                sku: data.sku,
                description: data.description,
                serving_tier: data.serving_tier || 'family',
                is_active: data.is_active ?? true,
                show_on_storefront: data.show_on_storefront ?? false,
                order_cutoff_date: data.order_cutoff_date ? new Date(data.order_cutoff_date) : null,
                price: data.price ? Number(data.price) : null,
                catalog_id: data.catalog_id || null, // Added catalog_id
                business_id: session.user.businessId,
                is_donation: data.is_donation ?? false
            }
        });

        // 2. Handle Contents (If Importing)
        if (data.contents && Array.isArray(data.contents)) {
            for (const item of data.contents) {
                // We expect item to have a child_recipe SKU or ID
                // Ideally we match by SKU for portability
                let recipeId = item.recipe_id; // Direct ID (if same DB)

                // If we have a nested recipe object (from export), try to find by SKU
                if (!recipeId && item.child_recipe?.sku) {
                    const found = await prisma.recipe.findUnique({ where: { sku: item.child_recipe.sku } });
                    if (found) recipeId = found.id;
                }

                if (recipeId) {
                    await prisma.bundleContent.create({
                        data: {
                            bundle_id: bundle.id,
                            recipe_id: recipeId,
                            quantity: Number(item.quantity) || 1
                        }
                    });
                }
            }
        }

        return NextResponse.json(bundle);
    } catch (e: any) {
        if (e.code === 'P2002') {
            return NextResponse.json({ error: 'SKU must be unique' }, { status: 409 });
        }
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
