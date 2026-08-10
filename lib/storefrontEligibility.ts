/**
 * Public storefront bundle eligibility — the single rule, in one place.
 *
 * WHAT WENT WRONG: the public tenant payload filtered only `show_on_storefront`.
 * Those are two different questions — "may customers see this?" and "is this a
 * sellable product at all?" — and answering only the first let a deactivated
 * bundle render on the public storefront with a working Add button.
 *
 * Both flags are required for public display and public purchase. Admin,
 * invoicing, and order-history surfaces deliberately do NOT use this: a tenant
 * may legitimately invoice or re-print an order containing a bundle they have
 * since deactivated.
 */

/**
 * Prisma `where` fragment for publicly visible bundles. Spread it rather than
 * hand-writing the flags, so a new public surface cannot quietly ship with half
 * the rule.
 */
export const PUBLIC_BUNDLE_VISIBILITY = {
    show_on_storefront: true,
    is_active: true,
} as const;

/**
 * The same rule as a predicate, for anything already holding bundle rows.
 *
 * Absent flags are treated as NOT eligible: this gate decides whether a
 * customer may buy something, so an unknown value must fail closed.
 */
export function isPubliclyVisibleBundle(bundle: {
    is_active?: boolean | null;
    show_on_storefront?: boolean | null;
} | null | undefined): boolean {
    if (!bundle) return false;
    return bundle.is_active === true && bundle.show_on_storefront === true;
}
