/**
 * COORD-FULFILLMENT-2 — the single definition of a coordinator-visible
 * supporter order.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md is the canonical ruling
 * this module implements (§1 grouping, §2 no supporter address, §5 release,
 * §9 coordinator visibility). Read it before changing this rule.
 *
 * WHY THIS EXISTS
 *
 * COORD-FULFILLMENT-1 worked out what a coordinator may see and where each
 * field truthfully comes from, and expressed it inline in the portal GET.
 * COORD-FULFILLMENT-2 adds a second reader — the printable pickup tracker —
 * and a third already exists in the XLSX pickup sheet. Three copies of the
 * email-lineage rule would be three chances to get it wrong in different ways,
 * and the wrong answer here is not a cosmetic bug: it prints a coordinator's
 * own inbox onto a sheet of paper as if it were a supporter's.
 *
 * THE EMAIL LINEAGE RULE
 *
 * Supporter email is NOT a column on Order. It lives on the Customer the order
 * is linked to, and the two fundraiser order paths link different things:
 *
 *   public supporter order    -> a per-supporter Customer, found or created
 *                                from the address that supporter typed.
 *                                contact_email IS the supporter's.
 *   coordinator "+ Add Order" -> the ORGANISATION running the campaign
 *                                (customer_id === campaign.customer_id).
 *                                contact_email is the org's own inbox.
 *
 * So the join is gated on durable identity, never on a display name. An order
 * linked to the campaign's own organisation reports NO supporter email.
 * Coordinator-entered orders genuinely capture none — the POST accepts an
 * `email` field and has no column to put it in — so null is the truthful
 * answer, not a gap to paper over. Giving those orders a real email is a
 * separate, deliberate phase (COORD-ADD-ORDER-CONTACT-1); do not fabricate one
 * here.
 *
 * WHAT THIS IS NOT
 *
 * Not an authorisation check. Every caller must already have resolved its
 * campaign from the coordinator session (lib/coordinatorSession.ts). This
 * module shapes rows that the caller has already proven it may read.
 *
 * Not a production-eligibility rule. Whether an order may be COOKED — and
 * therefore whether it belongs on a day-of pickup manifest — is
 * lib/productionIntake.ts. See isPickupEligibleOrder below, which composes it
 * rather than restating it.
 *
 * DELIBERATELY PURE
 *
 * No prisma import, so the rule is testable with plain literals and can be
 * imported by a client print page as well as by server routes. The Prisma
 * `select` below is a plain object literal for the same reason.
 */

import { isProductionEligibleOrder } from './productionIntake';

/**
 * The Prisma `select` every coordinator surface uses for supporter orders.
 *
 * Spread it rather than hand-writing the fields, so a new coordinator surface
 * cannot quietly ship with a different idea of what a supporter order is —
 * or, worse, with delivery_address added back.
 *
 * `customer_id` and `customer` are WORKING fields: they exist only to decide
 * whether a linked email is the supporter's. toSupporterOrder drops both, so
 * neither reaches a client.
 */
export const SUPPORTER_ORDER_SELECT = {
    id: true,
    customer_name: true,
    participant_name: true,
    total_amount: true,
    created_at: true,
    canceled_at: true,
    source: true,
    status: true,
    phone: true,
    customer_id: true,
    customer: { select: { contact_email: true } },
    items: {
        select: {
            quantity: true,
            variant_size: true,
            item_name: true,
            bundle_id: true,
        },
    },
} as const;

/** A row as it comes back from Prisma under SUPPORTER_ORDER_SELECT. Widened on
 *  purpose: no generated Prisma type is imported. */
export interface SupporterOrderRow {
    id: string;
    customer_name?: string | null;
    participant_name?: string | null;
    total_amount?: unknown;
    created_at?: Date | string | null;
    canceled_at?: Date | string | null;
    source?: string | null;
    status?: string | null;
    phone?: string | null;
    customer_id?: string | null;
    customer?: { contact_email?: string | null } | null;
    items?: Array<{
        quantity?: number | null;
        variant_size?: string | null;
        item_name?: string | null;
        bundle_id?: string | null;
    }> | null;
}

export interface SupporterOrderItem {
    quantity: number;
    variant_size: string | null;
    item_name: string | null;
    bundle_id: string | null;
}

/** What a coordinator surface may render. Note what is absent: no address, no
 *  customer object, no customer_id, no campaign id, no processor id. */
export interface CoordinatorSupporterOrder {
    id: string;
    customer_name: string | null;
    participant_name: string | null;
    email: string | null;
    phone: string | null;
    total_amount: unknown;
    created_at: Date | string | null;
    canceled_at: Date | string | null;
    source: string | null;
    items: SupporterOrderItem[];
}

/**
 * The supporter's own email, or null.
 *
 * @param campaignCustomerId FundraiserCampaign.customer_id — the organisation
 *        running the campaign. An order linked to it was entered by the
 *        coordinator and has no supporter email.
 */
export function supporterEmail(
    order: SupporterOrderRow | null | undefined,
    campaignCustomerId: string | null | undefined,
): string | null {
    if (!order) return null;
    if (!order.customer_id) return null;
    if (campaignCustomerId && order.customer_id === campaignCustomerId) return null;
    return order.customer?.contact_email ?? null;
}

/** Shape one row for a coordinator surface. */
export function toSupporterOrder(
    order: SupporterOrderRow,
    campaignCustomerId: string | null | undefined,
): CoordinatorSupporterOrder {
    return {
        id: order.id,
        customer_name: order.customer_name ?? null,
        participant_name: order.participant_name ?? null,
        email: supporterEmail(order, campaignCustomerId),
        phone: order.phone ?? null,
        total_amount: order.total_amount,
        created_at: order.created_at ?? null,
        canceled_at: order.canceled_at ?? null,
        source: order.source ?? null,
        items: (order.items ?? []).map((i) => ({
            quantity: Number(i?.quantity ?? 0),
            variant_size: i?.variant_size ?? null,
            item_name: i?.item_name ?? null,
            bundle_id: i?.bundle_id ?? null,
        })),
    };
}

// ── Pickup eligibility ───────────────────────────────────────────────────────

/**
 * May this order appear on a DAY-OF PICKUP manifest?
 *
 * THE LIVE TRACKER AND THE PICKUP TRACKER ARE DIFFERENT SETS, ON PURPOSE.
 *
 * The live tracker shows supporter COMMITMENTS — every order the campaign has
 * taken, including those still at `fundraiser_hold` while the organisation's
 * invoice is unpaid. That is what a coordinator watching their fundraiser fill
 * up needs to see.
 *
 * The pickup tracker is a fulfilment document. It answers "what food is
 * actually here to hand over today", and food only exists once the campaign was
 * released — which happens exactly once, when the organisation's invoice is
 * recorded PAID (app/api/tenant/invoices/[id]/settle/route.ts). Printing a held
 * order onto a pickup sheet would send a coordinator looking for a box that was
 * never cooked.
 *
 * This composes lib/productionIntake.ts rather than restating it: "not held,
 * not canceled, not an abandoned pre-payment checkout" is already the rule the
 * Kitchen Board and the production adapter enforce, and a pickup manifest wants
 * exactly the same three exclusions. There is deliberately no status ALLOWLIST
 * here — an order that has moved on to ready_to_ship, completed or delivered is
 * still a supporter who is owed their food, and historical fundraiser orders
 * that predate the hold mechanism are legitimately fulfilled work.
 *
 * This is NOT a per-supporter payment status. FreezerIQ has no authoritative
 * supporter paid/unpaid state, and this must never be rendered as one.
 */
export function isPickupEligibleOrder(
    order: { status?: string | null; source?: string | null; canceled_at?: Date | string | null } | null | undefined,
): boolean {
    return isProductionEligibleOrder(order);
}

// ── Grouping ─────────────────────────────────────────────────────────────────

/**
 * The durable key that decides whether two orders are the SAME PERSON.
 *
 * Never a display name: two supporters really can both be called John Smith,
 * and merging them would hand one person the other's food.
 *
 * A public supporter order carries a per-supporter Customer id, which is a real
 * identity and may merge. A coordinator-entered order carries the ORGANISATION's
 * id, which every such order shares — so it identifies nobody, and each of those
 * orders stays its own group. Truthful duplication is safer than a wrong merge;
 * a coordinator seeing the same name twice can reconcile it, a coordinator
 * seeing one merged row cannot discover the second person exists.
 */
export function supporterGroupKey(
    order: SupporterOrderRow | CoordinatorSupporterOrder | { id: string; customer_id?: string | null },
    campaignCustomerId: string | null | undefined,
): string {
    const customerId = (order as any).customer_id as string | null | undefined;
    if (customerId && customerId !== campaignCustomerId) return `customer:${customerId}`;
    return `order:${order.id}`;
}

export interface SupporterGroup {
    /** Durable group key — `customer:<id>` or `order:<id>`. Not for display. */
    key: string;
    customer_name: string | null;
    participant_name: string | null;
    email: string | null;
    phone: string | null;
    /** Every order in this group, newest-first order preserved from the caller. */
    orders: CoordinatorSupporterOrder[];
    /** All item lines across the group's orders, in order. */
    items: SupporterOrderItem[];
    /** Sum of the group's order totals. */
    total: number;
    /** Earliest order timestamp in the group. */
    firstOrderedAt: Date | string | null;
}

/**
 * Group supporter orders for a manifest.
 *
 * Takes RAW ROWS, not DTOs, and that is deliberate: the durable identity the
 * grouping depends on is `customer_id`, and toSupporterOrder drops it precisely
 * so it never reaches a client. Grouping DTOs would therefore have no identity
 * left to group ON, and would silently fall back to one-group-per-order — which
 * looks like working code and quietly stops merging a supporter's two orders.
 * Rows in, grouped DTOs out, identity never leaves the server.
 *
 * Input must already be filtered for eligibility and authorised — this only
 * groups. Contact details are taken from the first order in the group that
 * actually has them, so a supporter whose second order omitted a phone still
 * shows the one they gave.
 */
export function groupSupporterRows(
    rows: readonly SupporterOrderRow[],
    campaignCustomerId: string | null | undefined,
): SupporterGroup[] {
    const groups: SupporterGroup[] = [];
    const byKey = new Map<string, SupporterGroup>();

    for (const row of rows) {
        const key = supporterGroupKey(row, campaignCustomerId);
        const order = toSupporterOrder(row, campaignCustomerId);
        let group = byKey.get(key);

        if (!group) {
            group = {
                key,
                customer_name: order.customer_name,
                participant_name: order.participant_name,
                email: order.email,
                phone: order.phone,
                orders: [],
                items: [],
                total: 0,
                firstOrderedAt: order.created_at ?? null,
            };
            byKey.set(key, group);
            groups.push(group);
        }

        group.orders.push(order);
        group.items.push(...order.items);
        group.total += Number(order.total_amount ?? 0);

        // Fill in any detail the first order happened not to carry.
        group.customer_name = group.customer_name ?? order.customer_name;
        group.participant_name = group.participant_name ?? order.participant_name;
        group.email = group.email ?? order.email;
        group.phone = group.phone ?? order.phone;

        const at = order.created_at ?? null;
        if (at && (!group.firstOrderedAt || new Date(at as any) < new Date(group.firstOrderedAt as any))) {
            group.firstOrderedAt = at;
        }
    }

    return groups;
}

// ── Display ──────────────────────────────────────────────────────────────────

/**
 * Human-friendly serving tier. `serves_5` is a storage value, not something to
 * print on a document a volunteer reads at a pickup table.
 *
 * Mirrors the transformation components/coordinator/RecentOrders.tsx already
 * applied inline, so the printed sheet and the on-screen tracker cannot
 * describe the same order differently.
 */
export function formatServingTier(variantSize: string | null | undefined): string {
    const raw = (variantSize || '').trim();
    if (!raw) return '';
    const spaced = raw.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
