/**
 * COORDINATOR-CONTACT-DATE-1 — the one way to turn a stored email address into a
 * clickable link.
 *
 * WHAT A CLICK DOES
 * A `mailto:` link is handed by the browser to whatever mail handler the
 * coordinator's own device has registered — Outlook, Apple Mail, Gmail if the
 * browser has registered it, and so on. FreezerIQ only has to emit the standard
 * link; it never sends mail, never opens a compose screen of its own, and never
 * picks a provider.
 *
 * WHY A HELPER
 * Recent orders built `mailto:${email}` straight from the stored value. A value
 * with a stray space, a missing `@`, or a character that is meaningful inside a
 * URI (`?`, `#`, `%`, `/`) produced a link that looked clickable and handed the
 * mail app a broken recipient — one stored supporter address in Production is
 * malformed today. So the address is checked first; an address that cannot be a
 * recipient gets NO link at all, rather than a link that silently fails.
 *
 * PURE: no React, no I/O — safe in client components and in tests.
 */

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * The stored address, trimmed, when it is structurally usable as a recipient;
 * otherwise null. Case is preserved — what the coordinator sees is exactly what
 * was stored, and mail servers treat the domain case-insensitively anyway.
 *
 * Deliberately conservative: a single `@`, a dot-atom local part (no quoted
 * strings, no spaces, no `:`, so `javascript:` can never pass), and a dotted
 * hostname. A rare valid-but-exotic address simply renders as plain text.
 */
export function usableEmailAddress(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    if (!v || v.length > 254) return null;
    const at = v.indexOf('@');
    if (at <= 0 || at !== v.lastIndexOf('@')) return null;
    const local = v.slice(0, at);
    const domain = v.slice(at + 1);
    if (local.length > 64 || !LOCAL_PART.test(local)) return null;
    if (!DOMAIN.test(domain)) return null;
    return v;
}

/**
 * `mailto:` + the address, or null when there is no usable address.
 *
 * RFC 6068: inside a mailto URI the characters `%`, `/`, `?`, `#`, `[`, `]`
 * must be percent-encoded, as must anything a URI cannot carry. `+` and `@`
 * stay literal, so a plus-addressed recipient reaches the mail app unchanged.
 */
export function mailtoHref(raw: unknown): string | null {
    const address = usableEmailAddress(raw);
    if (!address) return null;
    const encoded = address.replace(/[%/?#[\]`{|}^]/g, (c) =>
        `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    return `mailto:${encoded}`;
}
