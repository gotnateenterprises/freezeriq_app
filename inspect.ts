import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log("Searching for 'Buttery garlic pork roast'...");

    const recipes = await prisma.recipe.findMany({
        where: { name: { contains: 'Buttery garlic pork roast' } },
        include: { child_items: true }
    });
    console.log(`Found ${recipes.length} recipes matching.`);

    for (const r of recipes) {
        console.log(`\nRecipe: ${r.name} (${r.id})`);

        const parentLinks = await prisma.bundleContent.findMany({
            where: { recipe_id: r.id },
            include: { bundle: true }
        });

        if (parentLinks.length > 0) {
            console.log('  Appears in Bundles:');
            parentLinks.forEach(p => console.log(`    - ${p.bundle.name}`));
        } else {
            console.log('  Does NOT appear in any bundles directly.');
        }

        const parentRecipes = await prisma.recipeItem.findMany({
            where: { child_recipe_id: r.id },
            include: { parent_recipe: true }
        });

        if (parentRecipes.length > 0) {
            console.log('  Appears as sub-recipe in:');
            parentRecipes.forEach(p => console.log(`    - ${p.parent_recipe.name}`));
        } else {
            console.log('  Does NOT appear as a sub-recipe.');
        }
    }
}

main().finally(() => prisma.$disconnect());
