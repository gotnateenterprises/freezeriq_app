
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    resolveBundleContents,
    isBundleContentsError,
    type ResolvedBundleContent,
} from '@/lib/bundleContents';

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

        // 2. Plan every bundle — READ ONLY.
        //
        // BUNDLE-PERSISTENCE-FIX. Import is the path that could destroy data:
        // it deleted a bundle's contents and only then tried to resolve the
        // replacements, skipping whatever it could not match. A five-recipe
        // export naming two unmatchable recipes left three rows behind and
        // still returned success. Nothing is written now until the entire
        // payload has been resolved, so an import this server cannot fully
        // honour fails with every existing bundle untouched.
        const planned: {
            target: { id: string } | null;
            bundle: any;
            catalogId: string | null;
            contents: ResolvedBundleContent[] | null;
        }[] = [];

        for (const bundle of bundles) {
            // Map Catalog ID
            const newCatalogId = bundle.catalog_id && catalogMap.has(bundle.catalog_id)
                ? catalogMap.get(bundle.catalog_id) ?? null
                : null;

            // Check existence by name (or SKU)
            let existing = await prisma.bundle.findFirst({
                where: { business_id: businessId, name: bundle.name },
                select: { id: true }
            });

            if (!existing && bundle.sku) {
                // Bundle.sku is globally unique, so this lookup must be scoped:
                // unscoped, an export naming another tenant's bundle SKU
                // resolved to THEIR bundle and the replacement below then wiped
                // its contents.
                existing = await prisma.bundle.findFirst({
                    where: { sku: bundle.sku, business_id: businessId },
                    select: { id: true }
                });
            }

            let contents: ResolvedBundleContent[] | null = null;
            if (bundle.contents !== undefined) {
                // Throws BundleContentsError if any entry cannot be matched to a
                // recipe owned by this business. No mutation has happened yet.
                contents = await resolveBundleContents(prisma, bundle.contents, businessId);
            }

            planned.push({ target: existing, bundle, catalogId: newCatalogId, contents });
        }

        // 3. Apply the whole plan in ONE transaction, so any failure rolls the
        // entire import back rather than leaving some bundles replaced and
        // others not.
        await prisma.$transaction(async (tx) => {
            for (const step of planned) {
                const { bundle, catalogId } = step;
                let bundleId: string;

                if (step.target) {
                    await tx.bundle.update({
                        where: { id: step.target.id },
                        data: {
                            description: bundle.description,
                            price: Number(bundle.menu_price || bundle.price || 0),
                            serving_tier: bundle.serving_tier,
                            is_active: bundle.is_active,
                            catalog_id: catalogId
                        }
                    });
                    bundleId = step.target.id;
                    results.bundlesUpdated++;
                } else {
                    const created = await tx.bundle.create({
                        data: {
                            name: bundle.name,
                            sku: bundle.sku || `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`, // Fallback SKU
                            description: bundle.description,
                            price: Number(bundle.menu_price || bundle.price || 0),
                            serving_tier: bundle.serving_tier,
                            is_active: bundle.is_active,
                            catalog_id: catalogId,
                            business_id: businessId
                        }
                    });
                    bundleId = created.id;
                    results.bundlesCreated++;
                }

                // Replacement and recreation share one transaction, so the wipe
                // can never outlive a failed recreate.
                if (step.contents !== null) {
                    await tx.bundleContent.deleteMany({ where: { bundle_id: bundleId } });
                    if (step.contents.length > 0) {
                        await tx.bundleContent.createMany({
                            data: step.contents.map((c) => ({ ...c, bundle_id: bundleId }))
                        });
                    }
                }
            }
        }, { timeout: 30_000 });

        return NextResponse.json({ success: true, results });

    } catch (e: any) {
        // An unresolvable or foreign recipe is a caller error with a message
        // worth showing, not an opaque 500 — and by the time it is thrown,
        // nothing has been written.
        if (isBundleContentsError(e)) {
            return NextResponse.json({ error: e.message }, { status: e.status });
        }
        console.error("Import Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
