/**
 * Square order simulation endpoint — RETIRED (FR-COORD-123A).
 *
 * ── WHY THIS IS NOW A DEAD END ──────────────────────────────────────────────
 *
 * This route existed to fabricate Square orders during early development. It
 * created Order and OrderItem rows from an unvalidated request body with:
 *
 *   - no authentication of any kind (no session, no webhook signature, no
 *     shared secret) — a bare exported POST that trusted `await req.json()`;
 *   - no tenant scoping — bundle lookups by SKU and by name ran across EVERY
 *     business, so a caller could attach a line item to another tenant's
 *     bundle;
 *   - no business_id on the order it created.
 *
 * It shipped to Production that way. Nothing in the product called it: its only
 * caller was components/SimulateOrderButton.tsx, which no page renders, and the
 * two simulate_square*.bat shims invoke scripts/simulate_square_order.ts, a file
 * that does not exist in the repository. Production carries zero orders with
 * source='square'. So the endpoint had no users — only reachability.
 *
 * ── WHAT IS EXPLICITLY *NOT* AFFECTED ───────────────────────────────────────
 *
 * The genuine Square integration never went through here, and is untouched:
 *
 *   app/api/webhooks/square/route.ts   the real webhook — reads an order and
 *                                      updates it; creates no order items
 *   app/api/checkout/square/pay/route.ts   real payment
 *   app/api/auth/square/*                  OAuth connect
 *   app/api/sync/orders/route.ts           authenticated, tenant-scoped order
 *                                          sync via lib/ingestion/square_handler
 *
 * ── WHY 410 RATHER THAN DELETION ────────────────────────────────────────────
 *
 * The route file remains so the retirement is legible at the path someone would
 * look for it, and so a stray caller receives a definite answer instead of a
 * Next.js 404 that reads like a deploy problem. The response body says nothing
 * about tenants, bundles, or what the endpoint used to do.
 *
 * There is no code path from this file to the database. That is the point.
 */

import { NextResponse } from 'next/server';

/** Identical for every verb: gone, no work performed, nothing disclosed. */
function gone() {
    return NextResponse.json(
        { error: 'This endpoint is no longer available.' },
        { status: 410, headers: { 'Cache-Control': 'no-store' } },
    );
}

export async function POST() {
    // The request body is deliberately never read: no parsing, no bundle
    // lookup, no order creation, no tenant resolution.
    return gone();
}

export async function GET() {
    return gone();
}
