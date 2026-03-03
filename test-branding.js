const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const brandings = await prisma.tenantBranding.findMany({
        include: { user: { select: { business_id: true } } }
    });
    console.log(JSON.stringify(brandings, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
