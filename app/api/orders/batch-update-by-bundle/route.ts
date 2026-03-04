import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { bundleId, currentStatus, newStatus, customerId } = await req.json();

        if (!bundleId || !newStatus) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        // 1. Update the OrderItems directly
        const itemResult = await prisma.orderItem.updateMany({
            where: {
                bundle_id: bundleId,
                // Match both APPROVED and PENDING since they are grouped together in the UI
                production_status: currentStatus === 'APPROVED' ? { in: ['APPROVED', 'PENDING'] } : currentStatus,
                order: {
                    business_id: session.user.businessId,
                    ...(customerId !== undefined ? { customer_id: customerId || null } : {})
                }
            },
            data: { production_status: newStatus === 'COMPLETED' ? 'READY_TO_SHIP' : newStatus }
        });

        // 2. If moving to IN_PRODUCTION, ensure parent Orders are bumped out of APPROVED/PENDING
        if (newStatus === 'IN_PRODUCTION') {
            await prisma.order.updateMany({
                where: {
                    business_id: session.user.businessId,
                    status: { in: ['APPROVED', 'PENDING', 'pending'] as any },
                    ...(customerId !== undefined ? { customer_id: customerId || null } : {}),
                    items: {
                        some: { bundle_id: bundleId }
                    }
                },
                data: { status: 'IN_PRODUCTION' }
            });
        }

        return NextResponse.json({ count: itemResult.count });

    } catch (e) {
        console.error("Batch Update Error:", e);
        return NextResponse.json({ error: "Failed to update orders" }, { status: 500 });
    }
}
