/**
 * OPS-6A.2 — the ONE rule for what a printed label's branding header shows.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT INLINE JSX
 *
 * The rule it encodes was wrong for a reason that inline JSX hid: it was a
 * two-branch if/else that LOOKED obviously correct while being unfalsifiable
 * by a test. Extracted here it is provable, exactly as OPS-5 extracted
 * collectBlockedLabels out of the meal-label page for the same reason.
 *
 * THE DEFECT THIS REPLACES
 *
 * The outer-box label previously chose its header like this:
 *
 *     if (logoUrl && !logoBroken) return <img src={logoUrl} onError=.../>
 *     if (businessName)           return <div>{businessName}</div>
 *     return null
 *
 * The first branch returns EARLY on the mere PRESENCE of a URL, so the moment
 * a tenant configured a logo the name branch became unreachable. `onError`
 * only fires when a load FAILS — an image that is merely STILL LOADING never
 * trips it, so `logoBroken` stayed false and the header rendered an <img>
 * carrying no painted pixels.
 *
 * That is precisely what the owner saw across the upload:
 *
 *     before upload : logo_url null      -> name branch  -> "Freezer Chef"
 *     after upload  : logo_url present   -> image branch -> BLANK
 *
 * The name vanishing is the proof that the URL reached render state. Two
 * things make the blank window real rather than theoretical: `img.complete`
 * is false immediately after a fresh `src` is set on any uncached image, and
 * the label's print block lives inside a `display:none` container until
 * `@media print` activates — so the first time that image is asked to paint
 * is the print capture itself.
 *
 * THE RULE
 *
 * The logo is shown only when its bytes are PROVEN loaded. Until then, and
 * forever after a failure, the tenant's customer-facing name is shown. A
 * branding header is therefore never blank while the tenant has a name.
 *
 * Branding stays FAIL-OPEN: nothing here can stop a label printing. The worst
 * case is a name where a logo was wanted, which is a cosmetic downgrade, not
 * a packing or identity error.
 */

/**
 * How far the tenant logo image has got.
 *
 * `idle`    no logo URL is configured for this tenant.
 * `pending` a URL exists and its bytes are still being fetched.
 * `ok`      the bytes loaded; the image is decodable and safe to render.
 * `failed`  the load errored (404, blocked, malformed).
 */
export type TenantLogoStatus = 'idle' | 'pending' | 'ok' | 'failed';

/** What the printed branding header should render. */
export type BrandHeaderChoice = 'logo' | 'name' | 'none';

/**
 * Decide the branding header.
 *
 * `logo` requires BOTH a URL and a confirmed-loaded image — presence of a URL
 * is deliberately NOT sufficient, which is the whole point of this module.
 * Everything else falls back to the tenant name, and only a tenant with no
 * usable name at all yields `none`.
 */
export function chooseBrandHeader(
    logoUrl: string | null | undefined,
    businessName: string | null | undefined,
    logoStatus: TenantLogoStatus,
): BrandHeaderChoice {
    const url = (logoUrl ?? '').trim();
    const name = (businessName ?? '').trim();

    if (url && logoStatus === 'ok') return 'logo';
    if (name) return 'name';
    return 'none';
}

/**
 * True when the header is still waiting on a logo that may yet appear.
 *
 * The print path uses this to give a nearly-loaded logo a bounded moment to
 * settle, so an operator who clicks Print within the first instants does not
 * get the name fallback for a logo that was about to be ready. It never
 * reports pending for a tenant with no logo configured, so a tenant without
 * one never waits at all.
 */
export function isLogoSettling(
    logoUrl: string | null | undefined,
    logoStatus: TenantLogoStatus,
): boolean {
    return Boolean((logoUrl ?? '').trim()) && logoStatus === 'pending';
}
