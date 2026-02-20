const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const columns = await prisma.$queryRaw`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'recipes' AND column_name IN ('image_url', 'cook_time', 'description')
        `;
        console.log('Column check:', JSON.stringify(columns, null, 2));

        const count = await prisma.$queryRaw`SELECT COUNT(*) FROM recipes WHERE cook_time IS NOT NULL`;
        console.log('Recipes with cook_time:', JSON.stringify(count, null, 2));
    } catch (e) {
        console.error(e);
    }
}

main().finally(() => prisma.$disconnect());
