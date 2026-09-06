import { NextRequest, NextResponse } from "next/server";
import { prisma } from '@/lib/db';
import { computePackagingNeed } from '@/lib/deliveryPackaging';
import {
    activeDeliveryOrderWhere,
    parseDeliveryWeek,
    undatedActiveDeliveryWhere,
} from '@/lib/delivery/activeDeliveryPopulation';

/**
 * OPS-6B — Delivery packing/packaging figures, from the CANONICAL physical-box
 * authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 Rule 8 and §12
 * (this route was NAMED there as a known non-conforming reader; this phase
 * clears that entry).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG — the owner's "49 labels / 14 Large / 35 Small" vs "2 boxes"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Three INDEPENDENT defects multiplied. Any one alone broke agreement with the
 * canonical answer; together they produced 49 where the truth was 2.
 *
 * 1. WRONG UNIT. It counted PURCHASED BUNDLE INSTANCES, not cartons:
 *
 *        if (isFamily) largeBoxesNeeded += qty; else smallBoxesNeeded += qty;
 *
 *    with no pairing arithmetic anywhere. Four Serves-2 bundles on one order
 *    are TWO large cartons (lib/physicalBoxPacking.ts pairs them two to a
 *    box); this counted four.
 *
 * 2. WRONG TIER AUTHORITY. It classified size from the MUTABLE
 *    `Bundle.serving_tier` (schema default: the literal "family") plus a
 *    `bundle.name.includes('family')` substring, and never once read the
 *    FROZEN `OrderItem.variant_size`. Both halves misfire in opposite
 *    directions: an un-retiered bundle counted large regardless of what was
 *    sold, while "Fall Family Favorites (Serves 2)" — a genuine Serves-2
 *    clone — also counted large because of its NAME.
 *
 * 3. WRONG POPULATION, and the term that made 49 grow with tenant age. There
 *    was no `canceled_at: null`, and the week escape hatches were UNBOUNDED:
 *    `{ delivery_date: null }` carried no `created_at` bound, and no fundraiser
 *    order-creation path ever writes `delivery_date` — so that clause matched
 *    every fundraiser order the tenant had EVER created, pinned into every
 *    week, forever.
 *
 * The population below is now structurally identical to
 * app/api/delivery/packing-slips/route.ts — same statuses, same
 * `canceled_at: null`, same NaN guard, same 30-day bound on BOTH escape
 * hatches — so the Delivery dashboard and the page it links to cannot describe
 * different sets of orders.
 *
 * RESPONSE FIELDS WERE RENAMED ON PURPOSE. `largeBoxesNeeded`/
 * `smallBoxesNeeded` became `largeBoxCount`/`smallBoxCount` so that any
 * consumer still reading the old shape breaks visibly rather than silently
 * rendering `undefined` as a plausible-looking zero.
 *
 * READ-ONLY. This route reports need; it never decrements stock. Consumption
 * happens once, in app/api/delivery/handoff/route.ts, where it can be
 * idempotent.
 */

export async function GET(req: NextRequest) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { searchParams } = new URL(req.url);

        // OPS-6B.1: the SAME population as the stop list, the slips and the
        // manifest. This route previously selected by STATUS and never
        // consulted the handoff at all, which is why the Print Queue and the
        // Slips badge described orders that Delivery did not own — and read the
        // same number before and after Send to Delivery.
        const week = parseDeliveryWeek(searchParams.get('delivery_week_start'));
        const whereClause = activeDeliveryOrderWhere(session.user.businessId, week);

        // Narrow select: only what the packing arithmetic reads. No supporter
        // name, phone, email or address is fetched — a count needs none of it.
        const activeOrders = await prisma.order.findMany({
            where: whereClause,
            select: {
                id: true,
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
                        // The FROZEN sold tier. The whole point of this fix.
                        variant_size: true,
                        bundle: {
                            select: {
                                contents: {
                                    select: {
                                        quantity: true,
                                        recipe: { select: { container_type: true } },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { id: 'asc' },
                },
            },
            orderBy: { id: 'asc' },
        });

        // ONE authority. Cartons come from lib/physicalBoxPacking.ts; containers
        // are walked off the frozen tier. Nothing is re-derived here.
        const need = computePackagingNeed(activeOrders as any);

        // OPS-6B.1: released work that carries NO effective delivery date sits
        // in no specific week. It is reported rather than silently omitted —
        // hiding released orders would be the original defect pointed the other
        // way. Only meaningful while a week is actually selected.
        const undatedActiveCount = week
            ? await prisma.order.count({ where: undatedActiveDeliveryWhere(session.user.businessId) })
            : 0;

        return NextResponse.json({
            undatedActiveCount,
            largeBoxCount: need.largeBoxCount,
            smallBoxCount: need.smallBoxCount,
            physicalBoxCount: need.physicalBoxCount,
            purchasedBundleCount: need.purchasedBundleCount,
            // Never silently dropped: a line whose sold tier cannot be proven
            // is not packable, and an operator short a carton needs to know.
            unpackable: need.unpackable,
            packaging: {
                tape: need.tape,
                largeTrays: need.largeTrays,
                largeLids: need.largeLids,
                smallTrays: need.smallTrays,
                smallLids: need.smallLids,
                gallonBags: need.gallonBags,
                quartBags: need.quartBags,
            },
            totalActiveOrders: activeOrders.length,
        });

    } catch (e) {
        console.error('Delivery stats failed');
        return NextResponse.json({ error: "Failed to calculate stats" }, { status: 500 });
    }
}
