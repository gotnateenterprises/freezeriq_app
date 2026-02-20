import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { bundleId, currentStatus, newStatus } = await req.json();

        if (!bundleId || !newStatus) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        // Find orders that contain this bundle and have the current status (or APPROVED if not specified)
        // Note: Using findMany first to identify orders might be safer if the relationship is complex,
        // but updateMany on OrderItems is slightly tricky because we want to update the ORDER status, not the ITEM.

        // Approach: Find all orders that have an item with this bundleId AND are in currentStatus
        const ordersToUpdate = await prisma.order.findMany({
            where: {
                business_id: session.user.businessId,
                status: currentStatus || 'APPROVED',
                items: {
                    some: {
                        bundle_id: bundleId
                    }
                }
            },
            select: { id: true }
        });

        const orderIds = ordersToUpdate.map(o => o.id);

        if (orderIds.length === 0) {
            return NextResponse.json({ count: 0, message: "No matching orders found" });
        }

        const result = await prisma.order.updateMany({
            where: {
                id: { in: orderIds }
            },
            data: { status: newStatus }
        });

        return NextResponse.json({ count: result.count });

    } catch (e) {
        console.error("Batch Update Error:", e);
        return NextResponse.json({ error: "Failed to update orders" }, { status: 500 });
    }
}
