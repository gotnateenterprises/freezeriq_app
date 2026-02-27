import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { InventoryEngine } from '@/lib/inventory_engine';


export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status');
        const id = searchParams.get('id');

        const whereClause: any = {};

        if (id) {
            whereClause.id = id;
        }

        if (status) {
            // Handle multiple statuses like ?status=pending,production_ready
            const statuses = status.split(',');
            if (statuses.length > 1) {
                whereClause.status = { in: statuses };
            } else {
                whereClause.status = status;
            }
        }

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        whereClause.business_id = session.user.businessId;

        const includeFundraisers = searchParams.get('include_fundraisers') === 'true';
        if (!includeFundraisers) {
            whereClause.campaign_id = null;
        }

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
                                price: true
                            }
                        }
                    }
                },
                customer: {
                    select: {
                        id: true,
                        name: true,
                        contact_email: true,
                        type: true,
                        delivery_address: true,
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
        const bundles = await prisma.bundle.findMany({
            where: { id: { in: bundleIds } }
        });

        const bundleMap = new Map(bundles.map(b => [b.id, b]));

        const orderItemsData = items.map((item: any) => {
            const bundle = bundleMap.get(item.bundle_id);
            if (!bundle) {
                throw new Error(`Invalid bundle ID: ${item.bundle_id}`);
            }
            if (bundle && bundle.price) {
                totalAmount += Number(bundle.price) * item.quantity;
            }
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
        return NextResponse.json({
            error: e.message || 'Internal Server Error'
        }, { status: 500 });
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
        return NextResponse.json({
            error: e.message || 'Internal Server Error'
        }, { status: 500 });
    }
}

export async function PATCH(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, status, delivery_signature } = body;

        if (!id || !status) {
            return NextResponse.json({ error: 'Missing ID or status' }, { status: 400 });
        }

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Try finding by internal ID first (UUID)
        let existingOrder = await (prisma.order as any).findUnique({
            where: { id },
            include: { invoice: true, customer: true }
        });

        // If not found, try external ID
        if (!existingOrder) {
            existingOrder = await (prisma.order as any).findUnique({
                where: { external_id: id },
                include: { invoice: true, customer: true }
            });
        }

        if (!existingOrder || existingOrder.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 });
        }

        const result = await prisma.$transaction(async (tx) => {
            // Update the order status
            const updatedOrder = await tx.order.update({
                where: { id: existingOrder.id },
                data: {
                    status,
                    ...(delivery_signature && {
                        // @ts-ignore - Stale Prisma Client
                        delivery_signature,
                        // @ts-ignore
                        delivered_at: new Date()
                    })
                }
            });

            // SYNC LINKED INVOICE
            // If marking as paid (production_ready), also mark the linked invoice as PAID
            // @ts-ignore
            if (status === 'production_ready' && existingOrder.invoice_id) {
                // @ts-ignore
                await tx.invoice.update({
                    // @ts-ignore
                    where: { id: existingOrder.invoice_id },
                    data: { status: 'PAID' }
                });

                // Award loyalty points ONLY if NOT a fundraiser organization
                // @ts-ignore
                const customer = existingOrder.customer;
                if (customer && customer.type !== 'fundraiser_org') {
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

            return updatedOrder;
        });

        if (status === 'completed' || status === 'delivered') {
            const engine = new InventoryEngine(session.user.businessId);
            engine.deductOrderInventory(existingOrder.id).catch(err => {
                console.error(`Inventory deduction failed for ${existingOrder.id}:`, err);
            });
        }

        return NextResponse.json(result);
    } catch (e: any) {
        console.error('Failed to update order:', e);
        return NextResponse.json({ error: 'Failed to update order' }, { status: 500 });
    }
}
