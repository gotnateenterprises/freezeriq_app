/**
 * FR-ACCEPTANCE-2A — who the tenant is, to a customer.
 *
 * A fundraiser email goes out under the tenant's name, to a volunteer who has
 * never heard of FreezerIQ. Two facts decide what that person reads, and both
 * were previously wrong.
 *
 * THE NAME. `Business.name` is the canonical internal identity and the
 * authority for the From header — "My Freezer Chef via FreezerIQ". But the
 * brand this tenant's customers know is "Freezer Chef", and there was nowhere
 * durable to say so. The only candidate, TenantBranding.business_name, is keyed
 * on user_id rather than business_id and carries DEFAULT 'Freezer Chef', so
 * reading it would sign every unconfigured tenant's mail as another company.
 * `Business.display_name` is the business-level answer, and null simply means
 * "no separate brand".
 *
 * THE WEBSITE. The footer linked to the platform storefront URL
 * (https://www.freezeriqapp.com/shop/my-freezer-chef). That is a FreezerIQ
 * address, not the tenant's — a volunteer who bookmarks it is bookmarking the
 * wrong company. `Business.custom_domain` holds the real one when the tenant has
 * one; the storefront URL remains the correct fallback when they do not.
 *
 * Neither value is ever hardcoded. Nothing here knows what "Freezer Chef" is.
 */

/** The columns any customer-facing surface needs. Nothing more is selected. */
export interface TenantBrandSource {
    name: string;
    display_name?: string | null;
    custom_domain?: string | null;
    slug?: string | null;
}

export interface TenantBrand {
    /** What a customer should read. Never blank. */
    name: string;
    /** Absolute URL of the tenant's public site, when one can be built. */
    websiteUrl: string | null;
    /** How that URL should be shown to a human — no scheme, no trailing slash. */
    websiteLabel: string | null;
}

/**
 * The customer-facing name.
 *
 * Trimmed before the fallback so a display_name of "   " — which a text input
 * can produce — cannot yield an empty brand. Whitespace is not a name.
 */
export function customerFacingBusinessName(business: TenantBrandSource): string {
    const display = (business.display_name ?? '').trim();
    return display || business.name;
}

/**
 * Strip a custom domain down to a bare host.
 *
 * Tenants type this field by hand, so it arrives as "myfreezerchef.com",
 * "https://myfreezerchef.com", or with a trailing slash. All three mean the
 * same site.
 */
function normalizeDomain(raw: string): string | null {
    let v = raw.trim();
    if (!v) return null;
    v = v.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!v || !v.includes('.')) return null;
    // Positively match a plausible host (plus optional port/path) rather than
    // rejecting a blacklist. "<b>x.com</b>" contains a dot and no whitespace, so
    // a whitespace check alone would let markup through into an href — escaped
    // and therefore harmless, but still a broken link presented as the tenant's
    // own address. Anything that is not recognisably a host falls back to the
    // storefront URL, which is always correct.
    if (!/^[a-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\-/%?=&]*)?$/i.test(v)) return null;
    if (v.startsWith('.') || v.startsWith('-') || /\.\./.test(v)) return null;
    return v;
}

/**
 * Resolve the tenant's public website.
 *
 * The custom domain wins when present. Otherwise the canonical storefront URL
 * is correct — it is genuinely where that tenant's customers shop.
 */
export function customerFacingWebsite(
    business: TenantBrandSource,
    platformOrigin?: string | null
): { url: string | null; label: string | null } {
    const domain = normalizeDomain(business.custom_domain ?? '');
    if (domain) return { url: `https://${domain}`, label: domain };

    const origin = (platformOrigin ?? '').trim().replace(/\/+$/, '');
    const slug = (business.slug ?? '').trim();
    if (!origin || !slug) return { url: null, label: null };

    const url = `${origin}/shop/${slug}`;
    return { url, label: url.replace(/^https?:\/\//i, '') };
}

/** Both facts at once, for the surfaces that need the whole identity. */
export function resolveTenantBrand(
    business: TenantBrandSource,
    platformOrigin?: string | null
): TenantBrand {
    const site = customerFacingWebsite(business, platformOrigin);
    return {
        name: customerFacingBusinessName(business),
        websiteUrl: site.url,
        websiteLabel: site.label,
    };
}
