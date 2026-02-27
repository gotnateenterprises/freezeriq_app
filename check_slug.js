const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const businesses = await prisma.business.findMany({
        select: {
            id: true,
            name: true,
            slug: true
        }
    });
    console.log(JSON.stringify(businesses, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
