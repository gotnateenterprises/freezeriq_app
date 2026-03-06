import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: List all production runs for the business
export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const runs = await prisma.productionRun.findMany({
            where: { business_id: session.user.businessId },
            orderBy: { run_date: 'desc' },
            include: {
                _count: {
                    select: { tasks: true }
                }
            }
        });
        return NextResponse.json(runs);
    } catch (error) {
        console.error("Fetch Production Runs Error:", error);
        return NextResponse.json({ error: 'Failed to fetch runs' }, { status: 500 });
    }
}

// POST: Create a new production run
export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, run_date, planFromOrders } = body;

        let tasks: any[] = [];

        if (planFromOrders) {
            // 1. Fetch pending orders and explode them via KitchenEngine
            const { PrismaAdapter } = await import('@/lib/prisma_adapter');
            const { KitchenEngine } = await import('@/lib/kitchen_engine');

            const db = new PrismaAdapter(session.user.businessId);
            const engine = new KitchenEngine(db);

            const orders = await db.getProductionOrders();
            if (orders.length === 0) {
                return NextResponse.json({ error: 'No pending or production-ready orders found.' }, { status: 400 });
            }

            const plan = await engine.generateProductionRun(orders);

            // 2. Map prepTasks to ProductionTask format
            // KitchenEngine returns prepTasks as a Record<RecipeName, {qty, id, unit...}>
            tasks = Object.values(plan.prepTasks).map((t: any) => ({
                item_id: t.id, // Recipe ID
                item_type: 'recipe',
                total_qty_needed: t.qty,
                unit: t.unit,
                status: 'todo'
            }));
        }

        const run = await prisma.productionRun.create({
            data: {
                name: name || (planFromOrders ? `Auto-Generated: ${new Date().toLocaleDateString()}` : 'New Production Run'),
                run_date: new Date(run_date),
                status: 'planning',
                business_id: session.user.businessId,
                tasks: {
                    create: tasks
                }
            },
            include: {
                _count: {
                    select: { tasks: true }
                }
            }
        });

        return NextResponse.json(run);
    } catch (error: any) {
        console.error("Create Production Run Error:", error);
        return NextResponse.json({ error: error.message || 'Failed to create run' }, { status: 500 });
    }
}
