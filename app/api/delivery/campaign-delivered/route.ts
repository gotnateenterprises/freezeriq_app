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
 * ALL OR NOTHING. Every order must be able to move to `delivered` under the
 * shared transition matrix (lib/orderStatus.ts), or none is touched. The write is
 * one transaction of compare-and-set updates pinned to each row's exact status;
 * if any row changed underneath us the transaction is rolled back in full, so a
 * fundraiser is never left half delivered. A second click — or a double-click
 * that loses the race — finds the orders already delivered and reports that.
 *
 * Self-defending: middleware does not cover /api/ (SEC-PUBLIC-ROUTE-1).
 */

const MAX_ORDERS_PER_STOP = 500;

// A marker object, not an Error subclass: with the ES5 compile target `instanceof`
// on an Error subclass is false, which would turn a safe rollback into a 500.
const STOP_CHANGED_DURING_WRITE = { stopChangedDuringWrite: true } as const;
const isStopChangedDuringWrite = (e: unknown) => (e as any)?.stopChangedDuringWrite === true;

type Refusal = { id: string; reason: 'not_found' | 'not_in_this_fundraiser' | 'canceled' | 'not_in_delivery' };

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

        // The authoritative set: this campaign's fundraiser orders in active Delivery.
        const eligible = await prisma.order.findMany({
            where: { ...activeDeliveryBaseWhere(businessId), campaign_id: campaign, source: FUNDRAISER_ORDER_SOURCE as any },
            select: { id: true, status: true },
            orderBy: { id: 'asc' },
        });

        // What the driver was shown, tenant-scoped. A foreign id simply does not come back.
        const shownRows = await prisma.order.findMany({
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
            return NextResponse.json({ error: 'Fundraiser stop not found', code: 'STOP_NOT_FOUND' }, { status: 404 });
        }

        const notShown = eligible.filter((r) => !shown.includes(r.id)).map((r) => r.id);
        if (refused.length > 0 || notShown.length > 0) {
            return NextResponse.json({
                error: 'This fundraiser stop changed since it was loaded. Refresh and try again.',
                code: 'STOP_CHANGED',
                refused,
                notShownOrderIds: notShown,
            }, { status: 409 });
        }

        // Every order must legally become `delivered` — or none does.
        const undeliverable = eligible.filter((r) => validateOrderStatusTransition(r.status, 'delivered').status !== 'allowed');
        if (undeliverable.length > 0) {
            return NextResponse.json({
                error: 'Some orders on this stop cannot be marked delivered from their current status.',
                code: 'ORDER_NOT_DELIVERABLE',
                failures: undeliverable.map((r) => ({ id: r.id, status: normalizeOrderStatus(r.status) })),
            }, { status: 409 });
        }

        if (eligible.length === 0) {
            return NextResponse.json({ campaignId: campaign, updated: 0, alreadyDelivered: alreadyDelivered.length, refused: [], updatedOrderIds: [] });
        }

        const deliveredValue = toDbSafeOrderStatus('delivered') as any;
        // Group by the exact stored status so each update pins what we validated.
        const byStatus = new Map<string, string[]>();
        for (const r of eligible) byStatus.set(String(r.status), [...(byStatus.get(String(r.status)) ?? []), r.id]);

        try {
            await prisma.$transaction(async (tx) => {
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
                // Any row that moved underneath us: undo everything, deliver nothing.
                if (written !== eligible.length) throw STOP_CHANGED_DURING_WRITE;
            });
        } catch (e) {
            if (!isStopChangedDuringWrite(e)) throw e;
            // Lost a race. If the winner delivered exactly these orders (a double-click),
            // that is the outcome the driver wanted: report it, write nothing more.
            const now = await prisma.order.findMany({ where: { id: { in: shown }, business_id: businessId }, select: { id: true, status: true } });
            if (now.length === shown.length && now.every((r) => normalizeOrderStatus(r.status) === 'delivered')) {
                return NextResponse.json({ campaignId: campaign, updated: 0, alreadyDelivered: shown.length, refused: [], updatedOrderIds: [], concurrent: true });
            }
            return NextResponse.json({
                error: 'Orders on this stop changed while saving. Nothing was marked delivered — refresh and try again.',
                code: 'STATUS_CHANGED_CONCURRENTLY',
            }, { status: 409 });
        }

        return NextResponse.json({
            campaignId: campaign,
            updated: eligible.length,
            alreadyDelivered: alreadyDelivered.length,
            refused: [],
            updatedOrderIds: eligible.map((r) => r.id),
        });
    } catch {
        // No detail and no echo: inputs are order ids, outputs change order state.
        console.error('Fundraiser delivery failed');
        return NextResponse.json({ error: 'Failed to mark the fundraiser delivered' }, { status: 500 });
    }
}
