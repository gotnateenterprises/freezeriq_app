import { NextResponse, NextRequest } from 'next/server';
import OAuthClient from 'intuit-oauth';
import { TokenManager } from '@/lib/auth/token_manager';

export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;
    const url = req.url; // intuit-oauth needs the full url to parse the response

    // Check for errors in the query before parsing
    const error = searchParams.get('error');
    if (error) {
        return NextResponse.json({ error: `QBO Auth Error: ${error}` }, { status: 400 });
    }

    try {
        const oauthClient = new OAuthClient({
            clientId: process.env.QBO_CLIENT_ID,
            clientSecret: process.env.QBO_CLIENT_SECRET,
            environment: process.env.QBO_ENVIRONMENT || 'sandbox',
            redirectUri: 'http://localhost:3000/api/auth/qbo/callback',
        });

        const authResponse = await oauthClient.createToken(url);

        // Structure of authResponse.getJson():
        // { access_token: '...', refresh_token: '...', x_refresh_token_expires_in: ... }
        const tokenData = authResponse.getJson();

        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        // Access token expires in 60 mins (3600s). Refresh token ~101 days.
        // We settle for just updating UpdatedAt in db, or calculating expiry if needed.
        // For simplicity, let's assume standard expiry or store current time.
        const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000));
        const realmId = searchParams.get('realmId');

        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        // Save to DB
        const tokenManager = new TokenManager('qbo', businessId);
        await tokenManager.saveTokens(
            accessToken,
            refreshToken,
            expiresAt,
            realmId || undefined
        );

        // Redirect back to Settings with success message
        return NextResponse.redirect(new URL('/settings?qbo=connected', req.url));

    } catch (e: any) {
        console.error("QBO Token Exchange Error:", e);
        return NextResponse.json({
            error: "Failed to connect QuickBooks",
            details: e.originalMessage || e.message
        }, { status: 500 });
    }
}
