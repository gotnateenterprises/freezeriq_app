
import { prisma } from '@/lib/db';
import RecipePageClient from '@/components/RecipePageClient';

export const dynamic = 'force-dynamic';

export default async function RecipesPage() {
    const recipes = await prisma.recipe.findMany({
        orderBy: { name: 'asc' },
        include: {
            _count: { select: { child_items: true } },
            child_items: {
                select: {
                    quantity: true,
                    child_recipe: { select: { name: true } },
                    child_ingredient: {
                        select: {
                            name: true,
                            cost_per_unit: true,
                            unit: true
                        }
                    }
                }
            },
            categories: true
        }
    });

    const categories = await prisma.category.findMany({
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
    });

    const { calculateRecipeCost } = await import('@/lib/cost_engine');

    // Explicitly convert Decimals to Numbers for Next.js Serializability
    const serializedRecipes = await Promise.all(recipes.map(async (r) => {
        const costData = await calculateRecipeCost(r.id);

        return {
            ...r,
            base_yield_qty: Number(r.base_yield_qty),
            calculated_cost: costData.totalCost, // New field for pre-calculated recursive cost
            child_items: r.child_items.map(item => ({
                ...item,
                quantity: Number(item.quantity),
                child_ingredient: item.child_ingredient ? {
                    ...item.child_ingredient,
                    cost_per_unit: Number(item.child_ingredient.cost_per_unit)
                } : null
            }))
        };
    }));

    return (
        <RecipePageClient
            initialRecipes={serializedRecipes as any}
            categories={categories as any}
        />
    );
}
