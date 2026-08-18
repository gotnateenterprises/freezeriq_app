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
 * SCOPE
 * Only the /coordinator surface is suppressed. Analytics for the rest of the
 * site is untouched — this closes a credential leak, it does not switch off
 * measurement.
 */
import { Analytics } from '@vercel/analytics/react';

/** Everything under this prefix is credential-adjacent and is never reported. */
export const ANALYTICS_SUPPRESSED_PREFIX = '/coordinator';

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
    return pathname === ANALYTICS_SUPPRESSED_PREFIX
        || pathname.startsWith(`${ANALYTICS_SUPPRESSED_PREFIX}/`);
}

export default function SafeAnalytics() {
    return (
        <Analytics
            beforeSend={(event) => {
                // Covers /coordinator/access#<credential>, the tokenless
                // /coordinator/portal, and any legacy /coordinator/<token> URL a
                // coordinator still has bookmarked.
                if (shouldSuppressAnalyticsUrl(event.url)) return null;
                return event;
            }}
        />
    );
}
