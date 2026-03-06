
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const catalog = await prisma.catalog.findUnique({
            where: { id },
            include: {
                bundles: {
                    select: { id: true, name: true, sku: true, serving_tier: true, is_active: true },
                    orderBy: { name: 'asc' }
                }
            }
        });

        if (!catalog) return NextResponse.json({ error: "Catalog not found" }, { status: 404 });

        return NextResponse.json(catalog);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await req.json();
        const { name, start_date, end_date, is_active, bundles_to_add, bundles_to_remove } = body;

        // 1. Update Catalog Details
        const updateData: any = {};
        if (name) updateData.name = name;
        if (start_date) updateData.start_date = new Date(start_date);
        if (end_date) updateData.end_date = new Date(end_date);
        if (is_active !== undefined) updateData.is_active = is_active;

        let catalog = await prisma.catalog.update({
            where: { id },
            data: updateData
        });

        // 2. Manage Bundles
        // Add Bundles (Set catalog_id = id)
        if (bundles_to_add && Array.isArray(bundles_to_add) && bundles_to_add.length > 0) {
            await prisma.bundle.updateMany({
                where: { id: { in: bundles_to_add } },
                data: { catalog_id: id }
            });
        }

        // Remove Bundles (Set catalog_id = null)
        if (bundles_to_remove && Array.isArray(bundles_to_remove) && bundles_to_remove.length > 0) {
            await prisma.bundle.updateMany({
                where: { id: { in: bundles_to_remove } },
                data: { catalog_id: null }
            });
        }

        return NextResponse.json(catalog);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        // Unassign bundles first (Optional: or cascade delete? Usually safe to just unassign)
        await prisma.bundle.updateMany({
            where: { catalog_id: id },
            data: { catalog_id: null }
        });

        await prisma.catalog.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
