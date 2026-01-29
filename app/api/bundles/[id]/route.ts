
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

        return NextResponse.json(bundle);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    try {
        const data = await req.json();

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
                    price: data.price ? Number(data.price) : null
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
    const { id } = await params;
    try {
        await prisma.bundleContent.deleteMany({ where: { bundle_id: id } }); // Clean up children first
        await prisma.bundle.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
