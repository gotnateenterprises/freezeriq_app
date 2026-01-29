
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        const pendingOrders = await prisma.order.findMany({
            where: { status: { not: 'completed' } },
            select: { id: true }
        });

        const ids = pendingOrders.map(o => o.id);

        if (ids.length > 0) {
            await prisma.orderItem.deleteMany({
                where: { order_id: { in: ids } }
            });

            await prisma.order.deleteMany({
                where: { id: { in: ids } }
            });
        }

        return NextResponse.json({
            success: true,
            message: `Deleted ${ids.length} pending orders.`
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
