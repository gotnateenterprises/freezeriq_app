/**
 * OPS-1 — the single definition of "a valid order-item quantity."
 *
 * Extracted from app/api/public/order/route.ts (FR-LAUNCH-1A), which validated
 * this inline. FR-OPS-LOCKDOWN-AUDIT-1 found that the coordinator-entered
 * order path (POST /api/coordinator) never validated quantity at all — it
 * flowed straight into the server-computed total and the OrderItem row. A
 * zero-or-malformed-quantity order still reconciles arithmetically in some
 * shapes (0 items x $0 = $0 total), which is exactly how it can slip past
 * creation and only surface later as a campaign that fundraiser closeout
 * refuses to reconcile (lib/fundraiserCloseoutMath.ts).
 *
 * Both order-creation paths call this ONE function so the rule can never
 * drift into two different definitions of "valid."
 */
export function isValidOrderQuantity(value: unknown): value is number {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        value > 0;
}

export function hasInvalidOrderQuantity(items: Array<{ quantity?: unknown }>): boolean {
    return items.some((item) => !isValidOrderQuantity(item?.quantity));
}
