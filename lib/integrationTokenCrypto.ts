/**
 * QB-INVOICE-1A — encryption at rest for third-party integration credentials.
 *
 * The legacy QuickBooks connector wrote access tokens, refresh tokens and the
 * company id to `integrations` in plaintext (lib/auth/token_manager.ts still
 * does, for the providers that use it). Anyone who can read that table — a
 * backup, a support query, a leaked read replica — could then act on a tenant's
 * books. This module is what the new QuickBooks connector stores instead.
 *
 * ── NOT NEW CRYPTO ──────────────────────────────────────────────────────────
 *
 * It is the same construction lib/outreachUnsubscribeToken.ts already uses and
 * that was reviewed for OUTREACH-CONSENT-1: Web Crypto AES-256-GCM, a key derived
 * with HKDF-SHA-256 from a dedicated environment secret, a random 96-bit IV per
 * message, and a `v1.` format prefix. Nothing here is hand-rolled; the GCM tag
 * does the authentication and its comparison is constant time.
 *
 * That module is not reused directly because it seals a fixed JSON shape (tenant
 * + email) under its own key. A credential needs a different key, so that the
 * compromise of one feature's secret never opens the other's data.
 *
 * ── THE ONE ADDITION: CONTEXT BINDING ───────────────────────────────────────
 *
 * Every ciphertext is bound, through GCM additional authenticated data, to the
 * provider, the tenant and the column it was written for. A value copied from
 * tenant A's row into tenant B's row — or from `refresh_token` into
 * `access_token` — fails authentication and opens to null. Row-level tampering
 * can therefore not move a credential between tenants even with write access to
 * the table, which is the property tenant isolation actually needs.
 *
 * ── KEY ROTATION ────────────────────────────────────────────────────────────
 *
 *     INTEGRATION_TOKEN_KEY_PREVIOUS = <old key>      (comma/newline separated)
 *     INTEGRATION_TOKEN_KEY          = <new key>
 *
 * New writes use the current key; reads try the current key, then each previous
 * one. That is the whole mechanism — nothing re-encrypts stored rows by itself:
 *
 *   - Replacing INTEGRATION_TOKEN_KEY WITHOUT listing the old key in _PREVIOUS
 *     makes every stored credential unreadable at once (fails closed:
 *     "reconnect required", Forget + reconnect).
 *   - With the old key in _PREVIOUS, a row moves to the new key only when the connector rewrites its access_token
 *     column: connect or reconnect, a successful refresh (including lost-commit
 *     reconciliation), and any tombstone written while the key set is in place — an
 *     admin disconnect, or a refresh that Intuit refuses (revoked / refresh_lost) or
 *     that finds the refresh token expired. The refresh lease claim and a
 *     failed-refresh release write refresh_token only: a transient failure restores
 *     the original ciphertext, an ambiguous one (timeout, lost response) re-seals just
 *     that column, leaving a mixed row. Idle connections, transient refresh failures
 *     and rows already disconnected before the rotation still need the old key.
 *   - The ciphertext carries no key identifier ("v1." is the format version), so
 *     migration can only be confirmed by trying to open each row with the new
 *     key alone.
 *
 * Keep the old key in _PREVIOUS until every row has been confirmed readable
 * without it, or has been reconnected/forgotten.
 *
 * Key format: 32+ characters, no commas or newlines (the _PREVIOUS separator) — a
 * current key containing one is refused outright. At most 4 previous keys are read.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────
 *
 * No key, or a key shorter than 32 characters, means sealing returns null and
 * the caller must refuse to store anything. There is deliberately no fallback to
 * NEXTAUTH_SECRET or any other variable: rotating an unrelated secret must never
 * silently strand every stored credential.
 */

const VERSION = 'v1';
const KEY_INFO = 'freezeriq/integration-token/v1';
const MIN_KEY_LENGTH = 32;
const MAX_KEYS = 5;
const MAX_SEALED_LENGTH = 16_384;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Which stored value a ciphertext belongs to. Part of the authenticated data. */
export interface SealContext {
    provider: string;
    businessId: string;
    field: 'access_token' | 'refresh_token' | 'realm_id';
}

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Backed by an explicit ArrayBuffer so the result satisfies BufferSource.
function b64urlDecode(s: string): Uint8Array<ArrayBuffer> | null {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
    try {
        const pad = s.replace(/-/g, '+').replace(/_/g, '/');
        const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
        const out = new Uint8Array(new ArrayBuffer(bin.length));
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}

/**
 * Every usable key, current first. Read through a function (not at module load)
 * so tests can set it and a server that gains the variable needs no rebuild.
 * `.trim()` because secrets pasted into a dashboard routinely carry a newline.
 */
export function integrationTokenKeys(env: NodeJS.ProcessEnv = process.env): string[] {
    const out: string[] = [];
    const push = (raw: string) => {
        const s = raw.trim();
        if (s.length >= MIN_KEY_LENGTH && !out.includes(s) && out.length < MAX_KEYS) out.push(s);
    };
    const current = (env.INTEGRATION_TOKEN_KEY ?? '').trim();
    if (current.length < MIN_KEY_LENGTH) return out; // no current key: nothing may be sealed OR opened
    // _PREVIOUS is split on commas and newlines, so a key containing either could
    // never be listed there at rotation — it would silently strand every credential
    // sealed under it. Refuse such a key now, before anything is sealed with it.
    if (/[,\n\r]/.test(current)) return out;
    push(current);
    for (const part of (env.INTEGRATION_TOKEN_KEY_PREVIOUS ?? '').split(/[,\n]/)) {
        if (part.trim()) push(part);
    }
    return out;
}

/** True when a current key is configured. Never reveals anything about it. */
export function integrationTokenKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return integrationTokenKeys(env).length > 0;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        // Fixed salt + distinct info: deterministic across processes, and domain
        // separated from every other HKDF use in the app.
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(KEY_INFO), info: enc.encode(KEY_INFO) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

function aad(ctx: SealContext): Uint8Array<ArrayBuffer> {
    const bytes = enc.encode(`${KEY_INFO}|${ctx.provider}|${ctx.businessId}|${ctx.field}`);
    const out = new Uint8Array(new ArrayBuffer(bytes.length));
    out.set(bytes);
    return out;
}

function validContext(ctx: SealContext): boolean {
    return !!ctx
        && typeof ctx.provider === 'string' && ctx.provider.length > 0 && !ctx.provider.includes('|')
        && typeof ctx.businessId === 'string' && ctx.businessId.length > 0 && !ctx.businessId.includes('|')
        && (ctx.field === 'access_token' || ctx.field === 'refresh_token' || ctx.field === 'realm_id');
}

/**
 * Seals one value for one provider/tenant/column. Returns null when no key is
 * configured or the input is unusable — never a partially formed ciphertext.
 */
export async function sealIntegrationSecret(
    plaintext: string,
    ctx: SealContext,
    env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
    const [secret] = integrationTokenKeys(env);
    if (!secret) return null;
    if (typeof plaintext !== 'string' || plaintext.length === 0) return null;
    if (!validContext(ctx)) return null;

    const key = await deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx) }, key, enc.encode(plaintext)),
    );
    return `${VERSION}.${b64url(iv)}.${b64url(sealed)}`;
}

/**
 * Opens a sealed value, or returns null.
 *
 * Every failure is null: wrong version, malformed encoding, truncation, a flipped
 * byte, an unknown key, or a ciphertext written for a different provider, tenant
 * or column. Callers treat null as "this credential is unusable".
 */
export async function openIntegrationSecret(
    sealed: unknown,
    ctx: SealContext,
    env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
    const secrets = integrationTokenKeys(env);
    if (!secrets.length) return null;
    if (typeof sealed !== 'string' || !sealed || sealed.length > MAX_SEALED_LENGTH) return null;
    if (!validContext(ctx)) return null;

    const parts = sealed.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const iv = b64urlDecode(parts[1]);
    const body = b64urlDecode(parts[2]);
    if (!iv || iv.length !== 12 || !body || body.length <= 16) return null;

    for (const secret of secrets) {
        try {
            const key = await deriveKey(secret);
            const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(ctx) }, key, body);
            return dec.decode(opened);
        } catch {
            // Wrong key or wrong context — indistinguishable by design.
        }
    }
    return null;
}
