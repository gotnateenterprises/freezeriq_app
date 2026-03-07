import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const businessId = "8352215f-0668-4526-a84d-56d82690e6b6";
    const nameToFind = decodeURIComponent("Amber%20Finley");

    const org = await prisma.customer.findFirst({
        where: {
            name: nameToFind,
            business_id: businessId
        }
    });

    console.log("Found org by exact name 'Amber Finley':", org !== null);
    console.log(org ? org.id : null);
}

main()
    .catch(e => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
