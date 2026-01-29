
import { prisma } from './db';

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID;
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const QBO_ENV = process.env.QBO_ENVIRONMENT || 'sandbox';
const REDIRECT_URI = 'https://freezeriq.vercel.app/api/integrations/auth/qbo/callback';

const DISCOVERY_URL = QBO_ENV === 'production'
    ? 'https://developer.api.intuit.com/.well-known/openid_configuration'
    : 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration';

// 1. Generate Auth URL
export function getAuthorizationUrl() {
    // Defines scopes: com.intuit.quickbooks.accounting (Accounting API)
    // state: random string for security (skipping for MVP validation, but good practice)
    const scopes = 'com.intuit.quickbooks.accounting openid profile email phone address';
    const url = new URL('https://appcenter.intuit.com/connect/oauth2');
    url.searchParams.append('client_id', QBO_CLIENT_ID || '');
    url.searchParams.append('response_type', 'code');
    url.searchParams.append('scope', scopes);
    url.searchParams.append('redirect_uri', REDIRECT_URI);
    url.searchParams.append('state', 'security_token_123');
    return url.toString();
}

// 2. Exchange Code for Token
export async function exchangeCodeForToken(code: string, realmId: string) {
    if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET) throw new Error("Missing QBO Credentials");

    const authHeader = 'Basic ' + Buffer.from(QBO_CLIENT_ID + ':' + QBO_CLIENT_SECRET).toString('base64');

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);

    const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Authorization': authHeader,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Token Exchange Failed: ${txt}`);
    }

    const tokenData = await response.json();

    // Save to DB
    await prisma.systemSetting.upsert({ where: { key: 'qbo_access_token' }, update: { value: tokenData.access_token }, create: { key: 'qbo_access_token', value: tokenData.access_token } });
    await prisma.systemSetting.upsert({ where: { key: 'qbo_refresh_token' }, update: { value: tokenData.refresh_token }, create: { key: 'qbo_refresh_token', value: tokenData.refresh_token } });
    await prisma.systemSetting.upsert({ where: { key: 'qbo_realm_id' }, update: { value: realmId }, create: { key: 'qbo_realm_id', value: realmId } });

    // Calculate Expiry (usually 1 hour)
    // We could store expiry time too, but for MVP we will refresh if fail.

    return tokenData;
}
