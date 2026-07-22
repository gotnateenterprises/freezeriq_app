
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * Safely coerce a JSONB field from $queryRaw into a plain JS array.
 * Postgres + Prisma can return JSONB columns as:
 *   - a pre-parsed JS array   → return as-is
 *   - a JSON string           → parse it; return the array or []
 *   - null / undefined        → return []
 *   - any other value         → return []
 * This helper never throws.
 */
function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            // Not valid JSON — fall through to []
        }
    }
    return [];
}

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
            return NextResponse.json({
                error: 'Business not found'
            }, { status: 404 });
        }

        console.log(`[Storefront API] Found business: ${business.name} (${business.id})`);

        // 2. Fetch Bundles with full recipe metadata, categories, and ingredient items via Prisma.
        // Phase 6E-1: replaced all $queryRawUnsafe blocks — order_cutoff_date, image_url,
        // description, cook_time, container_type, base_yield_qty/unit, categories, and
        // child ingredient items are now fetched inline through standard Prisma includes/selects.
        const bundlesWithRecipes = await prisma.bundle.findMany({
            where: {
                business_id: business.id,
                show_on_storefront: true
            },
            include: {
                contents: {
                    include: {
                        recipe: {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                image_url: true,
                                description: true,
                                cook_time: true,
                                container_type: true,
                                base_yield_qty: true,
                                base_yield_unit: true,
                                categories: {
                                    select: { name: true }
                                },
                                child_items: {
                                    where: { child_ingredient_id: { not: null } },
                                    include: {
                                        child_ingredient: {
                                            select: { name: true }
                                        }
                                    },
                                    orderBy: { id: 'asc' }
                                }
                            }
                        }
                    },
                    orderBy: { position: 'asc' }
                }
            }
        });

        // 3. Build recipeMetadata and bundleCutoffs maps from Prisma results — no raw SQL needed.
        const bundleCutoffs: Record<string, string | null> = {};
        const recipeMetadata: Record<string, any> = {};

        for (const bundle of bundlesWithRecipes) {
            // order_cutoff_date is now a standard Prisma field
            bundleCutoffs[bundle.id] = bundle.order_cutoff_date
                ? bundle.order_cutoff_date.toISOString().split('T')[0]
                : null;

            for (const content of bundle.contents) {
                const r = content.recipe;
                if (!r || recipeMetadata[r.id]) continue; // skip nulls and duplicates

                recipeMetadata[r.id] = {
                    image_url: r.image_url,
                    description: r.description,
                    yield_qty: Number(r.base_yield_qty),
                    yield_unit: r.base_yield_unit,
                    cook_time: r.cook_time,
                    container_type: r.container_type,
                    categories: r.categories.map((c: { name: string }) => c.name),
                    items: r.child_items
                        .filter((item: any) => item.child_ingredient)
                        .map((item: any) => ({
                            name: item.child_ingredient.name,
                            quantity: Number(item.quantity),
                            unit: item.unit
                        }))
                };
            }
        }
        console.log(`[Storefront API] Metadata ready for ${Object.keys(recipeMetadata).length} recipes`);

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
                   upsell_type, manual_upsell_name, manual_upsell_price, manual_upsell_image,
                   tax_percent, delivery_fee, is_delivery_enabled, is_pickup_enabled, origin_address, id
            FROM storefront_configs
            WHERE business_id = ${business.id}
            LIMIT 1
        `;

        const storefrontConfig = storefrontConfigs[0] || null;

        // 6b. Normalize JSONB array fields in storefrontConfig.
        // $queryRaw can return JSONB columns as strings, pre-parsed objects, or null
        // depending on the Postgres driver version. toArray() handles all cases safely.
        if (storefrontConfig) {
            storefrontConfig.testimonials = toArray(storefrontConfig.testimonials);
            storefrontConfig.trust_badges = toArray(storefrontConfig.trust_badges);
        }

        // 6c. Fetch delivery zones for this storefront config
        if (storefrontConfig?.id) {
            const zones: any[] = await prisma.$queryRaw`
                SELECT id, name, max_radius_miles, fee
                FROM delivery_zones
                WHERE storefront_config_id = ${storefrontConfig.id}
                ORDER BY max_radius_miles ASC
            `;
            storefrontConfig.delivery_zones = zones;
            delete storefrontConfig.id; // Don't expose internal ID to client
        }

        // Ensure bundlesWithRecipes is always an array before mapping
        const safeBundlesRaw: any[] = Array.isArray(bundlesWithRecipes) ? bundlesWithRecipes : [];

        // Ensure fundraisers is always an array before mapping
        const safeFundraisersRaw: any[] = Array.isArray(fundraisers) ? fundraisers : [];

        return NextResponse.json({
            business: {
                id: business.id,
                name: business.name,
                slug: business.slug,
                branding,
                storefrontConfig
            },
            bundles: safeBundlesRaw.map((b: any) => {
                const tierLower = (b.serving_tier || '').toLowerCase();
                const isServes2 = tierLower.includes('couple') || tierLower.includes('serves 2') || tierLower === 'couple';
                const price = b.price ? Number(b.price) : (isServes2 ? 60.00 : 125.00);

                const safeContents: any[] = Array.isArray(b.contents) ? b.contents : [];
                return {
                    ...b,
                    price,
                    // SF-3: explicit, contractual family pairing key for the storefront
                    // Serves-5/Serves-2 single-card presentation. Real nullable DB value,
                    // no derivation — additive to the existing response shape.
                    family_id: b.family_id ?? null,
                    order_cutoff_date: bundleCutoffs[b.id] || null,
                    stock_on_hand: Number(b.stock_on_hand),
                    contents: safeContents.map((c: any) => ({
                        ...c,
                        recipe: {
                            ...c.recipe,
                            ...(recipeMetadata[c.recipe?.id] || {})
                        }
                    }))
                };
            }),
            fundraisers: safeFundraisersRaw.map(f => ({
                ...f,
                customer: { name: f.customer_name }
            }))
        });

    } catch (error: any) {
        console.error('Public API Error:', error);
        return NextResponse.json({
            error: 'Internal Server Error',
            details: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}
