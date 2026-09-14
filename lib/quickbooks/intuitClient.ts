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
 *   - Accounting API calls: CompanyInfo (read), and — QB-INVOICE-1B — Customer
 *     query/read and a DisplayName-only Customer create. Nothing here creates,
 *     sends or reads an invoice or a payment.
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
    | 'malformed'
    /** QB-INVOICE-1B: Fault 6240 — the DisplayName is already used by a customer, vendor or employee. */
    | 'duplicate_name'
    /** QB-INVOICE-1B: Intuit validated and refused the request (a 4xx Fault); nothing was created. */
    | 'rejected';

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

// ── QB-INVOICE-1B: Customer lookup, read and minimal create ──────────────────
//
// Facts relied on (Intuit Accounting API docs, verified 2026-09-13):
//   - query string comparisons are NOT case-sensitive, so "exact" is enforced here,
//     byte for byte, after Intuit answers;
//   - a query returns only ACTIVE name-list entities unless it filters on Active,
//     and whether `Active IN (true,false)` combines with another filter is not
//     documented — so the inactive half is a second query with `Active = false`;
//   - an apostrophe in a literal is escaped with a backslash;
//   - DisplayName must not contain ':', tab or newline, and is unique across
//     customers, vendors and employees (Fault 6240 otherwise);
//   - a nonexistent id answers Fault 610; a 200 can still carry a Fault;
//   - `requestid` (max 50 chars) makes a POST idempotent: a repeat returns the
//     original response instead of creating again.
// Only Id, DisplayName, Active and the sub-customer/project flags are kept from a
// customer record; email, phone, address and balance are dropped on arrival.

/** A QuickBooks customer, reduced to what mapping needs. */
export interface QuickBooksCustomerSummary {
    id: string;
    displayName: string;
    active: boolean;
    /** A sub-customer (Job) or a Project — never linkable as an organization. */
    subCustomer: boolean;
}

/** Longest organization name FreezerIQ will propose or look up (a conservative ceiling; Intuit publishes none). */
export const QUICKBOOKS_DISPLAY_NAME_MAX = 100;

export type DisplayNameProblem = 'empty' | 'too_long' | 'surrounding_whitespace' | 'forbidden_character';

/**
 * Why a name cannot be used as a QuickBooks DisplayName verbatim, or null.
 * FreezerIQ never alters a name to make it fit — the admin changes it instead.
 * Forbidden: Intuit's ':' tab and newline; also carriage return, other control
 * characters, and backslash (its escaping inside a query literal is undocumented).
 */
export function displayNameProblem(name: unknown): DisplayNameProblem | null {
    if (typeof name !== 'string' || name.length === 0) return 'empty';
    if (name.length > QUICKBOOKS_DISPLAY_NAME_MAX) return 'too_long';
    if (name.trim() !== name) return 'surrounding_whitespace';
    if (/[:\\\u0000-\u001f\u007f]/.test(name)) return 'forbidden_character';
    return null;
}

const CUSTOMER_ID = /^[0-9]{1,32}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,50}$/;

/** Fault codes from a response body — top level or inside QueryResponse — or null when there is no Fault. */
function faultCodes(body: any): string[] | null {
    const fault = body?.Fault ?? body?.fault ?? body?.QueryResponse?.Fault;
    if (!fault) return null;
    const errors = Array.isArray(fault.Error) ? fault.Error : [];
    return errors.map((e: any) => String(e?.code ?? '')).filter(Boolean);
}

function parseCustomer(raw: any): QuickBooksCustomerSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.Id !== 'string' || !CUSTOMER_ID.test(raw.Id)) return null;
    if (typeof raw.DisplayName !== 'string' || raw.DisplayName.length === 0 || raw.DisplayName.length > 500) return null;
    if (typeof raw.Active !== 'boolean') return null;
    return { id: raw.Id, displayName: raw.DisplayName, active: raw.Active, subCustomer: raw.Job === true || raw.IsProject === true };
}

async function accountingRequest(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    pathAndQuery: string,
    init: RequestInit,
    fetchImpl: FetchLike,
): Promise<{ res: Response; body: any; tid?: string }> {
    if (!isValidRealmId(realmId)) throw new IntuitError('malformed');
    const res = await send(fetchImpl, `${config.apiBase}/v3/company/${encodeURIComponent(realmId)}${pathAndQuery}`, {
        ...init,
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, ...(init.headers as Record<string, string> | undefined) },
    });
    const tid = intuitTid(res);
    if (res.status === 401 || res.status === 403) throw new IntuitError('unauthorized', { status: res.status, intuitTid: tid });
    return { res, body: await readJson(res), tid };
}

async function queryCustomers(
    config: QuickBooksConfig, accessToken: string, realmId: string, where: string, fetchImpl: FetchLike,
): Promise<QuickBooksCustomerSummary[]> {
    const query = `select * from Customer where ${where} maxresults 20`;
    const { res, body, tid } = await accountingRequest(config, accessToken, realmId,
        `/query?query=${encodeURIComponent(query)}&minorversion=${QUICKBOOKS_MINOR_VERSION}`, { method: 'GET' }, fetchImpl);
    const codes = faultCodes(body);
    if (!res.ok || codes) throw new IntuitError(res.ok ? 'http' : res.status >= 500 ? 'http' : 'rejected', { status: res.status, intuitTid: tid });
    const qr = body?.QueryResponse;
    if (!qr || typeof qr !== 'object') throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    if (qr.Customer === undefined) return []; // an empty result omits the entity key
    if (!Array.isArray(qr.Customer)) throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    const out: QuickBooksCustomerSummary[] = [];
    for (const raw of qr.Customer) {
        const c = parseCustomer(raw);
        if (!c) throw new IntuitError('malformed', { status: res.status, intuitTid: tid }); // fail closed, never skip
        out.push(c);
    }
    return out;
}

/**
 * Every QuickBooks customer — active AND inactive — whose DisplayName Intuit
 * considers equal to `displayName`. Intuit's comparison ignores letter case, so
 * the caller decides what is EXACT (byte-for-byte) and what merely differs in case.
 * Read-only. Never matches on email or any other field.
 */
export async function findCustomersByDisplayName(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    displayName: string,
    fetchImpl: FetchLike = fetch,
): Promise<QuickBooksCustomerSummary[]> {
    if (displayNameProblem(displayName)) throw new IntuitError('rejected');
    const literal = `'${displayName.replace(/'/g, "\\'")}'`;
    const active = await queryCustomers(config, accessToken, realmId, `DisplayName = ${literal}`, fetchImpl);
    const inactive = await queryCustomers(config, accessToken, realmId, `DisplayName = ${literal} and Active = false`, fetchImpl);
    const byId = new Map<string, QuickBooksCustomerSummary>();
    for (const c of [...active, ...inactive]) byId.set(c.id, c);
    return [...byId.values()];
}

/**
 * INACTIVE QuickBooks customers whose DisplayName Intuit considers equal to `displayName` — used only
 * to find the "<organization name> (deleted)" customer QuickBooks leaves behind when it makes a
 * customer inactive (verified in the Intuit sandbox, 2026-09-14; owner ruling B). One read-only query;
 * the caller compares byte for byte. The literal may run past the 100 characters FreezerIQ allows for a
 * NEW customer name, because QuickBooks added the suffix.
 */
export async function findInactiveCustomersByDisplayName(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    displayName: string,
    fetchImpl: FetchLike = fetch,
): Promise<QuickBooksCustomerSummary[]> {
    const problem = displayNameProblem(displayName);
    if ((problem && problem !== 'too_long') || displayName.length > 500) throw new IntuitError('rejected');
    const literal = `'${displayName.replace(/'/g, "\\'")}'`;
    return queryCustomers(config, accessToken, realmId, `DisplayName = ${literal} and Active = false`, fetchImpl);
}

/** One QuickBooks customer by id, or null when Intuit reports it does not exist (Fault 610). Read-only. */
export async function readCustomer(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    customerId: string,
    fetchImpl: FetchLike = fetch,
): Promise<QuickBooksCustomerSummary | null> {
    if (!CUSTOMER_ID.test(customerId)) throw new IntuitError('rejected');
    const { res, body, tid } = await accountingRequest(config, accessToken, realmId,
        `/customer/${customerId}?minorversion=${QUICKBOOKS_MINOR_VERSION}`, { method: 'GET' }, fetchImpl);
    const codes = faultCodes(body);
    if (codes?.includes('610')) return null;
    if (!res.ok || codes) throw new IntuitError(res.status >= 500 || res.ok ? 'http' : 'rejected', { status: res.status, intuitTid: tid });
    const c = parseCustomer(body?.Customer);
    if (!c || c.id !== customerId) throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    return c;
}

/**
 * Creates a QuickBooks customer with a DisplayName and NOTHING else — no email,
 * phone, address or notes. `requestId` makes a repeated request return the first
 * response rather than create again.
 *
 * Outcomes: the created customer; IntuitError 'duplicate_name' (Fault 6240, nothing
 * created); 'rejected' (another 4xx Fault, nothing created). 'network', 'http' with a
 * 5xx status, and 'malformed' are AMBIGUOUS — the customer may exist.
 */
export async function createCustomer(
    config: QuickBooksConfig,
    accessToken: string,
    realmId: string,
    displayName: string,
    requestId: string,
    fetchImpl: FetchLike = fetch,
): Promise<QuickBooksCustomerSummary> {
    if (displayNameProblem(displayName) || !REQUEST_ID.test(requestId)) throw new IntuitError('rejected');
    const { res, body, tid } = await accountingRequest(config, accessToken, realmId,
        `/customer?minorversion=${QUICKBOOKS_MINOR_VERSION}&requestid=${encodeURIComponent(requestId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ DisplayName: displayName }) },
        fetchImpl);
    const codes = faultCodes(body);
    if (codes?.includes('6240')) throw new IntuitError('duplicate_name', { status: res.status, intuitTid: tid });
    if (res.status >= 500) throw new IntuitError('http', { status: res.status, intuitTid: tid });
    if (!res.ok || codes) throw new IntuitError(res.ok ? 'malformed' : 'rejected', { status: res.status, intuitTid: tid });
    const c = parseCustomer(body?.Customer);
    if (!c) throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    return c;
}
