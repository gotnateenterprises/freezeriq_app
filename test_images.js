const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env.prod' });

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL + '&pgbouncer=true'
        }
    }
});

async function main() {
    const business = await prisma.business.findFirst({
        where: { slug: 'myfreezerchef' }
    });

    if (!business) {
        console.log("Business not found");
        return;
    }

    const recipes = await prisma.recipe.findMany({
        where: { business_id: business.id },
        select: { name: true, image_url: true }
    });

    console.log(`Found ${recipes.length} recipes for ${business.name}`);

    const missingImages = recipes.filter(r => !r.image_url);
    console.log(`Recipes with MISSING images: ${missingImages.length}`);

    const withImages = recipes.filter(r => r.image_url);
    console.log(`Recipes WITH images: ${withImages.length}`);

    if (withImages.length > 0) {
        console.log("Example of image URL:");
        console.log(withImages[0].image_url);
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
