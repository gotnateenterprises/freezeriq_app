
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log("Fetching recent campaigns...");
    const campaigns = await prisma.fundraiserCampaign.findMany({
        take: 5,
        orderBy: { created_at: 'desc' },
        include: {
            customer: true
        }
    });

    console.log("Found", campaigns.length, "campaigns");
    campaigns.forEach(c => {
        console.log("------------------------------------------------");
        console.log("Campaign ID:", c.id);
        console.log("Campaign Name:", c.name);
        console.log("Linked Customer ID:", c.customer_id);
        console.log("Linked Customer Name:", c.customer ? c.customer.name : "N/A");
        console.log("Linked Customer Type:", c.customer ? c.customer.type : "N/A");
    });
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
