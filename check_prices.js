const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const bundles = await prisma.bundle.findMany({
        where: { show_on_storefront: true },
        select: { id: true, name: true, price: true, is_surplus: true, serving_tier: true }
    });
    console.log(JSON.stringify(bundles, null, 2));
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
