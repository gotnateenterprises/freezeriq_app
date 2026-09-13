/**
 * GET /api/integrations/quickbooks/connect — begin the QuickBooks OAuth flow.
 *
 * QB-INVOICE-1A. The ONE entry point for connecting QuickBooks (the retired
 * /api/auth/qbo and /api/integrations/auth/qbo pairs are gone or 410).
 *
 *   - Tenant ADMIN only, acting as themselves (lib/quickbooks/access.ts).
 *   - Refused outright where a connection must not exist: Preview deployments,
 *     Production until explicitly enabled, a local process with Production
 *     database credentials (lib/quickbooks/config.ts).
 *   - The tenant and user come from the session and are sealed into a signed,
 *     provider-bound state that expires in ten minutes; its nonce is also set as
 *     an httpOnly cookie scoped to the callback path (only this browser can
 *     complete the attempt) and recorded, as a digest, as the tenant's single
 *     open attempt (it can be completed only once, on any server —
 *     lib/quickbooks/oauthAttempt.ts).
 *   - Requests exactly one scope, com.intuit.quickbooks.accounting, with the
 *     redirect URI from configuration — never from the Host header.
 *
 * Nothing about the request other than the session is read.
 */

import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { cookies } from 'next/headers';
import { oauthNonce, signOAuthState } from '@/lib/auth/oauthState';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import {
    QUICKBOOKS_CALLBACK_PATH,
    QUICKBOOKS_OAUTH_COOKIE,
    QUICKBOOKS_STATE_TTL_SECONDS,
    resolveQuickBooksConfig,
} from '@/lib/quickbooks/config';
import { buildAuthorizationUrl } from '@/lib/quickbooks/intuitClient';
import { recordOAuthAttempt } from '@/lib/quickbooks/oauthAttempt';
import { loadQuickBooksConnection } from '@/lib/quickbooks/connection';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET() {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }
    if (!mayManageQuickBooks(session.user as any)) {
        return NextResponse.json({ error: 'Only a tenant administrator can connect QuickBooks.' }, { status: 403, headers: NO_STORE });
    }

    const resolved = resolveQuickBooksConfig();
    if (!resolved.enabled) {
        return NextResponse.json(
            { error: 'QuickBooks connection is not available in this environment.', reason: resolved.reason },
            { status: 503, headers: NO_STORE },
        );
    }
    const { config } = resolved;
    const businessId = (session.user as any).businessId as string;

    // A stored connection that cannot be read can never be reconnected (the callback
    // would answer reconnect_blocked). Stop here rather than send the admin through
    // Intuit consent to create a grant FreezerIQ is certain to refuse.
    try {
        const stored = await loadQuickBooksConnection(businessId);
        if (stored.kind === 'unreadable' || (stored.kind === 'disconnected' && stored.realmId === null)) {
            const res = NextResponse.redirect(`${config.appOrigin}/settings?quickbooks=reconnect_blocked`, 302);
            res.headers.set('Cache-Control', 'no-store');
            return res;
        }
    } catch (e) {
        console.error(`[quickbooks] connect failed: ${e instanceof Error ? e.name : 'unknown'}`);
        return NextResponse.json({ error: 'Could not start the QuickBooks connection.' }, { status: 500, headers: NO_STORE });
    }

    const nonce = oauthNonce();
    const exp = Math.floor(Date.now() / 1000) + QUICKBOOKS_STATE_TTL_SECONDS;
    const state = await signOAuthState({
        provider: 'quickbooks',
        businessId,
        userId: session.user.id,
        nonce,
        exp,
    }, config.stateSecret);

    try {
        await recordOAuthAttempt({ businessId, nonce, expiresAt: new Date(exp * 1000) });
    } catch (e) {
        console.error(`[quickbooks] connect failed: ${e instanceof Error ? e.name : 'unknown'}`);
        return NextResponse.json({ error: 'Could not start the QuickBooks connection.' }, { status: 500, headers: NO_STORE });
    }

    const cookieStore = await cookies();
    cookieStore.set(QUICKBOOKS_OAUTH_COOKIE, nonce, {
        httpOnly: true,
        secure: config.redirectUri.startsWith('https:'),
        sameSite: 'lax', // must survive Intuit's top-level redirect back
        maxAge: QUICKBOOKS_STATE_TTL_SECONDS,
        path: QUICKBOOKS_CALLBACK_PATH,
    });

    const res = NextResponse.redirect(buildAuthorizationUrl(config, state), 302);
    res.headers.set('Cache-Control', 'no-store');
    return res;
}
