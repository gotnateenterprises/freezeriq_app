
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    resolveBundleContents,
    isBundleContentsError,
    type ResolvedBundleContent,
} from '@/lib/bundleContents';

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

        // BUNDLE-PERSISTENCE-FIX. The whole intended set is resolved and proven
        // owned BEFORE the transaction opens, so a payload this server cannot
        // fully honour never reaches the deleteMany below and the bundle keeps
        // the contents it already had. The former pre-check validated only the
        // ids it could see: `.filter(Boolean)` dropped a null recipe_id from the
        // count, which then failed deep inside the transaction as an opaque 500.
        //
        // `data.contents === undefined` still means "leave contents alone"; an
        // empty array still means "remove them all". Only the validation of a
        // submitted list changed.
        let resolvedContents: ResolvedBundleContent[] | null = null;
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
                    catalog_id: data.catalog_id || null, // Ensure null if empty string
                    // BUNDLE-MEDIA-1: was never written despite the editor
                    // sending it. `undefined` (key absent) is left as `undefined`
                    // so Prisma skips the column rather than clearing an
                    // existing image on a caller that doesn't send it — an
                    // explicit '' is the deliberate "clear the image" signal
                    // and becomes null, matching Acceptance D.
                    image_url: data.image_url === undefined ? undefined : (data.image_url || null)
                }
            });

            // 2. Sync Contents if provided — using the set validated above, so
            // the rows written are exactly the rows that were proven resolvable.
            if (resolvedContents !== null) {
                // Wipe existing contents
                await tx.bundleContent.deleteMany({
                    where: { bundle_id: id }
                });

                // Re-insert new contents
                if (resolvedContents.length > 0) {
                    await tx.bundleContent.createMany({
                        data: resolvedContents.map((c) => ({ ...c, bundle_id: id }))
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
