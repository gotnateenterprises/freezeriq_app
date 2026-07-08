import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbSafeOrderStatus } from '@/lib/orderStatus';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { orderIds, status } = await req.json();

        if (!Array.isArray(orderIds) || !status) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        // Phase 5D: validate and normalize status to a DB-safe value.
        // Accepts both canonical lowercase values and legacy uppercase forms.
        // Returns null for any unrecognized input.
        const dbSafeStatus = toDbSafeOrderStatus(status);
        if (dbSafeStatus === null) {
            return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
        }
        // Temporary observability: log when normalization changes the input value
        if (status !== dbSafeStatus) {
            console.log(`[ORDER_STATUS] bulk-status normalized "${status}" -> "${dbSafeStatus}"`);
        }

        const result = await prisma.order.updateMany({
            where: {
                id: { in: orderIds },
                business_id: session.user.businessId
            },
            data: { status: dbSafeStatus as any }
        });

        return NextResponse.json({ count: result.count });

    } catch (e) {
        console.error("Bulk Update Error:", e);
        return NextResponse.json({ error: "Failed to update orders" }, { status: 500 });
    }
}
