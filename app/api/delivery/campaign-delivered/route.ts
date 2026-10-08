import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { activeDeliveryBaseWhere } from '@/lib/delivery/activeDeliveryPopulation';
import { FUNDRAISER_ORDER_SOURCE } from '@/lib/delivery/orderClassification';
import { normalizeOrderStatus, toDbSafeOrderStatus, validateOrderStatusTransition } from '@/lib/orderStatus';

/**
 * DELIVERY-FUNDRAISER-GROUPING-1 — Mark Delivered for a whole fundraiser stop.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §3 and §8.
 *
 * WHAT IT MEANS. "Freezer Chef delivered this fundraiser to the organization."
 * It does NOT mean every supporter picked up their order — that is the
 * coordinator's Pickup Tracker, and nothing here touches it. The only column
 * written is Order.status, to `delivered`, exactly what Mark Delivered on an
 * ordinary stop writes through PATCH /api/orders (which has no side effects for
 * this transition). No payment mark, no invoice, no release field, no sequence.
 *
 * WHICH ORDERS. The server decides, never the client: the campaign's orders in
 * ACTIVE Delivery (lib/delivery/activeDeliveryPopulation.ts — released, not
 * canceled, not yet delivered), tenant-scoped, and fundraiser orders only
 * (source + campaign_id, the classification conjunction — the same set the board
 * groups onto the stop). The client sends the order ids it was SHOWING, and they
 * are used for one thing: to refuse, writing nothing, when the stop has changed
 * since the driver looked at it — an order added, canceled, moved or already
 * finished elsewhere. So the click delivers exactly what was on the screen.
 *
 * ALL OR NOTHING, AND NOTHING CAN JOIN MID-FLIGHT (DELIVERY-FUNDRAISER-GROUPING-1A).
 * Everything happens in ONE transaction, in this order:
 *
 *   1. lock every order row of this tenant's campaign (SELECT … FOR UPDATE, in id
 *      order — the same order the handoff writes in, so the two cannot deadlock);
 *   2. read the authoritative active-Delivery set;
 *   3. compare it with what was shown, and check every transition;
 *   4. write `delivered`, pinned to each row's exact status.
 *
 * The lock is what makes the read in (2) the population AT COMMIT. An order
 * enters a campaign's Delivery set only one way — the Production → Delivery
 * handoff UPDATEs that order's own row (it is the sole writer of
 * released_to_delivery_at) — and that UPDATE needs the row lock we hold. So a
 * release that committed before we locked is visible in (2) and refuses the stop
 * (409, nothing written); a release attempted after we locked waits until we
 * commit and then lands as a new stop of its own. There is no interleaving in
 * which part of the campaign is committed delivered while another of its orders
 * was already in Delivery. The handoff is unchanged: it simply waits, as any
 * writer of a locked row does.
 *
 * Why not SERIALIZABLE: Postgres only detects serialization conflicts between
 * transactions that are BOTH serializable, and the handoff runs at the default
 * READ COMMITTED. A serializable read here would not notice its release.
 *
 * A second click waits for the first's locks, then finds the orders already
 * delivered and reports that. A deadlock or lock timeout with some other writer
 * rolls back and returns a refresh response — never a partial delivery.
 *
 * Self-defending: middleware does not cover /api/ (SEC-PUBLIC-ROUTE-1).
 */

const MAX_ORDERS_PER_STOP = 500;

// A marker object, not an Error subclass: with the ES5 compile target `instanceof`
// on an Error subclass is false, which would turn a safe rollback into a 500.
const STOP_CHANGED_DURING_WRITE = { stopChangedDuringWrite: true } as const;
const isStopChangedDuringWrite = (e: unknown) => (e as any)?.stopChangedDuringWrite === true;

/** Postgres/Prisma said "another transaction got in the way" — safe to retry, nothing committed. */
function isConcurrencyConflict(e: unknown): boolean {
    const err = e as any;
    if (err?.code === 'P2034' || err?.code === 'P2028') return true; // write conflict / deadlock; transaction timeout
    const pgCode = String(err?.meta?.code ?? err?.meta?.database_error ?? err?.message ?? '');
    return /40P01|40001|55P03|deadlock detected|could not serialize/i.test(pgCode);
}

type Refusal = { id: string; reason: 'not_found' | 'not_in_this_fundraiser' | 'canceled' | 'not_in_delivery' };
type Outcome = { status: number; body: Record<string, unknown> };

/** Step 1: every order of this tenant's campaign, locked until commit, in id order. */
async function lockCampaignOrders(tx: any, businessId: string, campaignId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM orders WHERE business_id = ${businessId} AND campaign_id = ${campaignId} ORDER BY id FOR UPDATE`;
}

/** Step 2: the authoritative set — this campaign's fundraiser orders in active Delivery. */
function readEligible(db: any, businessId: string, campaignId: string): Promise<{ id: string; status: string }[]> {
    return db.order.findMany({
        where: { ...activeDeliveryBaseWhere(businessId), campaign_id: campaignId, source: FUNDRAISER_ORDER_SOURCE as any },
        select: { id: true, status: true },
        orderBy: { id: 'asc' },
    });
}

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        let body: any;
        try {
            body = await req.json();
        } catch {
            return NextResponse.json({ error: 'Invalid request body', code: 'INVALID_PAYLOAD' }, { status: 400 });
        }

        const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
        const { campaignId, orderIds } = body ?? {};
        if (!isNonEmptyString(campaignId) || !Array.isArray(orderIds) || orderIds.length === 0 || !orderIds.every(isNonEmptyString)) {
            return NextResponse.json({ error: 'Invalid delivery request', code: 'INVALID_PAYLOAD' }, { status: 400 });
        }
        const campaign = campaignId.trim();
        const shown = Array.from(new Set<string>(orderIds.map((id: string) => id.trim())));
        if (shown.length > MAX_ORDERS_PER_STOP) {
            return NextResponse.json({ error: 'Too many orders in one stop', code: 'BATCH_TOO_LARGE' }, { status: 400 });
        }

        let outcome: Outcome;
        try {
            outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
                await lockCampaignOrders(tx, businessId, campaign);
                const eligible = await readEligible(tx, businessId, campaign);

                // What the driver was shown, tenant-scoped. A foreign id simply does not come back.
                const shownRows = await tx.order.findMany({
                    where: { id: { in: shown }, business_id: businessId },
                    select: { id: true, status: true, campaign_id: true, source: true, canceled_at: true, released_to_delivery_at: true },
                });
                const shownById = new Map(shownRows.map((r) => [r.id, r]));

                const eligibleIds = new Set(eligible.map((r) => r.id));
                const refused: Refusal[] = [];
                const alreadyDelivered: string[] = [];
                for (const id of shown) {
                    const row = shownById.get(id);
                    if (!row) { refused.push({ id, reason: 'not_found' }); continue; }
                    if (row.campaign_id !== campaign || String(row.source) !== FUNDRAISER_ORDER_SOURCE) {
                        refused.push({ id, reason: 'not_in_this_fundraiser' });
                        continue;
                    }
                    if (row.canceled_at !== null) { refused.push({ id, reason: 'canceled' }); continue; }
                    if (normalizeOrderStatus(row.status) === 'delivered') { alreadyDelivered.push(id); continue; }
                    if (!eligibleIds.has(id)) refused.push({ id, reason: 'not_in_delivery' });
                }

                // Nothing of this campaign is in, or was ever shown from, this tenant's Delivery.
                if (eligible.length === 0 && alreadyDelivered.length === 0) {
                    return { status: 404, body: { error: 'Fundraiser stop not found', code: 'STOP_NOT_FOUND' } };
                }

                const notShown = eligible.filter((r) => !shown.includes(r.id)).map((r) => r.id);
                if (refused.length > 0 || notShown.length > 0) {
                    return {
                        status: 409,
                        body: {
                            error: 'This fundraiser stop changed since it was loaded. Refresh and try again.',
                            code: 'STOP_CHANGED',
                            refused,
                            notShownOrderIds: notShown,
                        },
                    };
                }

                // Every order must legally become `delivered` — or none does.
                const undeliverable = eligible.filter((r) => validateOrderStatusTransition(r.status, 'delivered').status !== 'allowed');
                if (undeliverable.length > 0) {
                    return {
                        status: 409,
                        body: {
                            error: 'Some orders on this stop cannot be marked delivered from their current status.',
                            code: 'ORDER_NOT_DELIVERABLE',
                            failures: undeliverable.map((r) => ({ id: r.id, status: normalizeOrderStatus(r.status) })),
                        },
                    };
                }

                // A repeat click: everything shown is already delivered. Nothing to write.
                if (eligible.length === 0) {
                    return { status: 200, body: { campaignId: campaign, updated: 0, alreadyDelivered: alreadyDelivered.length, refused: [], updatedOrderIds: [] } };
                }

                const deliveredValue = toDbSafeOrderStatus('delivered') as any;
                // Group by the exact stored status so each update pins what we validated.
                const byStatus = new Map<string, string[]>();
                for (const r of eligible) byStatus.set(String(r.status), [...(byStatus.get(String(r.status)) ?? []), r.id]);

                let written = 0;
                for (const [status, ids] of byStatus) {
                    const res = await tx.order.updateMany({
                        where: {
                            id: { in: ids },
                            business_id: businessId,
                            campaign_id: campaign,
                            source: FUNDRAISER_ORDER_SOURCE as any,
                            canceled_at: null,
                            released_to_delivery_at: { not: null },
                            status: status as any,
                        },
                        data: { status: deliveredValue },
                    });
                    written += res.count;
                }
                // Defence in depth — the locks make this unreachable. Undo everything, deliver nothing.
                if (written !== eligible.length) throw STOP_CHANGED_DURING_WRITE;

                return {
                    status: 200,
                    body: {
                        campaignId: campaign,
                        updated: eligible.length,
                        alreadyDelivered: alreadyDelivered.length,
                        refused: [],
                        updatedOrderIds: eligible.map((r) => r.id),
                    },
                };
            }, { maxWait: 5000, timeout: 15000 });
        } catch (e) {
            if (!isStopChangedDuringWrite(e) && !isConcurrencyConflict(e)) throw e;
            return NextResponse.json({
                error: 'Orders on this stop changed while saving. Nothing was marked delivered — refresh and try again.',
                code: 'STATUS_CHANGED_CONCURRENTLY',
            }, { status: 409 });
        }

        return NextResponse.json(outcome.body, { status: outcome.status });
    } catch {
        // No detail and no echo: inputs are order ids, outputs change order state.
        console.error('Fundraiser delivery failed');
        return NextResponse.json({ error: 'Failed to mark the fundraiser delivered' }, { status: 500 });
    }
}
