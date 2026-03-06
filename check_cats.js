const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const cats = await prisma.category.findMany({
            select: { id: true, name: true, parent_id: true }
        });
        console.log(JSON.stringify(cats, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
