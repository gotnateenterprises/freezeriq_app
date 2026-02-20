const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const recipes = await prisma.recipe.findMany({
            select: {
                id: true,
                name: true,
                image_url: true
            },
            where: {
                image_url: { not: null }
            },
            take: 20
        });

        console.log('--- Recipe Image URLs ---');
        recipes.forEach(r => {
            console.log(`[${r.name}]: ${r.image_url}`);
        });

    } catch (e) {
        console.error('Prisma Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
