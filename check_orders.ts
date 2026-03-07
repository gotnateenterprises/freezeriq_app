import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const amberCustomer = "5504b116-9f59-4b9e-8103-2ec1544ce6e9";

    const orders = await prisma.order.findMany({
        where: {
            customer_id: amberCustomer
        }
    });

    console.log(JSON.stringify(orders, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
