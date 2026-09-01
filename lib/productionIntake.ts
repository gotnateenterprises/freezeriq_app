/**
 * FULFILLMENT-CONTINUITY-1 — the single definition of "visible to production."
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md is the canonical ruling
 * this module implements. Read it before changing this rule.
 *
 * WHY THIS EXISTS
 *
 * "Which orders may the kitchen work on?" is answered independently in two
 * places, and they drifted. app/api/production/dashboard/route.ts answers it
 * for the Kitchen Board's three customer lanes; lib/prisma_adapter.ts
 * getProductionOrders() answers it for /api/production/sync, /plan and /runs —
 * the last of which PERSISTS a ProductionRun and drives ingredient purchasing.
 *
 * OPS-3 discovered the drift the hard way: the adapter was missing both the
 * fundraiser hold and the canceled-order exclusion, so an unpaid held order
 * could reach the kitchen through a CRM pipeline stage. That was repaired by
 * hand-copying the board's predicates (see the comment at the adapter's own
 * where-clause). Hand-copying is what produced the drift in the first place.
 *
 * This module gives the rule a name and one home so the next production query
 * inherits it instead of re-deriving it.
 *
 * THE RULE
 *
 *   1. fundraiser_hold is an ABSOLUTE hold. A held fundraiser order is a
 *      commitment, not production work. It is released only by the authoritative
 *      Invoice PAID event (app/api/tenant/invoices/[id]/settle/route.ts).
 *   2. A canceled order is never cooked.
 *   3. An abandoned storefront checkout (source 'storefront' still at 'pending',
 *      i.e. created pre-payment and never paid) is never cooked.
 *
 * WHAT THIS IS NOT
 *
 * This is NOT a filter on `source`. A RELEASED fundraiser order — one the paid
 * invoice promoted to production_ready — MUST reach the kitchen; that is the
 * entire point of the OPS-3 gate. lib/prisma_adapter.ts getOrders() does carry
 * `source: { not: 'fundraiser' }`, but that is the Orders LIST deciding where a
 * row is displayed, not production deciding what to cook. Do not copy it here.
 * The hold is `status`, never `source`.
 *
 * DELIBERATELY OMITTED
 *
 * The status allowlist's OR-spine. lib/prisma_adapter.ts pairs the allowlist
 * with a `{ customer: { status: 'PRODUCTION' } }` relation branch that asserts
 * nothing about the order; the Kitchen Board has no such branch. That spine
 * stays owned by each caller, because unifying it would silently add or remove
 * a whole class of orders from one of the two intakes. The exclusions below are
 * ANDed on top of whatever spine the caller uses, which is what makes them safe
 * to share.
 *
 * The Kitchen Board's three lanes are deliberately NOT refactored onto these
 * constants in this phase: their literal predicates are asserted by occurrence
 * count in tests/ops3FundraiserBatchProduction.test.ts, which is currently the
 * only thing stopping a lane from silently losing its exclusion. Replacing a
 * real guard with an import is not an improvement. Conformance is enforced
 * instead by tests/fulfillmentContinuity1ProductionIntake.test.ts, which checks
 * every production-intake query carries the rule regardless of how it spells it.
 */

import { toDbOrderStatusReadCandidates } from './orderStatus';

/**
 * Prisma `where` fragment: the exclusions every production-intake query must
 * carry. Spread into an `AND` array so it composes with any spine — a flat
 * status allowlist, or an OR that also matches on a relation.
 *
 *   AND: [...PRODUCTION_ORDER_EXCLUSIONS]
 *
 * `canceled_at` is deliberately NOT in here. It belongs at the top level of the
 * where-clause alongside `business_id`, which is where all four existing
 * production queries already put it; burying it in an AND array would make the
 * queries read less like each other, not more.
 */
export const PRODUCTION_ORDER_EXCLUSIONS = [
    { NOT: { status: 'fundraiser_hold' as any } },
    { NOT: { source: 'storefront', status: 'pending' } },
] as const;

/**
 * The order statuses that represent live kitchen work.
 *
 * Derived from toDbOrderStatusReadCandidates so the canonical -> stored mapping
 * stays owned by lib/orderStatus.ts and legacy uppercase rows keep matching.
 * Deduplicated once here rather than at each call site.
 */
export const PRODUCTION_INTAKE_STATUSES: string[] = [
    ...new Set([
        ...toDbOrderStatusReadCandidates('pending'),
        ...toDbOrderStatusReadCandidates('production_ready'),
        ...toDbOrderStatusReadCandidates('in_production'),
    ]),
];

/**
 * The order shape this rule needs. Hand-declared and widened on purpose: no
 * Prisma model or enum type is imported, so the rule is testable with plain
 * object literals and cannot be broken by the split-brain OrderStatus enum.
 */
export interface ProductionIntakeOrder {
    status?: string | null;
    source?: string | null;
    canceled_at?: Date | string | null;
}

/**
 * The same three exclusions as an in-memory predicate, for anything already
 * holding order rows.
 *
 * This answers only "is this order excluded from production?" — it does NOT
 * answer "is this order's status one the kitchen works on", because that half
 * legitimately differs between the two intakes (see DELIBERATELY OMITTED). A
 * caller that wants the full adapter rule combines this with its own spine.
 *
 * Fails closed on a missing status: an order whose status cannot be read is not
 * given to the kitchen.
 */
export function isProductionEligibleOrder(
    order: ProductionIntakeOrder | null | undefined,
): boolean {
    if (!order) return false;
    if (order.canceled_at != null) return false;
    if (!order.status) return false;
    if (order.status === 'fundraiser_hold') return false;
    if (order.source === 'storefront' && order.status === 'pending') return false;
    return true;
}
