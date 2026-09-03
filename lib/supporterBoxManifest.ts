/**
 * OPS-6 — the ONE supporter outer-box manifest authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7, which names this
 * artifact and its content precisely:
 *
 *     CUSTOMER OUTER-BOX LABELS | one per supporter box | not built
 *     Future content: supporter name, bundle name, serving tier,
 *                     optional render-time Box N of M
 *     "No persisted box-number schema is authorized at this time. Box
 *      numbering, if built, is a render-time computation only."
 *
 * So nothing here is stored. Every value is computed from the source Order at
 * render time, and this module holds no Prisma import, no React, and no I/O —
 * it is a pure function over rows the caller already fetched tenant-scoped.
 *
 * WHAT AN OUTER-BOX LABEL ANSWERS
 *
 * Not "what food is this?" — that is the MEAL label (lib/mealLabel.ts,
 * lib/mealManifest.ts), a different layer with a different grain. This one
 * answers the packing question: WHO does this box belong to, WHICH bundle is
 * inside, WHAT tier was actually sold, and WHICH box is this of that
 * supporter's order.
 *
 * ONE PHYSICAL PURCHASED BUNDLE INSTANCE = ONE LABEL
 *
 * The count comes from OrderItem.quantity and nothing else. Deliberately NOT
 * from:
 *
 *   - prepTasks / assemblyTasks     (ingredient- and meal-grain, not box-grain)
 *   - BundleContent meal count      (how many MEALS are inside one box)
 *   - the serving multiplier         (serves_2 = 0.5 scales FOOD, not boxes)
 *   - lib/fundraiserMetrics weighting (serves_2 = 0.5 toward a fundraising
 *                                      goal; three Serves-2 bundles are three
 *                                      physical boxes, not one and a half)
 *
 * A supporter who bought 3 bundles gets 3 boxes however much food is in them.
 *
 * WHY THIS IS A NEW MODULE AND NOT A REUSED ONE
 *
 * lib/fundraiserProductionBatch.ts (OPS-3) already groups sold OrderItems by
 * (bundle identity, tier) and is the canonical fundraiser batch — but it
 * AGGREGATES ACROSS ORDERS into one campaign-level requirement, which is
 * exactly what a box label must not do: once Jane's and Bob's lines are summed
 * there is no per-order total left to say "Box 2 of 3" against. This module is
 * its per-order sibling, not a replacement, and it never re-implements the
 * batch's job.
 *
 * app/delivery/print-packing-slips/page.tsx already fans one printed sheet out
 * per physical bundle instance (`for (let i = 0; i < item.quantity; i++)`),
 * which is the same counting rule proven on a live surface. That page produces
 * an 8.5x11 paper insert that goes INSIDE the box and carries no tier and no
 * box number; this produces the adhesive label that goes ON it. The counting
 * rule is deliberately expressed once here, as a tested pure function, rather
 * than a second inline loop. The packing-slip page still owns its own copy —
 * see the deferred-findings note in the OPS-6 report; consolidating it would
 * mean editing a live Delivery render path, which OPS-6 is scoped out of.
 *
 * FAIL CLOSED
 *
 * A physical label is not a UI card. It is laminated to a box, handed to a
 * volunteer, and outlives every request that produced it. So every required
 * fact is proven before ANY label for that order is emitted, and a missing
 * fact blocks the order and names it rather than printing a guess. There is no
 * partial success for one order: an order either yields a complete, truthful
 * set of boxes or it yields none.
 */

// The strict serving-tier presentation formatter, shared with the meal labels.
//
// Reused, not re-implemented: lib/mealLabel.ts's servingTierLabel accepts ONLY
// the canonical `serves_5` / `serves_2` vocabulary and returns null for
// anything else, which is precisely the fail-closed behaviour Part H requires.
// A second formatter here would be a third serving-tier authority, and OPS-5
// already paid for what happens when one question has four implementations
// (four divergent allergen keyword maps printing different labels for the same
// meal). Importing a pure presentation function does NOT merge the two label
// systems: the dependency runs one way, this module never becomes a meal-label
// concern, and lib/mealLabel.ts still holds no supporter identity.
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

/** An OrderItem as an outer-box label needs it. */
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
 * An Order as an outer-box label needs it.
 *
 * Note what is absent: no phone, no email, no delivery_address, no Customer
 * relation. Those are not "omitted from the label" — they are not accepted by
 * this module at all, so no future edit here can put them on a box. The
 * supporter's own contact details are not needed to pack their box.
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

/** One printed outer-box label. */
export interface SupporterBoxLabel {
    orderId: string;
    orderItemId: string;
    /** 0-based instance within its OrderItem. Traceability, not display. */
    physicalInstanceIndex: number;
    supporterName: string;
    bundleName: string;
    /** Already presentation-ready: "Serves 2" / "Serves 5". */
    servingTier: string;
    /** 1-based, within the SOURCE ORDER. */
    boxNumber: number;
    /** Total eligible physical bundle instances in the SOURCE ORDER. */
    boxTotal: number;
}

export interface BlockedBoxOrder {
    orderId: string;
    reason: string;
}

export interface SupporterBoxManifest {
    labels: SupporterBoxLabel[];
    blocked: BlockedBoxOrder[];
}

/**
 * Names that must never be printed as a supporter.
 *
 * These are machine placeholders, not people. 'a supporter' is included
 * because it is purchaserDisplayName's own both-names-empty fallback — a
 * perfectly good word in a coordinator email, and a useless thing to hand a
 * volunteer holding a box.
 *
 * DELIBERATELY ABSENT: 'guest'. The owner ruling carves it out ("unless
 * 'Guest' is an intentional stored supporter name entered by the owner"), and
 * a stored "Guest" typed by a tenant is indistinguishable from a placeholder
 * one. Blocking it would break a legitimate entry, so it prints. See the
 * OPS-6 report, which flags this as the one judgement call in Part G.
 */
const PLACEHOLDER_SUPPORTER_NAMES: ReadonlySet<string> = new Set([
    'undefined',
    'null',
    'unknown',
    'unknown customer',
    'unknown supporter',
    'customer',
    'n/a',
    'na',
    '-',
    'a supporter',
]);

function isPlaceholderName(value: string): boolean {
    return PLACEHOLDER_SUPPORTER_NAMES.has(value.trim().toLowerCase());
}

/**
 * The supporter this box belongs to, from ORDER-TIME identity only.
 *
 * PRECEDENCE, and why:
 *   1. Order.first_name / Order.last_name — the order-time purchaser identity
 *      added by FR-SUPPORTER-CONTACT-1, written on every new order.
 *   2. Order.customer_name — the order-time combined scalar, present on
 *      historical rows that predate (1) and never backfilled.
 *
 * The mutable CRM record is deliberately NOT consulted. Customer.name and
 * Customer.contact_name are editable organization/contact fields that a tenant
 * may rename at any time, and for a fundraiser the Customer IS THE
 * ORGANIZATION (schema: `type OrgType @default(fundraiser_org)`), not the
 * supporter — so `customer.name` on a fundraiser order is the school or team,
 * which would put the wrong name on every box. That is exactly what the live
 * DeliveryQueue path did (`order.customer?.name || 'Unknown'`), and it is why
 * this module does not even accept a Customer relation.
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
 * The bundle name this box shows, from the FROZEN sale-time snapshot first.
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
 * that is a kitchen aggregation display, refreshed every time the dashboard
 * loads, where showing the tenant's current name is helpful. This is a
 * physical artifact that outlives the render.
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
 * box says it contains. lib/orderItemTier.ts states the rule this enforces:
 * "OrderItem.variant_size is the frozen snapshot of the tier actually
 * purchased, and is never re-derived afterwards."
 *
 * Note that resolveSoldVariantSize() from that module is deliberately NOT
 * called here. It is the WRITE-side helper — it takes Bundle.serving_tier as
 * authoritative in order to CREATE the snapshot at sale time. Calling it on a
 * read would resurrect the mutable Bundle value and re-derive the very
 * snapshot it exists to freeze.
 *
 * Returns null for absent or unrecognised values, which BLOCKS. Never guesses
 * a tier, and in particular never falls back to `serves_5` the way
 * resolveVariantSize() and lib/fundraiserProductionBatch.ts do — a default is
 * right for aggregation arithmetic and wrong on a physical label.
 */
export function resolveSoldTier(item: BoxManifestOrderItem): string | null {
    return servingTierLabel(item?.variant_size);
}

/**
 * Is this line a physical purchased BUNDLE instance at all?
 *
 * Only a line with real Bundle identity becomes a box. A line with no
 * bundle_id is a non-bundle line — a manual upsell in today's data — and is
 * SKIPPED, not blocked: it is legitimate, it simply is not a box.
 *
 * Tax, delivery fees and discounts cannot reach here in the first place:
 * schema.prisma keeps them as Order COLUMNS (`tax_amount`, `delivery_fee`),
 * not as OrderItem rows, and OrderItem has no item-type discriminator at all.
 * This predicate is what keeps that true if a future phase ever adds one.
 *
 * Quantity is checked separately, by quantityFault: a malformed quantity on an
 * otherwise-eligible bundle line must BLOCK rather than be skipped, because
 * silently dropping it would understate every other box's "of M" total.
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
 * Deterministic line ordering. Part N: never database default row order, and
 * never unordered object iteration.
 *
 * OrderItem has neither a `position` column nor a `created_at` column (see
 * prisma/schema.prisma) — `id` is the only authoritative stable field on the
 * row, so it is the sort key. Sorting INSIDE this function rather than
 * trusting the caller's array order is what makes Box N/M independent of how
 * the rows arrived: a re-fetch, a differently-ordered query, or a shuffled
 * array all produce the identical sequence. The server route orders by the
 * same key so client and server can never disagree.
 */
function orderedItems(items: BoxManifestOrderItem[]): BoxManifestOrderItem[] {
    return [...(items || [])].sort((a, z) => String(a?.id ?? '').localeCompare(String(z?.id ?? '')));
}

/**
 * Build every outer-box label for ONE source Order.
 *
 * BOX NUMBERING IS WITHIN THIS ORDER. Two separate Orders are two separate
 * numberings, even when the supporter name, email or phone match — merging
 * them would require deciding that two rows are the same person, and the
 * fulfillment contract disqualifies exactly that inference (§1.3: customer_id
 * is not the grouping key). A supporter who ordered twice gets "Box 1 of 1"
 * and "Box 1 of 2", which is correct: they are two separate purchases packed
 * separately.
 */
export function buildOrderBoxLabels(
    order: BoxManifestOrder,
): { ok: true; labels: SupporterBoxLabel[] } | { ok: false; reason: string } {
    if (!order || typeof order.id !== 'string' || order.id === '') {
        return { ok: false, reason: 'This order could not be identified, so no box labels were produced.' };
    }

    const supporterName = resolveSupporterName(order);
    if (!supporterName) {
        return {
            ok: false,
            reason: `Order ${order.id} has no supporter name on record, so its box labels were not produced. `
                + 'Add the purchaser\'s name to the order and try again.',
        };
    }

    const eligible = orderedItems(order.items).filter(isBoxEligibleItem);

    if (eligible.length === 0) {
        return {
            ok: false,
            reason: `Order ${order.id} has no purchased bundles on it, so there is no box to label.`,
        };
    }

    // Verify EVERY line before emitting ANY label, so a bad line can never
    // produce a set of labels numbered against a total that excludes it.
    const resolved: { item: BoxManifestOrderItem; bundleName: string; servingTier: string }[] = [];
    for (const item of eligible) {
        const fault = quantityFault(item);
        if (fault) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be labelled because one of its bundles has an unusable quantity: ${fault}.`,
            };
        }

        const bundleName = resolveBundleName(item);
        if (!bundleName) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be labelled because one of its bundles has no name on record.`,
            };
        }

        const servingTier = resolveSoldTier(item);
        if (!servingTier) {
            return {
                ok: false,
                reason: `Order ${order.id} could not be labelled because the serving size sold for "${bundleName}" `
                    + 'is missing or unrecognised. The sold serving size is never guessed.',
            };
        }

        resolved.push({ item, bundleName, servingTier });
    }

    const boxTotal = resolved.reduce((sum, r) => sum + r.item.quantity, 0);

    const labels: SupporterBoxLabel[] = [];
    let boxNumber = 0;
    for (const { item, bundleName, servingTier } of resolved) {
        for (let instance = 0; instance < item.quantity; instance++) {
            boxNumber += 1;
            labels.push({
                orderId: order.id,
                orderItemId: item.id,
                physicalInstanceIndex: instance,
                supporterName,
                bundleName,
                servingTier,
                boxNumber,
                boxTotal,
            });
        }
    }

    return { ok: true, labels };
}

/**
 * Build the outer-box manifest for a SET of source Orders.
 *
 * Orders are processed independently and each keeps its own Box N/M. A blocked
 * order does not stop the others — it is reported by id so the operator can
 * fix it — but it also contributes NO labels, so nothing printed is ever a
 * guess. Orders come back in a deterministic id order for the same reason the
 * lines do.
 */
export function buildSupporterBoxManifest(orders: BoxManifestOrder[]): SupporterBoxManifest {
    const labels: SupporterBoxLabel[] = [];
    const blocked: BlockedBoxOrder[] = [];

    const sorted = [...(orders || [])].sort((a, z) =>
        String(a?.id ?? '').localeCompare(String(z?.id ?? '')),
    );

    for (const order of sorted) {
        const result = buildOrderBoxLabels(order);
        if (result.ok) {
            labels.push(...result.labels);
        } else {
            blocked.push({ orderId: order?.id ?? '(unknown)', reason: result.reason });
        }
    }

    return { labels, blocked };
}

/**
 * Total eligible physical bundle instances across a set of orders.
 *
 * The Part O reconstruction check, exported so a header count and the printed
 * sheet count can never be computed two different ways.
 */
export function countPhysicalBoxes(orders: BoxManifestOrder[]): number {
    return buildSupporterBoxManifest(orders).labels.length;
}
