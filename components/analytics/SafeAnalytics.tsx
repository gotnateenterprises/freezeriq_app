'use client';

/**
 * FR-COORD-SEC-1B — analytics that cannot leak a coordinator credential.
 *
 * WHY THIS EXISTS
 * Moving the credential into the URL fragment keeps it off the wire, because
 * browsers do not transmit fragments. It does NOT keep it out of client-side
 * JavaScript, and Vercel Web Analytics is client-side JavaScript.
 *
 * This was verified against the live production script, not assumed. It builds
 * the reported URL from `location.href` — fragment included — and when it
 * rewrites the pathname it clears `search` but NOT `hash`:
 *
 *     function e(e){ let t=location.href;
 *                    if(e){ let n=new URL(t);
 *                           if(n.pathname!==e) return n.pathname=e, n.search="", n.href }
 *                    return t }
 *
 * and the send path honours the hook, dropping the event entirely on null:
 *
 *     let v = a({type,url:f,payload:n});
 *     if(!1===v || null===v) return;      // no fetch is issued
 *
 * So without this filter a coordinator pageview would POST the credential to
 * Vercel's collector. With it, nothing under /coordinator is ever reported.
 *
 * OUTREACH-CONSENT-1 EXTENDS THE SAME REASONING TO /u
 * The public unsubscribe page is /u/<sealed-token>, so the credential is in the
 * PATH rather than the fragment — which is worse: the upstream script reports
 * location.href, and a path is never stripped. Every recipient who opened an
 * unsubscribe link would hand their sealed token to a third-party collector,
 * and those tokens do not expire. The same drop applies.
 *
 * SCOPE
 * Only these credential-bearing surfaces are suppressed. Analytics for the rest
 * of the site is untouched — this closes credential leaks, it does not switch
 * off measurement.
 */
import { Analytics } from '@vercel/analytics/react';

/** Every prefix here is credential-adjacent and is never reported. */
export const ANALYTICS_SUPPRESSED_PREFIXES = ['/coordinator', '/u'] as const;

/** @deprecated Kept so existing imports keep compiling. Prefer the list above. */
export const ANALYTICS_SUPPRESSED_PREFIX = ANALYTICS_SUPPRESSED_PREFIXES[0];

/**
 * True when an analytics event must be dropped.
 *
 * Exported so tests can exercise the decision directly rather than mounting the
 * component and mocking the collector.
 *
 * Fails CLOSED: a URL that cannot be parsed is dropped rather than reported,
 * because an unparseable URL is exactly the case where we cannot prove it is
 * free of a credential.
 */
export function shouldSuppressAnalyticsUrl(url: string): boolean {
    let pathname: string;
    try {
        // Parsed with NO base on purpose. The upstream script builds this value
        // from location.href, so a real event is always absolute; anything that
        // is not absolute is something we did not anticipate, and the safe
        // response to "I cannot tell what this is" is to drop it.
        pathname = new URL(url).pathname;
    } catch {
        return true;
    }
    return ANALYTICS_SUPPRESSED_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
}

export default function SafeAnalytics() {
    return (
        <Analytics
            beforeSend={(event) => {
                // Covers /coordinator/access#<credential>, the tokenless
                // /coordinator/portal, any legacy /coordinator/<token> URL a
                // coordinator still has bookmarked, and /u/<unsubscribe-token>.
                if (shouldSuppressAnalyticsUrl(event.url)) return null;
                return event;
            }}
        />
    );
}
