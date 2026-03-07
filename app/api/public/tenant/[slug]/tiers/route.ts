import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(
    req: Request,
    { params }: { params: Promise<{ slug: string }> }
) {
    try {
        const { slug } = await params;

        // Find the business by slug
        const business = await prisma.business.findUnique({
            where: { slug },
            select: { id: true, name: true }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }

        // Fetch active subscription tiers
        const tiers = await prisma.subscriptionTier.findMany({
            where: {
                business_id: business.id,
                is_active: true
            },
            orderBy: {
                price: 'asc' // Order from cheapest to most expensive
            },
            select: {
                id: true,
                name: true,
                stripe_price_id: true,
                stripe_product_id: true,
                meal_credits_per_cycle: true,
                price: true,
            }
        });

        return NextResponse.json({ tiers });

    } catch (error: any) {
        console.error('[Public Tiers API] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
