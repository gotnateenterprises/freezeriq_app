import { NextResponse } from 'next/server';
import OAuthClient from 'intuit-oauth';

export async function GET() {
    const oauthClient = new OAuthClient({
        clientId: process.env.QBO_CLIENT_ID,
        clientSecret: process.env.QBO_CLIENT_SECRET,
        environment: process.env.QBO_ENVIRONMENT || 'sandbox',
        redirectUri: 'http://localhost:3000/api/auth/qbo/callback',
    });

    const authUri = oauthClient.authorizeUri({
        scope: [
            OAuthClient.scopes.Accounting,
            OAuthClient.scopes.OpenId,
        ],
        state: 'intuit-test',
    });

    console.log("--- QBO Debug ---");
    console.log("Environment:", process.env.QBO_ENVIRONMENT);
    console.log("Client ID:", process.env.QBO_CLIENT_ID?.substring(0, 5) + "...");
    console.log("Redirect URI Configured:", 'http://localhost:3000/api/auth/qbo/callback');
    console.log("Generated Auth URL:", authUri);

    return NextResponse.redirect(authUri);
}
