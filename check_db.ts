import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const customer = await prisma.customer.findFirst({
        where: {
            OR: [
                { name: { contains: 'VCHS' } },
                { contact_name: { contains: 'Amber Finley' } }
            ]
        },
        include: {
            campaigns: true
        }
    });

    console.log(JSON.stringify(customer, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
