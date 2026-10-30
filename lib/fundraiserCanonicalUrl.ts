/**
 * FR-SUPPORTER-SHARE-INTEGRITY-1 — THE public fundraiser URL, for supporters.
 *
 * One answer feeds the page's canonical link, its Open Graph URL and every supporter share channel
 * (Copy, Facebook, Email, Text, the device share sheet, before and after ordering, and the
 * scoreboard). It is the SAME authority the coordinator dashboard, the printed QR code, the flyer
 * and the previous-supporter invitation already use (lib/previousSupporterInvite.buildSupporterOrderUrl,
 * FR-COORD-123), so a supporter and a coordinator hand out the identical link:
 *
 *   tenant + campaign  →  /shop/{slug}/fundraiser/{campaignId}
 *                      →  the tenant's own storefront domain (Business.custom_domain), else the
 *                         PINNED platform origin (lib/fundraiserUrls.resolveOutreachOrigin)
 *
 * What it is never built from: the browser's address, the request's host, a Preview deployment, a
 * query string, an order or a confirmation. A Preview build pins the platform origin exactly as
 * Production does, so a Preview page cannot make itself canonical. When no safe URL can be built
 * the answer is null and the caller shows no share controls and emits no canonical tag: it fails
 * closed rather than sharing an internal address.
 *
 * SERVER-SIDE: reads the environment through resolveOutreachOrigin.
 */
import { buildSupporterOrderUrl } from './previousSupporterInvite';
import { resolveOutreachOrigin } from './fundraiserUrls';
import { sanitizeSupporterShareUrl } from './supporterShare';

export function resolveCanonicalSupporterUrl(input: {
    campaignId: string | null | undefined;
    /** The public scoreboard identifier; only used when the tenant has no storefront slug. */
    publicToken?: string | null;
    /** Business.slug — from the database row, never from the request. */
    slug: string | null | undefined;
    /** Business.custom_domain. */
    customDomain?: string | null;
}): string | null {
    if (!input.campaignId) return null;
    const raw = buildSupporterOrderUrl(
        resolveOutreachOrigin(),
        { id: input.campaignId, public_token: input.publicToken ?? null },
        { customDomain: input.customDomain ?? null, slug: input.slug ?? null },
    );
    return sanitizeSupporterShareUrl(raw);
}
