import { PrismaAdapter } from '@/lib/prisma_adapter';
import RecipeEditor from '@/components/RecipeEditor';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { convertUnit } from '@/lib/unit_converter';

export default async function RecipeDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return <div>Unauthorized</div>;

    const { id } = await params;
    const adapter = new PrismaAdapter(session.user.businessId);
    const recipe = await adapter.getRecipe(id);

    if (!recipe) {
        return (
            <div className="p-8 text-center bg-white rounded-xl border border-slate-200">
                <h2 className="text-xl font-bold text-slate-800">Recipe Not Found</h2>
                <p className="text-slate-500">The recipe you are looking for does not exist.</p>
            </div>
        );
    }

    // ------------------------------------------------------------------
    // SAFE COST CALCULATION (In-Memory)
    // Prevents "Too many database connections" by fetching data once.
    // ------------------------------------------------------------------

    // 1. Fetch Reference Data
    const [packagingItems, allIngredients, allRecipes] = await Promise.all([
        prisma.packagingItem.findMany({
            where: { business_id: session.user.businessId }
        }),
        prisma.ingredient.findMany({
            where: { business_id: session.user.businessId },
            select: { id: true, name: true, cost_per_unit: true, unit: true }
        }),
        prisma.recipe.findMany({
            where: { business_id: session.user.businessId },
            include: {
                child_items: {
                    include: {
                        child_ingredient: { select: { id: true, name: true, cost_per_unit: true, unit: true } },
                        child_recipe: { select: { id: true, name: true, base_yield_qty: true, base_yield_unit: true } }
                    }
                }
            }
        })
    ]);

    // 2. Maps
    const ingredientMap = new Map(allIngredients.map(i => [i.id, i]));
    const recipeMap = new Map(allRecipes.map(r => [r.id, r]));

    // 3. Calc Function
    const calculateCostInMemory = (rec: any, depth = 0): { totalCost: number, isAccurate: boolean } => {
        if (depth > 5) return { totalCost: 0, isAccurate: false };
        if (!rec) return { totalCost: 0, isAccurate: false };

        let totalCost = 0;
        let isAccurate = true;

        // Ingredients & Sub-Recipes
        if (rec.child_items) {
            for (const item of rec.child_items) {
                let lineCost = 0;

                if (item.child_ingredient_id) {
                    const ing = item.child_ingredient || ingredientMap.get(item.child_ingredient_id);
                    if (ing) {
                        const costPerUnit = Number(ing.cost_per_unit || 0);
                        if (costPerUnit === 0) isAccurate = false;

                        const conversion = convertUnit(1, item.unit, ing.unit, ing.name);
                        const qtyUsed = Number(item.quantity) * conversion;
                        lineCost = qtyUsed * costPerUnit;
                    }
                } else if (item.child_recipe_id) {
                    const subRecipe = item.child_recipe || recipeMap.get(item.child_recipe_id);
                    if (subRecipe) {
                        const fullSubRecipe = recipeMap.get(item.child_recipe_id);
                        if (fullSubRecipe) {
                            const subResult = calculateCostInMemory(fullSubRecipe, depth + 1);
                            if (!subResult.isAccurate) isAccurate = false;

                            const subBatchCost = subResult.totalCost;
                            const subYield = Number(fullSubRecipe.base_yield_qty) || 1;
                            const costPerYieldUnit = subBatchCost / subYield;

                            const conversion = convertUnit(1, item.unit, fullSubRecipe.base_yield_unit, fullSubRecipe.name);
                            const qtyUsed = Number(item.quantity) * conversion;
                            lineCost = qtyUsed * costPerYieldUnit;
                        }
                    }
                }
                totalCost += lineCost;
            }
        }

        // Packaging
        const containerType = rec.container_type || 'tray';
        const isFamily = rec.name.toLowerCase().includes('family') || rec.name.toLowerCase().includes('large');
        let packagingCost = 0;

        if (containerType === 'bag') {
            const bagName = isFamily ? 'Gallon' : 'Quart';
            const bag = packagingItems.find(p => p.name.includes(bagName) && (p.name.includes('Bag') || p.name.includes('Ziplock')));
            if (bag) packagingCost += Number(bag.cost_per_unit || 0);
        } else {
            const sizeName = isFamily ? 'Large' : 'Small';
            const container = packagingItems.find(p => p.name.includes(sizeName) && (p.name.includes('Tray') || p.name.includes('Container')));
            const lid = packagingItems.find(p => p.name.includes(sizeName) && p.name.includes('Lid'));
            if (container) packagingCost += Number(container.cost_per_unit || 0);
            if (lid) packagingCost += Number(lid.cost_per_unit || 0);
        }

        totalCost += packagingCost;
        return { totalCost, isAccurate };
    };

    // 4. Execute for Target Recipe
    const targetRecipeForCost = recipeMap.get(id);
    let totalCost = 0;
    let isAccurate = false;

    if (targetRecipeForCost) {
        const res = calculateCostInMemory(targetRecipeForCost);
        totalCost = res.totalCost;
        isAccurate = res.isAccurate;
    }

    const costData = {
        totalCost,
        costPerUnit: totalCost / (Number(recipe.base_yield_qty) || 1),
        yieldUnit: recipe.base_yield_unit,
        currency: 'USD',
        isAccurate
    };

    // Serialize for Client Component
    const serializedRecipe = {
        ...recipe,
        base_yield_qty: Number(recipe.base_yield_qty),
        items: recipe.items.map(i => ({
            ...i,
            quantity: Number(i.quantity)
        }))
    };

    return <RecipeEditor initialData={serializedRecipe} costData={costData} />;
}
