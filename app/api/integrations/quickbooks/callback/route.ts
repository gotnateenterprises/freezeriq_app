/**
 * GET /api/integrations/quickbooks/callback — Intuit's redirect after consent.
 *
 * QB-INVOICE-1A. Nothing is exchanged, and nothing is written, until ALL of these
 * hold, in this order:
 *
 *   1. a signed-in FreezerIQ user, who is the tenant's ADMIN acting as themselves;
 *   2. QuickBooks is enabled for this deployment (never on Preview);
 *   3. the `state` verifies: our signature, provider 'quickbooks', not expired;
 *   4. the state names THIS session's tenant and THIS user;
 *   5. the state's nonce matches the httpOnly cookie the connect route set in this
 *      browser (so another browser cannot present the URL);
 *   6. the attempt is CONSUMED in the database — true for exactly one request, on
 *      any server — before anything else in the callback is examined. The cookie
 *      alone cannot guarantee that: a doubled or retried redirect can reach two
 *      instances before the clearing response arrives, and Intuit may revoke the
 *      first grant if a code is exchanged twice. Because it is spent first, a
 *      denial or a malformed callback also ends the attempt and cannot be replayed;
 *   7. a well-formed authorization code and a numeric realmId.
 *
 * A denial (error=access_denied) is answered "denied" and exchanges and stores
 * nothing. Intuit does not document whether a denial carries state; if it does
 * and it verifies, the attempt is consumed first like any other callback.
 *
 * The attempt cookie is cleared exactly when the attempt stops being usable: when
 * this callback spends it, or proves it was already used, superseded or expired.
 * A request that cannot prove the attempt — no session, another browser, a stray
 * or hostile navigation to this URL, a bad state — leaves the cookie alone, so it
 * cannot disrupt the admin's real callback that is still on its way from Intuit.
 * Replay never depends on the cookie: the database attempt is single use.
 *
 * After the exchange, saveAuthorizedConnection proves with a read-only
 * CompanyInfo call that the new tokens really reach that realmId — the realmId is
 * on a URL the browser could alter — before binding it to the tenant.
 *
 * The tenant is read from the verified state, never from the query string. The
 * realmId is accepted only here, only on this verified redirect, and is bound to
 * that tenant by saveAuthorizedConnection — which also refuses a different
 * company than the one already bound, or a company another tenant holds.
 *
 * The browser is sent back to the configured application origin, never to one
 * derived from the request. Outcomes are short codes; no provider text, token,
 * code or realm id is ever written to the redirect or to an application log line.
 * (The inbound callback URL itself — code, state and realmId in its query string —
 * is recorded by the platform's request logs and the dev server's request log;
 * see docs/ai/QUICKBOOKS_INTEGRATION.md.)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { cookies } from 'next/headers';
import { verifyOAuthState } from '@/lib/auth/oauthState';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import {
    QUICKBOOKS_CALLBACK_PATH,
    QUICKBOOKS_OAUTH_COOKIE,
    resolveQuickBooksConfig,
    type QuickBooksConfig,
} from '@/lib/quickbooks/config';
import { IntuitError, exchangeAuthorizationCode, isValidRealmId } from '@/lib/quickbooks/intuitClient';
import { saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { consumeOAuthAttempt } from '@/lib/quickbooks/oauthAttempt';

const NO_STORE = { 'Cache-Control': 'no-store' };

function sameString(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function backToSettings(config: QuickBooksConfig, outcome: string) {
    const res = NextResponse.redirect(`${config.appOrigin}/settings?quickbooks=${encodeURIComponent(outcome)}`, 302);
    res.headers.set('Cache-Control', 'no-store');
    return res;
}

export async function GET(req: NextRequest) {
    const resolved = resolveQuickBooksConfig();

    const session = await auth();
    if (!session?.user?.id) {
        return resolved.enabled
            ? backToSettings(resolved.config, 'session_required')
            : NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }

    const cookieStore = await cookies();
    const cookieNonce = cookieStore.get(QUICKBOOKS_OAUTH_COOKIE)?.value;
    /** Expires the attempt cookie with the attributes it was set with (name + Path must match). */
    const clearAttemptCookie = (config: QuickBooksConfig) => cookieStore.set(QUICKBOOKS_OAUTH_COOKIE, '', {
        httpOnly: true,
        secure: config.redirectUri.startsWith('https:'),
        sameSite: 'lax',
        maxAge: 0,
        path: QUICKBOOKS_CALLBACK_PATH,
    });

    if (!resolved.enabled) {
        return NextResponse.json(
            { error: 'QuickBooks connection is not available in this environment.', reason: resolved.reason },
            { status: 503, headers: NO_STORE },
        );
    }
    const { config } = resolved;
    const user = session.user as any;

    if (!mayManageQuickBooks(user)) {
        console.warn('[quickbooks] callback rejected: not a tenant admin');
        return backToSettings(config, 'forbidden');
    }

    const params = req.nextUrl.searchParams;
    // The admin declined at Intuit (error=access_denied). Nothing is exchanged or
    // stored on a denial, whether or not its state can be verified.
    const denied = !!params.get('error');

    const state = await verifyOAuthState(params.get('state'), config.stateSecret, 'quickbooks');
    const stateMatchesSession = !!state
        && state.businessId === user.businessId
        && state.userId === user.id
        && typeof cookieNonce === 'string'
        && sameString(cookieNonce, state.nonce);
    if (!state || !stateMatchesSession) {
        // Intuit does not document whether `state` accompanies a denial, so a
        // denial that cannot be tied to the attempt is still just "denied" — it
        // has nothing to consume and nothing to exchange.
        if (denied) return backToSettings(config, 'denied');
        console.warn('[quickbooks] callback rejected: invalid_state');
        return backToSettings(config, 'invalid_state');
    }

    try {
        // Single use, spent FIRST: once a callback has proved this attempt (state
        // + session + cookie), the attempt is gone — whether this callback then
        // succeeds, was a denial, or carries a malformed code or realmId. No
        // outcome can be replayed, even if the cleared cookie never reached the
        // browser.
        const consumed = await consumeOAuthAttempt({ businessId: state.businessId, nonce: state.nonce });
        // This browser's cookie proved the attempt; either way it is now spent.
        clearAttemptCookie(config);
        if (!consumed) {
            if (denied) return backToSettings(config, 'denied');
            console.warn('[quickbooks] callback rejected: attempt already used, superseded or expired');
            return backToSettings(config, 'invalid_state');
        }
        if (denied) return backToSettings(config, 'denied');

        const code = params.get('code');
        const realmId = params.get('realmId');
        if (!code || code.length > 1024 || !/^[\x21-\x7e]+$/.test(code) || !isValidRealmId(realmId)) {
            console.warn('[quickbooks] callback rejected: invalid_callback');
            return backToSettings(config, 'invalid_callback');
        }

        const tokens = await exchangeAuthorizationCode(config, code);
        const outcome = await saveAuthorizedConnection({ businessId: state.businessId, realmId, tokens, config, authorizedByUserId: state.userId });
        if (outcome === 'connected') console.info(`[quickbooks] connected (${config.environment})`);
        return backToSettings(config, outcome);
    } catch (e) {
        const detail = e instanceof IntuitError
            ? `${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}${e.intuitTid ? ` intuit_tid=${e.intuitTid}` : ''}`
            : (e instanceof Error ? e.name : 'unknown');
        console.error(`[quickbooks] callback failed: ${detail}`);
        return backToSettings(config, e instanceof IntuitError ? 'token_exchange_failed' : 'error');
    }
}
