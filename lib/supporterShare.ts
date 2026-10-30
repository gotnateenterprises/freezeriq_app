/**
 * FR-SUPPORTER-SHARE-INTEGRITY-1 — every supporter share channel, built from ONE URL.
 *
 * WHY THIS EXISTS
 * The public fundraiser page built its share link from `window.location.href`: whatever address
 * the supporter's browser happened to be on. That is the wrong source three ways at once — a
 * Vercel Preview host (behind a login wall), a tracking query (`?fbclid=…`, `utm_*`) or a share
 * token (`_vercel_share`) all travelled into every Copy / Facebook / Text share, and the page's
 * own Open Graph URL pointed somewhere else again. A supporter could not reliably hand a friend
 * the fundraiser they were looking at.
 *
 * THE RULE
 * The destination is resolved ONCE, on the server, by the canonical authority
 * (lib/fundraiserCanonicalUrl.ts), and handed to the page. Every channel below takes that one
 * string. Message text may differ per channel; the destination never does.
 *
 * PURE: no React, no I/O, no globals. Browser objects are passed in, so each action is testable.
 */

/** The channel names a supporter share can use. A closed list, so nothing else can be recorded. */
export const SUPPORTER_SHARE_CHANNELS = ['copy_message', 'copy_link', 'facebook', 'email', 'text', 'native'] as const;
export type SupporterShareChannel = (typeof SUPPORTER_SHARE_CHANNELS)[number];

export function isSupporterShareChannel(value: unknown): value is SupporterShareChannel {
    return typeof value === 'string' && (SUPPORTER_SHARE_CHANNELS as readonly string[]).includes(value);
}

/** The only two public fundraiser page shapes: the ordering page and the old scoreboard. */
const PUBLIC_FUNDRAISER_PATH = /^\/(?:shop\/[A-Za-z0-9_-]+\/fundraiser\/[A-Za-z0-9_-]+|fundraiser\/[A-Za-z0-9_-]+)$/;

/**
 * A URL fit to hand to the public, or null.
 *
 * Refuses rather than repairs: anything carrying a query, a fragment or credentials means the
 * input did not come from the canonical authority, so it fails closed instead of being trimmed
 * into something that merely looks right. A `*.vercel.app` host is a deployment, never a public
 * destination, and plain http is accepted only for local development.
 */
export function sanitizeSupporterShareUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return null; }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password) return null;
    if (u.search || u.hash) return null;
    if (/(^|\.)vercel\.app$/i.test(u.hostname)) return null;
    if (!PUBLIC_FUNDRAISER_PATH.test(u.pathname)) return null;
    return `${u.origin}${u.pathname}`;
}

/** What the share text says. The URL is the canonical destination; nothing else is. */
export interface SupporterShareFacts {
    url: string;
    organizationName: string | null | undefined;
    /** Weighted bundle goal (serves 5 = 1, serves 2 = 0.5). */
    bundleGoal: number;
    /** Weighted bundles sold so far. */
    bundlesSold: number;
}

/** "5" or "5.5" — the same rule as lib/fundraiserMetrics.formatBundleCount, kept local to stay dependency-free. */
function count(n: number): string {
    const v = Number.isFinite(n) && n > 0 ? n : 0;
    return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1);
}

function orgOf(f: SupporterShareFacts): string {
    const name = (f.organizationName ?? '').trim();
    return name || 'this fundraiser';
}

/** The message body without the link, for channels that carry the link separately. */
function shareMessage(f: SupporterShareFacts): string {
    const goal = count(f.bundleGoal);
    const sold = count(f.bundlesSold);
    return `Help ${orgOf(f)} reach ${goal} bundles!\n\n` +
        `We're currently at ${sold} bundles. Choose delicious freezer meal ` +
        `bundles and support the fundraiser. Payment is collected separately by the coordinator.`;
}

/** The copy-and-paste caption (Copy, Facebook clipboard, Text): the message and the link. */
export function supporterShareCaption(f: SupporterShareFacts): string {
    return `${shareMessage(f)}\n\nOrder here:\n${f.url}`;
}

/** Facebook's Share Dialog. Facebook builds the preview from this URL's Open Graph tags. */
export function supporterFacebookHref(url: string): string {
    return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
}

/** The text-message composer, prefilled. `sms:?&body=` is the form both iOS and Android accept. */
export function supporterSmsHref(f: SupporterShareFacts): string {
    return `sms:?&body=${encodeURIComponent(supporterShareCaption(f))}`;
}

/** An email composer with no recipient: the supporter chooses who to send it to. */
export function supporterEmailHref(f: SupporterShareFacts): string {
    const subject = `Support ${orgOf(f)} — freezer meal fundraiser`;
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(supporterShareCaption(f))}`;
}

/** What the device share sheet receives. The link travels as `url`, not duplicated inside `text`. */
export function supporterNativeShareData(f: SupporterShareFacts): { title: string; text: string; url: string } {
    return { title: `Support ${orgOf(f)}`, text: shareMessage(f), url: f.url };
}

// ── actions: browser objects are passed in, never read from globals ──────────────────────────

export interface ShareWindow {
    open?: (url: string, target?: string, features?: string) => unknown;
    location?: { href: string };
}
export interface ShareNavigator {
    clipboard?: { writeText?: (text: string) => Promise<void> } | null;
    share?: ((data: { title?: string; text?: string; url?: string }) => Promise<void>) | null;
}

/**
 * Open Facebook's Share Dialog. SYNCHRONOUS on purpose: a popup is allowed only while the click's
 * user activation is live, so nothing (clipboard, network, a promise) may be awaited before it.
 */
export function openFacebookShare(win: ShareWindow | null | undefined, url: string): boolean {
    if (!win || typeof win.open !== 'function') return false;
    win.open(supporterFacebookHref(url), '_blank', 'noopener,noreferrer');
    return true;
}

/** Copy text. Resolves false when the clipboard is missing or refuses; never throws. */
export function copyShareText(nav: ShareNavigator | null | undefined, text: string): Promise<boolean> {
    const writeText = nav?.clipboard?.writeText;
    if (typeof writeText !== 'function') return Promise.resolve(false);
    try {
        return writeText.call(nav!.clipboard, text).then(() => true, () => false);
    } catch {
        return Promise.resolve(false);
    }
}

export type NativeShareResult = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/**
 * The device share sheet. Feature-detected, never user-agent sniffed. 'unsupported' and 'failed'
 * tell the caller to show its own fallback; a share is never a silent no-op.
 */
export async function shareNatively(
    nav: ShareNavigator | null | undefined,
    data: { title: string; text: string; url: string },
): Promise<NativeShareResult> {
    const share = nav?.share;
    if (typeof share !== 'function') return 'unsupported';
    try {
        await share.call(nav, data);
        return 'shared';
    } catch (e: any) {
        // The person closed the sheet: their choice, not an error to recover from.
        if (e && e.name === 'AbortError') return 'cancelled';
        return 'failed';
    }
}
