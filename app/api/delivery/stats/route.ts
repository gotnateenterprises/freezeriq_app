import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function GET() {
    try {
        // Fetch all pending or production-ready orders
        // (Status: pending, production_ready)
        const activeOrders = await prisma.order.findMany({
            where: {
                status: { in: ['pending', 'production_ready'] }
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        let largeBoxesNeeded = 0;
        let smallBoxesNeeded = 0;

        // Logic: 
        // Family -> 1 Large Box
        // Serves 2 / Single -> 1 Small Box
        // Or based on item count? (User said bundle size determines box)

        activeOrders.forEach(order => {
            order.items.forEach(item => {
                const bundle = item.bundle;
                if (!bundle) return;

                // Smart Mapping
                // Note: bundle.serving_tier is 'family', 'couple', 'single'
                // Or check Bundle name

                const tier = bundle.serving_tier?.toLowerCase() || '';
                const name = bundle.name?.toLowerCase() || '';

                if (tier === 'family' || name.includes('family')) {
                    largeBoxesNeeded += item.quantity;
                } else {
                    // Default fallback to small box for everything else (couple, single)
                    smallBoxesNeeded += item.quantity;
                }
            });
        });

        return NextResponse.json({
            largeBoxesNeeded,
            smallBoxesNeeded,
            totalActiveOrders: activeOrders.length
        });

    } catch (e) {
        console.error(e);
        return NextResponse.json({ error: "Failed to calculate stats" }, { status: 500 });
    }
}
