import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { buildSupporterBoxManifest, type BoxManifestOrder } from '@/lib/supporterBoxManifest';

/**
 * OPS-6 — the tenant-authorized supporter outer-box label manifest.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (outer-box labels)
 * and §11 (reuse the canonical authorities).
 *
 * WHY THE SERVER RESOLVES THE LABELS
 *
 * The label content is supporter identity. The client is therefore trusted
 * with Order IDs only: it posts the ids it queued, and this route decides —
 * from the session, never from the request — which tenant is asking and
 * whether those orders belong to them. A tampered id cannot cross a tenant
 * boundary because the `business_id` filter is part of the WHERE clause, not a
 * check applied to whatever came back.
 *
 * MIDDLEWARE DOES NOT PROTECT THIS
 *
 * The project's middleware does not cover `/api/`, so every handler is
 * self-defending (SEC-PUBLIC-ROUTE-1). This one resolves the session first and
 * returns 401 before touching Prisma.
 *
 * MINIMAL RESPONSE
 *
 * Only the four printed facts plus traceability ids leave this route. The
 * select list below deliberately omits `phone`, `delivery_address`,
 * `participant_name` and the Customer relation entirely — the existing
 * /api/production/dashboard route uses `include`, which ships every Order
 * scalar (supporter phone and address included) to the browser. That is
 * pre-existing and out of OPS-6's scope to change, but this new path does not
 * repeat it: what is never fetched cannot be leaked.
 *
 * READ-ONLY
 *
 * No writes. Printing a box label is not a lifecycle transition — Packed &
 * Ready and Delivered are later phases (§8), and this route deliberately has
 * no way to advance an order.
 */

/** Hard cap so one request cannot be used to enumerate a whole season. */
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

        // TENANT SCOPE IS IN THE QUERY. `business_id` is the authenticated
        // tenant's, so an id belonging to another business simply does not come
        // back — there is no row to filter out afterwards and no branch that
        // could forget to.
        const orders = await prisma.order.findMany({
            where: {
                id: { in: orderIds },
                business_id: businessId,
                canceled_at: null,
            },
            select: {
                id: true,
                first_name: true,
                last_name: true,
                customer_name: true,
                items: {
                    select: {
                        id: true,
                        bundle_id: true,
                        quantity: true,
                        variant_size: true,
                        item_name: true,
                        bundle: { select: { id: true, name: true } },
                    },
                    // Part N: an explicit deterministic key, never the database's
                    // default row order. OrderItem has no `position` and no
                    // `created_at`, so `id` is the only authoritative stable
                    // field — and lib/supporterBoxManifest.ts sorts by the same
                    // key, so the two can never disagree.
                    orderBy: { id: 'asc' },
                },
            },
            orderBy: { id: 'asc' },
        });

        // An id the caller asked for that did not come back is either another
        // tenant's, canceled, or gone. Reported as not-found WITHOUT saying
        // which — distinguishing "belongs to someone else" from "does not
        // exist" would make this an existence oracle for other tenants' ids.
        const foundIds = new Set(orders.map((o) => o.id));
        const unavailableCount = orderIds.filter((id) => !foundIds.has(id)).length;

        const manifest = buildSupporterBoxManifest(orders as unknown as BoxManifestOrder[]);

        return NextResponse.json({
            labels: manifest.labels,
            blocked: manifest.blocked,
            requestedCount: orderIds.length,
            unavailableCount,
        });
    } catch (e) {
        // Deliberately no error detail and no request echo in the log: this
        // handler's inputs are order ids and its outputs are supporter names.
        console.error('Box label manifest failed');
        return NextResponse.json({ error: 'Failed to build box labels' }, { status: 500 });
    }
}
