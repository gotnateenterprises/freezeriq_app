/**
 * SEC-OAUTH-CALLBACK-1 — a signed correlation token for provider connect flows.
 *
 * WHY THIS EXISTS
 *
 * The Stripe connect callback took its target tenant from the URL:
 *
 *     const businessId = url.searchParams.get('business_id');
 *
 * with no authentication, and upserted the integration for that tenant. Since a
 * Stripe integration's `access_token` is the connected account id — the account
 * that receives money — whoever chose that parameter chose where a tenant's
 * payments land.
 *
 * A state token fixes it by making the callback prove it corresponds to an
 * authorised connect attempt. The tenant is read out of the signed token, so a
 * query parameter can no longer nominate one.
 *
 * WHY NOT REUSE lib/auth/viewAsGrant.ts
 *
 * They answer different questions and their requirements genuinely differ:
 *
 *   - A view-as grant authorises a PRIVILEGE ("this super admin may act as this
 *     tenant") and is short-lived by design, because it is a capability.
 *   - OAuth state CORRELATES a redirect with an attempt. It grants nothing on
 *     its own. It must additionally bind the PROVIDER, so a token minted for one
 *     provider's callback cannot be presented at another's, and it must survive a
 *     Stripe onboarding session, which can take far longer than five minutes
 *     while documents are uploaded.
 *
 * Copying the grant would have meant a five-minute expiry that breaks real
 * onboarding and no provider binding at all. The shared primitives are small and
 * deliberately duplicated rather than generalised, so neither file's security
 * properties can drift by accident when the other changes.
 *
 * HMAC-SHA256 over Web Crypto, so it runs in both the Node and edge runtimes.
 */

export interface OAuthState {
    /** Provider this attempt belongs to; a token is not valid at another's callback. */
    provider: 'stripe' | 'square';
    /** The EFFECTIVE tenant the initiating user was authorised to act for. */
    businessId: string;
    /** The user who initiated the attempt. */
    userId: string;
    /** Provider-side account the attempt refers to, where one exists up front. */
    accountId?: string;
    /** Unpredictable, so a state cannot be guessed from its other fields. */
    nonce: string;
    /** Expiry, epoch seconds. */
    exp: number;
}

/**
 * Stripe account onboarding is a human filling in a form and uploading identity
 * documents; minutes is not a realistic budget for it. One hour bounds the
 * window without breaking a legitimate completion.
 */
export const OAUTH_STATE_TTL_SECONDS = 60 * 60;

/**
 * Mirrors Square's `square_oauth_state`. Lives here rather than in a route module
 * so the callback does not have to import the initiation route to learn the name.
 */
export const STRIPE_OAUTH_STATE_COOKIE = 'stripe_oauth_state';

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array | null {
    try {
        const pad = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export function oauthNonce(): string {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return b64url(b);
}

export async function signOAuthState(state: OAuthState, secret: string): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(state)));
    return body + '.' + b64url(await hmac(secret, body));
}

/**
 * Returns the state only if the signature verifies, it has not expired, and it
 * was minted for `expectedProvider`. Every failure path returns null — a bad
 * state is never a partial success.
 */
export async function verifyOAuthState(
    raw: unknown,
    secret: string,
    expectedProvider: OAuthState['provider'],
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<OAuthState | null> {
    if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
    if (!secret) return null;

    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;

    const body = raw.slice(0, dot);
    const given = b64urlDecode(raw.slice(dot + 1));
    if (!given) return null;

    if (!timingSafeEqual(given, await hmac(secret, body))) return null;

    const bytes = b64urlDecode(body);
    if (!bytes) return null;

    let parsed: any;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const { provider, businessId, userId, accountId, nonce, exp } = parsed;
    if (provider !== expectedProvider) return null;
    if (typeof businessId !== 'string' || !businessId) return null;
    if (typeof userId !== 'string' || !userId) return null;
    if (typeof nonce !== 'string' || !nonce) return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= nowSeconds) return null;
    if (accountId !== undefined && (typeof accountId !== 'string' || !accountId)) return null;

    return { provider, businessId, userId, accountId, nonce, exp };
}
