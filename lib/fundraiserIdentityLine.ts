/**
 * PACKED-READY-WAVES-1 — the one place the "Fundraiser: <organization>" line is worded.
 *
 * WHY THIS EXISTS
 *
 * Several fundraisers can be in Packed & Ready at once, and their packing slips have to
 * be physically sorted into separate piles. Until now a slip carried only the supporter's
 * name, so the packer had to recognise people to know which pile a slip belonged in. The
 * outer-box label already prints the organization (BOX-LABEL-ORG-1); this module is the
 * display half that lets the Packed & Ready row and the packing slip say the same thing.
 *
 * WHERE THE NAME COMES FROM IS NOT DECIDED HERE
 *
 * This module only words and cleans a name it is handed. The name's AUTHORITY is
 * `resolveOrganizationName` in lib/supporterBoxManifest.ts — the campaign's owning
 * organization (`Order.campaign.customer.name`), then the campaign's own name — carried
 * on `PhysicalBox.organizationName` for the slip and read through the same resolver for
 * the lane. It is never `Order.customer`, which for a coordinator-entered order IS the
 * organization and for a public supporter order is the supporter.
 *
 * NEVER A PLACEHOLDER
 *
 * An absent, blank or whitespace-only name yields NO line at all — not "null", not
 * "undefined", not "Fundraiser:" with nothing after it. An ordinary (non-fundraiser)
 * order has no organization, so it gets no line, which is what keeps ordinary slips and
 * ordinary rows exactly as they were.
 *
 * DISPLAY ONLY. Pure: no Prisma, no React, no I/O.
 */

/** The label that precedes the organization. One definition for the lane and the slip. */
export const FUNDRAISER_LINE_PREFIX = 'Fundraiser:';

export interface FundraiserIdentity {
    prefix: string;
    /** The organization, whitespace-collapsed. Never empty. */
    name: string;
}

/** The identity to print, or null when there is nothing truthful to print. */
export function fundraiserIdentity(
    organizationName: string | null | undefined,
): FundraiserIdentity | null {
    if (typeof organizationName !== 'string') return null;
    const name = organizationName.replace(/\s+/g, ' ').trim();
    if (name === '') return null;
    return { prefix: FUNDRAISER_LINE_PREFIX, name };
}

/** "Fundraiser: Alpha County Farm Bureau", or null. */
export function fundraiserIdentityText(
    organizationName: string | null | undefined,
): string | null {
    const identity = fundraiserIdentity(organizationName);
    return identity ? `${identity.prefix} ${identity.name}` : null;
}
