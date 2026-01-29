import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { KitchenEngine } from '@/lib/kitchen_engine';
import { PrismaAdapter } from '@/lib/prisma_adapter';

export async function GET() {
    try {
        // 1. Metrics
        const activeOrdersCount = await prisma.order.count({
            where: { status: { not: 'completed' } }
        });

        // 2. Weekly Revenue (Chart Data) & Total Revenue (Metric)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        // Chart Data (Last 7 Days)
        const ordersLast7Days = await prisma.order.findMany({
            where: {
                created_at: { gte: sevenDaysAgo },
                status: { not: 'pending' }
            },
            select: {
                created_at: true,
                total_amount: true
            }
        });

        // Total Revenue (All Time)
        // Using aggregate is more efficient than fetching all - matching Orders Page logic (ALL orders)
        const totalRevenueAgg = await prisma.order.aggregate({
            _sum: { total_amount: true }
        });
        // Use optional chaining for safety
        const revenue = Number(totalRevenueAgg._sum?.total_amount || 0);

        // Bucket by Day for Chart
        const daysMap = new Map<string, { amount: number, orders: number, date: Date }>();
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        // Initialize last 7 days (including today)
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = days[d.getDay()];
            daysMap.set(key, { amount: 0, orders: 0, date: d });
        }

        ordersLast7Days.forEach(o => {
            if (!o.created_at) return;
            const dayName = days[o.created_at.getDay()];
            const amount = Number(o.total_amount);

            const entry = daysMap.get(dayName);
            if (entry) {
                entry.amount += amount;
                entry.orders += 1;
            }
        });

        const weeklyBreakdown = Array.from(daysMap.entries()).map(([day, data]) => ({
            day,
            amount: data.amount,
            orders: data.orders
        }));

        // 2. Low Stock Ingredients (Active Tracking)
        const lowStock = await prisma.ingredient.findMany({
            where: { stock_quantity: { lt: 20 } }, // Threshold < 20 units
            take: 5,
            orderBy: { stock_quantity: 'asc' },
            select: { name: true, stock_quantity: true, unit: true, supplier: { select: { name: true } } }
        });

        // 3. Recent Activity (Orders + Social)
        const recentOrders = await prisma.order.findMany({
            take: 5,
            orderBy: { created_at: 'desc' },
            include: { organization: true }
        });

        let recentSocial: any[] = [];
        try {
            recentSocial = await prisma.activity.findMany({
                take: 5,
                orderBy: { timestamp: 'desc' },
                where: { status: 'unread' }
            });
        } catch (e) {
            console.warn("Activity table not found or accessible yet. Skipping social feed.");
        }


        // 4. Production Demand (Active Queue Breakdown)
        const demandAgg = await prisma.orderItem.groupBy({
            by: ['variant_size'],
            _sum: { quantity: true },
            where: {
                order: { status: { not: 'completed' } }
            }
        });

        const demandBreakdown = {
            family: 0,
            couple: 0,
            single: 0,
            total: 0
        };

        demandAgg.forEach((group: any) => {
            const qty = group._sum.quantity || 0;
            demandBreakdown.total += qty;
            if (group.variant_size === 'serves_5') demandBreakdown.family += qty;
            if (group.variant_size === 'serves_2') demandBreakdown.couple += qty;
        });

        // 5. Calculate Theoretical Food Cost (Last 7 Days)

        const ordersForCost = await prisma.order.findMany({
            where: {
                created_at: { gte: sevenDaysAgo },
                status: { not: 'pending' }
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        let totalCOGS = 0;
        let totalRevenueForCost = 0;

        const dbAdapter = new PrismaAdapter();
        const engine = new KitchenEngine(dbAdapter);
        const bundleCostCache = new Map<string, number>();

        for (const order of ordersForCost) {
            totalRevenueForCost += Number(order.total_amount);
            for (const item of order.items) {
                if (!item.bundle_id) continue;
                const cacheKey = `${item.bundle_id}-${item.variant_size}`;
                let unitCost = bundleCostCache.get(cacheKey);
                if (unitCost === undefined) {
                    try {
                        unitCost = await engine.calculateBundleCost(item.bundle_id, item.variant_size);
                        bundleCostCache.set(cacheKey, unitCost);
                    } catch (e) {
                        unitCost = 0;
                    }
                }
                totalCOGS += (unitCost * item.quantity);
            }
        }

        const foodCostPercentage = totalRevenueForCost > 0
            ? Math.round((totalCOGS / totalRevenueForCost) * 100)
            : 0;

        // Map Orders to Activity Format
        const orderActivities = recentOrders.map((o: any) => ({
            id: o.external_id,
            type: 'order',
            title: 'New Order',
            customer: o.organization?.name || o.customer_name || 'Guest',
            amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(o.total_amount) || 0),
            status: o.status === 'production_ready' ? 'Ready' : (o.status === 'completed' ? 'Completed' : 'Pending'),
            date: o.created_at,
            customerId: o.organization?.id || (o.customer_name ? encodeURIComponent(o.customer_name) : undefined)
        }));

        // Map Social to Activity Format
        const socialActivities = recentSocial.map((a: any) => ({
            id: a.external_id,
            type: a.type,
            title: a.type === 'comment' ? 'FB Comment' : a.type === 'message' ? 'FB Message' : 'New Lead',
            customer: a.customer_name || 'Anonymous',
            content: a.content,
            status: a.status,
            date: a.timestamp,
            customerId: a.customer_id
        }));

        const allActivity = [...orderActivities, ...socialActivities]
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 10);

        return NextResponse.json({
            metrics: {
                activeOrders: activeOrdersCount,
                revenue: revenue,
                productionProgress: 40,
                foodCost: foodCostPercentage
            },
            weeklyRevenue: weeklyBreakdown,
            lowStock,
            productionDemand: demandBreakdown,
            recentActivity: allActivity
        });

    } catch (e) {
        console.error("Dashboard API Error:", e);
        return NextResponse.json({ error: "Failed to fetch dashboard stats" }, { status: 500 });
    }
}
