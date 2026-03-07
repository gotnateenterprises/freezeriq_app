import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const amberCustomer = "5504b116-9f59-4b9e-8103-2ec1544ce6e9";

    const campaigns = await prisma.fundraiserCampaign.findMany({
        where: {
            OR: [
                { name: { contains: 'Amber Finley' } },
                { customer_id: amberCustomer }
            ]
        },
        include: {
            customer: true
        }
    });

    console.log(JSON.stringify(campaigns, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
