import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getCustomerSession } from '@/lib/customerAuth';

export async function POST(req: Request) {
    try {
        const session = await getCustomerSession();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { selections, businessId } = body; // selections: { [recipeId]: quantity }

        if (!selections || Object.keys(selections).length === 0) {
            return NextResponse.json({ error: 'No meals selected' }, { status: 400 });
        }

        // Calculate total meals requested
        const totalRequested = Object.values(selections).reduce((sum: any, qty: any) => sum + qty, 0) as number;

        // Verify the customer has enough credits
        const customer = await prisma.customer.findUnique({
            where: { id: session.customerId }
        });

        if (!customer) {
            return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
        }

        // @ts-ignore
        if (customer.meal_credits < totalRequested) {
            return NextResponse.json({
                // @ts-ignore
                error: `Not enough meal credits. Requested: ${totalRequested}, Available: ${customer.meal_credits}`
            }, { status: 400 });
        }

        // Fetch Recipes to get pricing (though for a subscription box, the price is effectively $0 or prepaid)
        // We will sum up the total retail value just for tracking purposes, but the customer won't be charged again.
        const recipeIds = Object.keys(selections);
        const recipes = await prisma.recipe.findMany({
            where: { id: { in: recipeIds } }
        });

        // Use Prisma Transaction to ensure atomicity
        const externalId = Math.random().toString(36).substring(2, 9).toUpperCase();

        await prisma.$transaction(async (tx) => {
            // 1. Create the Order
            const newOrder = await tx.order.create({
                data: {
                    external_id: externalId,
                    business_id: businessId,
                    customer_id: customer.id,
                    customer_name: customer.contact_name || customer.name || 'Subscriber',
                    // @ts-ignore
                    customer_email: customer.contact_email,
                    // @ts-ignore
                    customer_phone: customer.contact_phone,
                    status: 'production_ready',    // Ready for the kitchen
                    source: 'storefront',                 // Standard direct consumer
                    total_amount: 0,               // Prepaid via subscription
                    coordinator_paid: true,        // Prepaid
                    items: {
                        create: recipes.map((recipe: any) => ({
                            item_name: recipe.name,
                            quantity: selections[recipe.id],
                            unit_price: 0, // Prepaid
                        }))
                    }
                }
            });

            // Note: In an actual production scenario we'd assign this to a pre-defined generic Subscription Bundle, 
            // but mapping directly to Recipe items works flawlessly for the Shopping List aggregate builder.

            // 2. Deduct the Meal Credits
            await tx.customer.update({
                where: { id: customer.id },
                // @ts-ignore
                data: {
                    // @ts-ignore
                    meal_credits: customer.meal_credits - totalRequested
                }
            });
        });

        return NextResponse.json({ success: true, message: 'Box submitted successfully' });

    } catch (error) {
        console.error("Box Submit Error:", error);
        return NextResponse.json({ error: 'Failed to submit box' }, { status: 500 });
    }
}
