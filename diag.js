
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    console.log('--- DB DIAGNOSTICS ---');
    try {
        const connCount = await prisma.$queryRaw`SELECT count(*) FROM pg_stat_activity;`;
        console.log('Active Connections:', connCount);

        const businesses = await prisma.business.findMany({
            select: { name: true, slug: true }
        });
        console.log('All Businesses in DB:', businesses);
    } catch (e) {
        console.error('DB Error:', e.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
