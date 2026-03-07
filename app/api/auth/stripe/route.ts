import { NextResponse } from 'next/server';
import { auth } from '@/auth';

export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const clientId = process.env.STRIPE_CLIENT_ID;
        if (!clientId) {
            console.error("STRIPE_CLIENT_ID not configured.");
            return NextResponse.json({ error: 'Stripe integration not configured on the server.' }, { status: 500 });
        }

        // Base URL determination
        const host = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        const redirectUri = `${host}/api/auth/stripe/callback`;

        // state parameter ensures CSRF protection and allows business ID forwarding 
        // to the callback route which might not have cookie access.
        const statePayload = { businessId: session.user.businessId };
        const state = Buffer.from(JSON.stringify(statePayload)).toString('base64');

        const authUri = `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=${clientId}&scope=read_write&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

        return NextResponse.redirect(authUri);
    } catch (err: any) {
        console.error("Failed to generate Stripe Connect link", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
