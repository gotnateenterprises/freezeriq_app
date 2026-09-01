/**
 * FULFILLMENT-CONTINUITY-1 — the sold serving tier is the MENU's, not the client's.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md is the canonical ruling
 * this module implements. Read it before changing this rule.
 *
 * WHY THIS EXISTS
 *
 * OrderItem.variant_size decides how much food gets cooked. lib/kitchen_engine.ts
 * scales every ingredient by it (serves_5 = 1.0, serves_2 = 0.5), and the public
 * order route decrements bundle stock by the same multiplier. Until now three
 * order-intake routes took that value from the REQUEST BODY —
 * `resolveVariantSize(item.serving_tier)` — while carefully re-deriving the
 * PRICE of the very same line from the tenant-scoped Bundle row.
 *
 * So price was server-authoritative and tier was not. A hand-edited request
 * could buy a Serves-2 bundle at its correct Serves-2 price and have the kitchen
 * cook it at the Serves-5 multiplier.
 *
 * THE RULE (owner ruling, FULFILLMENT-CONTINUITY-1)
 *
 *   THE MENU DEFINES WHAT WAS SOLD.
 *   THE ORDER ITEM RECEIPT PRESERVES WHAT WAS SOLD.
 *
 *   At sale time, Bundle.serving_tier is authoritative. The client cannot
 *   redefine it. OrderItem.variant_size is the frozen snapshot of the tier
 *   actually purchased, and is never re-derived afterwards.
 *
 * The snapshot half is already the project's stated position — prisma/schema.prisma
 * says of the sibling InvoiceItem column that it is "Stored rather than
 * re-derived because Bundle.serving_tier is a mutable free-form string — editing
 * a bundle must not retroactively change what a historical invoice line said."
 * This module supplies the missing half: the snapshot must be taken FROM THE
 * BUNDLE at write time, not from the caller.
 *
 * NORMALIZE, NOT REJECT
 *
 * A conflicting client tier is ignored, not refused. Every real client already
 * echoes the bundle's own tier back to the server, so normalizing is a no-op for
 * all of them and needs no client change. Refusing would instead invent a new
 * error code that no client renders, and would fail an honest stale-tab order
 * whenever a tenant edits a bundle's tier mid-session — Bundle.serving_tier is
 * mutable free text. app/api/tenant/invoices/route.ts already normalizes this
 * way; this makes the order routes agree with the invoice route.
 *
 * WHAT THIS IS NOT
 *
 * This is not a new tier vocabulary. The freeform-string -> VariantSize mapping
 * stays owned by lib/serving_multipliers.ts (resolveVariantSize), which is a
 * sensitive core file and is imported here, never duplicated. Adding a second
 * normalizer is how "serves_2 read as family" defects happen.
 *
 * DELIBERATELY OMITTED
 *
 * A DB lookup. This module is pure so it can be tested with plain literals and
 * without a Prisma client. Each intake route owns its own tenant-scoped
 * `bundle.findMany({ where: { id: { in: bundleIds }, business_id } })` — most
 * already run one — and passes the tier in. Routing the query through
 * lib/pricing.ts was rejected: that module is deliberately shared with
 * authenticated invoice and manual-order surfaces, and widening its return type
 * would reach further than this rule should.
 *
 * APPLIED TO ALL FOUR ORDER-CREATION ROUTES: the public supporter route, the
 * coordinator add-order route, the storefront checkout route, and
 * app/api/orders/route.ts (tenant manual order entry).
 *
 * FC-1 initially exempted the manual route, because components/AddOrderModal.tsx
 * renders a serving-size selector separate from the bundle selector and that
 * looked like a deliberate custom sale. FC-1A found otherwise: the selector has
 * no price effect (the line total comes from the Bundle's own price), the tier is
 * never shown in the bundle dropdown, CB-1 already made Serves-2 and Serves-5
 * separate Bundle rows with separate prices, and the selector predates that model
 * — it is in the initial commit. Honouring it could only ever mean charging one
 * tier's price while cooking another's. See the contract, section 4.4.
 */

import { resolveVariantSize, type DbVariantSize } from './serving_multipliers';

/**
 * The tier this line was actually sold at.
 *
 * @param bundleServingTier - Bundle.serving_tier read from the TENANT-SCOPED
 *        Bundle row. When present this wins outright; the client value is not
 *        consulted at all.
 * @param clientServingTier - the caller-supplied tier. Used ONLY when there is
 *        no bundle to speak for the line — a manual upsell, or a bundle the
 *        route could not resolve. Preserves the previous behaviour exactly for
 *        those cases rather than inventing a tier for them.
 */
export function resolveSoldVariantSize(
    bundleServingTier: string | null | undefined,
    clientServingTier?: string | null | undefined,
): DbVariantSize {
    if (bundleServingTier != null && String(bundleServingTier).trim() !== '') {
        return resolveVariantSize(bundleServingTier);
    }
    return resolveVariantSize(clientServingTier);
}

/**
 * True when the caller asked for a tier the tenant-scoped bundle does not sell.
 *
 * Nothing rejects on this today — see NORMALIZE, NOT REJECT above. It exists so
 * the disagreement is nameable and testable rather than silently swallowed, and
 * so a future phase that wants to warn or report can do so without re-deriving
 * the comparison.
 */
export function clientTierDisagreesWithBundle(
    bundleServingTier: string | null | undefined,
    clientServingTier: string | null | undefined,
): boolean {
    if (bundleServingTier == null || String(bundleServingTier).trim() === '') return false;
    if (clientServingTier == null || String(clientServingTier).trim() === '') return false;
    return resolveVariantSize(bundleServingTier) !== resolveVariantSize(clientServingTier);
}
