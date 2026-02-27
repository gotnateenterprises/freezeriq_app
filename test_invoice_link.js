const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const customerId = 'bbc2cd63-bd27-4b7d-87eb-6c271755ae30'; // Ag in the Classroom

    const latestInvoice = await prisma.invoice.findFirst({
        where: { customer_id: customerId },
        orderBy: { created_at: 'desc' },
        include: { items: { include: { bundle: true } } }
    });

    if (latestInvoice) {
        console.log("Latest Invoice for Customer:");
        latestInvoice.items.forEach(item => {
            if (item.bundle) {
                console.log(`- Bundle: ${item.bundle.name} (ID: ${item.bundle.id})`);
            }
        });
    } else {
        console.log("No invoices found for dummy customer. Let's try 'Delmar PTO' (Customer ID of Delmar PTO)");
        const delmarInvoice = await prisma.invoice.findFirst({
            where: { customer: { name: 'Delmar PTO' } },
            orderBy: { created_at: 'desc' },
            include: { items: { include: { bundle: true } }, customer: { include: { campaigns: true } } }
        });
        if (delmarInvoice) {
            console.log("Latest Invoice for Delmar PTO:");
            delmarInvoice.items.forEach(item => {
                if (item.bundle) {
                    console.log(`- Bundle: ${item.bundle.name} (ID: ${item.bundle.id})`);
                }
            });
            console.log("\nCampaigns for Delmar PTO:");
            delmarInvoice.customer.campaigns.forEach(c => console.log(`- ${c.name} (${c.id})`));
        }
    }
}
main().catch(console.error).finally(() => prisma.$disconnect());
