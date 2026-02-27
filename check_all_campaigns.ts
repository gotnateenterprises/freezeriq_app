import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const campaigns = await prisma.fundraiserCampaign.findMany({
        include: {
            customer: true
        },
        orderBy: { created_at: 'desc' }
    });

    const summarized = campaigns.map(c => ({
        campaign_id: c.id,
        campaign_name: c.name,
        customer_name: c.customer?.name,
        customer_id: c.customer_id
    }));

    console.log(JSON.stringify(summarized, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
