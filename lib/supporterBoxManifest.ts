/**
 * OPS-6 / OPS-6A — LAYER 1: what the supporter PURCHASED.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS MODULE IS NOT ABOUT BOXES.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OPS-6 conflated two things that OPS-6A separates:
 *
 *   LAYER 1 (here)              what the supporter BOUGHT
 *                               -> PurchasedBundleInstance[]
 *
 *   LAYER 2 (physicalBoxPacking) how those purchases are PACKED
 *                               -> PhysicalBox[]
 *
 * OPS-6 assumed one purchased bundle instance = one physical outer box. The
 * owner's real operation is not that: a Serves-5 bundle fills a large box, but
 * a Serves-2 bundle only fills HALF of one, so two Serves-2 bundles from the
 * same order share a single large box. Two purchases, one box, one label.
 *
 * So "how many boxes?" is no longer answerable here, and deliberately is not.
 * This module answers only "what did they buy, and is each line truthful
 * enough to print?". lib/physicalBoxPacking.ts answers the box question, and
 * it is the ONLY thing that may.
 *
 * The split is enforced by naming, not just convention: nothing here is called
 * a box, and nothing here counts one. A future reader cannot mistake a
 * PurchasedBundleInstance for a shipping carton.
 *
 * PURCHASE TRUTH IS IMMUTABLE
 *
 * Layer 2 may GROUP these instances. It may never modify their identity.
 * Nothing in either layer writes an Order or an OrderItem.
 *
 * FAIL CLOSED
 *
 * A physical label is laminated to a box, handed to a volunteer, and outlives
 * every request that produced it. Every required fact is proven before ANY
 * instance for that order is emitted, and a missing fact blocks the order and
 * names it rather than printing a guess. There is no partial success for one
 * order.
 */

// The strict serving-tier presentation formatter, shared with the meal labels.
//
// Reused, not re-implemented: lib/mealLabel.ts's servingTierLabel accepts ONLY
// the canonical `serves_5` / `serves_2` vocabulary and returns null for
// anything else, which is precisely the fail-closed behaviour required. A
// second formatter here would be a third serving-tier authority, and OPS-5
// already paid for what happens when one question has four implementations
// (four divergent allergen keyword maps printing different labels for the same
// meal). Importing a pure presentation function does NOT merge the two label
// systems: the dependency runs one way, and lib/mealLabel.ts still holds no
// supporter identity.
//
// NOT lib/fundraiserProductionBatch.ts's formatServingTier: that one renders
// any string by underscore-splitting and capitalising, so a legacy `family`
// would print "Family" on a physical box.
//
// NOT lib/serving_multipliers.ts's normalizeStrictServingTier: that expands
// aliases (`family` -> serves_5), which is correct for sale-time intake but is
// a re-derivation here. OrderItem.variant_size is a Prisma enum whose only
// values are serves_2 and serves_5, so the strict formatter already recognises
// 100% of what the column can hold; a value it rejects did not come from the
// enum and must not be guessed at.
import { servingTierLabel } from './mealLabel';

// The ONE rule for combining a purchaser's separate first/last name.
// FR-SUPPORTER-CONTACT-1 made this the single authority; see the guarded call
// in resolveSupporterName below for why its 'A supporter' fallback can never
// reach a label.
import { purchaserDisplayName } from './purchaserName';

/** An OrderItem as the outer-box layers need it. */
export interface BoxManifestOrderItem {
    id: string;
    /**
     * Stable Bundle identity. NULL is meaningful, not an error: OrderItem.bundle_id
     * is nullable and a null line is a non-bundle line (see isBoxEligibleItem).
     */
    bundle_id: string | null;
    /** Physical bundle instances purchased on this line. */
    quantity: number;
    /**
     * The FROZEN sale-time serving tier. The authority, and the only one — see
     * resolveSoldTier.
     */
    variant_size: string | null;
    /** The FROZEN sale-time bundle display name. See resolveBundleName. */
    item_name: string | null;
    /** The live Bundle row, when the caller joined it. Fallback name only. */
    bundle?: { id?: string; name?: string | null } | null;
}

/**
 * An Order as the outer-box layers need it.
 *
 * Note what is absent: no phone, no email, no delivery_address, no Customer
 * relation. Those are not "omitted from the label" — they are not accepted by
 * this module at all, so no future edit here can put them on a box. The
 * supporter's contact details are not needed to pack their box.
 */
export interface BoxManifestOrder {
    id: string;
    /** FR-SUPPORTER-CONTACT-1 order-time first/last. Preferred identity. */
    first_name: string | null;
    last_name: string | null;
    /** Order-time combined name scalar, written on every order. Fallback. */
    customer_name: string | null;
    items: BoxManifestOrderItem[];
}

/**
 * ONE physical bundle the supporter actually bought.
 *
 * An OrderItem of quantity 3 yields THREE of these. That fan-out happens here,
 * in Layer 1, deliberately: Layer 2 pairs Serves-2 bundles two at a time, and
 * pairing must be able to combine two instances of the SAME OrderItem (a
 * qty-2 Serves-2 line is one large box, not two half-empty ones). If fan-out
 * happened after packing, that case would be unreachable.
 *
 * This is a PURCHASE, not a carton. It has no box number and no box type.
 */
export interface PurchasedBundleInstance {
    orderId: string;
    orderItemId: string;
    /** 0-based instance within its OrderItem. Traceability, not display. */
    instanceIndex: number;
    supporterName: string;
    bundleName: string;
    /** Presentation-ready: "Serves 2" / "Serves 5". */
    servingTier: string;
    /**
     * The canonical frozen tier token — 'serves_2' | 'serves_5'. Carried
     * because Layer 2 must branch on the tier, and matching a display string
     * would make packing depend on presentation.
     */
    variantSize: string;
    /**
     * Deterministic position within the order, 0-based. Layer 2 pairs in this
     * exact order, so the same order always yields the same boxes.
     */
    sequence: number;
}

export interface BlockedBoxOrder {
    orderId: string;
    reason: string;
}

/**
 * Names that must never be printed as a supporter.
 *
 * These are machine placeholders, not people. 'a supporter' is included
 * because it is purchaserDisplayName's own both-names-empty fallback — a
 * perfectly good phrase in a coordinator email, and a useless thing to hand a
 * volunteer holding a box.
 *
 * OPS-6A OWNER RULING: 'guest' is now here too. OPS-6 deliberately allowed it,
 * reasoning that a stored "Guest" might be an intentional tenant entry and
 * blocking it would break a legitimate name. The owner has since ruled the
 * other way, and the reasoning is better than mine was: the largest field on
 * the box exists to answer "whose box is this?", and "Guest" does not answer
 * it. A box that cannot name its owner is not distributable, so it blocks.
 */
const PLACEHOLDER_SUPPORTER_NAMES: ReadonlySet<string> = new Set([
    'undefined',
    'null',
    'unknown',
    'unknown customer',
    'unknown supporter',
    'customer',
    'guest',
    'n/a',
    'na',
    '-',
    'a supporter',
]);

function isPlaceholderName(value: string): boolean {
    return PLACEHOLDER_SUPPORTER_NAMES.has(value.trim().toLowerCase());
}

/**
 * The supporter this purchase belongs to, from ORDER-TIME identity only.
 *
 * PRECEDENCE, and why:
 *   1. Order.first_name / Order.last_name — the order-time purchaser identity
 *      added by FR-SUPPORTER-CONTACT-1, written on every new order.
 *   2. Order.customer_name — the order-time combined scalar, present on
 *      historical rows that predate (1) and never backfilled.
 *
 * The mutable CRM record is deliberately NOT consulted. Customer.name and
 * Customer.contact_name are editable fields a tenant may rename at any time,
 * and for a fundraiser the Customer IS THE ORGANIZATION (schema:
 * `type OrgType @default(fundraiser_org)`) — so `customer.name` on a
 * fundraiser order is the school or team, which would put the wrong name on
 * every box. That is exactly what the pre-OPS-6 DeliveryQueue path did
 * (`order.customer?.name || 'Unknown'`), and it is why this module does not
 * even accept a Customer relation.
 *
 * Returns null when no usable order-time name exists. A null BLOCKS the order.
 * No name is ever fabricated — not from an email local-part, not from a
 * participant name, not from an order id.
 */
export function resolveSupporterName(order: BoxManifestOrder): string | null {
    const first = (order?.first_name ?? '').trim();
    const last = (order?.last_name ?? '').trim();

    // Guarded so purchaserDisplayName's 'A supporter' fallback is unreachable:
    // it is only called when it has at least one real name to combine. That
    // keeps ONE concatenation rule in the codebase without importing its
    // placeholder.
    if (first || last) {
        const combined = purchaserDisplayName(first, last).trim();
        if (combined && !isPlaceholderName(combined)) return combined;
    }

    const scalar = (order?.customer_name ?? '').trim();
    if (scalar && !isPlaceholderName(scalar)) return scalar;

    return null;
}

/**
 * The bundle name this purchase shows, from the FROZEN sale-time snapshot.
 *
 * OrderItem.item_name is the name captured when the sale happened — every
 * order-creation route writes it (the public supporter route, storefront
 * checkout, the coordinator route). Preferring it means renaming a Bundle
 * today cannot retroactively change what a box sold last season says, the
 * same reason schema.prisma gives for storing InvoiceItem.variant_size rather
 * than re-deriving it.
 *
 * This is the OPPOSITE precedence to lib/fundraiserProductionBatch.ts's
 * `item.bundle?.name || item.item_name`, and the difference is deliberate:
 * that is a kitchen aggregation display, refreshed on every dashboard load,
 * where the tenant's current name is helpful. This is a physical artifact that
 * outlives the render.
 *
 * Returns null when neither a snapshot nor a joined Bundle name exists, which
 * BLOCKS the order rather than printing "Item".
 */
export function resolveBundleName(item: BoxManifestOrderItem): string | null {
    const snapshot = (item?.item_name ?? '').trim();
    if (snapshot) return snapshot;
    const live = (item?.bundle?.name ?? '').trim();
    if (live) return live;
    return null;
}

/**
 * The tier this line was SOLD at, as printed.
 *
 * OrderItem.variant_size, and nothing else. Bundle.serving_tier is a mutable
 * free-form String (schema default: "family") describing what the bundle sells
 * TODAY; re-deriving from it would let a bundle edit rewrite what a historical
 * box says it contains — and, after OPS-6A, would also silently change how
 * that order is PACKED. lib/orderItemTier.ts states the rule this enforces:
 * "OrderItem.variant_size is the frozen snapshot of the tier actually
 * purchased, and is never re-derived afterwards."
 *
 * resolveSoldVariantSize() from that module is deliberately NOT called here.
 * It is the WRITE-side helper — it takes Bundle.serving_tier as authoritative
 * in order to CREATE the snapshot at sale time. Calling it on a read would
 * resurrect the mutable Bundle value and re-derive the very snapshot it exists
 * to freeze.
 *
 * Returns null for absent or unrecognised values, which BLOCKS. Never guesses,
 * and in particular never falls back to `serves_5` the way resolveVariantSize()
 * and lib/fundraiserProductionBatch.ts do — a default is right for aggregation
 * arithmetic and wrong on a physical label.
 */
export function resolveSoldTier(item: BoxManifestOrderItem): string | null {
    return servingTierLabel(item?.variant_size);
}

/**
 * The canonical frozen tier token for packing — 'serves_2' | 'serves_5'.
 *
 * Deliberately derived from the SAME strict check as resolveSoldTier, so the
 * tier a box is packed by and the tier printed on its label can never
 * disagree. Returns null exactly when resolveSoldTier does.
 */
export function resolvePackingVariantSize(item: BoxManifestOrderItem): string | null {
    const label = servingTierLabel(item?.variant_size);
    if (!label) return null;
    return String(item.variant_size);
}

/**
 * Is this line a physical purchased BUNDLE instance at all?
 *
 * Only a line with real Bundle identity becomes a purchase. A line with no
 * bundle_id is a non-bundle line — a manual upsell in today's data — and is
 * SKIPPED, not blocked: it is legitimate, it simply is not something to pack.
 *
 * Tax, delivery fees and discounts cannot reach here in the first place:
 * schema.prisma keeps them as Order COLUMNS (`tax_amount`, `delivery_fee`),
 * not as OrderItem rows, and OrderItem has no item-type discriminator at all.
 * This predicate is what keeps that true if a future phase ever adds one.
 *
 * Quantity is checked separately, by quantityFault: a malformed quantity on an
 * otherwise-eligible bundle line must BLOCK rather than be skipped, because
 * silently dropping it would understate every box's "of M" total.
 */
export function isBoxEligibleItem(item: BoxManifestOrderItem): boolean {
    return typeof item?.bundle_id === 'string' && item.bundle_id.trim() !== '';
}

/** A human reason when this line's quantity cannot be trusted, else null. */
export function quantityFault(item: BoxManifestOrderItem): string | null {
    const q = item?.quantity;
    if (typeof q !== 'number' || !Number.isFinite(q)) return 'its quantity is missing or not a number';
    if (!Number.isInteger(q)) return `its quantity (${q}) is not a whole number of bundles`;
    if (q < 1) return `its quantity (${q}) is not at least one bundle`;
    return null;
}

/**
 * Deterministic line ordering. Never database default row order, and never
 * unordered object iteration.
 *
 * OrderItem has neither a `position` column nor a `created_at` column (see
 * prisma/schema.prisma) — `id` is the only authoritative stable field on the
 * row, so it is the sort key. Sorting INSIDE this function rather than
 * trusting the caller's array order is what makes the instance sequence — and
 * therefore Layer 2's pairing, and therefore Box N/M — independent of how the
 * rows arrived: a re-fetch, a differently-ordered query, or a shuffled array
 * all produce the identical sequence. The server route orders by the same key
 * so client and server can never disagree.
 */
function orderedItems(items: BoxManifestOrderItem[]): BoxManifestOrderItem[] {
    return [...(items || [])].sort((a, z) => String(a?.id ?? '').localeCompare(String(z?.id ?? '')));
}

/**
 * Every physical bundle instance ONE source Order purchased.
 *
 * Quantity is fanned out here (see PurchasedBundleInstance) and each instance
 * is stamped with its deterministic `sequence`, which is the order Layer 2
 * pairs in.
 *
 * Verifies EVERY line before emitting ANY instance, so a bad line can never
 * produce a set of boxes numbered against a total that excludes it.
 */
export function buildPurchasedInstances(
    order: BoxManifestOrder,
): { ok: true; instances: PurchasedBundleInstance[] } | { ok: false; reason: string } {
    if (!order || typeof order.id !== 'string' || order.id === '') {
        return { ok: false, reason: 'This order could not be identified, so no box labels were produced.' };
    }

    const supporterName = resolveSupporterName(order);
    if (!supporterName) {
        return {
            ok: false,
            reason: `Order ${order.id} has no usable supporter name on record, so its box labels were not produced. `
                + 'Add the purchaser\'s name to the order and try again.',
        };
    }

    const eligible = orderedItems(order.items).filter(isBoxEligibleItem);

    if (eligible.length === 0) {
        return {
            ok: false,
            reason: `Order ${order.id} has no purchased bundles on it, so there is nothing to pack.`,
        };
    }

    const instances: PurchasedBundleInstance[] = [];
    let sequence = 0;

    for (const item of eligible) {
        const fault = quantityFault(item);
        if (fault) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be packed because one of its bundles has an unusable quantity: ${fault}.`,
            };
        }

        const bundleName = resolveBundleName(item);
        if (!bundleName) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be packed because one of its bundles has no name on record.`,
            };
        }

        const servingTier = resolveSoldTier(item);
        const variantSize = resolvePackingVariantSize(item);
        if (!servingTier || !variantSize) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be packed because the serving size sold for "${bundleName}" `
                    + 'is missing or unrecognised. The sold serving size is never guessed.',
            };
        }

        for (let instanceIndex = 0; instanceIndex < item.quantity; instanceIndex++) {
            instances.push({
                orderId: order.id,
                orderItemId: item.id,
                instanceIndex,
                supporterName,
                bundleName,
                servingTier,
                variantSize,
                sequence: sequence++,
            });
        }
    }

    return { ok: true, instances };
}

/**
 * How many physical bundles this order purchased.
 *
 * This is the PURCHASE count, not the box count — after OPS-6A they are
 * routinely different, and conflating them is the exact defect this phase
 * exists to fix. For boxes, use lib/physicalBoxPacking.ts.
 */
export function countPurchasedInstances(order: BoxManifestOrder): number {
    const result = buildPurchasedInstances(order);
    return result.ok ? result.instances.length : 0;
}
