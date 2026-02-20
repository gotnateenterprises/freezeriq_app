import { NextRequest, NextResponse } from 'next/server';
import { TokenManager } from '@/lib/auth/token_manager';
import { auth } from '@/auth';

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function GET(req: NextRequest) {
    const searchParams = req.nextUrl.searchParams;
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
        return NextResponse.json({ error: `Instagram Auth Error: ${error}` }, { status: 400 });
    }

    if (!code) {
        return NextResponse.json({ error: "No authorization code returned" }, { status: 400 });
    }

    try {
        const redirectUri = `${NEXT_PUBLIC_BASE_URL}/api/auth/instagram/callback`;

        // 1. Exchange code for User Access Token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${META_APP_SECRET}&code=${code}`
        );
        const tokenData = await tokenRes.json();

        if (tokenData.error) {
            throw new Error(tokenData.error.message || "Failed to exchange token");
        }

        const userAccessToken = tokenData.access_token;

        // 2. Get Long-lived Access Token
        const longLivedRes = await fetch(
            `https://graph.facebook.com/v18.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${userAccessToken}`
        );
        const longLivedData = await longLivedRes.json();
        const finalUserToken = longLivedData.access_token || userAccessToken;

        // 3. Find Instagram Business Account
        // We need to iterate over pages to find one with an IG Business Account connected.
        const pagesRes = await fetch(
            `https://graph.facebook.com/v18.0/me/accounts?access_token=${finalUserToken}`
        );
        const pagesData = await pagesRes.json();

        if (pagesData.error) {
            throw new Error(pagesData.error.message || "Failed to fetch pages");
        }

        const pages = pagesData.data;
        if (!pages || pages.length === 0) {
            throw new Error("No Facebook Pages found. You need a Facebook Page to have an Instagram Business Account.");
        }

        let igBusinessId = null;
        let pageAccessToken = null;

        // Check each page for an IG Business Account
        for (const page of pages) {
            const igRes = await fetch(
                `https://graph.facebook.com/v18.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
            );
            const igData = await igRes.json();

            if (igData.instagram_business_account?.id) {
                igBusinessId = igData.instagram_business_account.id;
                pageAccessToken = page.access_token; // We use the Page Token to act on behalf of the IG account
                break;
            }
        }

        if (!igBusinessId) {
            throw new Error("No Instagram Business Account found connected to your Facebook Pages. Please ensure you have converted your Instagram account to a Business account and connected it to a Facebook Page.");
        }

        // 4. Save to DB
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const tokenManager = new TokenManager('instagram', businessId);
        await tokenManager.saveTokens(
            pageAccessToken, // Storing Page Token as the access token, as it allows managing the IG account
            undefined,
            undefined,
            igBusinessId     // Store IG Business ID as realm_id
        );

        return NextResponse.redirect(new URL('/settings?instagram_connected=true', req.url));

    } catch (e: any) {
        console.error("Instagram Token Exchange Error:", e);
        return NextResponse.json({ error: "Failed to connect Instagram", details: e.message }, { status: 500 });
    }
}
