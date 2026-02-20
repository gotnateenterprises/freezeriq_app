
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ slug: string }> }
) {
    const { slug } = await params;

    try {
        console.log(`[Storefront API] Attempting lookup for slug: "${slug}"`);

        // 1. Fetch Business by slug (using findFirst with mode insensitive for robustness)
        const business = await prisma.business.findFirst({
            where: {
                slug: {
                    equals: slug.toLowerCase().trim(),
                    mode: 'insensitive'
                }
            },
            select: { id: true, name: true, slug: true, logo_url: true }
        });

        if (!business) {
            console.log(`[Storefront API] Business not found for slug: "${slug}"`);
            const allBusinesses = await prisma.business.findMany({
                select: { name: true, slug: true },
                take: 5
            });
            return NextResponse.json({
                error: 'Business not found',
                attempted_slug: slug,
                available_shops: allBusinesses
            }, { status: 404 });
        }

        console.log(`[Storefront API] Found business: ${business.name} (${business.id})`);

        // 2. Fetch Bundles using Prisma (avoiding image_url for now to prevent crash if not generated)
        const bundlesWithRecipes = await prisma.bundle.findMany({
            where: {
                business_id: business.id,
                show_on_storefront: true
            } as any,
            include: {
                contents: {
                    include: {
                        recipe: {
                            select: { id: true, name: true, sku: true }
                        }
                    },
                    orderBy: { position: 'asc' }
                }
            } as any
        });

        // 3. Manually fetch recipe images using Parameterized Raw SQL (Safe)
        // We use Raw SQL because Prisma Client is stale and missing 'image_url' field
        const recipeIds = Array.from(new Set((bundlesWithRecipes as any[]).flatMap(b => b.contents.map((c: any) => c.recipe?.id)).filter(Boolean)));
        let recipeMetadata: Record<string, any> = {};

        // ALSO fetch bundle order_cutoff_date manually since Prisma client might omit it while locked
        const bundleIds = bundlesWithRecipes.map((b: any) => b.id);
        const bundlePlaceholders = bundleIds.map((_, i) => `$${i + 1}`).join(',');
        let bundleCutoffs: Record<string, string | null> = {};

        if (bundleIds.length > 0) {
            const rawBundles: any[] = await prisma.$queryRawUnsafe(
                `SELECT id, order_cutoff_date FROM bundles WHERE id IN (${bundlePlaceholders})`,
                ...bundleIds
            );
            rawBundles.forEach(rb => {
                bundleCutoffs[rb.id] = rb.order_cutoff_date || null;
            });
        }
        if (recipeIds.length > 0) {
            // SAFE: IDs are passed as parameters, placeholders are indices
            const placeholders = recipeIds.map((_, i) => `$${i + 1}`).join(',');
            const recipesRaw: any[] = await prisma.$queryRawUnsafe(
                `SELECT id, image_url, base_yield_qty, base_yield_unit, cook_time, container_type, description FROM recipes WHERE id IN (${placeholders})`,
                ...recipeIds
            );

            // Fetch categories for each recipe
            const recipeCategories: any[] = await prisma.$queryRawUnsafe(
                `SELECT rto."A" as category_id, rto."B" as recipe_id, c.name as category_name
                 FROM "_CategoryToRecipe" rto
                 JOIN categories c ON rto."A" = c.id
                 WHERE rto."B" IN (${placeholders})`,
                ...recipeIds
            );

            const recipeCategoriesMap: Record<string, string[]> = {};
            recipeCategories.forEach(rc => {
                if (!recipeCategoriesMap[rc.recipe_id]) recipeCategoriesMap[rc.recipe_id] = [];
                recipeCategoriesMap[rc.recipe_id].push(rc.category_name);
            });

            // Fetch recipe items (ingredients) for these recipes
            console.log(`[Storefront API] Fetching recipe items for ${recipeIds.length} recipes`);
            const recipeItems: any[] = await prisma.$queryRawUnsafe(
                `SELECT ri.parent_recipe_id as recipe_id, ri.quantity, ri.unit, i.name as ingredient_name 
                 FROM recipe_items ri
                 JOIN ingredients i ON ri.child_ingredient_id = i.id
                 WHERE ri.parent_recipe_id IN (${placeholders})`,
                ...recipeIds
            );

            const recipeItemsMap: Record<string, any[]> = {};
            recipeItems.forEach(item => {
                if (!recipeItemsMap[item.recipe_id]) recipeItemsMap[item.recipe_id] = [];
                recipeItemsMap[item.recipe_id].push({
                    name: item.ingredient_name,
                    quantity: Number(item.quantity),
                    unit: item.unit
                });
            });

            recipesRaw.forEach(img => {
                recipeMetadata[img.id] = {
                    image_url: img.image_url,
                    description: img.description,
                    yield_qty: Number(img.base_yield_qty),
                    yield_unit: img.base_yield_unit,
                    cook_time: img.cook_time,
                    container_type: img.container_type,
                    categories: recipeCategoriesMap[img.id] || [],
                    items: recipeItemsMap[img.id] || []
                };
            });
            console.log(`[Storefront API] Metadata ready for ${Object.keys(recipeMetadata).length} recipes`);
        }

        // 4. Fetch Active Fundraisers
        console.log(`[Storefront API] Fetching active fundraisers for business ${business.id}`);
        const fundraisers: any[] = await prisma.$queryRaw`
            SELECT fc.id, fc.name, fc.about_text, fc.mission_text, fc.payment_instructions, 
                   fc.external_payment_link, fc.end_date, fc.goal_amount, fc.total_sales,
                   fc.participant_label,
                   c.name as customer_customer_name
            FROM fundraiser_campaigns fc
            JOIN customers c ON fc.customer_id = c.id
            WHERE c.business_id = ${business.id}
            AND fc.status = 'ACTIVE'
            AND fc.end_date >= CURRENT_TIMESTAMP
        `;
        // Handle potential column name mismatch in raw query
        fundraisers.forEach(f => {
            if (f.customer_customer_name) f.customer_name = f.customer_customer_name;
        });

        // 5. Fetch Branding: "Last Edit Wins" Strategy
        // Find ALL admins/chefs for this business, order by who updated branding last
        const brandingRecords: any[] = await prisma.$queryRaw`
            SELECT b.* 
            FROM tenant_branding b
            JOIN users u ON b.user_id = u.id
            WHERE u.business_id = ${business.id}
            AND u.role IN ('ADMIN', 'CHEF')
            ORDER BY b.updated_at DESC
            LIMIT 1
        `;

        const branding = brandingRecords[0] || {
            business_name: business.name,
            primary_color: '#10b981',
            secondary_color: '#6366f1',
            accent_color: '#f59e0b',
            tagline: 'Intelligence for your Kitchen.',
            logo_url: business.logo_url
        };


        // 6. Fetch Storefront Config (Raw SQL to bypass Client field missing error)
        const storefrontConfigs: any[] = await prisma.$queryRaw`
            SELECT hero_headline, hero_subheadline, hero_image_url, our_story_headline, our_story_content,
                   how_it_works_content, footer_text, marketing_video_url, trust_badges, testimonials,
                   upsell_bundle_id, upsell_title, upsell_description, upsell_discount_percent,
                   upsell_type, manual_upsell_name, manual_upsell_price, manual_upsell_image
            FROM storefront_configs
            WHERE business_id = ${business.id}
            LIMIT 1
        `;

        const storefrontConfig = storefrontConfigs[0] || null;

        return NextResponse.json({
            business: {
                id: business.id,
                name: business.name,
                slug: business.slug,
                branding,
                storefrontConfig // Add to response
            },
            bundles: bundlesWithRecipes.map((b: any) => {
                const tierLower = (b.serving_tier || '').toLowerCase();
                const isServes2 = tierLower.includes('couple') || tierLower.includes('serves 2') || tierLower === 'couple';
                const price = b.price ? Number(b.price) : (isServes2 ? 60.00 : 125.00);

                return {
                    ...b,
                    price,
                    order_cutoff_date: bundleCutoffs[b.id] || null,
                    stock_on_hand: Number(b.stock_on_hand),
                    contents: b.contents.map((c: any) => ({
                        ...c,
                        recipe: {
                            ...c.recipe,
                            ...(recipeMetadata[c.recipe?.id] || {})
                        }
                    }))
                };
            }),
            fundraisers: fundraisers.map(f => ({
                ...f,
                customer: { name: f.customer_name }
            }))
        });

    } catch (error: any) {
        console.error('Public API Error:', error);
        return NextResponse.json({
            error: 'Internal Server Error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }, { status: 500 });
    }
}
