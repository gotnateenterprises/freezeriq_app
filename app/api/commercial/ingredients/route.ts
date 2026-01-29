import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const ingredients = await prisma.ingredient.findMany({
            orderBy: { name: 'asc' },
            include: { supplier: true }
        });

        // Transform Decimal types to Numbers for JSON serialization
        const safeIngredients = ingredients.map(i => ({
            id: i.id,
            name: i.name,
            cost_per_unit: Number(i.cost_per_unit),
            unit: i.unit,
            stock_quantity: Number(i.stock_quantity),
            supplier_id: i.supplier_id,
            supplier_name: i.supplier?.name,
            sku: i.sku,
            purchase_unit: i.purchase_unit,
            purchase_quantity: Number(i.purchase_quantity),
            purchase_cost: Number(i.purchase_cost)
        }));

        return NextResponse.json(safeIngredients);
    } catch (e) {
        console.error("List Ingredients Error:", e);
        return NextResponse.json({ error: "Failed to fetch ingredients" }, { status: 500 });
    }
}
