import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbSafeOrderStatus, toDbOrderStatusReadCandidates } from '@/lib/orderStatus';

/**
 * Returns all DB-safe status values to use in the WHERE clause for currentStatus.
 * Covers both canonical and legacy uppercase values stored in the DB via
 * toDbOrderStatusReadCandidates, which owns the full mapping table.
 *
 * Fallback: if input is invalid/missing, returns candidates for 'production_ready'
 * (includes both 'production_ready' and 'APPROVED') to preserve the original
 * PrepList behavior where the initial batch step may not send a currentStatus.
 *
 * Phase 5H-0: Replaced the manual switch statement (which had a dead
 * 'IN_PRODUCTION' case after Phase 5G-2) with a delegate to the helper.
 */
function getDbSafeCurrentStatusCandidates(input: string | null | undefined): string[] {
    const candidates = toDbOrderStatusReadCandidates(input);

    if (candidates.length === 0) {
        // Unrecognized or missing status — default to production_ready bucket.
        // This covers both 'production_ready' rows and legacy 'APPROVED' rows.
        return toDbOrderStatusReadCandidates('production_ready');
    }

    return candidates;
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { bundleId, currentStatus, newStatus } = await req.json();

        if (!bundleId || !newStatus) {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        // Phase 5D: validate and normalize newStatus to a DB-safe value.
        // Hard reject: if newStatus is unrecognized, return 400.
        const dbSafeNewStatus = toDbSafeOrderStatus(newStatus);
        if (dbSafeNewStatus === null) {
            return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
        }
        // Temporary observability: log when normalization changes the input value
        if (newStatus !== dbSafeNewStatus) {
            console.log(`[ORDER_STATUS] batch-update-by-bundle newStatus normalized "${newStatus}" -> "${dbSafeNewStatus}"`);
        }

        // Phase 5D: build WHERE candidates for currentStatus.
        // Returns all legacy DB variants so rows stored under old uppercase values are still matched.
        const dbSafeCurrentStatusCandidates = getDbSafeCurrentStatusCandidates(currentStatus);
        if (currentStatus && !dbSafeCurrentStatusCandidates.includes(currentStatus)) {
            console.log(`[ORDER_STATUS] batch-update-by-bundle currentStatus "${currentStatus}" -> candidates [${dbSafeCurrentStatusCandidates.join(', ')}]`);
        }

        // Find all orders that have an item with this bundleId AND are in currentStatus (or a legacy equivalent)
        const ordersToUpdate = await prisma.order.findMany({
            where: {
                business_id: session.user.businessId,
                status: { in: dbSafeCurrentStatusCandidates as any },
                items: {
                    some: {
                        bundle_id: bundleId
                    }
                }
            },
            select: { id: true, customer_id: true }
        });

        const orderIds = ordersToUpdate.map(o => o.id);
        const customerIds = ordersToUpdate
            .map(o => o.customer_id)
            .filter((id): id is string => !!id);

        if (orderIds.length === 0) {
            return NextResponse.json({ count: 0, message: "No matching orders found" });
        }

        // Use a transaction to update both orders and customers
        const result = await prisma.$transaction(async (tx) => {
            const updateCount = await tx.order.updateMany({
                where: {
                    id: { in: orderIds }
                },
                data: { status: dbSafeNewStatus as any }
            });

            // If we are marking as completed, also move customers to DELIVERY status.
            // Check uses dbSafeNewStatus so inputs like 'COMPLETED' also trigger this
            // side effect correctly after normalization.
            if (dbSafeNewStatus === 'completed' && customerIds.length > 0) {
                await tx.customer.updateMany({
                    where: {
                        id: { in: customerIds },
                        business_id: session.user.businessId
                    },
                    data: { status: 'DELIVERY' }
                });
            }

            return updateCount;
        });

        return NextResponse.json({ count: result.count });

    } catch (e) {
        console.error("Batch Update Error:", e);
        return NextResponse.json({ error: "Failed to update orders" }, { status: 500 });
    }
}
