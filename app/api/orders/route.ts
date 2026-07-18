import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { buildBundlePriceMap } from '@/lib/pricing';
import { toDbSafeOrderStatus, toDbOrderStatusReadCandidates, validateOrderStatusTransition, normalizeOrderStatus } from '@/lib/orderStatus';
import { LOYALTY_ACCRUAL_ENABLED } from '@/lib/loyalty';


export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status');
        const campaignId = searchParams.get('campaign_id');

        const whereClause: any = {};
        if (campaignId) {
            whereClause.campaign_id = campaignId;
        }
        if (status) {
            // Phase 5F: expand each requested status through the read-candidates helper
            // so ghost values (READY_TO_SHIP) and canonical values both map to the
            // correct DB values for the current split-brain enum state.
            const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
            const dbCandidates = [...new Set(statuses.flatMap(s => toDbOrderStatusReadCandidates(s)))];
            if (dbCandidates.length === 0) {
                return NextResponse.json({ error: 'Invalid order status filter' }, { status: 400 });
            }
            whereClause.status = { in: dbCandidates };
        }

        // Week filter: selected delivery week, plus recent null-date or completed escape-hatch rows.
        const deliveryWeekStart = searchParams.get('delivery_week_start');
        if (deliveryWeekStart) {
            const weekStart = new Date(deliveryWeekStart);
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekEnd.getDate() + 7);
            // DD-0.3: scope the null-date and completed-status escape hatches to
            // recently created rows only, so they don't pin every week forever.
            const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5);
            whereClause.OR = [
                { delivery_date: { gte: weekStart, lt: weekEnd } },
                { delivery_date: null, created_at: { gte: thirtyDaysAgo } },
                // Phase 5G-2: also pin 'completed' and 'ready_to_ship' rows regardless
                // of delivery_date (they may have no date set but still need to appear)
                { status: { in: toDbOrderStatusReadCandidates('completed') as any },
                  created_at: { gte: thirtyDaysAgo } }
            ];
        }

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        whereClause.business_id = session.user.businessId;

        const includeDetails = searchParams.get('include_details') === 'true';

        // Optimized query with selective fields instead of full includes
        const orders = await prisma.order.findMany({
            where: whereClause,
            select: {
                id: true,
                external_id: true,
                customer_name: true,
                delivery_date: true,
                delivery_address: true,
                delivery_sequence: true,
                status: true,
                total_amount: true,
                source: true,
                created_at: true,
                items: {
                    select: {
                        id: true,
                        quantity: true,
                        variant_size: true,
                        bundle: includeDetails ? {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                price: true,
                                serving_tier: true,
                                contents: {
                                    select: {
                                        quantity: true,
                                        recipe: {
                                            select: {
                                                id: true,
                                                name: true,
                                                type: true
                                            }
                                        }
                                    }
                                }
                            }
                        } : {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                price: true,
                                serving_tier: true
                            }
                        }
                    }
                },
                customer: {
                    select: {
                        id: true,
                        name: true,
                        contact_email: true,
                        type: true
                    }
                },
                campaign: {
                    select: {
                        id: true,
                        name: true
                    }
                },
                customer_id: true,
                campaign_id: true
            },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(orders);
    } catch (e: any) {
        console.error('Failed to fetch orders:', e);
        return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { customer_name, customer_id, delivery_date, items, delivery_address } = body;

        if (!customer_name || !items || items.length === 0) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Generate ID
        const timestamp = Date.now();
        const externalId = `MAN-${timestamp}`;

        // Calculate total
        let totalAmount = 0;

        const bundleIds = items.map((i: any) => i.bundle_id);
        const bundlePriceMap = await buildBundlePriceMap(session.user.businessId, bundleIds);

        // Validate all bundle IDs upfront — tenant-scoped (buildBundlePriceMap filters by businessId)
        const invalidBundle = items.find((item: any) => !bundlePriceMap.has(item.bundle_id));
        if (invalidBundle) {
            return NextResponse.json({ error: 'Invalid bundle' }, { status: 400 });
        }

        const orderItemsData = items.map((item: any) => {
            const price = bundlePriceMap.get(item.bundle_id) as number;
            totalAmount += price * item.quantity;
            return {
                bundle_id: item.bundle_id,
                quantity: parseInt(item.quantity),
                variant_size: item.variant_size || 'serves_5'
            };
        });

        // Check for existing Customer to link
        let targetCustomerId = customer_id;
        let existingCustomer = null;

        if (!targetCustomerId) {
            existingCustomer = await prisma.customer.findFirst({
                where: {
                    business_id: session.user.businessId,
                    name: { equals: customer_name, mode: 'insensitive' }
                }
            });
            targetCustomerId = existingCustomer?.id;
        } else {
            existingCustomer = await prisma.customer.findUnique({
                where: { id: targetCustomerId }
            });
        }

        // Create Order
        const order = await prisma.order.create({
            data: {
                external_id: externalId,
                source: 'manual' as any,
                customer_name: customer_name,
                // Link to customer if found
                customer_id: targetCustomerId || null,
                delivery_date: delivery_date ? new Date(delivery_date) : null,
                status: 'pending',
                total_amount: totalAmount,
                // @ts-ignore
                delivery_address: delivery_address || existingCustomer?.delivery_address,
                items: {
                    create: orderItemsData
                },
                business_id: session.user.businessId
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        return NextResponse.json(order);

    } catch (e: any) {
        console.error('Failed to create manual order:', e);
        return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'Missing order ID' }, { status: 400 });
        }

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Transaction to ensure cleanup
        await prisma.$transaction(async (tx) => {
            // Try finding by internal ID first (UUID)
            let order = await tx.order.findUnique({ where: { id: id } });

            // If not found, try external ID
            if (!order) {
                order = await tx.order.findUnique({ where: { external_id: id } });
            }

            if (!order || order.business_id !== session.user.businessId) {
                throw new Error('Order not found or unauthorized');
            }

            // Find internal ID
            await tx.orderItem.deleteMany({
                where: { order_id: order.id }
            });

            // 2. Delete Order
            await tx.order.delete({
                where: { id: order.id }
            });
        });

        return NextResponse.json({ success: true });

    } catch (e: any) {
        console.error('Failed to delete order:', e);
        return NextResponse.json({ error: 'Failed to delete order' }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        // 1. Authenticate first — an anonymous caller must get 401 before the body is
        //    even parsed; do no request work before this gate.
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        // 2. Parse the request body only after authentication.
        const body = await req.json();
        const { id, status } = body;

        // 2a. Validate the request presence.
        if (!id || !status) {
            return NextResponse.json({ error: 'Missing ID or status' }, { status: 400 });
        }

        // 2b. Validate and normalize the requested status to a DB-safe WRITE value.
        //    Accepts canonical lowercase and legacy uppercase; null for anything else.
        const dbSafeStatus = toDbSafeOrderStatus(status);
        if (dbSafeStatus === null) {
            return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
        }
        // Temporary observability: log when normalization changes the input value
        if (status !== dbSafeStatus) {
            console.log(`[ORDER_STATUS] PATCH normalized "${status}" -> "${dbSafeStatus}"`);
        }

        // 3. Locate the order (internal id first, then external_id).
        let existingOrder = await (prisma.order as any).findUnique({
            where: { id },
            include: { invoice: true, customer: true }
        });
        if (!existingOrder) {
            existingOrder = await (prisma.order as any).findUnique({
                where: { external_id: id },
                include: { invoice: true, customer: true }
            });
        }

        // 4. Verify business ownership BEFORE exposing any transition detail.
        if (!existingOrder || existingOrder.business_id !== businessId) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        // 5 + 6. DD-0.5: normalize the stored status and validate the transition using
        //    the shared canonical matrix. Uses write-normalization inside
        //    validateOrderStatusTransition — NOT read-candidate expansion — so a legacy
        //    read alias (e.g. 'completed' standing in for 'ready_to_ship') can never
        //    authorize a write.
        const transition = validateOrderStatusTransition(existingOrder.status, dbSafeStatus);

        if (transition.status === 'illegal') {
            console.log(`[ORDER_STATUS] rejected ${transition.from}→${transition.to} order=${existingOrder.id}`);
            return NextResponse.json({
                error: `Cannot move an order from '${transition.from}' to '${transition.to}'`,
                code: 'ILLEGAL_STATUS_TRANSITION',
                from: transition.from,
                to: transition.to,
            }, { status: 400 });
        }

        // Same canonical status → idempotent accept: do not rewrite status, do not run
        // transition-only side effects. Return the current row in the existing shape.
        if (transition.status === 'same') {
            const current = await (prisma.order as any).findFirst({ where: { id: existingOrder.id, business_id: businessId } });
            return NextResponse.json(current);
        }

        // 7 + 8. Atomic conditional write inside the existing transaction. The WHERE
        //    compares against the EXACT raw status read from the owned row, so if any
        //    other writer changed it between our read and write, count === 0 (lost race)
        //    and no status change or side effect occurs.
        const wonTransition = await prisma.$transaction(async (tx) => {
            const updateResult = await tx.order.updateMany({
                where: {
                    id: existingOrder.id,
                    business_id: businessId,
                    status: existingOrder.status,
                },
                data: { status: dbSafeStatus as any }
            });

            if (updateResult.count !== 1) {
                return false; // lost race — another writer won; do not run side effects
            }

            // SYNC LINKED INVOICE + LOYALTY — transition-only side effects.
            // Runs ONLY on a real successful transition INTO production_ready. The prior
            // status cannot already be production_ready here (same-status is handled and
            // returned above; production_ready is reachable only from pending per the
            // matrix), so loyalty/invoice sync fires exactly once and never on retry.
            // Check uses dbSafeStatus so that inputs like 'APPROVED' also trigger this
            // side effect correctly after normalization.
            // @ts-ignore
            if (dbSafeStatus === 'production_ready' && existingOrder.invoice_id) {
                // @ts-ignore
                await tx.invoice.update({
                    // @ts-ignore
                    where: { id: existingOrder.invoice_id },
                    data: { status: 'PAID' }
                });

                // Award loyalty points ONLY if NOT a fundraiser organization
                // LOY-P0: new accrual is globally paused. The invoice sync above is
                // deliberately OUTSIDE this gate and still runs.
                // @ts-ignore
                const customer = existingOrder.customer;
                if (LOYALTY_ACCRUAL_ENABLED && customer && customer.type !== 'fundraiser_org') {
                    const points = Math.floor(Number(existingOrder.total_amount));
                    if (points > 0) {
                        // @ts-ignore - Stale Prisma Client
                        await tx.loyaltyPoint.create({
                            data: {
                                customer_id: customer.id,
                                points,
                                reason: `Order ${existingOrder.external_id} Paid`
                            }
                        });

                        await tx.customer.update({
                            where: { id: customer.id },
                            data: {
                                // @ts-ignore - Stale Prisma Client
                                loyalty_balance: { increment: points }
                            }
                        });
                    }
                }
            }

            return true;
        });

        // 10. Lost race: the row's status changed between our read and conditional write.
        //     Do not overwrite the winner, do not run side effects. Report canonical current.
        if (!wonTransition) {
            const current = await (prisma.order as any).findFirst({ where: { id: existingOrder.id, business_id: businessId } });
            return NextResponse.json({
                error: 'Order status changed concurrently; please retry',
                code: 'STATUS_CHANGED_CONCURRENTLY',
                current: normalizeOrderStatus(current?.status),
            }, { status: 409 });
        }

        // 9. Re-read and return the order using the existing successful response shape.
        const updatedOrder = await (prisma.order as any).findFirst({ where: { id: existingOrder.id, business_id: businessId } });
        return NextResponse.json(updatedOrder);
    } catch (e: any) {
        console.error('Failed to update order:', e);
        return NextResponse.json({ error: 'Failed to update order' }, { status: 500 });
    }
}
