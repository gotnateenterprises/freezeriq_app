import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { KitchenEngine } from '@/lib/kitchen_engine';
import { PrismaAdapter } from '@/lib/prisma_adapter';
import { STATUS_LABELS, type CustomerStatus } from '@/lib/statusConstants';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Fetch business details
        const business = await prisma.business.findUnique({
            where: { id: session.user.businessId },
            select: { plan: true, google_calendar_url: true }
        });

        const isUltimate = business?.plan === 'ULTIMATE';
        const businessId = session.user.businessId;

        if (!isUltimate) {
            // Return restricted dashboard for non-Ultimate plans
            return NextResponse.json({
                metrics: {
                    activeOrders: 0,
                    activeOrdersGrowth: 0,
                    revenue: 0,
                    revenueGrowth: 0,
                    productionProgress: 0,
                    foodCost: 0,
                    foodCostGrowth: 0,
                    restricted: true
                },
                weeklyRevenue: [],
                lowStock: [],
                productionDemand: { family: 0, couple: 0, single: 0, total: 0 },
                recentActivity: [],
                calendarUrl: business?.google_calendar_url || ''
            });
        }

        // Fetch Business Metadata (Calendar URL)
        const businessParams = await prisma.business.findUnique({
            where: { id: businessId },
            select: { google_calendar_url: true }
        });

        // 1. Metrics - Active Orders (Now Customers in Production)
        const activeOrdersCount = await prisma.customer.count({
            where: {
                status: 'PRODUCTION',
                business_id: businessId
            }
        });

        // 2. Weekly Revenue (Chart Data) & Weekly In-Progress Orders
        const now = new Date();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(now.getDate() - 7);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const fourteenDaysAgo = new Date();
        fourteenDaysAgo.setDate(now.getDate() - 14);
        fourteenDaysAgo.setHours(0, 0, 0, 0);

        const inProgressStatuses = ['pending', 'production_ready', 'delivered'];

        // This Week's Data (Last 7 Days)
        const ordersThisWeek = await prisma.order.findMany({
            where: {
                created_at: { gte: sevenDaysAgo },
                business_id: businessId
                // We fetch all non-deleted orders and filter in code to be consistent
            },
            select: {
                created_at: true,
                total_amount: true,
                status: true,
                items: {
                    include: { bundle: true }
                }
            }
        });

        const revenueThisWeek = ordersThisWeek
            .filter(o => o.status !== 'pending') // Revenue usually doesn't count pending
            .reduce((sum, o) => sum + Number(o.total_amount), 0);

        const inProgressThisWeek = ordersThisWeek
            .filter(o => inProgressStatuses.includes((o.status || '').toLowerCase()))
            .length;

        // Last Week's Data (Days 8-14)
        const ordersLastWeek = await prisma.order.findMany({
            where: {
                created_at: { gte: fourteenDaysAgo, lt: sevenDaysAgo },
                business_id: businessId
            },
            select: {
                total_amount: true,
                status: true,
                items: {
                    include: { bundle: true }
                }
            }
        });

        const revenueLastWeek = ordersLastWeek
            .filter(o => o.status !== 'pending')
            .reduce((sum, o) => sum + Number(o.total_amount), 0);

        const inProgressLastWeek = ordersLastWeek
            .filter(o => inProgressStatuses.includes((o.status || '').toLowerCase()))
            .length;

        // Monthly Revenue (Current Month vs Last Month)
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        const ordersThisMonth = await prisma.order.findMany({
            where: {
                created_at: { gte: startOfMonth },
                status: { not: 'pending' },
                business_id: businessId
            },
            select: { total_amount: true }
        });

        const ordersLastMonth = await prisma.order.findMany({
            where: {
                created_at: { gte: startOfLastMonth, lte: endOfLastMonth },
                status: { not: 'pending' },
                business_id: businessId
            },
            select: { total_amount: true }
        });

        const revenueThisMonth = ordersThisMonth.reduce((sum, o) => sum + Number(o.total_amount), 0);
        const revenueLastMonthForGrowth = ordersLastMonth.reduce((sum, o) => sum + Number(o.total_amount), 0);

        // Growth Calculation Helper
        const calculateGrowth = (current: number, previous: number) => {
            if (previous === 0) return current > 0 ? 100 : 0;
            return Math.round(((current - previous) / previous) * 100);
        };

        const revenueMonthGrowth = calculateGrowth(revenueThisMonth, revenueLastMonthForGrowth);
        const currentMonthName = now.toLocaleString('default', { month: 'long' });

        const revenueGrowth = calculateGrowth(revenueThisWeek, revenueLastWeek);
        const ordersGrowth = calculateGrowth(inProgressThisWeek, inProgressLastWeek);

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

        ordersThisWeek.forEach(o => {
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
            where: {
                stock_quantity: { lt: 20 },
                business_id: businessId
            }, // Threshold < 20 units
            take: 5,
            orderBy: { stock_quantity: 'asc' },
            select: { name: true, stock_quantity: true, unit: true, supplier: { select: { name: true } } }
        });

        // 3. Recent Activity (Orders + Social)
        const recentOrders = await prisma.order.findMany({
            where: {
                status: { not: 'delivered' as any },
                business_id: businessId
            },
            take: 5,
            orderBy: { created_at: 'desc' },
            include: { customer: true }
        });

        let recentSocial: any[] = [];
        try {
            recentSocial = await prisma.activity.findMany({
                take: 10, // Increased
                orderBy: { timestamp: 'desc' },
                where: {
                    type: { in: ['message', 'comment'] },
                    status: { not: 'archived' }, // Show regular messages even if read/replied
                    business_id: businessId
                }
            });
        } catch (e) {
            console.warn("Activity table not found or accessible yet. Skipping social feed.");
        }

        // 4. Production Demand (Active Queue Breakdown)
        // Note: For "Production Demand", we specifically care about items not yet ready to ship.
        const demandAgg = await prisma.orderItem.groupBy({
            by: ['variant_size'],
            _sum: { quantity: true },
            where: {
                production_status: { in: ['PENDING', 'PREPPING'] },
                order: {
                    status: { notIn: ['COMPLETED', 'DELIVERED'] as any },
                    business_id: businessId
                }
            }
        });

        // Count orders that HAVE those statuses but NO items (fallback to sizing based on price)
        const unmappedOrders = await prisma.order.findMany({
            where: {
                status: { in: ['APPROVED', 'IN_PRODUCTION', 'PENDING'] as any },
                items: { none: {} },
                business_id: businessId
            },
            select: { total_amount: true }
        });

        const demandBreakdown = {
            family: 0,
            couple: 0,
            single: 0,
            total: 0
        };

        // Add unmapped orders based on price
        unmappedOrders.forEach(o => {
            const amount = Number(o.total_amount);
            demandBreakdown.total += 1;
            if (amount >= 110) { // $125 threshold
                demandBreakdown.family += 1;
            } else if (amount >= 50) { // $60 threshold
                demandBreakdown.couple += 1;
            } else {
                demandBreakdown.family += 1; // Default fallback
            }
        });

        demandAgg.forEach((group: any) => {
            const qty = group._sum.quantity || 0;
            demandBreakdown.total += qty;
            if (group.variant_size === 'serves_5') demandBreakdown.family += qty;
            else if (group.variant_size === 'serves_2') demandBreakdown.couple += qty;
            else demandBreakdown.family += qty; // Fallback for anything else
        });

        // 5. Calculate Theoretical Food Cost (This Week vs Last Week)
        const dbAdapter = new PrismaAdapter(businessId);
        const engine = new KitchenEngine(dbAdapter);

        const calculateCOGS = async (orders: any[]) => {
            if (orders.length === 0) return 0;

            // 1. Map orders to Kitchen Engine format
            const engineOrders: { bundle_id: string, quantity: number, variant_size: any }[] = [];
            orders.forEach(o => {
                o.items?.forEach((item: any) => {
                    if (item.bundle_id) {
                        engineOrders.push({
                            bundle_id: item.bundle_id,
                            quantity: item.quantity || 1,
                            variant_size: item.variant_size || 'serves_5'
                        });
                    }
                });
            });

            if (engineOrders.length === 0) return 0;

            // 2. Explode the recipes for the entire week
            try {
                const plan = await engine.generateProductionRun(engineOrders);
                let totalCOGS = 0;

                // 3. Apply the exact Math.ceil PO logic from the Shopping List
                Object.values(plan.rawIngredients).forEach((val: any) => {
                    const needed = val.qty || 0;
                    // For theoretical food cost tracking over time, we ignore current onHand inventory,
                    // otherwise weeks with lots of legacy stock will look artificially "free"
                    const toBuy = needed;

                    const purchaseQuantity = val.purchaseQuantity;

                    if (toBuy > 0 && purchaseQuantity && purchaseQuantity > 0 && val.purchaseCost !== undefined) {
                        const casesToOrder = Math.ceil(toBuy / purchaseQuantity);
                        totalCOGS += (casesToOrder * val.purchaseCost);
                    } else {
                        // Fallback strictly to unit cost if no purchase params defined
                        totalCOGS += (toBuy * (val.costPerUnit || 0));
                    }
                });

                return totalCOGS;
            } catch (e) {
                console.error("Failed to calculate explicit COGS:", e);
                return 0;
            }
        };

        const cogsThisWeek = await calculateCOGS(ordersThisWeek);
        const cogsLastWeek = await calculateCOGS(ordersLastWeek);

        const foodCostThisWeek = revenueThisWeek > 0 ? Math.round((cogsThisWeek / revenueThisWeek) * 100) : 0;
        const foodCostLastWeek = revenueLastWeek > 0 ? Math.round((cogsLastWeek / revenueLastWeek) * 100) : 0;

        const foodCostGrowth = foodCostLastWeek === 0 ? 0 : Math.round(((foodCostThisWeek - foodCostLastWeek) / foodCostLastWeek) * 100);

        // Map Orders to Activity Format
        const orderActivities = recentOrders.map((o: any) => {
            let label = 'Pending';
            if (o.customer?.status) {
                label = STATUS_LABELS[o.customer.status as CustomerStatus] || o.customer.status;
            } else {
                // Better Fallbacks for unlinked orders
                if (o.status === 'production_ready') label = 'In Progress';
                else if (o.status === 'completed') label = 'Ready';
                else if (o.status === 'delivered') label = 'Completed';
            }

            return {
                id: o.external_id,
                type: 'order',
                title: 'New Order',
                customer: o.customer?.name || o.customer_name || 'Guest',
                amount: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(o.total_amount) || 0),
                status: label,
                date: o.created_at,
                customerId: o.customer?.id || (o.customer_name ? encodeURIComponent(o.customer_name) : undefined)
            };
        });

        // Map Social to Activity Format
        const socialActivities = recentSocial.map((a: any) => {
            const metadataStr = typeof a.metadata === 'string' ? a.metadata : JSON.stringify(a.metadata);
            let metadataObj: any = {};
            try {
                if (metadataStr) metadataObj = JSON.parse(metadataStr);
            } catch (e) { }

            const threadId = metadataObj?.recipientId || metadataObj?.senderId || a.customer_id || a.customer_name || 'Unknown';

            return {
                id: a.id, // Use internal ID
                external_id: a.external_id,
                type: a.type,
                title: a.type === 'comment' ? 'FB Comment' : a.type === 'message' ? 'FB Message' : 'New Lead',
                customer: a.customer_name || 'Anonymous',
                content: a.content,
                status: a.status,
                date: a.timestamp,
                customerId: a.customer_id,
                threadId: threadId,
                metadata: a.metadata
            };
        });

        const recentOrdersActivity = orderActivities
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 10);

        const recentSocialActivity = socialActivities
            .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .slice(0, 10);

        // Calculate Production Progress from DB runs
        const activeRun = await prisma.productionRun.findFirst({
            where: {
                business_id: businessId,
                status: { in: ['planning', 'active'] }
            },
            include: {
                tasks: true
            },
            orderBy: {
                run_date: 'desc'
            }
        });

        let databaseProductionProgress = 0;
        if (activeRun && activeRun.tasks.length > 0) {
            const completedTasks = activeRun.tasks.filter(t => t.status === 'done').length;
            databaseProductionProgress = Math.round((completedTasks / activeRun.tasks.length) * 100);
        }

        // Check if Meta is connected
        const metaIntegration = await prisma.integration.findFirst({
            where: { provider: 'meta', business_id: businessId }
        });
        const metaConnected = !!metaIntegration;

        return NextResponse.json({
            metrics: {
                activeOrders: inProgressThisWeek,
                activeOrdersGrowth: ordersGrowth,
                revenue: revenueThisMonth,
                revenueGrowth: revenueMonthGrowth,
                currentMonth: currentMonthName,
                productionProgress: databaseProductionProgress,
                foodCost: foodCostThisWeek,
                foodCostGrowth: foodCostGrowth
            },
            weeklyRevenue: weeklyBreakdown,
            lowStock,
            productionDemand: demandBreakdown,
            recentActivity: recentOrdersActivity,
            socialFeed: recentSocialActivity,
            metaConnected: metaConnected,
            calendarUrl: businessParams?.google_calendar_url || ''
        });
    } catch (e) {
        console.error("Dashboard API Error:", e);
        return NextResponse.json({ error: "Failed to fetch dashboard stats" }, { status: 500 });
    }
}
