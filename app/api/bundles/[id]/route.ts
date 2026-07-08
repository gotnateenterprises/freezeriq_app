
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        const bundle = await prisma.bundle.findUnique({
            where: { id },
            include: {
                contents: {
                    include: {
                        recipe: true
                    },
                    orderBy: {
                        position: 'asc'
                    }
                }
            }
        });

        if (!bundle) {
            return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
        }

        if (bundle.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        return NextResponse.json(bundle);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        // Ownership check before mutation
        const existing = await prisma.bundle.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const data = await req.json();

        // Pre-check: verify all submitted recipe_ids belong to this tenant
        if (data.contents && data.contents.length > 0) {
            const submittedRecipeIds: string[] = [...new Set(
                data.contents.map((item: any) => item.recipe_id).filter(Boolean)
            )] as string[];

            if (submittedRecipeIds.length > 0) {
                const ownedRecipes = await prisma.recipe.findMany({
                    where: { id: { in: submittedRecipeIds }, business_id: session.user.businessId },
                    select: { id: true }
                });

                if (ownedRecipes.length !== submittedRecipeIds.length) {
                    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
                }
            }
        }

        // Transaction to update bundle and syncing contents
        const result = await prisma.$transaction(async (tx) => {
            // 1. Update Bundle Info
            const updatedBundle = await tx.bundle.update({
                where: { id },
                data: {
                    name: data.name,
                    sku: data.sku,
                    description: data.description,
                    serving_tier: data.serving_tier,
                    is_active: data.is_active,
                    show_on_storefront: data.show_on_storefront,
                    order_cutoff_date: data.order_cutoff_date ? new Date(data.order_cutoff_date) : null,
                    price: data.price ? Number(data.price) : null,
                    catalog_id: data.catalog_id || null // Ensure null if empty string
                }
            });

            // 2. Sync Contents if provided
            if (data.contents) {
                // Wipe existing contents
                await tx.bundleContent.deleteMany({
                    where: { bundle_id: id }
                });

                // Re-insert new contents
                if (data.contents.length > 0) {
                    await tx.bundleContent.createMany({
                        data: data.contents.map((item: any, index: number) => ({
                            bundle_id: id,
                            recipe_id: item.recipe_id,
                            position: index,
                            quantity: Number(item.quantity) || 1.0
                        }))
                    });
                }
            }

            return updatedBundle;
        });

        return NextResponse.json(result);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        const existing = await prisma.bundle.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        await prisma.bundleContent.deleteMany({ where: { bundle_id: id } }); // Clean up children first
        await prisma.bundle.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
