
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const { recipe } = await req.json();

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
                // Save the social media hook in instructions or as a separate field if available
                label_text: recipe.description
            }
        });

        // 2. Create Recipe Items (Ingredients)
        const recipeItems = recipe.ingredients
            .filter((ing: any) => ing.matched_ingredient_id) // Only add matched ingredients
            .map((ing: any) => ({
                parent_recipe_id: newRecipe.id,
                child_ingredient_id: ing.matched_ingredient_id,
                quantity: ing.approx_qty || 1,
                unit: ing.unit || 'units'
            }));

        if (recipeItems.length > 0) {
            await prisma.recipeItem.createMany({
                data: recipeItems
            });
        }

        return NextResponse.json({ success: true, recipeId: newRecipe.id });

    } catch (e: any) {
        console.error("Save AI Recipe Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
