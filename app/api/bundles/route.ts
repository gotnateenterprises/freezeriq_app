import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { calculateRecipeCost } from '@/lib/cost_engine';
import {
    resolveBundleContents,
    isBundleContentsError,
    type ResolvedBundleContent,
} from '@/lib/bundleContents';

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

        // BUNDLE-PERSISTENCE-FIX. Resolve and validate the entire intended
        // recipe set BEFORE anything is written. This also carries the
        // BUNDLE-SECURITY-1 ownership guarantee: resolveBundleContents proves
        // every recipe belongs to this business, so a foreign recipe_id can
        // neither be attached nor leak its costs back through GET /api/bundles.
        let resolvedContents: ResolvedBundleContent[] = [];
        if (data.contents !== undefined) {
            try {
                resolvedContents = await resolveBundleContents(
                    prisma, data.contents, session.user.businessId
                );
            } catch (err) {
                if (isBundleContentsError(err)) {
                    return NextResponse.json({ error: err.message }, { status: err.status });
                }
                throw err;
            }
        }

        // Bundle and its contents commit together, so a failure part-way
        // through can no longer leave a bundle holding fewer recipes than the
        // caller asked for while the response still reports success.
        const bundle = await prisma.$transaction(async (tx) => {
            const created = await tx.bundle.create({
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
                    business_id: session.user.businessId
                }
            });

            if (resolvedContents.length > 0) {
                await tx.bundleContent.createMany({
                    data: resolvedContents.map((c) => ({ ...c, bundle_id: created.id }))
                });
            }

            return created;
        });

        return NextResponse.json(bundle);
    } catch (e: any) {
        if (e.code === 'P2002') {
            return NextResponse.json({ error: 'SKU must be unique' }, { status: 409 });
        }
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
