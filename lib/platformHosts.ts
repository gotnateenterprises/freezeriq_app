/**
 * DOMAIN-ROUTING-1 — which hostnames are the FreezerIQ PLATFORM.
 *
 * FreezerIQ is the SaaS platform and lives at `freezeriqapp.com`. Everything
 * else that reaches the app is a tenant's own domain (My Freezer Chef at
 * `myfreezerchef.com`, and any future custom domain), which middleware rewrites
 * into `app/[domain]` for tenant resolution.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The previous test was a pair of substring checks:
 *
 *     hostname.includes('freezeriq.com') || hostname.includes('vercel.app')
 *
 * Substring matching answers the wrong question. It said NO to the real
 * platform domain — `freezeriqapp.com` does not contain `freezeriq.com`,
 * because `freezeriq` is followed by `app.com` — while saying YES to any
 * hostname that merely CONTAINS a trusted string, including
 * `freezeriq.com.evil.net` and `vercel.app.evil.net`. A host is a structured
 * name, not a haystack, so identity is decided here by exact match and by true
 * suffix, never by "contains".
 *
 * ── NOT A SECURITY BOUNDARY ON ITS OWN ───────────────────────────────────────
 * A hostname only reaches this code if Vercel already accepted it for this
 * project, so an attacker cannot route their own domain here by choosing a
 * clever name. This function decides PRODUCT SURFACE (platform vs tenant), and
 * the exactness above is about not being wrong, not about holding a perimeter.
 */

/** The authoritative SaaS domain. Works with no environment variable set. */
export const PLATFORM_ROOT_DOMAIN = 'freezeriqapp.com';

/**
 * Always platform, regardless of configuration. Kept independent of the
 * env override so a mistyped `NEXT_PUBLIC_ROOT_DOMAIN` can never take the real
 * SaaS domain offline.
 */
const PLATFORM_HOSTS: ReadonlySet<string> = new Set([
    PLATFORM_ROOT_DOMAIN,
    `www.${PLATFORM_ROOT_DOMAIN}`,
]);

/**
 * Development hosts. Exact matches only: `acme.localhost` is deliberately NOT
 * here, because a subdomain of localhost is how tenant domains are simulated
 * locally and must stay tenant traffic.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1',
]);

/**
 * Lowercase, strip the port, drop a trailing FQDN dot.
 *
 * Host headers are case-insensitive and usually carry a port in development
 * (`localhost:3000`), so comparing the raw value would miss real matches. The
 * trailing dot in `freezeriqapp.com.` is the legal absolute form of the same
 * name and must not be treated as a different host.
 */
export function normalizeHost(rawHost: string | null | undefined): string {
    if (!rawHost) return '';
    let host = rawHost.trim().toLowerCase();

    if (host.startsWith('[')) {
        // Bracketed IPv6 keeps its brackets: "[::1]:3000" -> "[::1]".
        const close = host.indexOf(']');
        if (close !== -1) host = host.slice(0, close + 1);
    } else {
        const colon = host.indexOf(':');
        if (colon !== -1) host = host.slice(0, colon);
    }

    if (host.endsWith('.')) host = host.slice(0, -1);
    return host;
}

/** Local development host. */
export function isLocalHost(rawHost: string | null | undefined): boolean {
    return LOCAL_HOSTS.has(normalizeHost(rawHost));
}

/**
 * A Vercel-owned host: the project alias, deployment URLs and every Preview.
 *
 * Suffix rule, not a substring: `vercel.app.evil.net` ENDS with `.evil.net`,
 * so it is not one of ours. Someone else's `*.vercel.app` cannot serve this
 * application anyway — Vercel routes by the domains attached to a project.
 */
export function isVercelHost(rawHost: string | null | undefined): boolean {
    const host = normalizeHost(rawHost);
    return host === 'vercel.app' || host.endsWith('.vercel.app');
}

/**
 * True when the request is for the FreezerIQ platform rather than a tenant.
 *
 * `rootDomainOverride` (wired to `NEXT_PUBLIC_ROOT_DOMAIN`) ADDS a platform
 * host; it never removes the built-in one. That direction is deliberate: the
 * authoritative domain must not depend on an environment variable being
 * present and correct.
 */
export function isPlatformHost(
    rawHost: string | null | undefined,
    rootDomainOverride?: string | null,
): boolean {
    const host = normalizeHost(rawHost);
    if (!host) return false;

    if (LOCAL_HOSTS.has(host)) return true;
    if (isVercelHost(host)) return true;
    if (PLATFORM_HOSTS.has(host)) return true;

    const root = normalizeHost(rootDomainOverride);
    if (root && (host === root || host === `www.${root}`)) return true;

    return false;
}
