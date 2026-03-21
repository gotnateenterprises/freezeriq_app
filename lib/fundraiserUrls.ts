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
export function buildFundraiserUrls(
    source: Request | string,
    tokens: TokenInputs
): FundraiserUrls {
    const origin = resolveOrigin(source);

    return {
        coordinatorUrl: tokens.portalToken
            ? `${origin}/coordinator/${tokens.portalToken}`
            : null,
        coordinatorGuideUrl: tokens.portalToken
            ? `${origin}/coordinator/${tokens.portalToken}/guide`
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
