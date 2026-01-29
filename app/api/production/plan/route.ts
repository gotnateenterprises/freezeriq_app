import { NextResponse } from 'next/server';
import { KitchenEngine } from '@/lib/kitchen_engine';
import { PrismaAdapter } from '@/lib/prisma_adapter';

export async function POST(request: Request) {
    try {
        const requestBody = await request.json();

        if (!requestBody.use_live_orders && !requestBody.orders && (!requestBody.bundle_id || !requestBody.quantity)) {
            return NextResponse.json(
                { error: 'Missing orders array or legacy bundle_id/quantity' },
                { status: 400 }
            );
        }

        // Initialize Engine
        const db = new PrismaAdapter();
        const engine = new KitchenEngine(db);

        let orders = [];

        if (requestBody.use_live_orders) {
            // Fetch REAL orders from DB
            orders = await db.getProductionOrders();
        } else if (Array.isArray(requestBody.orders)) {
            // Multi-Bundle Mode
            orders = requestBody.orders.map((o: any) => ({
                bundle_id: o.bundle_id,
                quantity: Number(o.quantity),
                variant_size: 'serves_2' // Default, or pass from UI if we add scaling selector later
            }));
        } else {
            // Legacy Single Mode (Simulator)
            orders = [{
                bundle_id: requestBody.bundle_id,
                quantity: Number(requestBody.quantity),
                variant_size: 'serves_2'
            }];
        }

        const result = await engine.generateProductionRun(orders);

        return NextResponse.json(result);

    } catch (e: any) {
        console.error("Production Plan Error:", e);
        return NextResponse.json(
            {
                error: `Failed to generate production plan: ${e.message}`,
                details: e.stack,
                debug_orders: 'See server console'
            },
            { status: 500 }
        );
    }
}
