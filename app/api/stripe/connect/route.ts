import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { headers } from 'next/headers';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return new NextResponse('Unauthorized', { status: 401 });
        }

        const business = await prisma.business.findUnique({
            where: { id: session.user.businessId }
        });

        if (!business) {
            return new NextResponse('Business not found', { status: 404 });
        }

        let accountId = business.stripe_account_id;

        // 1. Create a Stripe Express Account if they don't have one
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true }      // Allow platform to send them money
                },
                business_type: 'company',
                company: {
                    name: business.name
                }
            });

            accountId = account.id;

            await prisma.business.update({
                where: { id: business.id },
                data: { stripe_account_id: accountId }
            });
        }

        // 2. Draft the Return URL (Back to their Admin settings)
        const requestHeaders = await headers();
        const origin = requestHeaders.get('origin') || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

        // Ensure standard protocol for URLs
        const baseUrl = origin.startsWith('http') ? origin : `https://${origin}`;

        // 3. Generate the actual Stripe Hosted Onboarding Link
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${baseUrl}/admin/settings/billing`,
            return_url: `${baseUrl}/admin/settings/billing?stripe_connected=true`,
            type: 'account_onboarding',
        });

        return NextResponse.json({ url: accountLink.url });

    } catch (error: any) {
        console.error('[STRIPE_CONNECT]', error);
        return NextResponse.json({ error: error.message || 'Internal Error' }, { status: 500 });
    }
}
