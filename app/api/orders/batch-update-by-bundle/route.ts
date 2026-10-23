import { NextResponse } from 'next/server';
import { auth } from '@/auth';

/**
 * RETIRED — WAVES-CLOSEOUT-1A. This route is deliberately inert.
 *
 * It used to advance every tenant order whose status matched `currentStatus` and that held
 * `bundleId` on any line: one Prep card's button moved every fundraiser, and every ordinary order,
 * that happened to share the bundle. PREP-WAVES-1 replaced its only caller (PrepList) with the
 * exact-id route, POST /api/orders/bulk-status, driven by lib/prepWaves.ts; nothing calls this
 * route any more (tests/wavesCloseout1a.test.ts keeps it that way).
 *
 * The file stays, rather than being deleted, so that a stale browser tab or an unknown caller gets
 * an explicit 410 instead of a vanished route. The 410 is the whole behaviour:
 *
 *   - no body is read: `bundleId`, `currentStatus` and `newStatus` are never parsed or acted on;
 *   - no database is touched: this module must not import Prisma, `@/lib/db` or lib/orderStatus,
 *     so there is nothing here that could read or write an order;
 *   - nothing is translated: the request is not redirected to, or rewritten as, an exact-id call.
 *
 * Authentication is unchanged. A caller without a tenant session still gets 401, so the route does
 * not tell the anonymous internet anything about itself.
 */
export async function POST() {
    const session = await auth();
    if (!session?.user?.businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json(
        {
            error: 'This legacy kitchen batch route is no longer supported',
            code: 'LEGACY_BATCH_ROUTE_DISABLED',
        },
        { status: 410 },
    );
}
