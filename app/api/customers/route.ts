import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const filterType = searchParams.get('type'); // 'organization' | 'individual'
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const user = session.user as any;
        const userPlan = user.plan;
        const isSuperAdmin = user.isSuperAdmin;

        const hasAccess = userPlan === 'ENTERPRISE' || userPlan === 'ULTIMATE' || userPlan === 'FREE' || isSuperAdmin;
        if (!hasAccess) {
            return NextResponse.json({ error: "Upgrade required" }, { status: 403 });
        }

        const businessId = session.user.businessId;

        // 1. Fetch Organizations (B2B Customers)
        const orgs = await prisma.customer.findMany({
            where: {
                business_id: businessId
            },
            select: {
                id: true,
                name: true,
                type: true,
                contact_email: true,
                contact_name: true,
                status: true,
                archived: true,
                tags: true,
                stripe_subscription_id: true,
                subscription_status: true,
                orders: {
                    select: {
                        created_at: true,
                        total_amount: true,
                        status: true
                    }
                }
            }
        });

        // 2. Fetch Orders with manual customer names (B2C from Square)
        const individualOrders = await prisma.order.findMany({
            where: {
                business_id: businessId,
                customer_id: null,
                customer_name: { not: null }
            },
            select: {
                customer_name: true,
                created_at: true,
                total_amount: true,
                source: true,
                status: true
                // In some versions we might have customer_email here if we added it, 
                // but let's stick to what's in the schema.
            }
        });

        const customers = [];

        // Determine which organizations to include based on filter
        let organizationsToProcess: any[] = [];
        if (filterType === 'organization') {
            organizationsToProcess = orgs.filter(o => o.type === 'fundraiser_org' || o.type === 'organization');
        } else if (filterType === 'individual') {
            organizationsToProcess = orgs.filter(o => o.type === 'direct_customer');
        } else {
            organizationsToProcess = orgs;
        }

        // Process Orgs
        for (const org of organizationsToProcess) {
            const orgAny = org as any;
            customers.push({
                id: org.id,
                name: org.name,
                contact_name: org.contact_name,
                type: org.type === 'direct_customer' ? 'Individual' :
                    org.type === 'organization' ? 'Organization' : 'Fundraiser',
                email: org.contact_email || '', // Standardize on 'email' for frontend
                contact_email: org.contact_email || '', // Keep for compatibility
                status: orgAny.status || 'ACTIVE',
                archived: orgAny.archived || false,
                tags: orgAny.tags || [],
                stripe_subscription_id: orgAny.stripe_subscription_id || null,
                subscription_status: orgAny.subscription_status || null,
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orgAny.orders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                ),
                last_order: orgAny.orders.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]?.created_at || new Date(),
                order_count: orgAny.orders.length,
                orders: org.orders
            });
        }

        // Process Individuals (Simple aggregation) - Only if not filtering for organizations
        if (filterType !== 'organization') {
            const indMap = new Map();
            for (const ord of individualOrders) {
                const name = ord.customer_name!;
                if (!indMap.has(name)) {
                    indMap.set(name, { count: 0, last: new Date(0), total: 0, orders: [], email: '' });
                }
                const entry = indMap.get(name);
                entry.count++;
                entry.total += Number((ord as any).total_amount) || 0;
                entry.orders.push({ status: ord.status, total_amount: ord.total_amount, created_at: ord.created_at });

                if (ord.source) {
                    if (ord.source === 'qbo') entry.source = 'QBO';
                    else if (ord.source === 'manual') entry.source = 'Manual';
                    else entry.source = 'Square';
                }

                if (ord.created_at && new Date(ord.created_at) > entry.last) {
                    entry.last = new Date(ord.created_at);
                }
            }

            for (const [name, data] of Array.from(indMap.entries())) {
                const d = data as any;
                customers.push({
                    id: name,
                    name: name,
                    type: 'Individual',
                    email: d.email || '',
                    contact_email: d.email || '',
                    total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(d.total) || 0),
                    last_order: d.last,
                    order_count: d.count,
                    source: d.source || 'Square',
                    status: 'ACTIVE',
                    tags: [],
                    orders: d.orders
                });
            }

            // Calculate Metrics
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            sevenDaysAgo.setHours(0, 0, 0, 0);

            let weeklyRevenue = 0;
            const inProgressCount = customers.filter(c => c.status === 'ACTIVE').length;

            customers.forEach(c => {
                (c.orders || []).forEach((o: any) => {
                    if (o.created_at && new Date(o.created_at) >= sevenDaysAgo) {
                        weeklyRevenue += Number(o.total_amount) || 0;
                    }
                });
            });

            return NextResponse.json({
                customers: customers.sort((a, b) => a.name.localeCompare(b.name)),
                weeklyRevenue,
                inProgressCount
            });
        }

        // Return organization filtered result
        return NextResponse.json({
            customers: customers.sort((a, b) => a.name.localeCompare(b.name)),
            weeklyRevenue: 0,
            inProgressCount: 0
        });

    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { name, contact_name, contact_email, contact_phone, type, notes, delivery_address } = body;

        if (!name) {
            return NextResponse.json({ error: "Name is required" }, { status: 400 });
        }

        let dbType: 'direct_customer' | 'organization' | 'fundraiser_org' = 'direct_customer';
        if (type === 'Organization') dbType = 'organization';
        if (type === 'Fundraiser') dbType = 'fundraiser_org';

        const customer = await prisma.customer.create({
            data: {
                name,
                contact_name,
                business_id: session.user.businessId,
                contact_email,
                contact_phone,
                type: dbType,
                notes,
                // @ts-ignore
                delivery_address: delivery_address,
                status: 'LEAD',
                source: 'Manual',
                external_id: `man_${Date.now()}`
            }
        });

        return NextResponse.json(customer);
    } catch (e: any) {
        console.error("Failed to create customer:", e);
        return NextResponse.json({ error: e.message || "Failed to create customer" }, { status: 500 });
    }
}
