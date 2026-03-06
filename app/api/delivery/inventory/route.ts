import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// GET: List all items
export async function GET() {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const items = await prisma.packagingItem.findMany({
            where: {
                business_id: session.user.businessId
            },
            orderBy: { name: 'asc' }
        });
        return NextResponse.json(items);
    } catch (e) {
        return NextResponse.json({ error: "Failed to fetch inventory" }, { status: 500 });
    }
}

// POST: Create new item
export async function POST(req: NextRequest) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const data = await req.json();
        const item = await prisma.packagingItem.create({
            data: {
                name: data.name,
                quantity: Number(data.quantity) || 0,
                reorderUrl: data.reorderUrl || '',
                type: data.type || 'other',
                lowStockThreshold: Number(data.lowStockThreshold) || 10,
                cost_per_unit: data.cost_per_unit || 0,
                business_id: session.user.businessId
            }
        });
        return NextResponse.json(item);
    } catch (e) {
        return NextResponse.json({ error: "Failed to create item" }, { status: 500 });
    }
}

// PUT: Update item (quantity, name, etc)
export async function PUT(req: NextRequest) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const data = await req.json();
        const { id, ...updates } = data;

        // Ownership Check
        const existing = await prisma.packagingItem.findUnique({ where: { id } });
        if (!existing) return NextResponse.json({ error: "Not Found" }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const item = await prisma.packagingItem.update({
            where: { id },
            data: updates
        });
        return NextResponse.json(item);
    } catch (e) {
        return NextResponse.json({ error: "Failed to update item" }, { status: 500 });
    }
}

// DELETE: Remove item
export async function DELETE(req: NextRequest) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await req.json();

        // Ownership Check
        const existing = await prisma.packagingItem.findUnique({ where: { id } });
        if (!existing) return NextResponse.json({ error: "Not Found" }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        await prisma.packagingItem.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json({ error: "Failed to delete item" }, { status: 500 });
    }
}
