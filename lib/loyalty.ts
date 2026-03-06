
import { prisma } from './db';

/**
 * Adds loyalty points to a customer and updates their balance.
 * Rule: 1 point per $1 spent (rounded down).
 */
export async function addLoyaltyPoints(customerId: string, amount: number, reason: string) {
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
