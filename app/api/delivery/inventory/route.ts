import { NextRequest, NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// GET: List all items
export async function GET() {
    try {
        const items = await prisma.packagingItem.findMany({
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
        const data = await req.json();
        const item = await prisma.packagingItem.create({
            data: {
                name: data.name,
                quantity: Number(data.quantity) || 0,
                reorderUrl: data.reorderUrl || '',
                type: data.type || 'other',
                lowStockThreshold: Number(data.lowStockThreshold) || 10
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
        const data = await req.json();
        const { id, ...updates } = data;

        const item = await prisma.packagingItem.update({
            where: { id },
            data: updates
        });
        return NextResponse.json(item);
    } catch (e) {
        return NextResponse.json({ error: "Failed to update item" }, { status: 500 });
    }
}
