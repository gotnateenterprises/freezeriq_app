import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbSafeOrderStatus, normalizeOrderStatus, validateOrderStatusTransition } from '@/lib/orderStatus';

/**
 * KB-1B: statuses a kitchen batch route may TARGET.
 *
 * This is a route capability restriction, NOT a transition matrix. Every
 * from -> to legality decision is delegated to validateOrderStatusTransition,
 * which owns the single canonical matrix in lib/orderStatus.ts.
 *
 * These are EXACT raw request values, matched before normalization — aliases such
 * as 'READY_TO_SHIP', 'COMPLETED', or 'APPROVED' never qualify.
 */
const BATCHABLE_TARGETS = new Set(['in_production', 'ready_to_ship']);

/** Thrown inside the transaction so any mismatch rolls back the whole batch. */
class ConcurrentChangeError extends Error {
    ids: string[];
    constructor(ids: string[]) {
        super('STATUS_CHANGED_CONCURRENTLY');
        this.ids = ids;
    }
}

export async function POST(req: Request) {
    try {
        // 1. Authenticate — a tenant context is required for every read and write.
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { bundleId, currentStatus, newStatus } = await req.json();

        // 2. Body validation. currentStatus is REQUIRED — it is never silently
        //    defaulted, because defaulting it would advance orders belonging to a
        //    card the operator did not click.
        const isNonEmptyString = (v: unknown): v is string =>
            typeof v === 'string' && v.trim().length > 0;

        if (!isNonEmptyString(bundleId) || !isNonEmptyString(currentStatus) || !isNonEmptyString(newStatus)) {
            return NextResponse.json({
                error: 'Invalid batch request',
                code: 'INVALID_PAYLOAD',
            }, { status: 400 });
        }

        // 3. Validate the requested target status.
        const requestedTarget = newStatus.trim();
        const canonicalTarget = normalizeOrderStatus(requestedTarget);
        const dbSafeNewStatus = toDbSafeOrderStatus(requestedTarget);
        if (canonicalTarget === null || dbSafeNewStatus === null) {
            return NextResponse.json({
                error: 'Invalid order status',
                code: 'INVALID_STATUS',
            }, { status: 400 });
        }

        // Capability is checked against the EXACT trimmed raw value, never the
        // normalized one, so a recognized alias (e.g. 'READY_TO_SHIP', 'COMPLETED',
        // 'APPROVED') can never satisfy it. Only the two exact canonical kitchen
        // target strings are accepted, which also guarantees the write value below
        // is canonical rather than a legacy form.
        if (!BATCHABLE_TARGETS.has(requestedTarget)) {
            return NextResponse.json({
                error: 'This status cannot be applied through a kitchen batch operation',
                code: 'TRANSITION_NOT_BATCHABLE',
                to: canonicalTarget,
            }, { status: 400 });
        }

        // 4. Select by the EXACT raw currentStatus supplied by the displayed prep
        //    card. Deliberately NOT expanded to canonical/legacy alias candidates:
        //    the dashboard can render separate cards for 'production_ready' and
        //    'APPROVED', and clicking one card must never advance orders belonging
        //    to the other. canceled_at is not filtered here so canceled rows are
        //    reported explicitly.
        const rows = await prisma.order.findMany({
            where: {
                business_id: businessId,
                status: currentStatus as any,
                items: { some: { bundle_id: bundleId } },
            },
            select: { id: true, status: true, canceled_at: true },
        });

        // 5. No matches — preserve the existing count-compatible response.
        if (rows.length === 0) {
            return NextResponse.json({
                count: 0,
                updated: 0,
                unchanged: 0,
                orderIds: [],
                message: 'No matching orders found',
            });
        }

        // 6. Canceled orders reject the whole batch.
        const canceled = rows.filter(r => r.canceled_at !== null);
        if (canceled.length > 0) {
            return NextResponse.json({
                error: 'Canceled orders cannot be updated',
                code: 'ORDER_CANCELED',
                failures: canceled.map(r => ({ id: r.id })),
            }, { status: 400 });
        }

        // 7. Canonical transition preflight for every matched row.
        const toWrite: { id: string; status: string }[] = [];
        const unchanged: { id: string; status: string }[] = [];
        const illegal: { id: string; from: string | null; to: string | null }[] = [];

        for (const row of rows) {
            const result = validateOrderStatusTransition(row.status, canonicalTarget);
            if (result.status === 'allowed') {
                toWrite.push({ id: row.id, status: row.status });
            } else if (result.status === 'same') {
                unchanged.push({ id: row.id, status: row.status });
            } else {
                illegal.push({ id: row.id, from: result.from, to: result.to });
            }
        }

        // 8. Any illegal transition rejects the entire batch — nothing is written.
        if (illegal.length > 0) {
            return NextResponse.json({
                error: 'One or more order transitions are not allowed',
                code: 'ILLEGAL_STATUS_TRANSITION',
                failures: illegal,
            }, { status: 400 });
        }

        // 9. All-or-nothing write conditioned on the EXACT raw prior status, so a
        //    concurrent change misses and rolls the whole transaction back.
        //    KB-1B: the former `completed -> Customer.status = DELIVERY` side effect
        //    was removed. `completed` is no longer a batchable target, so the branch
        //    was unreachable; kitchen batch writes are now side-effect-free.
        await prisma.$transaction(async (tx) => {
            for (const row of toWrite) {
                const res = await tx.order.updateMany({
                    where: {
                        id: row.id,
                        business_id: businessId,
                        status: row.status as any,
                        canceled_at: null,
                    },
                    data: { status: dbSafeNewStatus as any },
                });
                if (res.count !== 1) throw new ConcurrentChangeError([row.id]);
            }

            // Same-status rows are verified, never rewritten.
            for (const row of unchanged) {
                const stillMatches = await tx.order.count({
                    where: {
                        id: row.id,
                        business_id: businessId,
                        status: row.status as any,
                        canceled_at: null,
                    },
                });
                if (stillMatches !== 1) throw new ConcurrentChangeError([row.id]);
            }
        });

        // 10. Success. `count` stays compatible with existing count-based consumers.
        return NextResponse.json({
            count: toWrite.length + unchanged.length,
            updated: toWrite.length,
            unchanged: unchanged.length,
            orderIds: [...toWrite.map(r => r.id), ...unchanged.map(r => r.id)],
        });

    } catch (e) {
        if (e instanceof ConcurrentChangeError) {
            return NextResponse.json({
                error: 'One or more orders changed while the batch was being processed',
                code: 'STATUS_CHANGED_CONCURRENTLY',
                failures: e.ids.map(id => ({ id })),
            }, { status: 409 });
        }
        console.error('Batch Update Error:', e);
        return NextResponse.json({ error: 'Failed to update orders' }, { status: 500 });
    }
}
