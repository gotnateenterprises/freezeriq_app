/**
 * SEC-TENANT-1 — a server-signed authorisation to view a specific tenant.
 *
 * WHY THIS EXISTS
 *
 * The first cut of the fix gated View As on the trusted `token.isSuperAdmin`
 * and then took the target id and the tenant's display/plan metadata straight
 * from the browser's `update()` payload. That closed the cross-tenant hole, but
 * it left the boundary INCOHERENT in three ways that an adversarial pass found:
 *
 *   1. The jwt callback never checked the target existed. POST /api/admin/switch-tenant
 *      validated it, but nothing forced the browser to call that endpoint first —
 *      `update({ viewAsBusinessId: 'anything' })` reached the callback directly.
 *   2. The metadata fields travelled independently, so a payload could claim
 *      tenant B's id alongside tenant C's name and a plan neither tenant has.
 *   3. `plan` drives feature gates, so it should never be a free-text client value
 *      even when the caller is privileged enough that it grants them nothing new.
 *
 * A grant fixes all three at once. The endpoint proves super-admin, loads the
 * business row, and signs ONE bundle. The jwt callback accepts the bundle only
 * if the signature verifies, so every field arrives together from a single
 * server-side lookup, and an unvalidated or nonexistent target cannot be signed
 * in the first place.
 *
 * The grant is bound to the issuing admin (`sub`) so one super admin's grant is
 * useless in another's session, and it is short-lived so it cannot be hoarded.
 *
 * This is NOT the privilege boundary — `token.isSuperAdmin` still is, and it is
 * checked independently in lib/auth/sessionUpdate.ts. The grant answers a
 * different question: "which tenant, with which real attributes?"
 *
 * HMAC-SHA256 via Web Crypto, so this runs unchanged in the edge middleware
 * bundle (auth.config.ts is imported by middleware.ts) and in Node.
 */

export interface ViewAsGrant {
    /** The super-admin user id this grant was issued to. */
    sub: string;
    /** Target business id. */
    bid: string;
    name: string;
    plan: string;
    status: string;
    /** Expiry, epoch seconds. */
    exp: number;
}

/** Grants are relayed by the browser immediately; they do not need a long life. */
export const VIEW_AS_GRANT_TTL_SECONDS = 300;

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
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
    return new Uint8Array(sig);
}

/** Length-independent comparison, so a mismatch leaks nothing through timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export async function signViewAsGrant(payload: ViewAsGrant, secret: string): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const sig = b64url(await hmac(secret, body));
    return body + '.' + sig;
}

/**
 * Returns the grant only if the signature verifies and it has not expired.
 * Every failure path returns null — a bad grant is never a partial success.
 */
export async function verifyViewAsGrant(
    raw: unknown,
    secret: string,
    nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ViewAsGrant | null> {
    if (typeof raw !== 'string' || !raw || raw.length > 4096) return null;
    if (!secret) return null;

    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);

    const given = b64urlDecode(sig);
    if (!given) return null;

    const expected = await hmac(secret, body);
    if (!timingSafeEqual(given, expected)) return null;

    const bytes = b64urlDecode(body);
    if (!bytes) return null;

    let parsed: any;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const { sub, bid, name, plan, status, exp } = parsed;
    if (typeof sub !== 'string' || !sub) return null;
    if (typeof bid !== 'string' || !bid) return null;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
    if (exp <= nowSeconds) return null;

    return {
        sub,
        bid,
        name: typeof name === 'string' ? name : '',
        plan: typeof plan === 'string' ? plan : '',
        status: typeof status === 'string' ? status : '',
        exp,
    };
}
