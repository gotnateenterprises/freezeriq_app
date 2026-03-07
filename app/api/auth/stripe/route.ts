import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';

export async function GET(req: Request) {
    const session = await auth();
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch user with its business relationship to find the active business and existing integrations
    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        include: {
            business: {
                include: {
                    integrations: true
                }
            }
        }
    });

    if (!user || !user.business) {
        return NextResponse.json({ error: 'No active business found' }, { status: 400 });
    }

    const business = user.business;

    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    try {
        let accountId: string;

        // Find if they already have an existing stripe integration saved in the DB
        const existingStripe = business.integrations.find(i => i.provider === 'stripe');

        if (existingStripe && existingStripe.access_token) {
            accountId = existingStripe.access_token;
        } else {
            // 1. Create a fresh Standard Stripe Account representing this tenant
            const account = await stripe.accounts.create({
                type: 'standard',
                business_profile: {
                    name: business.name
                },
                metadata: {
                    businessId: business.id
                }
            });
            accountId = account.id;
        }

        // 2. Generate the onboarding link utilizing the new Accounts V2 approach
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${appUrl}/settings?error=stripe_refresh`,
            return_url: `${appUrl}/api/auth/stripe/callback?account_id=${accountId}&business_id=${business.id}`,
            type: 'account_onboarding',
        });

        // Redirect the tenant instantly to the Stripe Onboarding UI
        return NextResponse.redirect(accountLink.url);
    } catch (error: any) {
        console.error("Stripe Account Creation Error:", error);
        return NextResponse.redirect(`${appUrl}/settings?error=stripe_init_failed`);
    }
}
