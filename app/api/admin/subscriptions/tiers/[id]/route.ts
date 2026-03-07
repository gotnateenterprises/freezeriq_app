import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const session = await auth();
        if (!session?.user?.businessId) {
            return new NextResponse('Unauthorized', { status: 401 });
        }

        const body = await req.json();
        const { is_active } = body;

        // Verify the tier belongs to this business
        // @ts-ignore
        const tier = await prisma.subscriptionTier.findFirst({
            where: {
                id: id,
                business_id: session.user.businessId
            }
        });

        if (!tier) {
            return new NextResponse('Tier not found', { status: 404 });
        }

        // @ts-ignore
        const updatedTier = await prisma.subscriptionTier.update({
            where: { id: id },
            data: { is_active }
        });

        // Note: We don't necessarily delete the Stripe Product/Price when deactivated, 
        // we just hide it from the Storefront so new people can't subscribe.

        return NextResponse.json(updatedTier);
    } catch (error: any) {
        console.error('[TIER_PATCH]', error);
        return new NextResponse(error.message || 'Internal Error', { status: 500 });
    }
}
