import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { OrderStatus } from '@prisma/client';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const businessId = session.user.businessId;

        // 1. Fetch PENDING or PAID orders (Holding Area)
        const pendingOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                status: { in: [OrderStatus.pending, OrderStatus.production_ready] }
            },
            include: {
                customer: {
                    select: { name: true, type: true }
                },
                items: {
                    include: {
                        bundle: {
                            select: { name: true, sku: true }
                        }
                    }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        // 2. Fetch KITCHEN-APPROVED orders (Prep List)
        const productionOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                status: { in: ['APPROVED', 'IN_PRODUCTION', 'READY_TO_SHIP'] as any } // Must include READY_TO_SHIP as some items might still be prepping
            },
            include: {
                customer: {
                    select: { id: true, name: true, type: true }
                },
                items: {
                    include: {
                        bundle: {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                contents: {
                                    include: {
                                        recipe: {
                                            select: { id: true, name: true, label_text: true }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        // 3. Fetch Delivery Queue Orders (Orders with at least one READY_TO_SHIP or DELIVERED item)
        const deliveryOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                items: {
                    some: {
                        production_status: { in: ['READY_TO_SHIP', 'DELIVERED'] }
                    }
                },
                status: { notIn: [OrderStatus.completed, OrderStatus.DELIVERED, OrderStatus.delivered] as any } // Once the order is COMPLETED or DELIVERED, it drops off
            },
            include: {
                customer: {
                    select: { name: true, type: true, delivery_address: true }
                },
                items: {
                    include: {
                        bundle: {
                            select: { id: true, name: true, sku: true }
                        }
                    }
                }
            },
            orderBy: { created_at: 'asc' }
        });

        // Aggregate for Prep List - Group by Customer, Bundle AND Item Production Status
        const prepMap = new Map<string, {
            bundle_id: string;
            bundle_name: string;
            sku: string;
            total_quantity: number;
            order_count: number;
            status: string;
            customer_id?: string;
            customer_name?: string;
            customer_type?: string;
            recipes: { id: string, name: string, quantity: number, label_text?: string | null }[];
        }>();

        productionOrders.forEach(order => {
            order.items.forEach(item => {
                if (!item.bundle) return;
                // Exclude items that are already ready to ship or delivered from the kitchen prep list
                if (item.production_status === 'READY_TO_SHIP' || item.production_status === 'DELIVERED') return;

                const bid = item.bundle.id;
                // Map PENDING to APPROVED for the prep list UI grouping logic
                const status = item.production_status === 'PENDING' ? 'APPROVED' : item.production_status;
                const cid = order.customer?.id || 'none';
                const key = `${cid}-${bid}-${status}`;

                if (!prepMap.has(key)) {
                    prepMap.set(key, {
                        bundle_id: bid,
                        bundle_name: item.bundle.name,
                        sku: item.bundle.sku,
                        total_quantity: 0,
                        order_count: 0,
                        status: status,
                        customer_id: order.customer?.id,
                        customer_name: order.customer?.name || 'Unknown',
                        customer_type: order.customer?.type || 'Customer',
                        recipes: (item.bundle.contents || []).map(c => ({
                            id: c.recipe?.id || 'unknown',
                            name: c.recipe?.name || 'Unknown Recipe',
                            quantity: c.quantity || 1,
                            label_text: (c.recipe as any)?.label_text
                        }))
                    });
                }

                const entry = prepMap.get(key)!;
                entry.total_quantity += item.quantity;
                entry.order_count += 1;
            });
        });

        return NextResponse.json({
            pending: pendingOrders,
            prep: Array.from(prepMap.values()),
            completed: deliveryOrders // Renaming the payload value to "completed" to avoid breaking old frontend code that expects it, but containing deliveryOrders
        });

    } catch (e) {
        console.error("Dashboard API Error:", e);
        return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
    }
}
