/**
 * LEGACY-WRITER-GUARDS-1 — a bundle that business history points at is never hard-deleted.
 *
 * Deleting a referenced bundle never failed, which was the problem. The baseline migration makes
 * order_items.bundle_id and invoice_items.bundle_id ON DELETE SET NULL and campaign_bundles.bundle_id
 * ON DELETE CASCADE, so the delete silently unlinked every order line that sold the bundle (and
 * production math skips lines with no bundle), blanked the invoice lines, and took the bundle off
 * every campaign's menu. Retiring a bundle is "Active off", which every reader already honours.
 *
 * bundle_contents is not history (it is the bundle's own definition) and storefront_configs only
 * points at an upsell suggestion; both keep their existing behaviour.
 */

export interface BundleReferenceCounts {
    orderItems: number;
    invoiceItems: number;
    campaignBundles: number;
}

/** The narrow Prisma surface the count needs, so a test can supply a double. */
export interface BundleReferenceReader {
    orderItem: { count(args: { where: { bundle_id: string } }): Promise<number> };
    invoiceItem: { count(args: { where: { bundle_id: string } }): Promise<number> };
    campaignBundle: { count(args: { where: { bundle_id: string } }): Promise<number> };
}

/**
 * Counts every history row that points at the bundle. Canceled orders count too: a canceled
 * order is still a record of what was sold and to whom.
 */
export async function countBundleReferences(
    tx: BundleReferenceReader,
    bundleId: string,
): Promise<BundleReferenceCounts> {
    const where = { bundle_id: bundleId };
    const orderItems = await tx.orderItem.count({ where });
    const invoiceItems = await tx.invoiceItem.count({ where });
    const campaignBundles = await tx.campaignBundle.count({ where });
    return { orderItems, invoiceItems, campaignBundles };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Null when the bundle may be deleted; otherwise the reason, in words a tenant can act on. */
export function bundleDeletionRefusal(counts: BundleReferenceCounts): string | null {
    const uses: string[] = [];
    if (counts.orderItems > 0) uses.push(plural(counts.orderItems, 'order line', 'order lines'));
    if (counts.invoiceItems > 0) uses.push(plural(counts.invoiceItems, 'invoice line', 'invoice lines'));
    if (counts.campaignBundles > 0) uses.push(plural(counts.campaignBundles, 'fundraiser menu', 'fundraiser menus'));
    if (uses.length === 0) return null;

    const list = uses.length === 1
        ? uses[0]
        : `${uses.slice(0, -1).join(', ')} and ${uses[uses.length - 1]}`;
    return `This bundle can't be deleted because it is used by ${list}. Turn off "Active" to retire it instead.`;
}
