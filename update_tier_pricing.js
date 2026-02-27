const { PrismaClient } = require('@prisma/client');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const prisma = new PrismaClient();

async function main() {
    try {
        const update = { id: '665b04f7-c61b-450b-90cf-a83a471e35c1', newPrice: 225.00 }; // 10 Meal Bundle (Family Size)

        const tier = await prisma.subscriptionTier.findUnique({
            where: { id: update.id },
            include: { business: true }
        });

        if (!tier) {
            console.log(`Tier ${update.id} not found.`);
            return;
        }

        console.log(`Updating ${tier.name} to $${update.newPrice}`);

        const business = tier.business;

        // 1. Create a new Price on Stripe under this connected account
        let stripeAccountOpts = {};
        if (business.stripe_account_id) {
            stripeAccountOpts = { stripeAccount: business.stripe_account_id };
        }

        const newStripePrice = await stripe.prices.create({
            product: tier.stripe_product_id,
            unit_amount: Math.round(update.newPrice * 100),
            currency: 'usd',
            recurring: { interval: 'month' },
        }, stripeAccountOpts);

        console.log(`Created new Stripe Price: ${newStripePrice.id}`);

        // 2. Deactivate the old price
        if (tier.stripe_price_id) {
            try {
                await stripe.prices.update(tier.stripe_price_id, {
                    active: false
                }, stripeAccountOpts);
                console.log(`Deactivated old Stripe Price: ${tier.stripe_price_id}`);
            } catch (e) {
                console.log(`Could not deactivate old price: ${e.message}`);
            }
        }

        // 3. Update the database record
        await prisma.subscriptionTier.update({
            where: { id: tier.id },
            data: {
                price: update.newPrice,
                stripe_price_id: newStripePrice.id
            }
        });

        console.log(`Successfully updated tier ${tier.name} in DB to $225.\n`);

    } catch (error) {
        console.error('Error updating pricing:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
