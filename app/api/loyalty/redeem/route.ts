import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { customerId, businessId, pointAmount } = body;

        if (!customerId || !businessId || !pointAmount || isNaN(pointAmount) || pointAmount <= 0) {
            return NextResponse.json({ error: 'Valid Customer ID, Business ID, and Point Amount required' }, { status: 400 });
        }

        // 1. Verify customer exists and has enough points
        const customer = await prisma.customer.findUnique({
            where: { id: customerId }
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        if (Number(customer.loyalty_balance) < pointAmount) {
            return NextResponse.json({ error: 'Insufficient loyalty points' }, { status: 400 });
        }

        // 2. Calculate Discount Value (e.g. 100 points = $5.00)
        // Adjust this conversion rate based on business rules. 
        // Example: 1 point = $0.05
        const conversionRate = 0.05;
        const discountAmount = pointAmount * conversionRate;

        // Generate a fun unique code
        const randomString = Math.random().toString(36).substring(2, 7).toUpperCase();
        const discountCode = `LOYALTY-${discountAmount}-${randomString}`;

        // 3. Atomically deduct points and create the discount code
        const result = await prisma.$transaction(async (tx) => {
            // Deduct points
            const updatedCustomer = await tx.customer.update({
                where: { id: customerId },
                data: {
                    loyalty_balance: { decrement: pointAmount }
                }
            });

            // Log the reason
            await tx.loyaltyPoint.create({
                data: {
                    customer_id: customerId,
                    points: -pointAmount,
                    reason: `Redeemed ${pointAmount} points for $${discountAmount.toFixed(2)} off`
                }
            });

            // Create usable Discount Code
            const newDiscount = await tx.discountCode.create({
                data: {
                    business_id: businessId,
                    code: discountCode,
                    amount: discountAmount,
                    is_percentage: false,
                    is_active: true
                }
            });

            return { updatedCustomer, newDiscount };
        });

        return NextResponse.json({
            success: true,
            discountCode: result.newDiscount.code,
            discountAmount: result.newDiscount.amount,
            newBalance: result.updatedCustomer.loyalty_balance
        });

    } catch (e: any) {
        console.error('Loyalty redemption error:', e);
        return NextResponse.json({ error: e.message || 'Internal Server Error' }, { status: 500 });
    }
}
