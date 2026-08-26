/**
 * OUTREACH-CONSENT-1 — the opaque credential in an unsubscribe link.
 *
 * ── WHY NOT REUSE lib/auth/oauthState.ts ────────────────────────────────────
 *
 * That module is a good signed-state primitive and this one borrows its shape —
 * b64url helpers, Web Crypto, constant-time compare — but it cannot be used
 * here, for two reasons that are properties of the problem rather than of the
 * code:
 *
 *   1. It SIGNS a base64 payload. Base64 is not concealment. Anyone holding an
 *      oauth state can read the tenant id out of it. An unsubscribe link travels
 *      in an email to a member of the public and gets forwarded, quoted, logged
 *      by mail providers and pasted into support tickets — so the supporter's
 *      address and the tenant id must be SEALED, not merely authenticated.
 *   2. It expires. An unsubscribe link must still work when someone digs up a
 *      two-year-old email, which is exactly when they are most annoyed. A TTL on
 *      an opt-out is a dark pattern with extra steps.
 *
 * So the token is AES-256-GCM sealed rather than signed: the tenant and address
 * are ciphertext, the GCM tag authenticates them, and there is no expiry field
 * at all.
 *
 * ── "NO EXPIRY" IS A CLAIM ABOUT THE KEY, NOT JUST THE PAYLOAD ──────────────
 *
 * Having no expiry FIELD is not the same as never expiring. The key is derived
 * from an environment variable, so changing that variable would retire every
 * link ever mailed just as effectively as a TTL — silently, and with no way for
 * a recipient to tell us. That is what `unsubscribeVerificationSecrets()` below
 * exists to prevent, and its doc comment carries the operational obligation that
 * makes the non-expiry claim true rather than aspirational.
 *
 * ── WHAT THE TOKEN IS ───────────────────────────────────────────────────────
 *
 *     v1.<b64url iv>.<b64url ciphertext‖tag>
 *
 * The version prefix is there so a future key rotation can add `v2` while old
 * links keep resolving, instead of silently breaking every unsubscribe footer
 * ever mailed.
 *
 * Nothing is stored. There is no token table, no digest column, and no row to
 * enumerate — which is also why this needed no migration.
 *
 * ── THE SECRET FAILS CLOSED ─────────────────────────────────────────────────
 *
 * OUTREACH_UNSUBSCRIBE_SECRET is dedicated and deliberately NOT falling back to
 * NEXTAUTH_SECRET. A fallback would mean that adding the dedicated variable
 * later invalidates every link already in someone's inbox — the one failure mode
 * nobody would notice until a recipient could not opt out.
 *
 * With no secret configured, sealing returns null. Callers must treat that as
 * "this message cannot be sent", because a promotional email with no working
 * unsubscribe link is precisely what OUTREACH-CONSENT-1 exists to prevent.
 */

import { normalizeEmail, isPlausibleEmail } from '@/lib/seasonalAudience';

/** Resolved from a valid token. Both fields are authoritative. */
export interface UnsubscribeTokenPayload {
    /** Tenant the opt-out belongs to. Never accepted from a request. */
    businessId: string;
    /** Canonically normalized — the same key outreach suppression looks up. */
    normalizedEmail: string;
}

const VERSION = 'v1';
const KEY_INFO = 'freezeriq/outreach-unsubscribe/v1';
const MAX_TOKEN_LENGTH = 2048;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Backed by an explicit ArrayBuffer so the result satisfies BufferSource: a
// plain `new Uint8Array(n)` is typed over ArrayBufferLike, which Web Crypto
// will not accept because it could be a SharedArrayBuffer.
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
 * The SEALING secret, or null.
 *
 * Read through a function rather than captured at module load so a test can set
 * it, and so a server that gains the variable does not need a rebuild.
 *
 * `.trim()` matters more than it looks: secrets pasted into a dashboard field or
 * a .env file routinely arrive with a trailing newline or space, and an untrimmed
 * value would derive a completely different key from the same secret.
 */
export function unsubscribeSecret(): string | null {
    const s = (process.env.OUTREACH_UNSUBSCRIBE_SECRET ?? '').trim();
    // A short secret is not a secret. Refusing is safer than sealing weakly.
    return s.length >= 32 ? s : null;
}

/** Bounds the work an invalid token can cost, and the operational sprawl. */
const MAX_VERIFICATION_SECRETS = 5;

/**
 * Every secret a token may legitimately have been sealed under: the current one
 * first, then retired ones from OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS.
 *
 * ── WHY THIS EXISTS — THE NON-EXPIRY CONTRACT IS OTHERWISE A LIE ────────────
 *
 * This module has no expiry field, and the first version of it claimed on that
 * basis that unsubscribe links never stop working. That claim did not survive
 * review. The key is derived from ONE environment variable, so rotating that
 * variable silently invalidated every unsubscribe link already sitting in every
 * recipient's inbox — and the `v1` prefix does nothing to help, because it
 * versions the FORMAT, not the key. The failure would also be invisible: nobody
 * files a ticket saying "your unsubscribe link stopped working", they mark the
 * mail as spam.
 *
 * So rotation is now expressible without breaking anyone:
 *
 *     OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS = <the old secret>
 *     OUTREACH_UNSUBSCRIBE_SECRET          = <the new secret>
 *
 * New links seal under the new key; old links still open under the retired one.
 * Comma or newline separated, so several generations can be retained.
 *
 * THE OPERATIONAL CONTRACT, stated plainly because it is a real obligation:
 * a retired secret must be kept in this list for as long as links sealed under
 * it might still be clicked. Dropping it revokes those links. Since a recipient
 * may act on a two-year-old email, the honest default is to retain rather than
 * to rotate — this variable exists to make an unavoidable rotation safe, not to
 * make routine rotation a good idea.
 */
export function unsubscribeVerificationSecrets(): string[] {
    const out: string[] = [];
    const push = (raw: string) => {
        const s = raw.trim();
        if (s.length >= 32 && !out.includes(s)) out.push(s);
    };

    const current = unsubscribeSecret();
    if (current) push(current);

    for (const part of (process.env.OUTREACH_UNSUBSCRIBE_SECRET_PREVIOUS ?? '').split(/[,\n]/)) {
        if (out.length >= MAX_VERIFICATION_SECRETS) break;
        if (part.trim()) push(part);
    }

    return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        // A fixed salt with a distinct info string: the derivation must be
        // deterministic across processes, and domain separation comes from
        // KEY_INFO so this key can never coincide with another feature's.
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(KEY_INFO), info: enc.encode(KEY_INFO) },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/**
 * Seals one tenant + address into a link-safe token.
 *
 * Returns null when there is no usable secret or the address is not plausible —
 * never a partially-formed token, and never a token that would resolve to
 * something other than what the caller meant.
 */
export async function sealUnsubscribeToken(input: {
    businessId: string;
    email: string;
}): Promise<string | null> {
    const secret = unsubscribeSecret();
    if (!secret) return null;
    if (typeof input.businessId !== 'string' || !input.businessId.trim()) return null;
    if (typeof input.email !== 'string' || !isPlausibleEmail(input.email)) return null;

    // Normalized ON THE WAY IN, so the token can only ever resolve to the same
    // key the audience and the send-time suppression check use.
    const payload = JSON.stringify({
        b: input.businessId.trim(),
        e: normalizeEmail(input.email),
    });

    const key = await deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payload)),
    );
    return `${VERSION}.${b64url(iv)}.${b64url(sealed)}`;
}

/**
 * Opens a token, or returns null.
 *
 * EVERY failure is null and nothing else: wrong version, malformed base64,
 * truncation, a flipped byte, a token minted under a different secret, or a
 * payload of the wrong shape. There is no error variant, because distinguishing
 * "bad signature" from "unknown tenant" is exactly the oracle an attacker wants.
 *
 * Tamper detection is the GCM authentication tag — decrypt throws on any change,
 * and the comparison inside it is constant time.
 */
export async function openUnsubscribeToken(raw: unknown): Promise<UnsubscribeTokenPayload | null> {
    const secrets = unsubscribeVerificationSecrets();
    if (!secrets.length) return null;
    if (typeof raw !== 'string' || !raw || raw.length > MAX_TOKEN_LENGTH) return null;

    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [version, ivPart, bodyPart] = parts;
    if (version !== VERSION) return null;

    const iv = b64urlDecode(ivPart);
    const body = b64urlDecode(bodyPart);
    if (!iv || iv.length !== 12 || !body || body.length === 0) return null;

    // Current key first, then retired ones. A token sealed before a rotation
    // still opens; one sealed under a secret that has been dropped entirely does
    // not, which is the documented cost of dropping it.
    let plain: string | null = null;
    for (const secret of secrets) {
        try {
            const key = await deriveKey(secret);
            const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, body);
            plain = dec.decode(opened);
            break;
        } catch {
            // Wrong key for this token — try the next generation. Indistinguishable
            // from a forged token, which is the point.
        }
    }
    if (plain === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(plain);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const { b, e } = parsed as { b?: unknown; e?: unknown };
    if (typeof b !== 'string' || !b.trim()) return null;
    if (typeof e !== 'string' || !isPlausibleEmail(e)) return null;

    // Re-normalized on the way out too: a token sealed by an older build with a
    // laxer rule still resolves to today's canonical key.
    return { businessId: b, normalizedEmail: normalizeEmail(e) };
}

/** The human-facing opt-out page for a token. */
export function buildUnsubscribePageUrl(origin: string, token: string): string {
    return `${String(origin).replace(/\/+$/, '')}/u/${encodeURIComponent(token)}`;
}

/**
 * The endpoint named in List-Unsubscribe.
 *
 * Its GET redirects to the page above rather than acting, so a mailbox provider
 * or security scanner that follows the link cannot unsubscribe anybody.
 */
export function buildUnsubscribeEndpointUrl(origin: string, token: string): string {
    return `${String(origin).replace(/\/+$/, '')}/api/unsubscribe/${encodeURIComponent(token)}`;
}
