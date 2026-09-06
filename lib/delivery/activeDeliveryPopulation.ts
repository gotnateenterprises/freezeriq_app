/**
 * OPS-6B.1 — the ONE definition of "which Orders are in active Delivery".
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §8 and §11 Rule 8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS — a real Production acceptance failure
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OPS-6B unified the box CLASSIFICATION authority (five competing
 * large-vs-small heuristics collapsed into lib/physicalBoxPacking.ts) but left
 * the POPULATION question answered in three different places. Only the stop
 * list learned about the handoff:
 *
 *   /api/delivery/queue          business_id + canceled_at + RELEASED + not delivered
 *   /api/delivery/stats          business_id + canceled_at + 5 active statuses
 *   /api/delivery/packing-slips  business_id + canceled_at + 5 active statuses
 *
 * So in Production, an owner released ONE order and got one delivery stop —
 * while the Print Queue, the Large/Small cards, the Slips badge and the
 * packing-slip page all still described a completely different set. A second
 * supporter who had never been sent to Delivery printed a packing slip anyway,
 * and the Slips badge read 2 both BEFORE and AFTER the handoff, because the
 * handoff was invisible to it.
 *
 * That is the whole bug: not a bad box rule, but four surfaces each deciding
 * membership for themselves. This module makes that decision once.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE EFFECTIVE DELIVERY DATE — why the week selector was also lying
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The same failure had a second half. The dashboard read "Aug 23 - Aug 29"
 * while the slips it printed were dated 9/22/2026, and both were "correct"
 * under their own rule:
 *
 *   - every route filtered the week on `Order.delivery_date`;
 *   - every packing slip DISPLAYS `Campaign.delivery_date` first
 *     (lib/packingSlipContents.ts#resolveSlipDeliveryDate);
 *   - and NO fundraiser order-creation path ever writes `Order.delivery_date`,
 *     so fundraiser orders are systematically dateless.
 *
 * A dateless order therefore matched the `{ delivery_date: null }` escape
 * hatch, which is bounded only by a 30-day `created_at` floor and NOT by the
 * selected week — so it appeared in every week, and then printed the campaign
 * date it had never been filtered on.
 *
 * The fix is to filter on the SAME date the document prints. EFFECTIVE
 * DELIVERY DATE is `Campaign.delivery_date` when the order belongs to a
 * campaign that has one, otherwise `Order.delivery_date`. That precedence is
 * deliberately identical to resolveSlipDeliveryDate's, so the filter and the
 * printed date can never disagree again.
 *
 * ORDERS WITH NO EFFECTIVE DATE AT ALL (no campaign date and no order date)
 * belong to no specific week, so a week-filtered view excludes them rather
 * than showing them in all weeks. They remain visible under "All Weeks", and
 * `countUndatedActiveOrders` exists so a surface can say so out loud instead of
 * quietly dropping them — silently hiding work would just be the original bug
 * pointed the other way.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Not a stop builder and not a grouping rule. Every consumer still turns one
 * Order into one stop exactly as before, so ordinary customer delivery keeps
 * its per-order stop at its own address (contract §3.4 / Rule 6) and no
 * fundraiser campaign is collapsed. The "one campaign = one stop" grouping
 * repair is a separate phase, and the sibling discriminator module in this
 * directory was built for it — deliberately still unimported, with its
 * zero-importer tripwire left armed, because this phase changes no grouping.
 *
 * (That module's path is not spelled out here on purpose: its guard test
 * searches file CONTENTS for the import path, without stripping comments, so
 * even naming it in prose would trip a check that exists to prove nothing
 * imports it yet.)
 *
 * Not a box rule. Cartons remain lib/physicalBoxPacking.ts's answer alone.
 */

import { toDbOrderStatusReadCandidates } from '../orderStatus';

/** A selected Delivery week: [start, end). */
export interface DeliveryWeek {
    start: Date;
    end: Date;
}

/** How many days a delivery week spans. */
export const DELIVERY_WEEK_DAYS = 7;

/**
 * Parse the `delivery_week_start` query parameter into a week window.
 *
 * Returns null for absent OR unparseable input — an unreadable date must mean
 * "no week filter", never a silent window around the epoch.
 */
export function parseDeliveryWeek(raw: string | null | undefined): DeliveryWeek | null {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const start = new Date(String(raw));
    if (Number.isNaN(start.getTime())) return null;
    const end = new Date(start);
    end.setDate(end.getDate() + DELIVERY_WEEK_DAYS);
    return { start, end };
}

/**
 * The Prisma OR-branches matching orders whose EFFECTIVE delivery date falls in
 * the given week.
 *
 * Precedence is Campaign.delivery_date > Order.delivery_date, matching what a
 * packing slip prints. Exported so a test can assert every consumer uses the
 * identical shape rather than a lookalike.
 */
export function effectiveDeliveryDateInWeek(week: DeliveryWeek): any[] {
    const inWeek = { gte: week.start, lt: week.end };
    return [
        // The campaign owns the date whenever it has one.
        { campaign: { delivery_date: inWeek } },
        // Campaign present but undated: fall back to the order's own date.
        { campaign: { delivery_date: null }, delivery_date: inWeek },
        // No campaign at all (ordinary customer delivery): the order's date.
        { campaign_id: null, delivery_date: inWeek },
    ];
}

/**
 * The membership rule for ACTIVE Delivery, independent of any week.
 *
 *   released_to_delivery_at IS NOT NULL  — someone deliberately handed it over
 *   canceled_at IS NULL                  — not soft-canceled
 *   status NOT IN (delivered)            — a finished delivery is not active work
 *   business_id = session tenant         — never from the client
 *
 * Order STATUS is otherwise not consulted: crossing the handoff boundary IS the
 * membership test. An order sitting at `ready_to_ship` that nobody sent to
 * Delivery belongs to Production, not to Delivery.
 */
export function activeDeliveryBaseWhere(businessId: string): any {
    return {
        business_id: businessId,
        canceled_at: null,
        released_to_delivery_at: { not: null },
        NOT: { status: { in: toDbOrderStatusReadCandidates('delivered') as any } },
    };
}

/**
 * THE authority. Every active-Delivery surface — stop list, Print Queue,
 * Large/Small counts, Slips badge, packing slips, manifest, label batch —
 * builds its query from this and nothing else.
 *
 * A consumer may still SELECT different columns and transform the rows into its
 * own representation. It may not decide which orders belong.
 */
export function activeDeliveryOrderWhere(
    businessId: string,
    week: DeliveryWeek | null,
): any {
    const where = activeDeliveryBaseWhere(businessId);
    if (!week) return where;
    return { ...where, OR: effectiveDeliveryDateInWeek(week) };
}

/**
 * Active Delivery orders that carry NO effective delivery date at all, and so
 * appear under "All Weeks" but in no specific week.
 *
 * Exposed so a surface can report them rather than let them vanish. Hiding
 * released work would be the same class of defect as printing unreleased work.
 */
export function undatedActiveDeliveryWhere(businessId: string): any {
    return {
        ...activeDeliveryBaseWhere(businessId),
        delivery_date: null,
        OR: [
            { campaign_id: null },
            { campaign: { delivery_date: null } },
        ],
    };
}
