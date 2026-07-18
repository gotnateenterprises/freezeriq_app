
import { prisma } from './db';

/**
 * LOY-P0: New loyalty accrual is intentionally PAUSED, not deleted.
 *
 * While this is false, no positive LoyaltyPoint row is created and no customer
 * loyalty balance is incremented by any writer. Existing positive and negative
 * rows, existing balances, balance/history reads, and redemption all remain
 * fully functional and untouched.
 *
 * This is reversible: flipping this constant to true restores the previous
 * behavior. Do NOT flip it casually — reactivation requires the dedicated
 * loyalty phase that establishes exactly-once awarding (the current schema has
 * no order/invoice linkage and no unique constraint, so duplicate awards from
 * retries, duplicate webhooks, and concurrent requests cannot be prevented yet).
 */
export const LOYALTY_ACCRUAL_ENABLED = false;

/**
 * Adds loyalty points to a customer and updates their balance.
 * Rule: 1 point per $1 spent (rounded down).
 */
export async function addLoyaltyPoints(customerId: string, amount: number, reason: string) {
    // LOY-P0: defense-in-depth — accrual is globally paused. Return safely
    // without creating a row, incrementing a balance, or throwing.
    if (!LOYALTY_ACCRUAL_ENABLED) return null;

    const points = Math.floor(amount);

    if (points <= 0) return null;

    return await prisma.$transaction(async (tx) => {
        const entry = await tx.loyaltyPoint.create({
            data: {
                customer_id: customerId,
                points,
                reason
            }
        });

        const customer = await tx.customer.update({
            where: { id: customerId },
            data: {
                loyalty_balance: { increment: points }
            }
        });

        return { entry, balance: customer.loyalty_balance };
    });
}
