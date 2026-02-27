const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function GET(token) {
    try {
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { portal_token: token },
            include: {
                customer: {
                    select: {
                        name: true,
                        business_id: true,
                        business: {
                            select: {
                                plan: true,
                                subscription_status: true
                            }
                        }
                    }
                },
                orders: {
                    where: { status: { not: 'cancelled' } },
                    orderBy: { created_at: 'desc' },
                    select: {
                        id: true,
                        participant_name: true,
                        customer_name: true,
                        total_amount: true,
                        created_at: true,
                        source: true
                    }
                }
            }
        });

        if (!campaign) {
            console.log("Portal not found");
            return;
        }

        const business = campaign.customer?.business;
        const businessId = campaign.customer?.business_id;
        const plan = business?.plan || 'FREE';

        const allowedPlans = ['ENTERPRISE', 'ULTIMATE', 'FREE', 'PRO'];
        if (!allowedPlans.includes(plan)) {
            console.log("Plan restriction", plan);
            return;
        }

        const bundles = await prisma.bundle.findMany({
            where: {
                business_id: businessId,
                is_active: true
            },
            select: {
                id: true,
                name: true,
                price: true,
                serving_tier: true
            }
        });

        console.log("Success! Campaign:", campaign.name, "Bundles:", bundles.length);

    } catch (e) {
        console.error("Fetch Coordinator Portal Error:", e);
    }
}

GET('0c2a10be-7fe7-4d19-84ca-41bea66ab2ea')
    .catch(console.error)
    .finally(() => prisma.$disconnect());
