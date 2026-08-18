/**
 * Fundraiser URL Builder
 *
 * SINGLE SOURCE OF TRUTH for all fundraiser-related URL generation.
 *
 * Strategy (in priority order):
 *   1. Dynamic request origin — from `new URL(req.url).origin` in API routes
 *   2. NEXTAUTH_URL env var — for non-request contexts (email templates, etc.)
 *   3. Never hardcode a production domain
 *
 * This ensures fundraiser links work correctly across:
 *   - localhost / dev / staging / production / custom domains
 *
 * Usage (API route):
 *   const urls = buildFundraiserUrls(req, { portalToken, publicToken });
 *
 * Usage (client component):
 *   const urls = buildFundraiserUrls(window.location.origin, { portalToken, publicToken });
 *
 * Usage (server-side without request):
 *   const urls = buildFundraiserUrls(process.env.NEXTAUTH_URL!, { portalToken, publicToken });
 */

export type FundraiserUrls = {
    /** Coordinator portal dashboard: /coordinator/{portal_token} */
    coordinatorUrl: string | null;
    /** Coordinator success guide: /coordinator/{portal_token}/guide */
    coordinatorGuideUrl: string | null;
    /** Public fundraiser scoreboard/storefront: /fundraiser/{public_token} */
    publicUrl: string | null;
};

type TokenInputs = {
    portalToken?: string | null;
    publicToken?: string | null;
};

/**
 * Resolve the base URL from a Request object, a raw origin string,
 * or fall back to NEXTAUTH_URL.
 */
function resolveOrigin(source: Request | string): string {
    if (typeof source === 'string') {
        // Already a raw origin string (e.g. window.location.origin or env var)
        return source.replace(/\/+$/, '');
    }
    // Request object — extract origin from the URL
    return new URL(source.url).origin;
}

/**
 * Build all fundraiser URLs from a single origin source.
 *
 * @param source - A Request object (API routes), origin string (client), or env var
 * @param tokens - portal_token and/or public_token for the campaign
 */
/**
 * FR-COORD-SEC-1B — the canonical coordinator origin.
 *
 * Coordinator access is pinned to the FreezerIQ platform domain rather than the
 * dynamic request origin. The session cookie is host-only (`__Host-` prefix, no
 * Domain attribute), so it belongs to exactly one host; issuing links from
 * whichever domain happened to serve the request would scatter sessions across
 * tenant storefront domains that cannot see each other's cookies.
 */
export const CANONICAL_COORDINATOR_ORIGIN = 'https://www.freezeriqapp.com';

export function resolveCoordinatorOrigin(source?: Request | string | null): string {
    // Production always uses the canonical platform origin.
    if (process.env.NODE_ENV === 'production') return CANONICAL_COORDINATOR_ORIGIN;
    // Dev/preview: follow the caller so localhost and preview URLs work.
    if (source) return resolveOrigin(source);
    const env = (process.env.NEXTAUTH_URL ?? '').trim();
    if (env) { try { return new URL(env).origin; } catch { /* fall through */ } }
    return CANONICAL_COORDINATOR_ORIGIN;
}

/**
 * FR-COORD-SEC-1B — THE coordinator link.
 *
 * The credential goes after `#`. Browsers never transmit a fragment, so the
 * request this URL produces is exactly `GET /coordinator/access` and the secret
 * never reaches a server log. `/coordinator/access` then exchanges it, once, in
 * a request body, for a session cookie.
 *
 * This is the only supported way to build a coordinator link. The previous
 * `/coordinator/<token>` shape put the credential in the request path, where
 * Vercel recorded it on every visit.
 */
export function buildCoordinatorAccessUrl(
    source: Request | string | null | undefined,
    portalToken: string
): string {
    return `${resolveCoordinatorOrigin(source)}/coordinator/access#${encodeURIComponent(portalToken)}`;
}

export function buildFundraiserUrls(
    source: Request | string,
    tokens: TokenInputs
): FundraiserUrls {
    const origin = resolveOrigin(source);

    return {
        coordinatorUrl: tokens.portalToken
            ? buildCoordinatorAccessUrl(source, tokens.portalToken)
            : null,
        // The guide lives inside the portal now, so it is reached through the
        // same one-time exchange rather than by pasting the credential again.
        coordinatorGuideUrl: tokens.portalToken
            ? buildCoordinatorAccessUrl(source, tokens.portalToken)
            : null,
        publicUrl: tokens.publicToken
            ? `${origin}/fundraiser/${tokens.publicToken}`
            : null,
    };
}

/**
 * Convenience: build just the public fundraiser URL.
 * Useful in routes that only need the public link (QR, promo scripts, etc.)
 */
export function buildPublicFundraiserUrl(
    source: Request | string,
    publicToken: string
): string {
    const origin = resolveOrigin(source);
    return `${origin}/fundraiser/${publicToken}`;
}

/**
 * FR-RETENTION-4 — origin resolution that is allowed to FAIL.
 *
 * `resolveOrigin` above assumes the caller already has a usable source. The
 * rebooking send path cannot assume that: if no origin can be resolved we must
 * refuse to send rather than email a broken or half-formed link, so this returns
 * null instead of fabricating one.
 */
export function resolveRequestOrigin(
    source: Request | string | null | undefined
): string | null {
    if (source && typeof source !== 'string') return new URL(source.url).origin;
    const raw = (typeof source === 'string' ? source : process.env.NEXTAUTH_URL ?? '').trim();
    if (!raw) return null;
    try {
        return new URL(raw).origin;
    } catch {
        return null;
    }
}

/**
 * FR-RETENTION-4 — the durable rebooking link: /rebook/{token}.
 *
 * Same shape as the existing /coordinator and /fundraiser token routes, so it
 * reads as one family of links. The difference is invisible from here and lives
 * in the database: only the SHA-256 digest of this token is stored.
 */
export function buildRebookingUrl(
    source: Request | string,
    rebookingToken: string
): string {
    const origin = resolveOrigin(source);
    return `${origin}/rebook/${rebookingToken}`;
}
