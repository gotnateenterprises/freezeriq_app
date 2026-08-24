import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { cookies } from 'next/headers';
import {
    signOAuthState,
    oauthNonce,
    OAUTH_STATE_TTL_SECONDS,
    STRIPE_OAUTH_STATE_COOKIE,
} from '@/lib/auth/oauthState';

export async function GET(req: Request) {
    const session = await auth();
    if (!session || !session.user || !session.user.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // SEC-OAUTH-CALLBACK-1 / SEC-TENANT-1. Resolve the tenant from the EFFECTIVE
    // session, the way app/api/auth/square/route.ts already does — not from the
    // durable users.business_id row this used to read via `user.business`.
    // That row no longer follows View As, so a super admin inspecting Tenant B
    // would have silently connected Stripe to their OWN tenant instead.
    const effectiveBusinessId = (session.user as any).businessId as string | undefined;
    if (!effectiveBusinessId) {
        return NextResponse.json({ error: 'No active business found' }, { status: 400 });
    }

    const business = await prisma.business.findUnique({
        where: { id: effectiveBusinessId },
        include: { integrations: true },
    });

    if (!business) {
        return NextResponse.json({ error: 'No active business found' }, { status: 400 });
    }

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

        // SEC-OAUTH-CALLBACK-1. The return_url used to carry account_id and
        // business_id as plain parameters, and the callback believed them. Both
        // facts now travel inside a signed state instead, so the callback reads
        // the tenant from something the server minted rather than from whatever
        // URL happens to be requested.
        const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
        if (!secret) {
            return NextResponse.redirect(`${appUrl}/settings?error=stripe_init_failed`);
        }

        const state = await signOAuthState({
            provider: 'stripe',
            businessId: business.id,
            userId: session.user.id,
            accountId,
            nonce: oauthNonce(),
            exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
        }, secret);

        // Defence in depth, matching Square: the same browser must come back.
        const cookieStore = await cookies();
        cookieStore.set(STRIPE_OAUTH_STATE_COOKIE, state, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: OAUTH_STATE_TTL_SECONDS,
            path: '/',
        });

        // 2. Generate the onboarding link utilizing the new Accounts V2 approach
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${appUrl}/settings?error=stripe_refresh`,
            return_url: `${appUrl}/api/auth/stripe/callback?state=${encodeURIComponent(state)}`,
            type: 'account_onboarding',
        });

        // Redirect the tenant instantly to the Stripe Onboarding UI
        return NextResponse.redirect(accountLink.url);
    } catch (error: any) {
        console.error("Stripe Account Creation Error:", error);
        const msg = encodeURIComponent(error?.message || 'Unknown error');
        return NextResponse.redirect(`${appUrl}/settings?error=stripe_init_failed&detail=${msg}`);
    }
}
