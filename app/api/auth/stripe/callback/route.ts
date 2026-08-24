/**
 * Stripe Connect onboarding return.
 *
 * SEC-OAUTH-CALLBACK-1. This route previously read the target tenant straight
 * from the URL and had no authentication of any kind:
 *
 *     const accountId  = url.searchParams.get('account_id');
 *     const businessId = url.searchParams.get('business_id');
 *     ... prisma.integration.upsert({ business_id: businessId, access_token: accountId })
 *
 * A Stripe integration's `access_token` is the connected account id — the
 * account that receives money — so whoever chose that parameter chose where a
 * tenant's payments land. No part of the request had to come from Stripe.
 *
 * Both facts now arrive inside a state signed at initiation
 * (app/api/auth/stripe/route.ts) and are never read from the query string.
 * Existence of a business is NOT authorisation: the state proves an authorised
 * connect attempt happened, for this provider, this tenant and this account.
 *
 * NOTE ON THE FLOW. This is Stripe Connect account onboarding via accountLinks,
 * not an OAuth code grant, so there is no `code` to exchange. The server-to-server
 * check is `accounts.retrieve`, which runs on the platform key and therefore only
 * resolves accounts belonging to this platform, and `metadata.businessId`, which
 * the initiation route stamps on the account at creation.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';
import { cookies } from 'next/headers';
import { verifyOAuthState, STRIPE_OAUTH_STATE_COOKIE } from '@/lib/auth/oauthState';

export async function GET(req: Request) {
    const url = new URL(req.url);
    const appUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const settingsUrl = `${appUrl}/settings`;

    const fail = (reason: string) => NextResponse.redirect(`${settingsUrl}?error=${reason}`);

    const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
    if (!secret) return fail('stripe_callback_failed');

    const state = await verifyOAuthState(url.searchParams.get('state'), secret, 'stripe');
    if (!state || !state.accountId) {
        // Covers absent, malformed, tampered, expired, and wrong-provider states.
        console.error('Stripe Callback Error: missing or invalid state.');
        return fail('stripe_callback_invalid_state');
    }

    // Defence in depth. The state alone is already authoritative — it is signed,
    // and it pins the account to the tenant, so replaying one can only ever
    // re-assert the binding it already describes. The cookie additionally
    // requires the same browser, but its ABSENCE is not treated as failure:
    // onboarding can legitimately complete in a context where the cookie is gone,
    // and refusing then would break a real connection for no security gain.
    const cookieStore = await cookies();
    const storedState = cookieStore.get(STRIPE_OAUTH_STATE_COOKIE)?.value;
    if (storedState && storedState !== url.searchParams.get('state')) {
        console.error('Stripe Callback Error: state does not match the stored cookie.');
        return fail('stripe_callback_invalid_state');
    }
    cookieStore.delete(STRIPE_OAUTH_STATE_COOKIE);

    const businessId = state.businessId;
    const accountId = state.accountId;

    try {
        // Server-to-server, on the platform key: only resolves accounts that
        // belong to this platform.
        const account = await stripe.accounts.retrieve(accountId);

        if (!account) {
            console.error('Stripe Callback Error: Account not found.');
            return fail('stripe_account_not_found');
        }

        // The initiation route stamps metadata.businessId when it creates the
        // account, so Stripe itself can corroborate the pairing. Treated as a
        // confirmation rather than a requirement: a mismatch is fatal, but an
        // account predating that stamp has no metadata and is still covered by
        // the signed state.
        const stamped = (account as any)?.metadata?.businessId;
        if (stamped && stamped !== businessId) {
            console.error('Stripe Callback Error: account/tenant mismatch.');
            return fail('stripe_callback_invalid_state');
        }

        const persist = () => prisma.integration.upsert({
            where: { business_id_provider: { business_id: businessId, provider: 'stripe' } },
            update: { access_token: accountId, updated_at: new Date() },
            create: { business_id: businessId, provider: 'stripe', access_token: accountId },
        });

        // `details_submitted` tells us whether they finished onboarding. We still
        // save an incomplete connection so it can be resumed — that is existing
        // product behaviour, and it is now an AUTHORISED write either way.
        if (!account.details_submitted) {
            console.warn(`User aborted or did not finish Stripe Onboarding. Account: ${accountId}`);
            await persist();
            return fail('stripe_setup_incomplete');
        }

        await persist();

        return NextResponse.redirect(`${settingsUrl}?success=stripe_connected`);
    } catch (error: any) {
        // Never surface provider error text to the browser.
        console.error('Stripe Callback Exception:', error);
        return fail('stripe_callback_failed');
    }
}
