
import { prisma } from './lib/db';

async function verify() {
    console.log("Verifying Orders...");
    const orders = await prisma.order.findMany({
        where: { source: 'square' },
        orderBy: { created_at: 'desc' },
        take: 1,
        include: { items: true }
    });

    if (orders.length > 0) {
        console.log("✅ Latest Order Found:", orders[0].external_id);
        console.log("Status:", orders[0].status);
        console.log("Items:", orders[0].items.length);
    } else {
        console.error("❌ No Square orders found.");
    }
}

verify()
    .catch(e => console.error(e))
    .finally(async () => await prisma.$disconnect());
