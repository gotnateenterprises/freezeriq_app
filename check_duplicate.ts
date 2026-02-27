import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const ambers = await prisma.customer.findMany({
        where: {
            OR: [
                { name: { contains: 'Amber' } },
                { contact_name: { contains: 'Amber' } }
            ]
        }
    });

    console.log(JSON.stringify(ambers, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
