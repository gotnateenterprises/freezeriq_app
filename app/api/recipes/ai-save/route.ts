
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const { recipe } = await req.json();

        if (!recipe || !recipe.name) {
            return NextResponse.json({ error: "Invalid recipe data" }, { status: 400 });
        }

        // 1. Create the Recipe (all fields via standard Prisma — no raw SQL)
        const newRecipe = await prisma.recipe.create({
            data: {
                name: recipe.name,
                type: 'menu_item',
                base_yield_qty: 1,
                base_yield_unit: 'Batch',
                instructions: Array.isArray(recipe.instructions)
                    ? recipe.instructions.join('\n')
                    : (recipe.instructions || null),
                label_text: recipe.description || null,
                description: recipe.description || null,
                cook_time: recipe.cook_time || null,
                business_id: businessId
            }
        });

        // 2. Create Recipe Items (Ingredients) — tenant-scoped
        if (recipe.ingredients && recipe.ingredients.length > 0) {
            for (const ing of recipe.ingredients) {
                let ingredientId = ing.matched_ingredient_id;

                // If not matched by ID, try to find by name within this tenant or create new
                if (!ingredientId) {
                    const existing = await prisma.ingredient.findFirst({
                        where: {
                            name: ing.name,
                            business_id: businessId
                        }
                    });

                    if (existing) {
                        ingredientId = existing.id;
                    } else {
                        // Create new Ingredient scoped to this tenant
                        const newIng = await prisma.ingredient.create({
                            data: {
                                name: ing.name,
                                unit: ing.unit || 'units',
                                cost_per_unit: 0,
                                business_id: businessId,
                                needs_review: true
                            }
                        });
                        ingredientId = newIng.id;
                    }
                }

                await prisma.recipeItem.create({
                    data: {
                        parent_recipe_id: newRecipe.id,
                        child_ingredient_id: ingredientId,
                        quantity: parseFloat(ing.approx_qty) || 1,
                        unit: ing.unit || 'units'
                    }
                });
            }
        }

        return NextResponse.json({ success: true, recipeId: newRecipe.id });

    } catch (e: any) {
        console.error("Save AI Recipe Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
