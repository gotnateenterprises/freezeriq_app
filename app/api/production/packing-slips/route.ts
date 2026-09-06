import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';
import {
    PACKING_SLIP_ORDER_SELECT,
    buildPackingSlipPayload,
} from '@/lib/packingSlipContents';

/**
 * OPS-6B.2 — PRIMARY (pre-handoff) packing slips, for Packed & Ready.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7, §8, §11 Rule 8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A packing slip is the customer-facing paper that goes INSIDE the box. It is
 * therefore printed while the order is still in Production's hands:
 *
 *     Packed & Ready -> print box labels -> print packing slips
 *                    -> put the slip in the box -> Send to Delivery
 *
 * OPS-6B.1 correctly repaired the ACTIVE DELIVERY population (an unreleased
 * order must not appear on the Delivery board, its Slips badge, or its
 * documents) — but it implemented that by moving ALL slip printing behind the
 * handoff, which inverted the physical workflow. This route restores the
 * primary path without reopening that defect.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO WORKFLOW POPULATIONS, ONE PHYSICAL-BOX AUTHORITY
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   THIS ROUTE (primary)          explicitly chosen Packed & Ready orders that
 *                                 have NOT yet been released.
 *   /api/delivery/packing-slips   the shared ACTIVE DELIVERY population
 *   (reprint)                     (lib/delivery/activeDeliveryPopulation.ts),
 *                                 for recovering a slip after release.
 *
 * The two differ ONLY in which orders are eligible. Everything a slip actually
 * SAYS — cartons and Box N/M, supporter identity, sold tier, meal contents,
 * printed date, print order — comes from the shared
 * PACKING_SLIP_ORDER_SELECT + buildPackingSlipPayload in
 * lib/packingSlipContents.ts, so the reprint is the same document the packer
 * put in the box. Do not fork that assembly to "customise" either context.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ELIGIBILITY IS SERVER TRUTH, NOT THE CLIENT'S CLAIM
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The body carries opaque Order IDs and nothing else. They are identifiers,
 * never authority: the tenant comes from the session, and every id is
 * re-checked here against genuine Packed & Ready membership. An order that has
 * already been released is refused BY THIS ROUTE — its slip is a reprint and
 * belongs to the Delivery side — which is what keeps the two populations from
 * quietly merging back into one.
 *
 * READ-ONLY. Printing is not a lifecycle transition (§8): this route contains
 * no write of any kind, so printing cannot release an order, mark it
 * delivered, change its status, or consume packaging. That is structural
 * rather than a matter of discipline, and a test proves the file contains no
 * mutation call.
 */

/** Hard cap so one request cannot sweep a whole season into a print job. */
const MAX_ORDERS_PER_BATCH = 500;

export async function POST(request: Request) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;
        if (!businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        let body: any;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        const rawIds = Array.isArray(body?.orderIds) ? body.orderIds : null;
        if (!rawIds || rawIds.length === 0) {
            return NextResponse.json({ error: 'No orders were requested.' }, { status: 400 });
        }

        const cleanedIds: string[] = rawIds
            .filter((id: unknown): id is string => typeof id === 'string' && id.trim() !== '')
            .map((id: string) => id.trim());
        const orderIds: string[] = Array.from(new Set<string>(cleanedIds)).slice(0, MAX_ORDERS_PER_BATCH);

        if (orderIds.length === 0) {
            return NextResponse.json({ error: 'No usable order ids were requested.' }, { status: 400 });
        }

        // The Packed & Ready lane's own membership rule, read from the canonical
        // status authority rather than restated here. Identical to the set
        // app/api/production/dashboard/route.ts builds for that lane.
        const packedAndReadyStatuses = [
            ...new Set([
                ...toDbOrderStatusReadCandidates('completed'),
                ...toDbOrderStatusReadCandidates('ready_to_ship'),
            ]),
        ];

        // TENANT SCOPE AND ELIGIBILITY ARE BOTH IN THE QUERY. An id belonging to
        // another tenant, a canceled order, a delivered one, or one already sent
        // to Delivery simply is not a row here — there is nothing to filter out
        // afterwards and no branch that could forget to.
        //
        // PART H: no delivery-week predicate. The operator explicitly selected
        // these orders in Production; whatever week the Delivery dashboard
        // happens to be showing is unrelated client state and must not hide a
        // box the packer is holding.
        const orders = await prisma.order.findMany({
            where: {
                id: { in: orderIds },
                business_id: businessId,
                canceled_at: null,
                released_to_delivery_at: null,
                status: { in: packedAndReadyStatuses as any },
            },
            select: PACKING_SLIP_ORDER_SELECT,
            orderBy: { id: 'asc' },
        });

        // An id that did not come back is another tenant's, canceled, delivered,
        // not yet packed, or already released. Reported as a single count
        // WITHOUT saying which — distinguishing those would make this an
        // existence oracle for other tenants' ids.
        const foundIds = new Set(orders.map((o) => o.id));
        const unavailableCount = orderIds.filter((id) => !foundIds.has(id)).length;

        return NextResponse.json({
            ...buildPackingSlipPayload(orders),
            requestedCount: orderIds.length,
            unavailableCount,
        });
    } catch (e) {
        // Deliberately no error detail and no request echo: this handler's
        // inputs are order ids and its outputs are supporter names.
        console.error('Pre-handoff packing slip build failed');
        return NextResponse.json({ error: 'Failed to build packing slips' }, { status: 500 });
    }
}
