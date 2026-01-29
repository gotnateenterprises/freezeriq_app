import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';


export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const status = searchParams.get('status');

        const whereClause: any = {};
        if (status) {
            // Handle multiple statuses like ?status=pending,production_ready
            const statuses = status.split(',');
            if (statuses.length > 1) {
                whereClause.status = { in: statuses };
            } else {
                whereClause.status = status;
            }
        }

        const orders = await prisma.order.findMany({
            where: whereClause,
            include: {
                items: {
                    include: { bundle: true }
                },
                organization: true // Assuming customer info is here or directly on order
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
        const { customer_name, delivery_date, items } = body;

        if (!customer_name || !items || items.length === 0) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
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

        // Create Order
        const order = await prisma.order.create({
            data: {
                external_id: externalId,
                source: 'manual' as any,
                customer_name: customer_name,
                delivery_date: delivery_date ? new Date(delivery_date) : null,
                status: 'pending',
                total_amount: totalAmount,
                items: {
                    create: orderItemsData
                }
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

        // Transaction to ensure cleanup
        await prisma.$transaction(async (tx) => {
            const order = await tx.order.findUnique({ where: { external_id: id } });
            if (!order) {
                // If order not found, it might already be deleted. Return success to be idempotent or 404.
                throw new Error('Order not found');
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
