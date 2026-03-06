import { NextRequest, NextResponse } from 'next/server';
import { TokenManager } from '@/lib/auth/token_manager';

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    if (error) {
        return NextResponse.json({ error: `Meta Auth Error: ${error}` }, { status: 400 });
    }

    if (!code) {
        return NextResponse.json({ error: "No authorization code returned" }, { status: 400 });
    }

    try {
        const redirectUri = `${NEXT_PUBLIC_BASE_URL}/api/auth/meta/callback`;

        // 1. Exchange code for Access Token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${META_APP_SECRET}&code=${code}`
        );
        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            throw new Error(tokenData.error.message || "Failed to exchange token");
        }

        const userAccessToken = tokenData.access_token;

        // 2. Get Long-lived Access Token (Optional but good practice)
        const longLivedRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${userAccessToken}`
        );
        const longLivedData = await longLivedRes.json();
        const finalUserToken = longLivedData.access_token || userAccessToken;

        // 3. Get Page Access Tokens
        const pagesRes = await fetch(
            `https://graph.facebook.com/v18.0/me/accounts?access_token=${finalUserToken}`
        );
        const pagesData = await pagesRes.json();

        if (pagesData.error) {
            throw new Error(pagesData.error.message || "Failed to fetch pages");
        }

        const pages = pagesData.data;
        if (!pages || pages.length === 0) {
            throw new Error("No Facebook Pages found for this account.");
        }

        // For MVP, we'll take the first page. 
        // In a production app, you'd show a UI to pick a page.
        const targetPage = pages[0];
        const pageAccessToken = targetPage.access_token;
        const pageId = targetPage.id;

        // 4. Save to DB using TokenManager
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const tokenManager = new TokenManager('meta', businessId);
        await tokenManager.saveTokens(
            pageAccessToken,
            undefined, // Meta doesn't use refresh tokens for pages in the same way Square/QBO does
            undefined, // Page tokens are usually long-lived/permanent if from a long-lived user token
            pageId     // Store Page ID in realm_id field
        );

        // Redirect back to Settings with success message
        return NextResponse.redirect(new URL('/settings?meta_connected=true', req.url));

    } catch (e: any) {
        console.error("Meta Token Exchange Error:", e);
        return NextResponse.json({ error: "Failed to connect Meta", details: e.message }, { status: 500 });
    }
}
