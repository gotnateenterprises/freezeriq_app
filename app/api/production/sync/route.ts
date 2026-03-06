import { NextResponse } from 'next/server';
import { PrismaAdapter } from '@/lib/prisma_adapter';

export async function GET() {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        const businessId = session.user.businessId;

        const db = new PrismaAdapter(businessId);
        const rawOrders = await db.getProductionOrders();

        // Aggregate by bundle_id
        const aggregated = rawOrders.reduce((acc, curr) => {
            const bid = curr.bundle_id;
            if (!acc[bid]) {
                acc[bid] = { bundle_id: bid, quantity: 0 };
            }
            acc[bid].quantity += curr.quantity;
            return acc;
        }, {} as Record<string, { bundle_id: string; quantity: number }>);

        return NextResponse.json(Object.values(aggregated));
    } catch (e: any) {
        console.error('Failed to sync production orders:', e);
        return NextResponse.json({ error: 'Failed to sync orders' }, { status: 500 });
    }
}
