import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const recipes = await prisma.recipe.findMany({
        where: {
            name: {
                in: [
                    'Sour Cream Chicken Enchilada Casserole',
                    'Chicken Noodle Casserole',
                    'Ranch Chicken Street Tacos',
                    'Crack Chicken',
                    'Pizza Chicken - Keto',
                    'Tuscan Garlic Chicken - Keto',
                    'Ranch Chicken n Broccoli',
                    'Ranch Chicken Street Tacos (Serves 2)'
                ]
            }
        },
        include: {
            child_items: {
                include: {
                    child_ingredient: true
                }
            }
        }
    });

    for (const r of recipes) {
        console.log(`\n=== ${r.name} ===`);
        for (const i of r.child_items) {
            if (i.child_ingredient) {
                console.log(`- ${i.child_ingredient.name}: ${i.quantity} ${i.unit}`);
            }
        }
    }
}

main().finally(() => prisma.$disconnect());
