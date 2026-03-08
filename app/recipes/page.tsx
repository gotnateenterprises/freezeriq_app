// @ts-nocheck
import { prisma } from '@/lib/db';
import RecipePageClient from '@/components/RecipePageClient';

export const dynamic = 'force-dynamic';


export default async function RecipesPage() {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) return <div>Unauthorized</div>;

    // ------------------------------------------------------------------
    // OPTIMIZED: In-Memory Cost Calculation (Solves "Too Many Connections")
    // ------------------------------------------------------------------

    // 1. Fetch ALL Reference Data in Parallel Safely
    try {
        const [packagingItems, allIngredients, allRecipes, categories] = await Promise.all([
            prisma.packagingItem.findMany({
                where: { business_id: session.user.businessId }
            }),
            prisma.ingredient.findMany({
                where: { business_id: session.user.businessId },
                select: { id: true, name: true, cost_per_unit: true, unit: true }
            }),
            prisma.recipe.findMany({
                where: { business_id: session.user.businessId },
                orderBy: { name: 'asc' },
                include: {
                    _count: { select: { child_items: true } },
                    child_items: {
                        include: {
                            child_ingredient: { select: { id: true, name: true, cost_per_unit: true, unit: true } },
                            child_recipe: { select: { id: true, name: true, base_yield_qty: true, base_yield_unit: true } }
                        }
                    },
                    categories: true
                }
            }),
            prisma.category.findMany({
                where: { business_id: session.user.businessId },
                orderBy: { name: 'asc' },
                include: {
                    _count: { select: { recipes: true } },
                    children: {
                        orderBy: { name: 'asc' },
                        include: {
                            _count: { select: { recipes: true } },
                            children: {
                                orderBy: { name: 'asc' },
                                include: {
                                    _count: { select: { recipes: true } }
                                }
                            }
                        }
                    }
                }
            })
        ]);

        // 2. Build Lookup Maps for O(1) Access
        const ingredientMap = new Map(allIngredients.map(i => [i.id, i]));
        const recipeMap = new Map(allRecipes.map(r => [r.id, r]));

        const canViewFinancials = session?.user?.role === 'ADMIN' || session?.user?.permissions?.includes('VIEW_FINANCIALS');

        const { convertUnit } = await import('@/lib/unit_converter');

        // 3. Define Synchronous Cost Calculator
        const calculateCostInMemory = (recipe: any, depth = 0): { totalCost: number, isAccurate: boolean } => {
            if (depth > 5) return { totalCost: 0, isAccurate: false };
            if (!recipe) return { totalCost: 0, isAccurate: false };

            let totalCost = 0;
            let isAccurate = true;

            // A. Ingredients & Sub-Recipes
            if (recipe.child_items && Array.isArray(recipe.child_items)) {
                for (const item of recipe.child_items) {
                    let lineCost = 0;

                    if (item.child_ingredient_id) {
                        const ing = item.child_ingredient || ingredientMap.get(item.child_ingredient_id);
                        if (ing) {
                            const costPerUnit = Number(ing.cost_per_unit || 0);
                            if (costPerUnit === 0) isAccurate = false;
                            const conversion = convertUnit(1, item.unit || ing.unit, ing.unit, ing.name);
                            const qtyUsed = Number(item.quantity || 0) * conversion;
                            lineCost = qtyUsed * costPerUnit;
                        }
                    } else if (item.child_recipe_id) {
                        const subRecipe = item.child_recipe || recipeMap.get(item.child_recipe_id);
                        if (subRecipe) {
                            const fullSubRecipe = recipeMap.get(item.child_recipe_id);
                            if (fullSubRecipe) {
                                const subResult = calculateCostInMemory(fullSubRecipe, depth + 1);
                                if (!subResult.isAccurate) isAccurate = false;

                                const subBatchCost = subResult.totalCost || 0;
                                const subYield = Number(fullSubRecipe.base_yield_qty) || 1;
                                const costPerYieldUnit = subBatchCost / subYield;

                                const conversion = convertUnit(1, item.unit || fullSubRecipe.base_yield_unit, fullSubRecipe.base_yield_unit, fullSubRecipe.name);
                                const qtyUsed = Number(item.quantity || 0) * conversion;
                                lineCost = qtyUsed * costPerYieldUnit;
                            }
                        }
                    }
                    totalCost += lineCost;
                }
            }

            // B. Packaging (Heuristic Matching)
            const containerType = recipe.container_type || 'tray';
            const isFamily = recipe.name?.toLowerCase().includes('family') || recipe.name?.toLowerCase().includes('large');
            let packagingCost = 0;

            if (containerType === 'bag') {
                const bagName = isFamily ? 'Gallon' : 'Quart';
                const bag = packagingItems.find(p => p.name?.includes(bagName) && (p.name?.includes('Bag') || p.name?.includes('Ziplock')));
                if (bag) packagingCost += Number(bag.cost_per_unit || 0);
            } else {
                const sizeName = isFamily ? 'Large' : 'Small';
                const container = packagingItems.find(p => p.name?.includes(sizeName) && (p.name?.includes('Tray') || p.name?.includes('Container')));
                const lid = packagingItems.find(p => p.name?.includes(sizeName) && p.name?.includes('Lid'));
                if (container) packagingCost += Number(container.cost_per_unit || 0);
                if (lid) packagingCost += Number(lid.cost_per_unit || 0);
            }
            totalCost += packagingCost;
            return { totalCost, isAccurate };
        };

        // 4. Map & Serialize
        const recipeImages: any[] = await prisma.$queryRaw`SELECT id, image_url FROM recipes WHERE business_id = ${session.user.businessId}`;
        const imageMap: Record<string, string> = {};
        recipeImages.forEach(r => { if (r.image_url) imageMap[r.id] = r.image_url; });

        const serializedRecipes = allRecipes.map(r => {
            const { totalCost } = calculateCostInMemory(r);
            return {
                ...r,
                base_yield_qty: Number(r.base_yield_qty || 0),
                calculated_cost: canViewFinancials ? totalCost : null,
                image_url: imageMap[r.id] || null,
                child_items: Array.isArray(r.child_items) ? r.child_items.map(item => ({
                    ...item,
                    quantity: Number(item.quantity || 0),
                    section_batch: item.section_batch ? Number(item.section_batch) : null,
                    child_ingredient: item.child_ingredient ? {
                        ...item.child_ingredient,
                        cost_per_unit: canViewFinancials ? Number(item.child_ingredient.cost_per_unit || 0) : 0
                    } : null,
                    child_recipe: item.child_recipe ? {
                        ...item.child_recipe,
                        base_yield_qty: Number(item.child_recipe.base_yield_qty || 0)
                    } : null
                })) : []
            };
        });

        return (
            <RecipePageClient
                initialRecipes={serializedRecipes as any}
                categories={categories as any}
            />
        );
    } catch (error) {
        console.error("FATAL ERROR RENDERING RECIPES PAGE:", error);
        // Fallback render so the page doesn't throw a 500 digest crash on load
        return (
            <div className="p-8 text-center text-red-500">
                <h1 className="text-2xl font-bold mb-4">Error Loading Recipes</h1>
                <p>There was an error communicating with the database. Our team has been notified.</p>
                <div className="mt-4 opacity-50 text-xs text-left max-w-xl mx-auto overflow-auto max-h-32 bg-slate-100 p-2 rounded">
                    {error instanceof Error ? error.message : "Unknown error"}
                </div>
            </div>
        );
    }
}
