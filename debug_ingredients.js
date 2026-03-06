const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        console.log('--- Checking Recipes & Ingredients ---');
        // Get first 5 recipes
        const recipes = await prisma.recipe.findMany({
            take: 5,
            include: {
                child_items: {
                    include: {
                        child_ingredient: true,
                        child_recipe: true
                    }
                }
            }
        });

        if (recipes.length === 0) {
            console.log('No recipes found in DB.');
        } else {
            console.log(`Found ${recipes.length} recipes.`);
            recipes.forEach(r => {
                console.log(`\nRecipe: ${r.name} (ID: ${r.id})`);
                console.log(`  - Ingredient Count: ${r.child_items.length}`);
                if (r.child_items.length > 0) {
                    r.child_items.forEach(item => {
                        const iName = item.child_ingredient?.name || item.child_recipe?.name || 'Unknown Item';
                        console.log(`    - ${item.quantity} ${item.unit} ${iName}`);
                    });
                } else {
                    console.log('    (No ingredients linked)');
                }
            });
        }

        console.log('\n--- Checking OpenAI Integrations ---');
        const integrations = await prisma.integration.findMany({
            where: { provider: 'openai' }
        });
        console.log(`Found ${integrations.length} OpenAI integrations.`);
        integrations.forEach(i => {
            console.log(`- Business: ${i.business_id}, Key ends in: ...${i.access_token.slice(-4)}`);
        });

    } catch (e) {
        console.error('Prisma Error:', e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
