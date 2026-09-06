import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';
import { computePackagingNeed, packagingDrawdown } from '@/lib/deliveryPackaging';

/**
 * OPS-6B — the explicit Production → Delivery handoff. The ONLY writer of
 * `Order.released_to_delivery_at`.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §8 (fulfillment
 * lifecycle) and §11 Rule 8 (reuse the canonical authorities).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Before this route there was no boundary between "packed" and "gone". An
 * order reached the Packed & Ready lane by having status `ready_to_ship`, and
 * nothing could ever remove it — printing box labels and packing slips writes
 * nothing at all (both of those routes are read-only by construction), so the
 * lane grew forever and Delivery showed orders that had never left the kitchen.
 *
 * The owner asked for a deliberate act: SEND TO DELIVERY. This is it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A TIMESTAMP AND NOT A STATUS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A status write could not have worked, and this is provable rather than
 * preferential:
 *
 *   - `ready_to_ship` is ALREADY the Packed & Ready lane's membership key
 *     (app/api/production/dashboard/route.ts), and both PrepList and
 *     InProductionArea write it to ENTER that lane. Writing it again is a
 *     no-op — bulk-status classifies it 'same' and returns updated: 0.
 *   - `ready_to_ship`'s only legal successor in the canonical transition
 *     matrix is `delivered`, and Send to Delivery must NOT mark anything
 *     delivered — that is a later phase with a recipient in the loop.
 *
 * So the handoff is modeled the way lib/orderStatus.ts already models the
 * other lifecycle event that sits outside the status ladder: "Cancellation is
 * NOT modeled here — it is represented by canceled_at." This route writes the
 * matching pair, and never touches `status`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IDEMPOTENCY IS THE WHERE CLAUSE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `released_to_delivery_at: null` inside the conditional updateMany IS the
 * idempotency key. A second click, a double-submit, a stale tab or a retry
 * matches ZERO rows, so `count === 0`, so the packaging drawdown below never
 * runs for that order. No PrintJob table, no request id, no time window — the
 * durable claim on the row is the whole mechanism, exactly as the
 * `fundraiser_hold` release gate works (§5.1).
 *
 * That is also why the packaging decrement lives INSIDE this transaction and
 * is computed ONLY from the rows that actually transitioned. Consumption can
 * physically happen at most once per order because the row can only flip once.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING IS TRUSTED FROM THE CLIENT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The body carries `{ orderIds }` and nothing else. No businessId (the session
 * is the only tenant authority), and no quantities — every packaging figure is
 * derived server-side from the frozen `OrderItem.variant_size` of the orders
 * actually released, via lib/deliveryPackaging.ts. A browser can no longer POST
 * `{ largeBoxes: 9999 }` and drive stock to any value it likes.
 *
 * MIDDLEWARE DOES NOT PROTECT THIS: middleware does not cover `/api/`, so this
 * handler is self-defending (SEC-PUBLIC-ROUTE-1) and resolves the session
 * before touching Prisma.
 */

/** Hard cap so one request cannot sweep an entire season into Delivery. */
const MAX_ORDERS_PER_HANDOFF = 500;

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const actor = (session.user as any)?.id ?? null;

        let body: any;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body', code: 'INVALID_PAYLOAD' }, { status: 400 });
        }

        const { orderIds } = body ?? {};
        const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

        // The whole array is validated before anything else. A partially-valid
        // payload is rejected outright rather than silently filtered, so the
        // route can never report success for less than what was submitted.
        if (!Array.isArray(orderIds)) {
            return NextResponse.json({ error: 'Invalid handoff request', code: 'INVALID_PAYLOAD' }, { status: 400 });
        }
        if (orderIds.length === 0) {
            return NextResponse.json({ error: 'No orders selected', code: 'EMPTY_BATCH' }, { status: 400 });
        }
        if (!orderIds.every(isNonEmptyString)) {
            return NextResponse.json({ error: 'Invalid handoff request', code: 'INVALID_PAYLOAD' }, { status: 400 });
        }

        const uniqueIds = Array.from(new Set<string>(orderIds.map((id: string) => id.trim())));
        if (uniqueIds.length > MAX_ORDERS_PER_HANDOFF) {
            return NextResponse.json({ error: 'Too many orders in one handoff', code: 'BATCH_TOO_LARGE' }, { status: 400 });
        }

        // Eligibility is the Packed & Ready lane's own membership rule, read
        // from the canonical status authority rather than restated here.
        const packedAndReadyStatuses = [
            ...new Set([
                ...toDbOrderStatusReadCandidates('completed'),
                ...toDbOrderStatusReadCandidates('ready_to_ship'),
            ]),
        ];

        // TENANT SCOPE IS IN THE QUERY. An id belonging to another business
        // simply does not come back, so there is no row to filter out later and
        // no branch that could forget to.
        const rows = await prisma.order.findMany({
            where: { id: { in: uniqueIds }, business_id: businessId },
            select: {
                id: true,
                status: true,
                canceled_at: true,
                released_to_delivery_at: true,
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
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

        // Missing and foreign ids are reported identically, so this route can
        // never be used as an existence oracle for another tenant's ids.
        const foundIds = new Set(rows.map((r) => r.id));
        const notFound = uniqueIds.filter((id) => !foundIds.has(id));
        if (notFound.length > 0) {
            return NextResponse.json({
                error: 'One or more orders were not found',
                code: 'ORDER_NOT_FOUND',
                failures: notFound.map((id) => ({ id })),
            }, { status: 404 });
        }

        const canceled = rows.filter((r) => r.canceled_at !== null);
        if (canceled.length > 0) {
            return NextResponse.json({
                error: 'Canceled orders cannot be sent to Delivery',
                code: 'ORDER_CANCELED',
                failures: canceled.map((r) => ({ id: r.id })),
            }, { status: 400 });
        }

        // Server-side eligibility recheck AT MUTATION TIME. A stale tab showing
        // a button for an order that has since moved cannot release it.
        const ineligible = rows.filter((r) => !packedAndReadyStatuses.includes(r.status as any));
        if (ineligible.length > 0) {
            return NextResponse.json({
                error: 'Only orders that are Packed & Ready can be sent to Delivery',
                code: 'ORDER_NOT_PACKED',
                failures: ineligible.map((r) => ({ id: r.id, status: r.status })),
            }, { status: 400 });
        }

        const alreadyReleased = rows.filter((r) => r.released_to_delivery_at !== null);
        const candidates = rows.filter((r) => r.released_to_delivery_at === null);

        const releasedAt = new Date();
        const shortages: { name: string; needed: number; available: number }[] = [];

        const released = await prisma.$transaction(async (tx) => {
            const won: typeof rows = [];

            for (const row of candidates) {
                // COMPARE-AND-SET. `released_to_delivery_at: null` is the
                // idempotency key; `status` pins the exact raw value read in
                // preflight so a concurrent change loses harmlessly instead of
                // releasing an order that has moved underneath us.
                const res = await tx.order.updateMany({
                    where: {
                        id: row.id,
                        business_id: businessId,
                        released_to_delivery_at: null,
                        canceled_at: null,
                        status: row.status as any,
                    },
                    data: {
                        released_to_delivery_at: releasedAt,
                        released_to_delivery_by: actor,
                    },
                });
                // count === 0 means someone else won the race, or it was
                // already released. Either way this request consumes nothing
                // for that order. Never an error — a no-op is the correct
                // outcome of clicking twice.
                if (res.count === 1) won.push(row);
            }

            if (won.length === 0) return won;

            // Packaging is consumed ONCE, for the rows that actually flipped,
            // and every quantity is computed here from frozen sale-time truth.
            const need = computePackagingNeed(won as any);

            for (const [partialName, qty] of packagingDrawdown(need)) {
                if (qty <= 0) continue;

                const item = await tx.packagingItem.findFirst({
                    where: { business_id: businessId, name: { contains: partialName, mode: 'insensitive' } },
                    orderBy: { name: 'asc' },
                });
                // A tenant whose rows are named differently matches nothing.
                // Recorded as a shortage rather than silently ignored.
                if (!item) {
                    shortages.push({ name: partialName, needed: qty, available: 0 });
                    continue;
                }

                // Guarded atomic decrement. If stock is insufficient (or another
                // writer drew it down between the read and the write) the row is
                // clamped to zero rather than driven negative — Part L: never
                // invent inventory, never corrupt the count, surface it instead.
                const dec = await tx.packagingItem.updateMany({
                    where: { id: item.id, business_id: businessId, quantity: { gte: qty } },
                    data: { quantity: { decrement: qty } },
                });
                if (dec.count === 0) {
                    shortages.push({ name: item.name, needed: qty, available: item.quantity });
                    await tx.packagingItem.updateMany({
                        where: { id: item.id, business_id: businessId },
                        data: { quantity: 0 },
                    });
                }
            }

            return won;
        });

        // A shortage is reported, never a refusal: bookkeeping that has drifted
        // must not strand physically-packed boxes in Production.
        return NextResponse.json({
            released: released.length,
            unchanged: alreadyReleased.length + (candidates.length - released.length),
            releasedOrderIds: released.map((r) => r.id),
            unchangedOrderIds: [
                ...alreadyReleased.map((r) => r.id),
                ...candidates.filter((c) => !released.some((r) => r.id === c.id)).map((c) => c.id),
            ],
            shortages,
        });
    } catch (e) {
        // Deliberately no error detail and no request echo: this handler's
        // inputs are order ids and its outputs touch tenant inventory.
        console.error('Delivery handoff failed');
        return NextResponse.json({ error: 'Failed to send orders to Delivery' }, { status: 500 });
    }
}
