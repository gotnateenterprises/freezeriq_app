import { prisma } from './lib/db';
import { convertUnit } from './lib/unit_converter';

async function testCost() {
    const recipes = await prisma.recipe.findMany({
        include: {
            parent_items: {
                include: {
                    child_ingredient: true,
                    child_recipe: true
                }
            }
        }
    });

    const shepherd = recipes.find(r => r.name.includes("Shepherd"));
    if (!shepherd) {
        console.log("Shepherd's Pie not found");
        return;
    }

    console.log(`Testing costs for: ${shepherd.name} (Yield: ${shepherd.base_yield_qty} ${shepherd.base_yield_unit})`);

    let totalCost = 0;

    shepherd.parent_items.forEach(item => {
        if (item.is_sub_recipe && item.child_recipe) {
            // Find cost of child recipe
            const subRec = item.child_recipe;
            // How is subRec cost calculated? In the frontend it uses an any cast: `(subRec as any).cost_per_unit || 0;`
            // But Prisma Recipe doesn't have `cost_per_unit`.

            console.log(`Sub-Recipe: ${subRec.name}, qty: ${item.quantity} ${item.unit}`);
            console.log(`  SubRec Base Unit: ${subRec.base_yield_unit}`);

            // This is the bug. The frontend expects subRecipe cost_per_unit to exist on the object, but it dynamically calculates it.
            // Let's check `lib/inventory_engine.ts` to see how it calculates it for the frontend API `api/recipes/route.ts`

        } else if (!item.is_sub_recipe && item.child_ingredient) {
            const ing = item.child_ingredient;
            const costPerUnit = Number(ing.cost_per_unit || 0);
            const conversion = convertUnit(1, item.unit, ing.unit, ing.name);
            const lineCost = Number(item.quantity) * conversion * costPerUnit;
            console.log(`Ingredient: ${ing.name}, qty: ${item.quantity} ${item.unit} -> $${lineCost.toFixed(2)}`);
            totalCost += lineCost;
        }
    });

    console.log(`Total Cost: $${totalCost.toFixed(2)}`);
    console.log(`Cost Per Serving: $${(totalCost / Number(shepherd.base_yield_qty)).toFixed(2)}`);
}

testCost().catch(console.error).finally(() => prisma.$disconnect());
