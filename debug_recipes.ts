
import { prisma } from './lib/db';

async function main() {
    console.log("Listing Recipes...");
    const recipes = await prisma.recipe.findMany({
        take: 5,
        select: { id: true, name: true }
    });

    if (recipes.length === 0) {
        console.log("No recipes found in DB.");
    } else {
        console.log("Found recipes:");
        recipes.forEach(r => console.log(`${r.id} : ${r.name}`));
    }
}

main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
