import { NextResponse, NextRequest } from 'next/server';
import { SquareClient, SquareEnvironment } from 'square';
import { TokenManager } from '@/lib/auth/token_manager';
import { auth } from '@/auth';

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const businessId = session.user.businessId;

    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
        return NextResponse.json({ error: `Square Auth Error: ${error}` }, { status: 400 });
    }

    if (!code) {
        return NextResponse.json({ error: "No authorization code returned" }, { status: 400 });
    }

    try {
        // Initialize Square Client
        // We only need the client ID/Secret to exchange the token initially
        const client = new SquareClient({
            environment: process.env.SQUARE_ENVIRONMENT === 'production' ? SquareEnvironment.Production : SquareEnvironment.Sandbox,
        });

        const response = await client.oAuth.obtainToken({
            clientId: process.env.SQUARE_APP_ID!,
            clientSecret: process.env.SQUARE_APP_SECRET!,
            code: code,
            grantType: 'authorization_code'
        });

        const { accessToken, refreshToken, expiresAt } = response;

        if (!accessToken) {
            throw new Error("Failed to obtain access token");
        }

        // Save to DB
        const tokenManager = new TokenManager('square', businessId);
        await tokenManager.saveTokens(
            accessToken,
            refreshToken,
            expiresAt ? new Date(expiresAt) : undefined
        );

        // Redirect back to Settings with success message
        return NextResponse.redirect(new URL('/settings?square_connected=true', req.url));

    } catch (e: any) {
        console.error("Square Token Exchange Error:", e);
        // Safely extract error message from Square SDK response if available
        let result = e.result ? JSON.stringify(e.result) : e.message;
        return NextResponse.json({ error: "Failed to connect Square", details: result }, { status: 500 });
    }
}
