import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import crypto from 'crypto';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  try {
    // Auth: only logged-in tenant users can initiate OAuth
    const session = await auth();
    if (!session?.user?.id || !(session.user as any).businessId) {
      return new NextResponse('Unauthorized', { status: 401 });
    }

    const businessId = (session.user as any).businessId;

    // Generate CSRF state token
    const nonce = crypto.randomBytes(16).toString('hex');
    const state = Buffer.from(JSON.stringify({ businessId, nonce })).toString('base64url');

    // Store state in httpOnly cookie for validation on callback
    const cookieStore = await cookies();
    cookieStore.set('square_oauth_state', state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const params = new URLSearchParams({
      client_id: process.env.SQUARE_APP_ID!,
      scope: 'PAYMENTS_WRITE PAYMENTS_READ ORDERS_WRITE ORDERS_READ CUSTOMERS_READ',
      session: 'false',
      state,
      redirect_uri: `${appUrl}/api/auth/square/callback`,
    });

    const squareBaseUrl = process.env.SQUARE_ENVIRONMENT === 'production'
      ? 'https://connect.squareup.com'
      : 'https://connect.squareupsandbox.com';

    return NextResponse.redirect(`${squareBaseUrl}/oauth2/authorize?${params.toString()}`);

  } catch (error: any) {
    console.error('[SQUARE_OAUTH_INITIATE]', error);
    return new NextResponse('Something went wrong', { status: 500 });
  }
}
