
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const data = await req.json();
        const { bundles = [], catalogs = [] } = data;
        const businessId = session.user.businessId;

        const results = {
            catalogsCreated: 0,
            catalogsUpdated: 0,
            bundlesCreated: 0,
            bundlesUpdated: 0
        };

        // 1. Process Catalogs
        const catalogMap = new Map<string, string>(); // Old ID -> New ID

        for (const cat of catalogs) {
            // Try formatting dates
            const startDate = cat.start_date ? new Date(cat.start_date) : new Date();
            const endDate = cat.end_date ? new Date(cat.end_date) : new Date();

            // Check existence by name
            const existing = await prisma.catalog.findFirst({
                where: { business_id: businessId, name: cat.name }
            });

            if (existing) {
                // Update
                await prisma.catalog.update({
                    where: { id: existing.id },
                    data: {
                        start_date: startDate,
                        end_date: endDate,
                        is_active: cat.is_active
                    }
                });
                catalogMap.set(cat.id, existing.id);
                results.catalogsUpdated++;
            } else {
                // Create
                const newCat = await prisma.catalog.create({
                    data: {
                        name: cat.name,
                        start_date: startDate,
                        end_date: endDate,
                        is_active: cat.is_active,
                        business_id: businessId
                    }
                });
                catalogMap.set(cat.id, newCat.id);
                results.catalogsCreated++;
            }
        }

        // 2. Process Bundles
        for (const bundle of bundles) {
            // Map Catalog ID
            const newCatalogId = bundle.catalog_id && catalogMap.has(bundle.catalog_id)
                ? catalogMap.get(bundle.catalog_id)
                : null;

            // Check existence by name (or SKU)
            let existing = await prisma.bundle.findFirst({
                where: { business_id: businessId, name: bundle.name }
            });

            if (!existing && bundle.sku) {
                existing = await prisma.bundle.findUnique({
                    where: { sku: bundle.sku }
                });
            }

            if (existing) {
                // Update basic fields
                await prisma.bundle.update({
                    where: { id: existing.id },
                    data: {
                        description: bundle.description,
                        price: Number(bundle.menu_price || bundle.price || 0),
                        serving_tier: bundle.serving_tier,
                        is_active: bundle.is_active,
                        catalog_id: newCatalogId
                    }
                });
                results.bundlesUpdated++;
            } else {
                // Create
                existing = await prisma.bundle.create({
                    data: {
                        name: bundle.name,
                        sku: bundle.sku || `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`, // Fallback SKU
                        description: bundle.description,
                        price: Number(bundle.menu_price || bundle.price || 0),
                        serving_tier: bundle.serving_tier,
                        is_active: bundle.is_active,
                        catalog_id: newCatalogId,
                        business_id: businessId
                    }
                });
                results.bundlesCreated++;
            }

            // 3. Process Contents
            // We need to re-link recipes. This is tricky if recipes don't match.
            // We'll attempt to match by SKU first, then Name.
            if (bundle.contents && Array.isArray(bundle.contents)) {
                // Clear existing contents to avoid duplicates? Or logic to merge?
                // Safest is to wipe and recreate for this bundle to ensure strict sync.
                await prisma.bundleContent.deleteMany({ where: { bundle_id: existing.id } });

                for (const content of bundle.contents) {
                    let recipeId = null;

                    // Try matching by SKU (Best)
                    if (content.recipe?.sku) {
                        const r = await prisma.recipe.findUnique({ where: { sku: content.recipe.sku } });
                        if (r) recipeId = r.id;
                    }

                    // Try matching by Name
                    if (!recipeId && content.recipe?.name) {
                        const r = await prisma.recipe.findFirst({ where: { business_id: businessId, name: content.recipe.name } });
                        if (r) recipeId = r.id;
                    }

                    if (recipeId) {
                        await prisma.bundleContent.create({
                            data: {
                                bundle_id: existing.id,
                                recipe_id: recipeId,
                                quantity: Number(content.quantity) || 1
                            }
                        });
                    }
                }
            }
        }

        return NextResponse.json({ success: true, results });

    } catch (e: any) {
        console.error("Import Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
