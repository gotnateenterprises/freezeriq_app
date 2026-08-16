/**
 * INV-A — who is allowed to close out a fundraiser campaign.
 *
 * This module holds ONLY the authorization rule. The closed-status list and the
 * isCampaignClosed() predicate already have a canonical home in
 * lib/campaignBundleSelection.ts and are imported from there — a second copy
 * could drift, and the two rules that depend on it (the closeout claim, and the
 * org_share_percent edit lock) must never disagree about what "closed" means.
 */

/**
 * Owner decision (INV-A): closeout is ADMIN or super-admin.
 *
 * Closeout freezes settlement_total, releases held production orders, and names
 * the responsible actor — so it is not "any authenticated tenant user". CHEF and
 * DRIVER are explicitly NOT authorized. A super-admin is authorized regardless
 * of the role string.
 *
 * Takes plain fields rather than a session type so it is directly testable, and
 * compares strictly: a truthy-but-not-true isSuperAdmin, or a lowercased role,
 * must not open a financial gate.
 */
export function mayCloseOutCampaign(user: {
    role?: unknown;
    isSuperAdmin?: unknown;
}): boolean {
    if (user.isSuperAdmin === true) return true;
    return user.role === 'ADMIN';
}
