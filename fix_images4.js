const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env.prod' });

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL
        }
    }
});

async function main() {
    const stockImages = [
        "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=2071&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=2071&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?q=80&w=2070&auto=format&fit=crop",
        "https://images.unsplash.com/photo-158503222665a-719976ec8dfc?q=80&w=1982&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=2070&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?q=80&w=2013&auto=format&fit=crop",
        "https://images.unsplash.com/photo-1565557623262-b51c2513a641?q=80&w=1971&auto=format&fit=crop"
    ];

    // Grab all recipes that are missing an image_url
    const recipes = await prisma.$queryRaw`SELECT id, name FROM recipes WHERE image_url IS NULL OR image_url = ''`;

    console.log(`Found ${recipes.length} recipes missing images globally.`);

    let count = 0;
    for (const recipe of recipes) {
        const img = stockImages[count % stockImages.length];

        await prisma.$executeRaw`
            UPDATE recipes 
            SET image_url = ${img}
            WHERE id = ${recipe.id}
        `;

        console.log(`✅ Updated ${recipe.name}`);
        count++;
    }

    console.log("Done restoring images! Closing connection.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
