/**
 * QB-INVOICE-1A — the only code that talks to Intuit.
 *
 * A small, explicit REST client written against Intuit's published OAuth 2.0
 * and Accounting API endpoints. It replaces two npm packages (intuit-oauth and
 * node-quickbooks — the latter pinned the long-deprecated `request@2.88.0`) and
 * copies no code from either: the protocol is four HTTP calls, and owning them
 * outright is what lets this file guarantee the properties below.
 *
 *   - ONE scope: com.intuit.quickbooks.accounting. Never payments, never openid.
 *   - Credentials travel only in the Authorization header or a POST body — never
 *     in a URL, where they would land in access logs.
 *   - No error message, thrown value or log line ever contains a token, the
 *     authorization code, the client secret or a response body. Failures carry a
 *     reason code, the HTTP status, and Intuit's `intuit_tid` correlation id
 *     (which Intuit support asks for and which is not a credential).
 *   - Every call has a timeout, so a hung Intuit endpoint cannot pin a request.
 *
 * `fetchImpl` is injectable so tests exercise the real request construction and
 * response parsing without the network.
 */

import {
    INTUIT_AUTHORIZE_URL,
    INTUIT_REVOKE_URL,
    INTUIT_TOKEN_URL,
    QUICKBOOKS_MINOR_VERSION,
    QUICKBOOKS_SCOPE,
    type QuickBooksConfig,
} from '@/lib/quickbooks/config';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 15_000;
/**
 * A refresh gets longer. If we abort a refresh that Intuit completes anyway, the
 * rotated token is lost and the connection must be re-authorised — so the client
 * should almost never be the side that gives up. Still well inside the 60s
 * refresh lease in lib/quickbooks/connection.ts.
 */
export const REFRESH_TIMEOUT_MS = 30_000;
/** Intuit documents a 60-minute access token; used only if a response omits expires_in. */
const DEFAULT_ACCESS_SECONDS = 3600;
const MAX_TOKEN_LENGTH = 8_192;

export type IntuitErrorKind =
    /** Refresh token or authorization code rejected — the user must reconnect. */
    | 'invalid_grant'
    /** The API refused the access token (expired, revoked, or no company access). */
    | 'unauthorized'
    /** Any other non-success HTTP status. */
    | 'http'
    /** The request never completed (DNS, TLS, timeout). */
    | 'network'
    /** A success status with a body that is not what Intuit documents. */
    | 'malformed';

export class IntuitError extends Error {
    readonly kind: IntuitErrorKind;
    readonly status?: number;
    readonly intuitTid?: string;

    constructor(kind: IntuitErrorKind, detail: { status?: number; intuitTid?: string } = {}) {
        // The message is built from the reason code only — never from a body.
        super(`Intuit request failed: ${kind}${detail.status ? ` (HTTP ${detail.status})` : ''}`);
        // tsconfig targets ES5, where extending Error loses the prototype chain and
        // `instanceof IntuitError` is silently false (see lib/bundleContents.ts).
        Object.setPrototypeOf(this, IntuitError.prototype);
        this.name = 'IntuitError';
        this.kind = kind;
        this.status = detail.status;
        this.intuitTid = detail.intuitTid;
    }
}

export interface IntuitTokenSet {
    accessToken: string;
    refreshToken: string;
    accessExpiresAt: Date;
    /** Rolling refresh-token expiry (~100 days, extended by each refresh), when reported. */
    refreshExpiresAt: Date | null;
    /**
     * Absolute end of the authorization (Intuit's 5-year refresh-token limit),
     * reported only because we opt in with x-include-refresh-token-hard-expires-in.
     */
    hardExpiresAt: Date | null;
}

export interface CompanyInfoSummary {
    /** Deliberately minimal: enough for an admin to recognise the company. */
    companyName: string | null;
    country: string | null;
}

/** Realm ids are numeric. Anything else is refused before it reaches a URL. */
export function isValidRealmId(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

/** Intuit's per-request correlation id. Not a credential; safe to log. */
function intuitTid(res: Response): string | undefined {
    const tid = res.headers.get('intuit_tid');
    return tid && /^[A-Za-z0-9-]{1,128}$/.test(tid) ? tid : undefined;
}

function basicAuth(config: QuickBooksConfig): string {
    return 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number = TIMEOUT_MS): Promise<Response> {
    try {
        return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    } catch {
        // The underlying error can echo the request; it is dropped on purpose.
        throw new IntuitError('network');
    }
}

async function readJson(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * The Intuit consent URL. Exactly five parameters; the scope is the constant.
 */
export function buildAuthorizationUrl(config: QuickBooksConfig, state: string): string {
    const url = new URL(INTUIT_AUTHORIZE_URL);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', QUICKBOOKS_SCOPE);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
}

function parseTokenResponse(body: any, now: number): IntuitTokenSet {
    const access = body?.access_token;
    const refresh = body?.refresh_token;
    const expiresIn = body?.expires_in;
    if (typeof access !== 'string' || !access || access.length > MAX_TOKEN_LENGTH) throw new IntuitError('malformed');
    if (typeof refresh !== 'string' || !refresh || refresh.length > MAX_TOKEN_LENGTH) throw new IntuitError('malformed');
    // A valid token pair is never thrown away over a missing lifetime: dropping a
    // freshly rotated refresh token would force the tenant to reconnect.
    const accessSeconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn
        : DEFAULT_ACCESS_SECONDS;

    const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(now + v * 1000) : null);

    return {
        accessToken: access,
        refreshToken: refresh,
        accessExpiresAt: new Date(now + accessSeconds * 1000),
        refreshExpiresAt: seconds(body?.x_refresh_token_expires_in),
        hardExpiresAt: seconds(body?.x_refresh_token_hard_expires_in),
    };
}

async function tokenRequest(
    config: QuickBooksConfig,
    form: Record<string, string>,
    fetchImpl: FetchLike,
    now: () => number,
    timeoutMs: number = TIMEOUT_MS,
): Promise<IntuitTokenSet> {
    const res = await send(fetchImpl, INTUIT_TOKEN_URL, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: basicAuth(config),
            // Opt-in (Intuit, 2026): adds x_refresh_token_hard_expires_in to the response.
            'x-include-refresh-token-hard-expires-in': 'true',
        },
        body: new URLSearchParams(form).toString(),
    }, timeoutMs);
    const tid = intuitTid(res);
    const body = await readJson(res);

    if (!res.ok) {
        // Only the OAuth `error` code is inspected; the rest of the body is dropped.
        if (body?.error === 'invalid_grant') throw new IntuitError('invalid_grant', { status: res.status, intuitTid: tid });
        throw new IntuitError('http', { status: res.status, intuitTid: tid });
    }
    try {
        return parseTokenResponse(body, now());
    } catch (e) {
        if (e instanceof IntuitError) throw new IntuitError(e.kind, { status: res.status, intuitTid: tid });
        throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    }
}

/** Server-to-server exchange of the one-time authorization code. */
export function exchangeAuthorizationCode(
    config: QuickBooksConfig,
    code: string,
    fetchImpl: FetchLike = fetch,
    now: () => number = Date.now,
): Promise<IntuitTokenSet> {
    return tokenRequest(config, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.redirectUri,
    }, fetchImpl, now);
}

/**
 * Refresh. Intuit may rotate the refresh token; the caller must persist the returned one.
 *
 * An IntuitError of kind 'network' — or 'malformed' with a 2xx status — is
 * AMBIGUOUS: Intuit may have rotated the token even though we never read the
 * result. Callers must not treat it like a clean refusal.
 */
export function refreshAccessToken(
    config: QuickBooksConfig,
    refreshToken: string,
    fetchImpl: FetchLike = fetch,
    now: () => number = Date.now,
): Promise<IntuitTokenSet> {
    return tokenRequest(config, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    }, fetchImpl, now, REFRESH_TIMEOUT_MS);
}

/**
 * Revokes a token at Intuit. Returns true on success, false on any failure —
 * revocation is best effort at the call site, which ALWAYS disables local
 * credentials regardless, so a failure here must not throw past it.
 */
export async function revokeToken(
    config: QuickBooksConfig,
    token: string,
    fetchImpl: FetchLike = fetch,
): Promise<{ revoked: boolean; status?: number; intuitTid?: string }> {
    try {
        const res = await send(fetchImpl, INTUIT_REVOKE_URL, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: basicAuth(config),
            },
            body: JSON.stringify({ token }),
        });
        return { revoked: res.ok, status: res.status, intuitTid: intuitTid(res) };
    } catch {
        return { revoked: false };
    }
}

/**
 * Read-only CompanyInfo — the health proof, and the proof at connect time that
 * the freshly issued tokens really belong to the realm Intuit's redirect named.
 *
 * Health checks pass the tenant's STORED realm; the callback passes the realm from
 * its own verified redirect exactly once, before anything is stored. Only two
 * fields are kept from the response.
 */
export async function fetchCompanyInfo(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    fetchImpl: FetchLike = fetch,
): Promise<CompanyInfoSummary & { intuitTid?: string }> {
    if (!isValidRealmId(realmId)) throw new IntuitError('malformed');
    const realm = encodeURIComponent(realmId);
    const url = `${config.apiBase}/v3/company/${realm}/companyinfo/${realm}?minorversion=${QUICKBOOKS_MINOR_VERSION}`;

    const res = await send(fetchImpl, url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    const tid = intuitTid(res);
    if (res.status === 401 || res.status === 403) throw new IntuitError('unauthorized', { status: res.status, intuitTid: tid });
    if (!res.ok) throw new IntuitError('http', { status: res.status, intuitTid: tid });

    const body = await readJson(res);
    // Intuit documents that a 200 can still carry a Fault instead of the entity.
    if (body?.Fault || body?.fault) throw new IntuitError('http', { status: res.status, intuitTid: tid });
    const info = body?.CompanyInfo;
    if (!info || typeof info !== 'object') throw new IntuitError('malformed', { status: res.status, intuitTid: tid });

    const name = typeof info.CompanyName === 'string' ? info.CompanyName.slice(0, 200) : null;
    const country = typeof info.Country === 'string' ? info.Country.slice(0, 8) : null;
    return { companyName: name, country, intuitTid: tid };
}
