/**
 * STOREFRONT-CUSTOMER-EXPERIENCE-1B — the tenant's choice to list a fundraiser in the public
 * storefront's "Active Fundraisers" section.
 *
 * DISCOVERY ONLY. `FundraiserCampaign.listed_on_storefront` is read by the storefront's
 * discovery query (app/api/public/tenant/[slug]/route.ts) and by the tenant's own CRM, and by
 * nothing else. The direct fundraiser link, supporter ordering, the coordinator portal, the
 * scoreboard, QR codes, flyers, packets, closeout, invoices and QuickBooks never read it:
 * a fundraiser that is not listed is still fully live for everyone who has its link.
 * tests/storefrontExperience1b.test.ts fails if any other file starts reading it.
 *
 * Listing is necessary, not sufficient. Discovery still requires an Active, open, current
 * campaign whose coordinator has chosen its bundles, so a campaign listed at launch appears
 * only once it is actually taking orders.
 */

/** The toggle's label, shared by the Edit details dialog and both launch flows. */
export const STOREFRONT_LISTING_LABEL = 'Show on customer storefront';

/** The toggle's help text, owner-approved wording. */
export const STOREFRONT_LISTING_HELP =
    'Display this fundraiser in the public Active Fundraisers section. '
    + 'Direct fundraiser links continue to work when this is off.';

/** The CRM indicator shown on a listed fundraiser. */
export const STOREFRONT_LISTING_CHIP = 'On storefront';

export type StorefrontListingDecision =
    | { change: false }
    | { change: true; listed: boolean }
    | { change: false; rejected: true; status: 400; error: string };

/** Narrowing helper so route code reads plainly, matching the org-share/goal pattern. */
export function isStorefrontListingRejected(
    d: StorefrontListingDecision
): d is { change: false; rejected: true; status: 400; error: string } {
    return (d as any).rejected === true;
}

/**
 * One request's decision about the listing flag. Omission leaves it untouched; only a real
 * boolean is written. No closeout gate on purpose: a closed campaign is never listed whatever
 * this says, so letting a tenant tidy the flag afterwards cannot change what the public sees.
 */
export function decideStorefrontListingChange(requested: unknown): StorefrontListingDecision {
    if (requested === undefined) return { change: false };
    if (typeof requested !== 'boolean') {
        return {
            change: false,
            rejected: true,
            status: 400,
            error: 'Choose whether to show this fundraiser on the customer storefront.',
        };
    }
    return { change: true, listed: requested };
}
