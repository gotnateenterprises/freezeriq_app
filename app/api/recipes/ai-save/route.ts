
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';

export async function POST(req: Request) {
    try {
        const { recipe } = await req.json();

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        if (!recipe || !recipe.name) {
            return NextResponse.json({ error: "Invalid recipe data" }, { status: 400 });
        }

        // 1. Create the Recipe
        const newRecipe = await prisma.recipe.create({
            data: {
                name: recipe.name,
                type: 'menu_item', // Default for AI recipes
                base_yield_qty: 1, // Default yield
                base_yield_unit: 'Batch',
                instructions: recipe.instructions.join('\n'),
                label_text: recipe.description,
                business_id: session.user.businessId
            }
        });

        // HOTFIX: Update specific fields via Raw SQL to bypass Prisma Client sync issues
        // AI recipes might have cook_time suggested by the LLM
        if (recipe.cook_time || recipe.description) {
            await prisma.$executeRawUnsafe(
                `UPDATE recipes SET description = $1, cook_time = $2 WHERE id = $3`,
                recipe.description || null,
                recipe.cook_time || null,
                newRecipe.id
            );
        }

        // 2. Create Recipe Items (Ingredients)
        // 2. Create Recipe Items (Ingredients)
        // Fix: Don't just filter matched ones. Create new ingredients if needed.
        if (recipe.ingredients && recipe.ingredients.length > 0) {
            for (const ing of recipe.ingredients) {
                let ingredientId = ing.matched_ingredient_id;

                // If not matched by ID, try to find by name or create new
                if (!ingredientId) {
                    const trimmedName = ing.name.trim();
                    const existing = await prisma.ingredient.findFirst({
                        where: {
                            business_id: session.user.businessId,
                            name: { equals: trimmedName, mode: 'insensitive' }
                        }
                    });

                    if (existing) {
                        ingredientId = existing.id;
                    } else {
                        // Create new Ingredient
                        const newIng = await prisma.ingredient.create({
                            data: {
                                name: trimmedName,
                                unit: ing.unit ? ing.unit.trim().toLowerCase() : 'units',
                                cost_per_unit: 0,
                                business_id: session.user.businessId,
                                needs_review: true // Mark for review since it's auto-created
                            } as any
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

        revalidatePath('/recipes');
        return NextResponse.json({ success: true, recipeId: newRecipe.id });

    } catch (e: any) {
        console.error("Save AI Recipe Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
