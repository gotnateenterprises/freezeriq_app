
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { convertUnit } from '@/lib/unit_converter';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        // Array of { name: 'Ground Beef', qty: 10, unit: 'lb' }
        const { ingredients } = body;

        if (!ingredients || !Array.isArray(ingredients)) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        const results = [];

        // Transaction is safer but lets do simple loop for speed/errors
        for (const item of ingredients) {
            let dbItem;

            if (item.id) {
                // Precise lookup by ID
                dbItem = await prisma.ingredient.findUnique({
                    where: { id: item.id }
                });
            } else {
                // Fallback: Find by name (case insensitive)
                dbItem = await prisma.ingredient.findFirst({
                    where: { name: { equals: item.name, mode: 'insensitive' } }
                });
            }

            if (dbItem) {
                // Normalize Quantity
                let deductionQty = Number(item.qty);

                // Attempt conversion if units mismatch
                if (item.unit && dbItem.unit && item.unit.toLowerCase() !== dbItem.unit.toLowerCase()) {
                    deductionQty = convertUnit(Number(item.qty), item.unit, dbItem.unit);

                    // Safety Check: If conversion failed (returned same qty) but units are definitely different,
                    // we might want to flag this. For MVP, we proceed but maybe we'll add a 'warning' status.
                }

                const newStock = Math.max(0, Number(dbItem.stock_quantity) - deductionQty); // Prevent negative stock

                await prisma.ingredient.update({
                    where: { id: dbItem.id },
                    data: { stock_quantity: newStock }
                });

                results.push({
                    name: item.name,
                    status: 'deducted',
                    previous: Number(dbItem.stock_quantity),
                    deducted: deductionQty,
                    remaining: newStock,
                    unit: dbItem.unit
                });
            } else {
                results.push({ name: item.name, status: 'not_found' });
            }
        }

        return NextResponse.json({ success: true, results });

    } catch (e) {
        console.error("Depletion Error:", e);
        return NextResponse.json({ error: "Failed to deduct stock" }, { status: 500 });
    }
}
