
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import {
    resolveBundleContents,
    isBundleContentsError,
    type ResolvedBundleContent,
} from '@/lib/bundleContents';
import { buildBundleUpdateData } from '@/lib/bundleUpdate';

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
        const existing = await prisma.bundle.findUnique({ where: { id }, select: { business_id: true, catalog_id: true } });
        if (!existing) return NextResponse.json({ error: 'Bundle not found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        const data = await req.json();

        const update = buildBundleUpdateData(data, { catalog_id: existing.catalog_id ?? null });
        if (!update.ok) return NextResponse.json({ error: update.error }, { status: update.status });

        if (update.catalogIdToVerify) {
            const catalog = await prisma.catalog.findFirst({
                where: { id: update.catalogIdToVerify, business_id: session.user.businessId },
                select: { id: true },
            });
            if (!catalog) return NextResponse.json({ error: 'Catalog not found' }, { status: 400 });
        }

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
            // 1. Update Bundle Info — only the columns this request actually sent.
            const updatedBundle = await tx.bundle.update({
                where: { id },
                data: update.data,
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
