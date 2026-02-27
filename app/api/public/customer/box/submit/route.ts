import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCustomerSession } from '@/lib/customerAuth';
import crypto from 'crypto';

export async function POST(req: Request) {
    try {
        const session = await getCustomerSession();

        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { selections, businessId } = await req.json();

        if (!selections || Object.keys(selections).length === 0) {
            return NextResponse.json({ error: 'No selections provided' }, { status: 400 });
        }

        const customer = await prisma.customer.findUnique({
            where: { id: session.customerId }
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        // Calculate total requested quantity
        const totalRequested = Object.values(selections).reduce((sum: number, qty: any) => sum + Number(qty), 0);

        if (customer.meal_credits < totalRequested) {
            return NextResponse.json({ error: 'Not enough meal credits' }, { status: 400 });
        }

        // Generate a random external ID for the order
        const externalId = 'SUB-' + crypto.randomBytes(4).toString('hex').toUpperCase();

        // Use Prisma transaction to ensure atomicity
        await prisma.$transaction(async (tx) => {
            // 1. Create the Order
            const order = await tx.order.create({
                data: {
                    external_id: externalId,
                    source: 'storefront',
                    status: 'production_ready',
                    customer_name: customer.contact_name || customer.name,
                    customer_id: customer.id,
                    business_id: businessId,
                    customer_email: customer.contact_email || '',
                    customer_phone: customer.contact_phone || '',
                    delivery_address: customer.delivery_address,
                    total_amount: 0, // Prepaid via subscription
                    payment_status: 'paid', // Mark as paid since credits were used
                }
            });

            // 2. Create Order Items
            // Selections has shape { [recipeId]: quantity }
            for (const [recipeId, quantity] of Object.entries(selections)) {

                // Fetch the recipe name to store it statically on the line item
                const recipe = await tx.recipe.findUnique({
                    where: { id: recipeId },
                    select: { name: true }
                });

                if (recipe) {
                    await tx.orderItem.create({
                        data: {
                            order_id: order.id,
                            quantity: Number(quantity),
                            item_name: recipe.name,
                            is_subscription: true,
                            unit_price: 0 // Prepaid
                        }
                    });
                }
            }

            // 3. Deduct Meal Credits from Customer
            await tx.customer.update({
                where: { id: customer.id },
                data: {
                    meal_credits: customer.meal_credits - totalRequested
                }
            });
        });

        return NextResponse.json({
            success: true,
            message: 'Box confirmed successfully'
        });

    } catch (error: any) {
        console.error('[Customer Box Submit API] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
