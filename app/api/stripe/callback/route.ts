import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2022-11-15' as any, // Temporary bypass while keeping the runtime satisfied
});

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        if (!state) {
            return new NextResponse('Missing state parameter (businessId)', { status: 400 });
        }

        // Handle user cancellation or other Stripe errors
        if (error) {
            console.error('[STRIPE OAUTH ERROR]', error, errorDescription);
            return NextResponse.redirect(new URL(`/settings?stripe_connected=false&error=${error}`, req.url));
        }

        if (!code) {
            return new NextResponse('Missing authorization code', { status: 400 });
        }

        // Exchange the authorization code for a Stripe connected account ID
        const response = await stripe.oauth.token({
            grant_type: 'authorization_code',
            code,
        });

        const connectedAccountId = response.stripe_user_id;

        if (!connectedAccountId) {
            throw new Error('No stripe_user_id returned from token exchange');
        }

        // Save the connected account ID to the business record
        await prisma.business.update({
            where: { id: state },
            data: {
                stripe_account_id: connectedAccountId,
                stripe_onboarding_complete: true,
                charges_enabled: true // Generally true for Standard accounts immediately after OAuth
            }
        });

        // Redirect back to settings with success flag
        return NextResponse.redirect(new URL('/settings?stripe_connected=true', req.url));

    } catch (e: any) {
        console.error('[STRIPE_CALLBACK_ERROR]', e);
        return NextResponse.redirect(new URL(`/settings?stripe_connected=false&error=internal_error`, req.url));
    }
}
