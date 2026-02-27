import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { InventoryEngine } from '@/lib/inventory_engine';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { orderIds, status } = await req.json();

        if (!Array.isArray(orderIds) || !status) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        const result = await prisma.order.updateMany({
            where: {
                id: { in: orderIds },
                business_id: session.user.businessId
            },
            data: { status }
        });

        // Trigger ERP ERP Deduction Hook
        if (status === 'completed' || status === 'delivered') {
            const engine = new InventoryEngine(session.user.businessId);
            for (const id of orderIds) {
                // Async background deduct to prevent blocking response too long
                engine.deductOrderInventory(id).catch(err => {
                    console.error(`Inventory deduction failed for ${id}:`, err);
                });
            }
        }

        return NextResponse.json({ count: result.count });

    } catch (e) {
        console.error("Bulk Update Error:", e);
        return NextResponse.json({ error: "Failed to update orders" }, { status: 500 });
    }
}
