import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export async function GET(req: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized: Missing business session.' }, { status: 401 });
        }

        const clientId = process.env.NEXT_PUBLIC_STRIPE_CLIENT_ID;
        if (!clientId) {
            return NextResponse.json({ error: 'Config error: Missing Stripe Client ID.' }, { status: 500 });
        }

        const url = new URL(req.url);
        const origin = url.origin;
        const redirectUri = `${origin}/api/stripe/callback`;

        // Generate the Stripe OAuth URL with the strict server-side businessId as state
        const stripeUrl = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${encodeURIComponent(redirectUri)}&state=${businessId}`;

        return NextResponse.json({ url: stripeUrl });
    } catch (error: any) {
        console.error('[STRIPE LINK GENERATION ERROR]', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
