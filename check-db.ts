import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    console.log("Looking up Business Owners for the two business IDs...");

    const bus1 = await prisma.business.findUnique({
        where: { id: '8352215f-0668-4526-a84d-56d82690e6b6' },
        select: {
            id: true,
            name: true,
            slug: true,
            users: { select: { email: true, name: true, role: true } }
        }
    });

    const bus2 = await prisma.business.findUnique({
        where: { id: 'fe37a2a6-b940-47fd-b139-427dfa006cd5' },
        select: {
            id: true,
            name: true,
            slug: true,
            users: { select: { email: true, name: true, role: true } }
        }
    });

    console.log("\nBusiness 1 (28 Customers):");
    console.dir(bus1, { depth: null });

    console.log("\nBusiness 2 (1 Customer):");
    console.dir(bus2, { depth: null });
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
