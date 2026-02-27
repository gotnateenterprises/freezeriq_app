import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';

export async function POST() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return new NextResponse('Unauthorized', { status: 401 });
        }

        const business = await prisma.business.findUnique({
            where: { id: session.user.businessId }
        });

        if (!business?.stripe_account_id) {
            return new NextResponse('No connected Stripe account found', { status: 404 });
        }

        // Fetch the account from Stripe to verify capabilities
        const account = await stripe.accounts.retrieve(business.stripe_account_id);

        if (account.details_submitted) {
            await prisma.business.update({
                where: { id: business.id },
                data: {
                    stripe_onboarding_complete: true,
                    charges_enabled: account.charges_enabled
                }
            });
            return NextResponse.json({ success: true, verified: true });
        }

        return NextResponse.json({ success: true, verified: false });

    } catch (error: any) {
        console.error('[STRIPE_VERIFY]', error);
        return new NextResponse(error.message || 'Internal Error', { status: 500 });
    }
}
