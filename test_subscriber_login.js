const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const crypto = require('crypto');

async function main() {
    // 1. Find a business
    const business = await prisma.business.findFirst();
    if (!business) return console.log("No business found.");

    let userEmail = 'test-subscriber@freezeriq.com';

    // 2. Find or create a subscriber
    let subscriber = await prisma.customer.findFirst({
        where: {
            business_id: business.id,
            subscription_status: 'active'
        }
    });

    if (!subscriber) {
        console.log("No active subscriber found. Creating a test one...");
        subscriber = await prisma.customer.create({
            data: {
                name: 'Test Subscriber',
                contact_name: 'Test Subscriber',
                contact_email: userEmail,
                business_id: business.id,
                type: 'direct_customer',
                status: 'ACTIVE',
                meal_credits: 5,
                subscription_status: 'active',
                stripe_subscription_id: 'sub_test_123',
                external_id: 'test_sub_' + Date.now()
            }
        });
    } else {
        userEmail = subscriber.contact_email || subscriber.email || userEmail;
        console.log(`Found existing active subscriber: ${subscriber.name} (${userEmail})`);

        // Ensure they have meal credits for the demo
        if (subscriber.meal_credits < 5) {
            await prisma.customer.update({
                where: { id: subscriber.id },
                data: { meal_credits: 5 }
            });
            console.log("Topped off test subscriber with 5 meal credits.");
        }
    }

    // 3. Generate Magic Link
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins

    await prisma.magicLinkToken.create({
        data: {
            email: userEmail,
            token: hashedToken,
            expires_at: expiresAt,
            business_id: business.id
        }
    });

    const loginUrl = `http://localhost:3000/api/public/customer/auth/verify?token=${rawToken}&email=${encodeURIComponent(userEmail)}&businessId=${business.id}`;

    console.log('\n--- HOW TO TEST "BUILD A BOX" LOCAL DEV ---');
    console.log(`1. Click this magic login link: ${loginUrl}`);
    console.log(`(This logs you into the storefront as: ${userEmail})`);
    console.log(`2. You will be redirected to the customer dashboard.`);
    console.log(`3. Click the "Build Your Box Now" button.`);
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
