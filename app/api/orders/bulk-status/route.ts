import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { toDbSafeOrderStatus, normalizeOrderStatus, validateOrderStatusTransition } from '@/lib/orderStatus';

/**
 * KB-1B: statuses a kitchen batch route may TARGET.
 *
 * This is a route capability restriction, NOT a transition matrix. It says which
 * targets this endpoint is allowed to write at all; every from -> to legality
 * decision is still delegated to validateOrderStatusTransition, which owns the
 * single canonical matrix in lib/orderStatus.ts.
 *
 * production_ready is excluded because it carries invoice/loyalty side effects
 * owned by the guarded single-order PATCH. delivered is excluded because delivery
 * completion belongs to the guarded delivery workflow. fundraiser_hold is excluded
 * because fundraiser release is closeout-only. completed is excluded because the
 * Kitchen Board advances straight to ready_to_ship.
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

        const { orderIds, status } = await req.json();

        const isNonEmptyString = (v: unknown): v is string =>
            typeof v === 'string' && v.trim().length > 0;

        // 2a. Validate the WHOLE orderIds array before anything else. Malformed
        //    members are never silently filtered out: a partially-valid request
        //    must be rejected outright, otherwise the route could report success
        //    after processing only part of what the caller submitted.
        if (!Array.isArray(orderIds)) {
            return NextResponse.json({
                error: 'Invalid batch request',
                code: 'INVALID_PAYLOAD',
            }, { status: 400 });
        }

        if (orderIds.length === 0) {
            return NextResponse.json({
                error: 'No orders selected',
                code: 'EMPTY_BATCH',
            }, { status: 400 });
        }

        if (!orderIds.every(isNonEmptyString)) {
            return NextResponse.json({
                error: 'Invalid batch request',
                code: 'INVALID_PAYLOAD',
            }, { status: 400 });
        }

        // 2b. Only now — with every member proven a non-empty string — deduplicate.
        //    Every submitted id therefore participates in the tenant read and the
        //    missing-order comparison.
        const uniqueIds = Array.from(new Set<string>(orderIds));

        // Defensive: a validated non-empty array should never reduce to nothing.
        if (uniqueIds.length === 0) {
            return NextResponse.json({
                error: 'No orders selected',
                code: 'EMPTY_BATCH',
            }, { status: 400 });
        }

        // 3. Validate the requested target status before normalization helpers run.
        if (!isNonEmptyString(status)) {
            return NextResponse.json({
                error: 'Invalid order status',
                code: 'INVALID_STATUS',
            }, { status: 400 });
        }

        const requestedTarget = status.trim();
        const canonicalTarget = normalizeOrderStatus(requestedTarget);
        const dbSafeStatus = toDbSafeOrderStatus(requestedTarget);
        if (canonicalTarget === null || dbSafeStatus === null) {
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

        // 4. Tenant-scoped preflight read. canceled_at is deliberately NOT filtered
        //    here so canceled rows are reported explicitly rather than silently
        //    appearing as "not found".
        const rows = await prisma.order.findMany({
            where: {
                id: { in: uniqueIds },
                business_id: businessId,
            },
            select: { id: true, status: true, canceled_at: true },
        });

        // 5. Missing and foreign ids are treated identically so ownership is never
        //    disclosed across tenants.
        const foundIds = new Set(rows.map(r => r.id));
        const notFound = uniqueIds.filter(id => !foundIds.has(id));
        if (notFound.length > 0) {
            return NextResponse.json({
                error: 'One or more orders were not found',
                code: 'ORDER_NOT_FOUND',
                failures: notFound.map(id => ({ id })),
            }, { status: 404 });
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

        // 7. Canonical transition preflight for every row. validateOrderStatusTransition
        //    is the only transition authority; no rules are duplicated here.
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

        // 9. All-or-nothing write. Each conditional update matches the EXACT raw
        //    status read during preflight, so any concurrent change misses and rolls
        //    the whole transaction back.
        await prisma.$transaction(async (tx) => {
            for (const row of toWrite) {
                const res = await tx.order.updateMany({
                    where: {
                        id: row.id,
                        business_id: businessId,
                        status: row.status as any,
                        canceled_at: null,
                    },
                    data: { status: dbSafeStatus as any },
                });
                if (res.count !== 1) throw new ConcurrentChangeError([row.id]);
            }

            // Same-status rows are verified, never rewritten. If one no longer
            // matches its exact raw status, another writer moved it mid-batch.
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
        console.error('Bulk Update Error:', e);
        return NextResponse.json({ error: 'Failed to update orders' }, { status: 500 });
    }
}
