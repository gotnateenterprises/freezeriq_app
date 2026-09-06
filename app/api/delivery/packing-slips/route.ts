import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { type BoxManifestOrder } from '@/lib/supporterBoxManifest';
import { buildPhysicalBoxManifest } from '@/lib/physicalBoxPacking';
import {
    buildMealsByOrderItemId,
    orderBoxesByDeliverySequence,
    resolveSlipDeliveryDate,
} from '@/lib/packingSlipContents';
import { activeDeliveryOrderWhere, parseDeliveryWeek } from '@/lib/delivery/activeDeliveryPopulation';

/**
 * PACKING-SLIP-1 — the tenant-authorized packing-slip data authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (reuse the
 * canonical authorities) and §11. This route adds no packing rule of its
 * own — it is a thin, tenant-scoped fetch feeding the SAME
 * `buildPhysicalBoxManifest` that /api/production/box-labels uses, so a
 * physical box can never be counted or grouped differently on a packing slip
 * than on the outer-box sticker for the same order.
 *
 * WHY GET, NOT POST, AND WHY NO CLIENT-SUPPLIED ORDER LIST
 *
 * /api/production/box-labels is a POST because its caller hand-picks a batch
 * of Order ids from the Production screen and queues them. The packing-slip
 * page has never worked that way — before and after this phase it is a
 * self-loading "this week's (or this status set's) orders" view, the same
 * shape as the /api/orders call it used to make. Preserving that shape (GET,
 * with an optional `delivery_week_start` filter) means this is an adaptation
 * of the existing data flow, not a redesign of it.
 *
 * The status set itself is NOT a query parameter. The page has only ever
 * requested one fixed list — every non-terminal, non-canceled status a
 * fulfillable order can be in — so making it client-configurable would add
 * an attack surface (an arbitrary status filter) this route has no caller
 * that needs.
 *
 * MIDDLEWARE DOES NOT PROTECT THIS
 *
 * The project's middleware does not cover `/api/`, so this handler is
 * self-defending (SEC-PUBLIC-ROUTE-1): the session is resolved first, and
 * every WHERE clause below carries `business_id` from that session — never
 * from the request. There is no code path that returns another tenant's
 * order.
 *
 * MINIMAL RESPONSE
 *
 * The select list omits `phone`, `delivery_address`, `participant_name` and
 * the Customer relation, the same omission box-labels makes and for the same
 * reason: a packing slip does not need them, so they are never fetched. The
 * ONE thing a packing slip prints that a box label does not is the meal list
 * inside each bundle — `bundle.contents.recipe.name` — which is LIVE,
 * mutable data; see lib/packingSlipContents.ts for why that is a deliberate,
 * documented, pre-launch-known limitation and not an oversight.
 *
 * READ-ONLY
 *
 * No writes. This route cannot advance an order's lifecycle.
 */

export async function GET(request: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;
        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);

        // OPS-6B.1 — THE ACTIVE DELIVERY POPULATION, and nothing else.
        //
        // This route used to select by STATUS (every fulfillable status) with a
        // 30-day dateless escape hatch, and never consulted the handoff. In
        // Production that printed a packing slip for a supporter who had never
        // been sent to Delivery, while the stop list beside it correctly showed
        // one stop — and the Slips badge read the same number before and after
        // the handoff, because the handoff was invisible to this query.
        //
        // One physical box is one packing slip, so the set of slips must be the
        // set of boxes Delivery actually owns. Membership now comes from the one
        // authority; see lib/delivery/activeDeliveryPopulation.ts.
        //
        // WORKFLOW CONSEQUENCE, deliberate: packing slips are printed AFTER
        // Send to Delivery, not while packing. Box labels remain the
        // Production-side print (app/api/production/box-labels/route.ts) and are
        // unaffected.
        const week = parseDeliveryWeek(searchParams.get('delivery_week_start'));
        const whereClause = activeDeliveryOrderWhere(businessId, week);

        const orders = await prisma.order.findMany({
            where: whereClause,
            select: {
                id: true,
                first_name: true,
                last_name: true,
                customer_name: true,
                delivery_date: true,
                delivery_sequence: true,
                campaign: { select: { delivery_date: true } },
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
                        variant_size: true,
                        item_name: true,
                        bundle: {
                            select: {
                                id: true,
                                name: true,
                                contents: {
                                    select: {
                                        quantity: true,
                                        recipe: { select: { name: true } },
                                    },
                                },
                            },
                        },
                    },
                    // Same deterministic key lib/supporterBoxManifest.ts sorts
                    // by, so client and server can never disagree on sequence.
                    orderBy: { id: 'asc' },
                },
            },
            orderBy: { id: 'asc' },
        });

        // The canonical physical-box authority. Identical call to box-labels
        // — this route derives no packing rule of its own.
        const manifest = buildPhysicalBoxManifest(orders as unknown as BoxManifestOrder[]);

        const deliverySequenceByOrderId: Record<string, number | null> = {};
        const deliveryDateByOrderId: Record<string, string | null> = {};
        for (const order of orders) {
            deliverySequenceByOrderId[order.id] = order.delivery_sequence;
            const resolved = resolveSlipDeliveryDate(order as any);
            deliveryDateByOrderId[order.id] = resolved ? new Date(resolved).toISOString() : null;
        }

        // Print order follows the delivery run, not order-id — see
        // lib/packingSlipContents.ts. This reorders the already-finished box
        // list only; it does not touch a single box's contents or numbering.
        const boxes = orderBoxesByDeliverySequence(manifest.boxes, deliverySequenceByOrderId);

        // The one thing a packing slip needs that a box label does not: the
        // live meal list inside each bundle. Keyed by OrderItem id so the
        // page can look a box's contents up without re-fetching orders.
        const mealsByOrderItemId = buildMealsByOrderItemId(orders as any);

        return NextResponse.json({
            boxes,
            blocked: manifest.blocked,
            purchasedBundleCount: manifest.purchasedBundleCount,
            physicalBoxCount: manifest.physicalBoxCount,
            largeBoxCount: manifest.largeBoxCount,
            smallBoxCount: manifest.smallBoxCount,
            deliveryDateByOrderId,
            mealsByOrderItemId,
        });
    } catch (e) {
        // Deliberately no error detail and no request echo in the log: this
        // handler's inputs are session-derived and its outputs are supporter
        // names and meal contents.
        console.error('Packing slip manifest failed');
        return NextResponse.json({ error: 'Failed to build packing slips' }, { status: 500 });
    }
}
