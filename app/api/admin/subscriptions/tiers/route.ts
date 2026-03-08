import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { stripe } from '@/lib/stripe';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // TODO: Implement SubscriptionTier in Prisma schema
        // const tiers = await prisma.subscriptionTier.findMany({
        //     where: { business_id: session.user.businessId },
        //     orderBy: { price: 'asc' }
        // });

        return NextResponse.json([]);
    } catch (error: any) {
        console.error('[TIERS_GET]', error);
        return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
    }
}

export async function POST(req: Request) {
    return NextResponse.json({ error: 'Subscriptions are currently in development.' }, { status: 501 });
}
