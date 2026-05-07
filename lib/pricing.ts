/**
 * Bundle Pricing — Centralized server-side price resolution.
 *
 * SINGLE SOURCE OF TRUTH for mapping bundle IDs to their authoritative
 * database prices. All order intake routes MUST use this utility instead
 * of building their own price maps.
 *
 * CONSTITUTION — LAW 1 compliance:
 *   Database bundle.price is the ONLY source of truth for pricing.
 *   Client-sent prices are NEVER trusted.
 *
 * @module pricing
 */

import { prisma } from '@/lib/db';

/**
 * Builds a Map of bundleId → price (as number) from the database.
 *
 * This is the canonical price lookup used by all order intake routes.
 * Returns only bundles that exist AND belong to the specified business
 * (tenant-scoped per CONSTITUTION §2).
 *
 * @param businessId - The tenant business ID (scoping)
 * @param bundleIds  - Array of bundle IDs to look up
 * @returns Map<string, number> where key=bundleId, value=price
 *
 * @example
 * const priceMap = await buildBundlePriceMap(businessId, ['bundle-1', 'bundle-2']);
 * const price = priceMap.get('bundle-1'); // 89.99
 */
export async function buildBundlePriceMap(
    businessId: string,
    bundleIds: string[]
): Promise<Map<string, number>> {
    if (bundleIds.length === 0) return new Map();

    const dbBundles = await prisma.bundle.findMany({
        where: {
            id: { in: bundleIds },
            business_id: businessId,
        },
        select: { id: true, price: true },
    });

    return new Map(
        dbBundles.map((b: any) => [b.id, Number(b.price)])
    );
}
