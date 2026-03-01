import { NextResponse } from 'next/server';

const META_APP_ID = process.env.META_APP_ID;
const NEXT_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

export async function GET() {
    if (!META_APP_ID) {
        return NextResponse.json({ error: "Missing META_APP_ID in environment" }, { status: 500 });
    }

    const redirectUri = `${NEXT_PUBLIC_BASE_URL}/api/auth/meta/callback`;

    // Scopes needed for our app to read and manage business pages
    const scopes = [
        'pages_show_list',
        'pages_messaging',
        'pages_manage_metadata',
        'business_management',
        'public_profile'
    ].join(',');

    // State for CSRF protection
    const state = 'meta_auth_flow';

    const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=${state}`;

    return NextResponse.redirect(authUrl);
}
