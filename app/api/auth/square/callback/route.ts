/**
 * Square OAuth Callback
 * 
 * GET /api/auth/square/callback?code=xxx&state=yyy
 * 
 * Exchanges authorization code for access/refresh tokens.
 * Stores tokens in Integration table under provider 'square'.
 * Updates StorefrontConfig.payment_provider to 'square'.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { TokenManager } from '@/lib/auth/token_manager';
import { SquareClient, SquareEnvironment } from 'square';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    // Handle user denial
    if (error) {
      console.warn('[SQUARE_OAUTH_CALLBACK] User denied access:', error);
      return NextResponse.redirect(`${appUrl}/settings?tab=integrations&error=square_denied`);
    }

    if (!code || !state) {
      return new NextResponse('Missing code or state', { status: 400 });
    }

    // Validate CSRF state
    const cookieStore = await cookies();
    const storedState = cookieStore.get('square_oauth_state')?.value;
    if (!storedState || storedState !== state) {
      return new NextResponse('Invalid state parameter (CSRF check failed)', { status: 400 });
    }

    // Clear the state cookie
    cookieStore.delete('square_oauth_state');

    // Decode state to get businessId
    let businessId: string;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
      businessId = decoded.businessId;
    } catch {
      return new NextResponse('Invalid state format', { status: 400 });
    }

    // Verify business exists
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      return new NextResponse('Business not found', { status: 404 });
    }

    // Exchange code for tokens
    const squareEnv = process.env.SQUARE_ENVIRONMENT === 'production'
      ? SquareEnvironment.Production
      : SquareEnvironment.Sandbox;

    const client = new SquareClient({ environment: squareEnv });

    const tokenResponse = await client.oAuth.obtainToken({
      clientId: process.env.SQUARE_APP_ID!,
      clientSecret: process.env.SQUARE_APP_SECRET!,
      grantType: 'authorization_code',
      code,
      redirectUri: `${appUrl}/api/auth/square/callback`,
    });

    if (!tokenResponse.accessToken) {
      console.error('[SQUARE_OAUTH_CALLBACK] No access token returned');
      return NextResponse.redirect(`${appUrl}/settings?tab=integrations&error=square_token_failed`);
    }

    // Store tokens in Integration table
    const tokenManager = new TokenManager('square', businessId);
    await tokenManager.saveTokens(
      tokenResponse.accessToken,
      tokenResponse.refreshToken,
      tokenResponse.expiresAt ? new Date(tokenResponse.expiresAt) : undefined
    );

    // Update StorefrontConfig to use Square as payment provider
    await prisma.storefrontConfig.upsert({
      where: { business_id: businessId },
      update: { payment_provider: 'square' },
      create: {
        business_id: businessId,
        payment_provider: 'square',
      },
    });

    console.log(`[SQUARE_OAUTH_CALLBACK] Square payment connected for business ${businessId}`);

    return NextResponse.redirect(`${appUrl}/settings?tab=integrations&success=square_connected`);

  } catch (error: any) {
    console.error('[SQUARE_OAUTH_CALLBACK]', error);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    return NextResponse.redirect(`${appUrl}/settings?tab=integrations&error=square_failed`);
  }
}
