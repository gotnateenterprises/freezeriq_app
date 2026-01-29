
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
    try {
        // 1. Fetch Organizations (B2B Customers)
        const orgs = await prisma.organization.findMany({
            include: {
                orders: {
                    select: { created_at: true, total_amount: true }
                }
            }
        });

        // 2. Fetch Orders with manual customer names (B2C from Square)
        // Grouping by name isn't natively supported easily in one go with Prisma + SQLite/Postgres differences,
        // so we'll fetch manual orders and aggregate in JS for MVP.
        const individualOrders = await prisma.order.findMany({
            where: {
                organization_id: null,
                customer_name: { not: null }
            },
            select: {
                customer_name: true,
                created_at: true,
                total_amount: true,
                source: true
            }
        });

        const customers = [];

        // Process Orgs
        for (const org of orgs) {
            const orgAny = org as any;
            customers.push({
                id: org.id,
                name: org.name,
                type: 'Organization',
                email: org.contact_email,
                source: orgAny.source || 'Manual',
                status: orgAny.status || 'Active',
                tags: orgAny.tags || [],
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orgAny.orders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                ),
                last_order: orgAny.orders.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]?.created_at || new Date(),
                order_count: orgAny.orders.length
            });
        }

        // Process Individuals (Simple aggregation)
        const indMap = new Map();
        for (const ord of individualOrders) {
            const name = ord.customer_name!;
            if (!indMap.has(name)) {
                indMap.set(name, { count: 0, last: new Date(0), total: 0 });
            }
            const entry = indMap.get(name);
            entry.count++;
            entry.total += Number((ord as any).total_amount) || 0;
            // Simple heuristic: Take last source seen
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
            customers.push({
                id: name,
                name: name,
                type: 'Individual',
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data.total),
                last_order: data.last,
                order_count: data.count,
                source: data.source || 'Square', // Default to Square for unlinked checks
                status: 'Active', // Simple default
                tags: []
            });
        }

        return NextResponse.json(customers.sort((a, b) => b.order_count - a.order_count));

    } catch (e) {
        return NextResponse.json({ error: "Failed to fetch customers" }, { status: 500 });
    }
}
