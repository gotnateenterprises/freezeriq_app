import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';

/**
 * OPS-6B — the ACTIVE Delivery queue: orders Delivery actually owns.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A NEW ROUTE INSTEAD OF A FLAG ON /api/orders
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The Delivery board used to build its stop list from
 *
 *     /api/orders?status=pending,production_ready,in_production,ready_to_ship,completed
 *
 * which is not a delivery queue at all — it is "everything not delivered". An
 * order became a delivery stop the moment it was CREATED, before it was even
 * approved for production, and because that GET carries no `canceled_at`
 * predicate, soft-canceled orders appeared as stops too.
 *
 * This route replaces that read for the Delivery board. It is a separate file
 * rather than a parameter on /api/orders for two reasons: `app/api/orders/route.ts`
 * is a designated sensitive core file (Order CRUD) whose approval workflow this
 * phase has no need to invoke, and a dedicated route can select NARROWLY for
 * one purpose — the same reasoning that produced
 * app/api/delivery/packing-slips/route.ts in the previous phase.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MEMBERSHIP RULE
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   released_to_delivery_at IS NOT NULL   — someone deliberately handed it over
 *   canceled_at IS NULL                   — not soft-canceled
 *   status NOT IN (delivered)             — a completed delivery does not come
 *                                           back as active work
 *
 * Status is otherwise NOT consulted: crossing the handoff boundary is the
 * membership test, which is the entire point of OPS-6B. An order sitting at
 * `ready_to_ship` that nobody has sent to Delivery is Production's, not
 * Delivery's.
 *
 * ADDRESS AND NAME ARE SELECTED HERE, DELIBERATELY. Unlike the box-label and
 * packing-slip routes, a driver's stop list genuinely needs them — the
 * fulfillment contract keeps ordinary customer delivery as a per-order stop at
 * its own address (§3.4). They are returned in a response body and never placed
 * in a URL or query string.
 *
 * READ-ONLY. Delivery completion is a later phase with a recipient in the loop.
 */
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { searchParams } = new URL(req.url);
        const deliveryWeekStart = searchParams.get('delivery_week_start');

        const whereClause: any = {
            business_id: businessId,
            canceled_at: null,
            // THE HANDOFF BOUNDARY. This single predicate is what makes the
            // Delivery board mean "Delivery owns this".
            released_to_delivery_at: { not: null },
            NOT: { status: { in: toDbOrderStatusReadCandidates('delivered') as any } },
        };

        if (deliveryWeekStart) {
            const weekStart = new Date(deliveryWeekStart);
            if (!Number.isNaN(weekStart.getTime())) {
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 7);
                const hatchFloor = new Date(Date.now() - 30 * 864e5);
                whereClause.OR = [
                    { delivery_date: { gte: weekStart, lt: weekEnd } },
                    { delivery_date: null, created_at: { gte: hatchFloor } },
                ];
            }
        }

        const orders = await prisma.order.findMany({
            where: whereClause,
            select: {
                id: true,
                external_id: true,
                customer_name: true,
                delivery_address: true,
                delivery_sequence: true,
                delivery_date: true,
                status: true,
                released_to_delivery_at: true,
                customer: { select: { name: true, delivery_address: true } },
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
                        variant_size: true,
                        item_name: true,
                        bundle: { select: { id: true, name: true } },
                    },
                    orderBy: { id: 'asc' },
                },
            },
            orderBy: { id: 'asc' },
        });

        return NextResponse.json(orders);
    } catch (e) {
        console.error('Delivery queue failed');
        return NextResponse.json({ error: 'Failed to load the delivery queue' }, { status: 500 });
    }
}
