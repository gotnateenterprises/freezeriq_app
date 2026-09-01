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

        // OPS-4: aggregate by (bundle_id, variant_size), never bundle_id alone.
        // OrderItem.variant_size is the frozen historical snapshot of the tier
        // actually sold (docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §4). The
        // previous bundle_id-only key discarded it from this endpoint's output
        // entirely, so a synced Serves-2 order — correctly tiered by
        // getProductionOrders() above — silently became untiered here, and the
        // Manual Planner's "Calculate Plan" step then defaulted it to
        // Serves-5/family, roughly doubling ingredient demand.
        const aggregated = rawOrders.reduce((acc, curr) => {
            const bid = curr.bundle_id;
            const variant = curr.variant_size ?? null;
            const key = `${bid}::${variant ?? ''}`;
            if (!acc[key]) {
                acc[key] = { bundle_id: bid, quantity: 0, variant_size: variant };
            }
            acc[key].quantity += curr.quantity;
            return acc;
        }, {} as Record<string, { bundle_id: string; quantity: number; variant_size: string | null }>);

        return NextResponse.json(Object.values(aggregated));
    } catch (e: any) {
        console.error('Failed to sync production orders:', e);
        return NextResponse.json({ error: 'Failed to sync orders' }, { status: 500 });
    }
}
