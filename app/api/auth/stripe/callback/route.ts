import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { stripe } from '@/lib/stripe';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
            console.error("Stripe connect authorization denied:", error);
            return NextResponse.redirect(new URL('/settings?stripe_connected=false&error=access_denied', req.url));
        }

        if (!code || !state) {
            return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
        }

        // Decode the state payload
        let decodedState;
        try {
            decodedState = JSON.parse(Buffer.from(state, 'base64').toString('ascii'));
        } catch (e) {
            return NextResponse.json({ error: 'Invalid state payload' }, { status: 400 });
        }

        const businessId = decodedState?.businessId;
        if (!businessId) {
            return NextResponse.json({ error: 'Invalid state parameter structure' }, { status: 400 });
        }

        // Exchange authorization code for Stripe Connect credentials
        const response = await stripe.oauth.token({
            grant_type: 'authorization_code',
            code
        });

        const connectedAccountId = response.stripe_user_id;

        if (!connectedAccountId) {
            throw new Error("No connected account ID returned from Stripe.");
        }

        // Save the connected Stripe Account ID into the Integrations table.
        // We store the connectedAccountId in access_token to match the Integrations schema pattern.
        await prisma.integration.upsert({
            where: {
                business_id_provider: {
                    business_id: businessId,
                    provider: 'stripe'
                }
            },
            create: {
                business_id: businessId,
                provider: 'stripe',
                access_token: connectedAccountId,
                refresh_token: response.refresh_token,
            },
            update: {
                access_token: connectedAccountId,
                refresh_token: response.refresh_token,
                updated_at: new Date()
            }
        });

        // Return to settings page with a success signal
        return NextResponse.redirect(new URL('/settings?stripe_connected=true', req.url));

    } catch (e: any) {
        console.error("Stripe callback failure executing integration link:", e.message);
        return NextResponse.redirect(new URL('/settings?stripe_connected=false&error=server_error', req.url));
    }
}
