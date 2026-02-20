import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { name, cost_per_unit, unit, stock_quantity, sku } = body;

        if (!name) return NextResponse.json({ error: "Name required" }, { status: 400 });

        const ingredient = await prisma.ingredient.create({
            data: {
                name,
                sku: sku || undefined,
                cost_per_unit: Number(cost_per_unit) || 0,
                unit: unit || 'each',
                stock_quantity: Number(stock_quantity) || 0,
                business_id: session.user.businessId
            }
        });

        // Return full structure for UI
        return NextResponse.json({
            id: ingredient.id,
            name: ingredient.name,
            sku: ingredient.sku,
            cost_per_unit: Number(ingredient.cost_per_unit),
            unit: ingredient.unit,
            stock_quantity: Number(ingredient.stock_quantity),
            supplier_id: null
        });
    } catch (e: any) {
        console.error("Create Ingredient Error:", e);
        return NextResponse.json({
            error: e.message || "Failed to create ingredient",
            code: e.code
        }, { status: 500 });
    }
}
