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
 *     query/read and a DisplayName-only Customer create; and — QB-INVOICE-1C —
 *     Preferences/Account/Item/Term reads, a confirmed Service-item create, and
 *     one invoice's create (always unsent), read by its own id, recipient/payment-
 *     option update and explicit send; and — QB-INVOICE-1D — a READ of the one
 *     Payment an invoice's own LinkedTxn names. Nothing here creates, updates,
 *     voids or records a payment, nothing queries or searches payments, and
 *     nothing queries or searches invoices.
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
    | 'rejected'
    /** QB-INVOICE-1C: Fault 610 — the object does not exist (or is not visible to this company). */
    | 'not_found'
    /** QB-INVOICE-1C: Fault 5010 — the SyncToken is stale; someone changed the object in between. Nothing was written. */
    | 'stale_object';

export class IntuitError extends Error {
    readonly kind: IntuitErrorKind;
    readonly status?: number;
    readonly intuitTid?: string;
    /**
     * QB-INVOICE-1C: Intuit's numeric Fault codes (e.g. "6000", "2380"), when the response carried
     * a Fault. Codes only — never Intuit's message or detail text, which can echo request data.
     */
    readonly faultCodes?: string[];

    constructor(kind: IntuitErrorKind, detail: { status?: number; intuitTid?: string; faultCodes?: string[] } = {}) {
        // The message is built from the reason code only — never from a body.
        super(`Intuit request failed: ${kind}${detail.status ? ` (HTTP ${detail.status})` : ''}`);
        // tsconfig targets ES5, where extending Error loses the prototype chain and
        // `instanceof IntuitError` is silently false (see lib/bundleContents.ts).
        Object.setPrototypeOf(this, IntuitError.prototype);
        this.name = 'IntuitError';
        this.kind = kind;
        this.status = detail.status;
        this.intuitTid = detail.intuitTid;
        if (detail.faultCodes && detail.faultCodes.length) this.faultCodes = detail.faultCodes.filter((c) => /^[0-9A-Za-z-]{1,16}$/.test(c)).slice(0, 8);
    }
}

/**
 * The ONE sanitized description of a failed Intuit request — for server logs and for the durable
 * `problem_detail` a tenant's support case is reconstructed from (Intuit App Assessment, Error Handling Q3).
 *
 * It is built ONLY from fields IntuitError already holds, each of which was validated when it was captured:
 * the reason code, the HTTP status, Intuit's numeric Fault codes, and `intuit_tid` — Intuit's own correlation
 * id, which is what their support asks for. A response body is never reparsed here and never included, so no
 * token, authorization code, client secret, realm id, customer name, email address, amount or invoice line can
 * reach a log line or a database column through this function. Anything that is not an IntuitError reduces to
 * its error NAME, never its message.
 *
 * Deterministic and bounded: at most ~140 characters, so it always fits the 500-character `problem_detail`
 * constraint alongside a reason code.
 */
export function intuitErrorDetail(error: unknown): string {
    if (!(error instanceof IntuitError)) {
        const name = error instanceof Error && /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : 'unknown';
        return `kind:${name}`;
    }
    const parts = [`kind:${error.kind}`];
    if (typeof error.status === 'number' && Number.isFinite(error.status)) parts.push(`http:${error.status}`);
    if (error.faultCodes?.length) parts.push(`fault:${error.faultCodes.join('|')}`);
    if (error.intuitTid) parts.push(`tid:${error.intuitTid}`);
    return parts.join(',').slice(0, 140);
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

// ── QB-INVOICE-1C: invoice create / read / update / send, and the setup reads ──────────────
//
// Facts relied on (Intuit Accounting API docs and the 1C sandbox spikes, 2026-09-15):
//   - a POST carrying `requestid` is idempotent: a repeat returns the original response;
//   - a SPARSE update applies only the fields sent — EXCEPT the four online-payment flags, which
//     QuickBooks re-defaults to the company setting whenever an update omits them (verified: even a
//     memo-only update flipped false -> true). So every invoice update built here restates all four,
//     and `updateQuickBooksInvoiceDelivery` cannot be called without them;
//   - `POST /invoice/{id}/send` with Content-Type application/octet-stream and no body sends to the
//     invoice's BillEmail (+ BillEmailCc), sets EmailStatus=EmailSent and fills DeliveryInfo; a
//     DeliveryErrorType can appear asynchronously a minute or two later;
//   - QuickBooks auto-emails an API-created US invoice only when card or ACH payment is enabled ON THE
//     INVOICE (both documented rule sets agree), which is why a create built here carries all four flags
//     explicitly false, EmailStatus NotSet and no recipient at all — enforced below, not by callers;
//   - HTTP 200 can still carry a Fault.
// Nothing here queries or searches QuickBooks invoices: an invoice is read only by the id FreezerIQ's
// own create returned (docs/ai/QUICKBOOKS_INTEGRATION.md §11.5 recording contract). Parsed results keep
// an allowlist of fields; nothing is logged.

const OBJECT_ID = /^[0-9]{1,32}$/;
const MAX_EMAIL_FIELD = 100;
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown, max = 4000): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const refValue = (v: any): string | null => (v && typeof v === 'object' && typeof v.value === 'string' && v.value.length <= 64 ? v.value : null);
const emailOf = (v: any): string | null => (v && typeof v === 'object' && typeof v.Address === 'string' && v.Address.length > 0 ? v.Address.slice(0, 256) : null);

/** Throws the IntuitError a failed Accounting response deserves. Writes pass `write` so a 200-with-Fault is AMBIGUOUS, not a refusal. */
function throwFailure(res: Response, body: any, tid: string | undefined, write: boolean): never {
    const codes = faultCodes(body) ?? [];
    const detail = { status: res.status, intuitTid: tid, faultCodes: codes };
    if (codes.includes('610')) throw new IntuitError('not_found', detail);
    if (codes.includes('5010')) throw new IntuitError('stale_object', detail);
    if (codes.includes('6240')) throw new IntuitError('duplicate_name', detail);
    if (res.status >= 500) throw new IntuitError('http', detail);
    if (res.ok) throw new IntuitError(write ? 'malformed' : 'http', detail);
    throw new IntuitError('rejected', detail);
}

async function accountingJson(
    config: QuickBooksConfig, accessToken: string, realmId: string, pathAndQuery: string, init: RequestInit, fetchImpl: FetchLike,
): Promise<{ body: any; status: number; tid?: string }> {
    const write = (init.method ?? 'GET').toUpperCase() !== 'GET';
    const { res, body, tid } = await accountingRequest(config, accessToken, realmId, pathAndQuery, init, fetchImpl);
    if (!res.ok || faultCodes(body)) throwFailure(res, body, tid, write);
    if (!body || typeof body !== 'object') throw new IntuitError('malformed', { status: res.status, intuitTid: tid });
    return { body, status: res.status, tid };
}

const mv = `minorversion=${QUICKBOOKS_MINOR_VERSION}`;

async function queryEntities(
    config: QuickBooksConfig, accessToken: string, realmId: string, query: string, entity: string, fetchImpl: FetchLike,
): Promise<any[]> {
    const { body, status, tid } = await accountingJson(config, accessToken, realmId, `/query?query=${encodeURIComponent(query)}&${mv}`, { method: 'GET' }, fetchImpl);
    const qr = body.QueryResponse;
    if (!qr || typeof qr !== 'object') throw new IntuitError('malformed', { status, intuitTid: tid });
    if (qr[entity] === undefined) return [];
    if (!Array.isArray(qr[entity])) throw new IntuitError('malformed', { status, intuitTid: tid });
    return qr[entity];
}

async function readEntity(
    config: QuickBooksConfig, accessToken: string, realmId: string, entityPath: string, id: string, entity: string, fetchImpl: FetchLike,
): Promise<any | null> {
    if (!OBJECT_ID.test(id)) throw new IntuitError('rejected');
    try {
        const { body, status, tid } = await accountingJson(config, accessToken, realmId, `/${entityPath}/${id}?${mv}`, { method: 'GET' }, fetchImpl);
        if (!body[entity] || typeof body[entity] !== 'object') throw new IntuitError('malformed', { status, intuitTid: tid });
        return body[entity];
    } catch (e) {
        if (e instanceof IntuitError && e.kind === 'not_found') return null;
        throw e;
    }
}

// ── setup reads (tenant mapping) ──

export interface QuickBooksAccountSummary {
    id: string;
    name: string;
    accountType: string;
    accountSubType: string | null;
    active: boolean;
}

export interface QuickBooksItemSummary {
    id: string;
    name: string;
    /** Service | NonInventory | Inventory | Group | Category … */
    type: string;
    active: boolean;
    /** The account an invoice line with this item posts to. */
    incomeAccountId: string | null;
}

export interface QuickBooksTermSummary {
    id: string;
    name: string;
    /** STANDARD (due N days after the invoice date) or DATE_DRIVEN. */
    type: string | null;
    dueDays: number | null;
    active: boolean;
}

/** The company settings the 1C gates read. Addresses are reduced to presence; nothing else is kept. */
export interface QuickBooksSalesPreferences {
    /** A company-wide CC address exists; QuickBooks copies it onto any invoice whose own CC is blank. */
    defaultCcPresent: boolean;
    defaultBccPresent: boolean;
    /** QuickBooks emails the company a copy of every customer email. */
    emailCopyToCompany: boolean;
    /** Preferences.SalesFormsPrefs.ETransactionPaymentEnabled — online payments are active for the company. */
    onlinePaymentsEnabled: boolean;
    /** Custom transaction numbers: QuickBooks then leaves DocNumber blank unless one is supplied. */
    customTxnNumbers: boolean;
    homeCurrency: string | null;
    multiCurrencyEnabled: boolean;
}

function parseAccount(raw: any): QuickBooksAccountSummary | null {
    if (!raw || typeof raw.Id !== 'string' || !OBJECT_ID.test(raw.Id) || typeof raw.Name !== 'string' || typeof raw.AccountType !== 'string') return null;
    return { id: raw.Id, name: raw.Name.slice(0, 200), accountType: raw.AccountType.slice(0, 64), accountSubType: strOrNull(raw.AccountSubType, 64), active: raw.Active === true };
}

function parseItem(raw: any): QuickBooksItemSummary | null {
    if (!raw || typeof raw.Id !== 'string' || !OBJECT_ID.test(raw.Id) || typeof raw.Name !== 'string' || typeof raw.Type !== 'string') return null;
    return { id: raw.Id, name: raw.Name.slice(0, 200), type: raw.Type.slice(0, 32), active: raw.Active === true, incomeAccountId: refValue(raw.IncomeAccountRef) };
}

function parseTerm(raw: any): QuickBooksTermSummary | null {
    if (!raw || typeof raw.Id !== 'string' || !OBJECT_ID.test(raw.Id) || typeof raw.Name !== 'string') return null;
    return { id: raw.Id, name: raw.Name.slice(0, 200), type: strOrNull(raw.Type, 32), dueDays: numOrNull(raw.DueDays), active: raw.Active === true };
}

function parseAll<T>(rows: any[], parse: (r: any) => T | null): T[] {
    return rows.map((r) => {
        const p = parse(r);
        if (!p) throw new IntuitError('malformed'); // fail closed, never skip
        return p;
    });
}

export async function readQuickBooksPreferences(config: QuickBooksConfig, accessToken: string, realmId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksSalesPreferences> {
    const { body, status, tid } = await accountingJson(config, accessToken, realmId, `/preferences?${mv}`, { method: 'GET' }, fetchImpl);
    const p = body.Preferences;
    if (!p || typeof p !== 'object') throw new IntuitError('malformed', { status, intuitTid: tid });
    const sf = p.SalesFormsPrefs ?? {};
    const cp = p.CurrencyPrefs ?? {};
    return {
        defaultCcPresent: !!emailOf(sf.SalesEmailCc),
        defaultBccPresent: !!emailOf(sf.SalesEmailBcc),
        emailCopyToCompany: sf.EmailCopyToCompany === true,
        onlinePaymentsEnabled: sf.ETransactionPaymentEnabled === true,
        customTxnNumbers: sf.CustomTxnNumbers === true,
        homeCurrency: refValue(cp.HomeCurrency),
        multiCurrencyEnabled: cp.MultiCurrencyEnabled === true,
    };
}

/** Active accounts (QuickBooks' default query returns active name-list entities only). */
export async function listQuickBooksAccounts(config: QuickBooksConfig, accessToken: string, realmId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksAccountSummary[]> {
    return parseAll(await queryEntities(config, accessToken, realmId, 'select * from Account maxresults 1000', 'Account', fetchImpl), parseAccount);
}

/** Active items. */
export async function listQuickBooksItems(config: QuickBooksConfig, accessToken: string, realmId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksItemSummary[]> {
    return parseAll(await queryEntities(config, accessToken, realmId, 'select * from Item maxresults 1000', 'Item', fetchImpl), parseItem);
}

/** Active payment terms. */
export async function listQuickBooksTerms(config: QuickBooksConfig, accessToken: string, realmId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksTermSummary[]> {
    return parseAll(await queryEntities(config, accessToken, realmId, 'select * from Term maxresults 200', 'Term', fetchImpl), parseTerm);
}

export async function readQuickBooksAccount(config: QuickBooksConfig, accessToken: string, realmId: string, accountId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksAccountSummary | null> {
    const raw = await readEntity(config, accessToken, realmId, 'account', accountId, 'Account', fetchImpl);
    if (raw === null) return null;
    const a = parseAccount(raw);
    if (!a || a.id !== accountId) throw new IntuitError('malformed');
    return a;
}

export async function readQuickBooksItem(config: QuickBooksConfig, accessToken: string, realmId: string, itemId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksItemSummary | null> {
    const raw = await readEntity(config, accessToken, realmId, 'item', itemId, 'Item', fetchImpl);
    if (raw === null) return null;
    const i = parseItem(raw);
    if (!i || i.id !== itemId) throw new IntuitError('malformed');
    return i;
}

export async function readQuickBooksTerm(config: QuickBooksConfig, accessToken: string, realmId: string, termId: string, fetchImpl: FetchLike = fetch): Promise<QuickBooksTermSummary | null> {
    const raw = await readEntity(config, accessToken, realmId, 'term', termId, 'Term', fetchImpl);
    if (raw === null) return null;
    const t = parseTerm(raw);
    if (!t || t.id !== termId) throw new IntuitError('malformed');
    return t;
}

/**
 * Creates a non-taxable Service item that posts to `incomeAccountId` — called ONLY after an explicit
 * tenant confirmation (lib/quickbooks/invoiceSettings.ts). Outcomes as createCustomer: 'duplicate_name'
 * and 'rejected' created nothing; 'network' / 5xx 'http' / 'malformed' are AMBIGUOUS.
 */
export async function createQuickBooksServiceItem(
    config: QuickBooksConfig, accessToken: string, realmId: string,
    input: { name: string; incomeAccountId: string }, requestId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksItemSummary> {
    if (displayNameProblem(input.name) || !OBJECT_ID.test(input.incomeAccountId) || !REQUEST_ID.test(requestId)) throw new IntuitError('rejected');
    const { body, status, tid } = await accountingJson(config, accessToken, realmId, `/item?${mv}&requestid=${encodeURIComponent(requestId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Name: input.name, Type: 'Service', Taxable: false, IncomeAccountRef: { value: input.incomeAccountId } }),
    }, fetchImpl);
    const item = parseItem(body.Item);
    if (!item) throw new IntuitError('malformed', { status, intuitTid: tid });
    return item;
}

// ── invoices ──

export interface QuickBooksPaymentFlags {
    card: boolean;
    ach: boolean;
    paypal: boolean;
    affirm: boolean;
}

export const PAYMENT_FLAGS_OFF: Readonly<QuickBooksPaymentFlags> = Object.freeze({ card: false, ach: false, paypal: false, affirm: false });

export interface QuickBooksInvoiceLineSnapshot {
    detailType: string;
    amount: number | null;
    description: string | null;
    itemId: string | null;
    /** The account the line actually posts to, as QuickBooks reports it. */
    itemAccountId: string | null;
    qty: number | null;
    unitPrice: number | null;
    taxCode: string | null;
}

/** An allowlisted view of a QuickBooks invoice — everything the read-back contracts check, nothing else. */
export interface QuickBooksInvoiceSnapshot {
    id: string;
    syncToken: string;
    docNumber: string | null;
    txnDate: string | null;
    dueDate: string | null;
    customerId: string | null;
    currency: string | null;
    termId: string | null;
    billEmail: string | null;
    billEmailCc: string | null;
    billEmailBcc: string | null;
    emailStatus: string | null;
    delivery: { type: string | null; time: string | null; errorType: string | null } | null;
    eInvoiceStatus: string | null;
    totalAmt: number | null;
    balance: number | null;
    /** QuickBooks' own tax total for the transaction (`TxnTaxDetail.TotalTax`). */
    totalTax: number | null;
    /** Every QuickBooks-native tax line's amount, in order; `null` for one QuickBooks did not report as a number. */
    taxLineAmounts: (number | null)[];
    /** The transaction tax code QuickBooks attaches (`TxnTaxCodeRef`). Metadata: it carries no amount of its own. */
    txnTaxCodeId: string | null;
    /** False when a tax block is present in a shape this parser cannot interpret, so the contract can fail closed. */
    taxDetailReadable: boolean;
    payment: { card: boolean | null; ach: boolean | null; paypal: boolean | null; affirm: boolean | null };
    customerMemo: string | null;
    lines: QuickBooksInvoiceLineSnapshot[];
}

/**
 * QuickBooks' transaction tax block, reduced to the two facts the read-back contract needs: QuickBooks' own tax
 * total, and every native tax line's amount. A company on Automated Sales Tax returns this block on invoices
 * FreezerIQ sends no tax detail for — a transaction tax code, and in some companies a zero-value tax line — so the
 * contract has to judge the AMOUNTS, not the presence of the metadata. `readable` is false when the block is present
 * but in a shape this parser cannot interpret (including a TotalTax that is not a finite number): the contract then
 * fails closed rather than reading an unknown shape as "no tax".
 */
function taxDetailOf(tt: any): { totalTax: number | null; taxLineAmounts: (number | null)[]; readable: boolean } {
    if (tt === undefined || tt === null) return { totalTax: null, taxLineAmounts: [], readable: true };
    if (typeof tt !== 'object' || Array.isArray(tt)) return { totalTax: null, taxLineAmounts: [], readable: false };
    const stated = tt.TotalTax !== undefined && tt.TotalTax !== null;
    const totalTax = stated ? numOrNull(tt.TotalTax) : null;
    const lines = tt.TaxLine;
    const linesReadable = lines === undefined || lines === null || Array.isArray(lines);
    return {
        totalTax,
        taxLineAmounts: Array.isArray(lines) ? lines.map((l: any) => numOrNull(l?.Amount)) : [],
        readable: (!stated || totalTax !== null) && linesReadable,
    };
}

export function parseQuickBooksInvoice(raw: any): QuickBooksInvoiceSnapshot | null {
    if (!raw || typeof raw !== 'object' || typeof raw.Id !== 'string' || !OBJECT_ID.test(raw.Id) || typeof raw.SyncToken !== 'string') return null;
    if (raw.Line !== undefined && !Array.isArray(raw.Line)) return null;
    const di = raw.DeliveryInfo;
    const tt = raw.TxnTaxDetail;
    const tax = taxDetailOf(tt);
    return {
        id: raw.Id,
        syncToken: raw.SyncToken.slice(0, 32),
        docNumber: strOrNull(raw.DocNumber, 32),
        txnDate: strOrNull(raw.TxnDate, 32),
        dueDate: strOrNull(raw.DueDate, 32),
        customerId: refValue(raw.CustomerRef),
        currency: refValue(raw.CurrencyRef),
        termId: refValue(raw.SalesTermRef),
        billEmail: emailOf(raw.BillEmail),
        billEmailCc: emailOf(raw.BillEmailCc),
        billEmailBcc: emailOf(raw.BillEmailBcc),
        emailStatus: strOrNull(raw.EmailStatus, 32),
        delivery: di && typeof di === 'object' ? { type: strOrNull(di.DeliveryType, 32), time: strOrNull(di.DeliveryTime, 64), errorType: strOrNull(di.DeliveryErrorType, 64) } : null,
        eInvoiceStatus: strOrNull(raw.EInvoiceStatus, 32),
        totalAmt: numOrNull(raw.TotalAmt),
        balance: numOrNull(raw.Balance),
        totalTax: tax.totalTax,
        taxLineAmounts: tax.taxLineAmounts,
        txnTaxCodeId: tt && typeof tt === 'object' ? refValue(tt.TxnTaxCodeRef) : null,
        taxDetailReadable: tax.readable,
        payment: {
            card: boolOrNull(raw.AllowOnlineCreditCardPayment),
            ach: boolOrNull(raw.AllowOnlineACHPayment),
            paypal: boolOrNull(raw.AllowOnlinePayPalPayment),
            affirm: boolOrNull(raw.AllowOnlineAffirmPayment),
        },
        customerMemo: raw.CustomerMemo && typeof raw.CustomerMemo === 'object' ? strOrNull(raw.CustomerMemo.value, 1000) : null,
        lines: (raw.Line ?? []).map((l: any) => ({
            detailType: typeof l?.DetailType === 'string' ? l.DetailType.slice(0, 64) : 'Unknown',
            amount: numOrNull(l?.Amount),
            description: strOrNull(l?.Description),
            itemId: refValue(l?.SalesItemLineDetail?.ItemRef),
            itemAccountId: refValue(l?.SalesItemLineDetail?.ItemAccountRef),
            qty: numOrNull(l?.SalesItemLineDetail?.Qty),
            unitPrice: numOrNull(l?.SalesItemLineDetail?.UnitPrice),
            taxCode: refValue(l?.SalesItemLineDetail?.TaxCodeRef),
        })),
    };
}

/** The ONLY invoice create body this module sends: no recipient, EmailStatus NotSet, every online-payment flag false. */
export interface QuickBooksInvoiceCreateBody {
    CustomerRef: { value: string };
    TxnDate: string;
    SalesTermRef: { value: string };
    PrivateNote: string;
    CustomerMemo?: { value: string };
    EmailStatus: 'NotSet';
    AllowOnlineCreditCardPayment: false;
    AllowOnlineACHPayment: false;
    AllowOnlinePayPalPayment: false;
    AllowOnlineAffirmPayment: false;
    Line: Array<{
        DetailType: 'SalesItemLineDetail';
        Amount: number;
        Description: string;
        SalesItemLineDetail: { ItemRef: { value: string }; Qty: number; UnitPrice: number; TaxCodeRef: { value: 'NON' } };
    }>;
}

const CREATE_KEYS = ['CustomerRef', 'TxnDate', 'SalesTermRef', 'PrivateNote', 'CustomerMemo', 'EmailStatus',
    'AllowOnlineCreditCardPayment', 'AllowOnlineACHPayment', 'AllowOnlinePayPalPayment', 'AllowOnlineAffirmPayment', 'Line'];
const PAYMENT_FLAG_FIELDS = ['AllowOnlineCreditCardPayment', 'AllowOnlineACHPayment', 'AllowOnlinePayPalPayment', 'AllowOnlineAffirmPayment'];

/**
 * Defence in depth for the send-safety rule: refuses — before any request — a create body that names a
 * recipient, a DocNumber, native tax, a discount, a non-NotSet EmailStatus, any payment flag that is not
 * explicitly false, or a line that is not a NON-taxable item line.
 */
export function assertUnsentInvoiceCreateBody(body: QuickBooksInvoiceCreateBody): void {
    const b = body as any;
    const bad = (why: string): never => { throw new IntuitError('rejected', { faultCodes: [`local-${why}`] }); };
    if (!b || typeof b !== 'object') bad('body');
    for (const k of Object.keys(b)) if (CREATE_KEYS.indexOf(k) === -1) bad('field');
    if (b.EmailStatus !== 'NotSet') bad('email-status');
    for (const f of PAYMENT_FLAG_FIELDS) if (b[f] !== false) bad('payment-flag');
    if (!OBJECT_ID.test(b.CustomerRef?.value ?? '') || !OBJECT_ID.test(b.SalesTermRef?.value ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(b.TxnDate ?? '')) bad('header');
    if (!Array.isArray(b.Line) || b.Line.length === 0) bad('lines');
    for (const l of b.Line) {
        if (l?.DetailType !== 'SalesItemLineDetail' || Object.keys(l).some((k) => ['DetailType', 'Amount', 'Description', 'SalesItemLineDetail'].indexOf(k) === -1)) bad('line-type');
        const d = l.SalesItemLineDetail;
        if (!d || Object.keys(d).some((k) => ['ItemRef', 'Qty', 'UnitPrice', 'TaxCodeRef'].indexOf(k) === -1)) bad('line-detail');
        if (d.TaxCodeRef?.value !== 'NON' || !OBJECT_ID.test(d.ItemRef?.value ?? '')) bad('line-tax-code');
        if (![l.Amount, d.Qty, d.UnitPrice].every((n) => typeof n === 'number' && Number.isFinite(n))) bad('line-money');
        if (typeof l.Description !== 'string' || l.Description.length === 0 || l.Description.length > 4000) bad('line-description');
    }
    if (typeof b.PrivateNote !== 'string' || b.PrivateNote.length > 4000) bad('private-note');
    if (b.CustomerMemo !== undefined && (typeof b.CustomerMemo?.value !== 'string' || b.CustomerMemo.value.length > 1000)) bad('memo');
}

/** Recipients + online-payment options for a SPARSE update. Every field is always sent, flags included. */
export interface QuickBooksInvoiceDeliveryFields {
    billEmail: string;
    /** One address or a comma-separated list; null leaves any existing CC untouched (V1 never clears one). */
    billEmailCc: string | null;
    payment: QuickBooksPaymentFlags;
}

/** One RFC 5322-style mailbox (local@domain), deliberately conservative. */
export const QUICKBOOKS_RECIPIENT = /^[A-Za-z0-9.!#$%&*+/=?^_{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function deliveryBody(id: string, syncToken: string, f: QuickBooksInvoiceDeliveryFields): Record<string, unknown> {
    const flags = [f?.payment?.card, f?.payment?.ach, f?.payment?.paypal, f?.payment?.affirm];
    if (!flags.every((x) => typeof x === 'boolean')) throw new IntuitError('rejected', { faultCodes: ['local-payment-flags-incomplete'] });
    if (typeof f.billEmail !== 'string' || f.billEmail.length > MAX_EMAIL_FIELD || !QUICKBOOKS_RECIPIENT.test(f.billEmail)) throw new IntuitError('rejected', { faultCodes: ['local-recipient'] });
    if (f.billEmailCc !== null && (typeof f.billEmailCc !== 'string' || f.billEmailCc.length > MAX_EMAIL_FIELD
        || !f.billEmailCc.split(',').map((s) => s.trim()).every((s) => QUICKBOOKS_RECIPIENT.test(s)))) throw new IntuitError('rejected', { faultCodes: ['local-cc'] });
    return {
        Id: id, SyncToken: syncToken, sparse: true,
        BillEmail: { Address: f.billEmail },
        ...(f.billEmailCc !== null ? { BillEmailCc: { Address: f.billEmailCc } } : {}),
        AllowOnlineCreditCardPayment: f.payment.card,
        AllowOnlineACHPayment: f.payment.ach,
        AllowOnlinePayPalPayment: f.payment.paypal,
        AllowOnlineAffirmPayment: f.payment.affirm,
    };
}

function invoiceFrom(body: any, status: number, tid?: string): QuickBooksInvoiceSnapshot {
    const inv = parseQuickBooksInvoice(body?.Invoice);
    if (!inv) throw new IntuitError('malformed', { status, intuitTid: tid });
    return inv;
}

/**
 * Creates the UNSENT QuickBooks invoice. `requestId` must be the invoice link's reserved idempotency key.
 * 'rejected' created nothing; 'network', 5xx 'http' and 'malformed' are AMBIGUOUS — repeat with the same requestId.
 */
export async function createQuickBooksInvoice(
    config: QuickBooksConfig, accessToken: string, realmId: string,
    body: QuickBooksInvoiceCreateBody, requestId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksInvoiceSnapshot> {
    if (!REQUEST_ID.test(requestId)) throw new IntuitError('rejected', { faultCodes: ['local-request-id'] });
    assertUnsentInvoiceCreateBody(body);
    const r = await accountingJson(config, accessToken, realmId, `/invoice?${mv}&requestid=${encodeURIComponent(requestId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl);
    return invoiceFrom(r.body, r.status, r.tid);
}

/** Reads one QuickBooks invoice by the id FreezerIQ's own create returned; null when QuickBooks reports it missing (610). */
export async function readQuickBooksInvoice(
    config: QuickBooksConfig, accessToken: string, realmId: string, qboInvoiceId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksInvoiceSnapshot | null> {
    const raw = await readEntity(config, accessToken, realmId, 'invoice', qboInvoiceId, 'Invoice', fetchImpl);
    if (raw === null) return null;
    const inv = parseQuickBooksInvoice(raw);
    if (!inv || inv.id !== qboInvoiceId) throw new IntuitError('malformed');
    return inv;
}

// ── QB-INVOICE-1D: payment EVIDENCE — read-only ─────────────────────────────────────────────
//
// Facts relied on — Intuit's Invoice and Payment entity references (minorversion 75), confirmed field by
// field against real responses in the 1D sandbox shape spike (2026-09-21):
//   - Invoice.LinkedTxn lists every payment applied to the invoice as { TxnId, TxnType: 'Payment' }. Intuit:
//     "Links to Payment transactions are established within the QuickBooks UI, only, and are available as
//     read-only at the API level. Use LinkedTxn.TxnId as the ID in a separate read request." An unpaid
//     invoice reads back `LinkedTxn: []`.
//   - A credit memo applied to an invoice does NOT appear on the invoice as a CreditMemo: it appears as a
//     linked PAYMENT whose TotalAmt is 0 and whose lines link the Invoice AND the CreditMemo. A linked Payment
//     is therefore not evidence that money arrived — only the Payment object itself can say that.
//   - Payment.Line[].LinkedTxn.TxnType is one of Invoice, CreditMemo, JournalEntry, Expense, Check,
//     CreditCardCredit. An overpayment carries UnappliedAmt > 0. A voided Payment is unlinked from the
//     invoice and reads back TotalAmt 0 and Line [].
//   - Payment has no status field: an in-flight bank (ACH) payment reads exactly like a settled one.
// Only ONE Payment is ever read — the id the invoice's own LinkedTxn names — and nothing here queries,
// creates, updates, voids or records a payment.

/** One entry of a transaction's LinkedTxn, as Intuit returns it. */
export interface QuickBooksLinkedTxnRef {
    txnId: string;
    txnType: string;
}

/** An allowlisted view of one QuickBooks Payment — the evidence fields, nothing else (no note, no card data). */
export interface QuickBooksPaymentSnapshot {
    id: string;
    txnDate: string | null;
    customerId: string | null;
    currency: string | null;
    totalAmt: number | null;
    unappliedAmt: number | null;
    lines: Array<{ amount: number | null; linked: QuickBooksLinkedTxnRef[] | null }>;
}

const TXN_TYPE = /^[A-Za-z]{1,32}$/;

/** Parses a LinkedTxn array. null when it is absent or any entry is not exactly { TxnId, TxnType } — never skipped. */
export function parseLinkedTxns(raw: unknown): QuickBooksLinkedTxnRef[] | null {
    if (!Array.isArray(raw)) return null;
    const out: QuickBooksLinkedTxnRef[] = [];
    for (const l of raw) {
        if (!l || typeof l !== 'object' || typeof (l as any).TxnId !== 'string' || !OBJECT_ID.test((l as any).TxnId)
            || typeof (l as any).TxnType !== 'string' || !TXN_TYPE.test((l as any).TxnType)) return null;
        out.push({ txnId: (l as any).TxnId, txnType: (l as any).TxnType });
    }
    return out;
}

export function parseQuickBooksPayment(raw: any): QuickBooksPaymentSnapshot | null {
    if (!raw || typeof raw !== 'object' || typeof raw.Id !== 'string' || !OBJECT_ID.test(raw.Id)) return null;
    if (raw.Line !== undefined && !Array.isArray(raw.Line)) return null;
    return {
        id: raw.Id,
        txnDate: strOrNull(raw.TxnDate, 32),
        customerId: refValue(raw.CustomerRef),
        currency: refValue(raw.CurrencyRef),
        totalAmt: numOrNull(raw.TotalAmt),
        unappliedAmt: numOrNull(raw.UnappliedAmt),
        lines: (raw.Line ?? []).map((l: any) => ({ amount: numOrNull(l?.Amount), linked: parseLinkedTxns(l?.LinkedTxn) })),
    };
}

/**
 * Reads one QuickBooks invoice — by the id FreezerIQ's own create returned — together with its LinkedTxn, for the
 * payment check. The invoice snapshot is exactly readQuickBooksInvoice's; `linkedTxns` is null when QuickBooks
 * returned none or something that is not a well-formed LinkedTxn array. null when the invoice is missing (610).
 */
export async function readQuickBooksInvoicePaymentLinks(
    config: QuickBooksConfig, accessToken: string, realmId: string, qboInvoiceId: string, fetchImpl: FetchLike = fetch,
): Promise<{ invoice: QuickBooksInvoiceSnapshot; linkedTxns: QuickBooksLinkedTxnRef[] | null } | null> {
    const raw = await readEntity(config, accessToken, realmId, 'invoice', qboInvoiceId, 'Invoice', fetchImpl);
    if (raw === null) return null;
    const invoice = parseQuickBooksInvoice(raw);
    if (!invoice || invoice.id !== qboInvoiceId) throw new IntuitError('malformed');
    return { invoice, linkedTxns: parseLinkedTxns(raw.LinkedTxn) };
}

/** Reads ONE QuickBooks Payment by the id an invoice's LinkedTxn named; null when QuickBooks reports it missing (610). */
export async function readQuickBooksPayment(
    config: QuickBooksConfig, accessToken: string, realmId: string, paymentId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksPaymentSnapshot | null> {
    const raw = await readEntity(config, accessToken, realmId, 'payment', paymentId, 'Payment', fetchImpl);
    if (raw === null) return null;
    const p = parseQuickBooksPayment(raw);
    if (!p || p.id !== paymentId) throw new IntuitError('malformed');
    return p;
}

/**
 * Sparse update of recipients and online-payment options ONLY — nothing financial is ever sent. The four
 * payment flags are always restated. 'stale_object' (5010) wrote nothing; 'network'/5xx/'malformed' are ambiguous.
 */
export async function updateQuickBooksInvoiceDelivery(
    config: QuickBooksConfig, accessToken: string, realmId: string,
    input: { id: string; syncToken: string; fields: QuickBooksInvoiceDeliveryFields }, requestId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksInvoiceSnapshot> {
    if (!OBJECT_ID.test(input.id) || !/^[0-9]{1,16}$/.test(input.syncToken) || !REQUEST_ID.test(requestId)) throw new IntuitError('rejected', { faultCodes: ['local-update'] });
    const body = deliveryBody(input.id, input.syncToken, input.fields);
    const r = await accountingJson(config, accessToken, realmId, `/invoice?${mv}&requestid=${encodeURIComponent(requestId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl);
    const inv = invoiceFrom(r.body, r.status, r.tid);
    if (inv.id !== input.id) throw new IntuitError('malformed', { status: r.status, intuitTid: r.tid });
    return inv;
}

/**
 * QuickBooks' explicit send, to the invoice's own BillEmail and BillEmailCc (never a `sendTo` override).
 * A Fault (e.g. 2380: no email address) sent nothing; 'network'/5xx/'malformed' are AMBIGUOUS — read back.
 */
export async function sendQuickBooksInvoice(
    config: QuickBooksConfig, accessToken: string, realmId: string, qboInvoiceId: string, fetchImpl: FetchLike = fetch,
): Promise<QuickBooksInvoiceSnapshot> {
    if (!OBJECT_ID.test(qboInvoiceId)) throw new IntuitError('rejected', { faultCodes: ['local-invoice-id'] });
    const r = await accountingJson(config, accessToken, realmId, `/invoice/${qboInvoiceId}/send?${mv}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } }, fetchImpl);
    const inv = invoiceFrom(r.body, r.status, r.tid);
    if (inv.id !== qboInvoiceId) throw new IntuitError('malformed', { status: r.status, intuitTid: r.tid });
    return inv;
}
