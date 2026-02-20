import { NextResponse } from 'next/server';

const META_APP_ID = process.env.META_APP_ID;
const NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function GET() {
    if (!META_APP_ID) {
        return NextResponse.json({ error: "Missing META_APP_ID in environment" }, { status: 500 });
    }

    const redirectUri = `${NEXT_PUBLIC_BASE_URL}/api/auth/instagram/callback`;

    // Scopes for Instagram Business
    // We need 'instagram_basic' and 'pages_show_list' at minimum. 
    // 'instagram_manage_messages' for DMs if needed later.
    const scopes = [
        'instagram_basic',
        'instagram_manage_insights',
        'pages_show_list',
        'instagram_manage_messages',
        'public_profile'
    ].join(',');

    // State for CSRF protection
    const state = 'instagram_auth_flow';

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}`;

    return NextResponse.redirect(authUrl);
}
