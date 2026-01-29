
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Recipe } from '@/types';

export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const recipe = await prisma.recipe.findUnique({
        where: { id },
        include: {
            child_items: {
                include: {
                    child_recipe: true,
                    child_ingredient: { include: { supplier: true } }
                }
            }
        }
    });

    if (!recipe) {
        return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
    }

    // Transform to App Type (Partial, mostly for validation or specialized clients)
    // But typically PrismaAdapter is used in Server Components. 
    // This API is for Client Component fetching if needed.
    return NextResponse.json(recipe);
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        const body = await request.json();
        const { name, type, yield_qty, yield_unit, items, category_id, allergens, instructions, macros } = body;

        // Interactive Transaction to ensure atomicity
        const updatedId = await prisma.$transaction(async (tx) => {
            // 1. Update Base Info
            const updated = await tx.recipe.update({
                where: { id },
                data: {
                    name,
                    type,
                    base_yield_qty: Number(yield_qty) || 1, // Ensure Number
                    base_yield_unit: yield_unit || 'servings',
                    category_id: category_id || null,
                    categories: {
                        set: (body.category_ids || (category_id ? [category_id] : [])).map((id: string) => ({ id }))
                    },
                    allergens: allergens || null,
                    instructions: instructions || null,
                    macros: macros || null
                }
            });

            // 2. Update Items (Full Replacement Strategy)
            // Delete all existing links
            await tx.recipeItem.deleteMany({
                where: { parent_recipe_id: id }
            });

            // Re-create links
            if (items && items.length > 0) {
                for (const item of items) {
                    if (!item.name) continue;

                    // Find Ingredient or Recipe
                    let linkedIngredient = await tx.ingredient.findFirst({
                        where: { name: { equals: item.name, mode: 'insensitive' } }
                    });

                    let linkedRecipe = null;
                    if (!linkedIngredient) {
                        linkedRecipe = await tx.recipe.findFirst({
                            where: { name: { equals: item.name, mode: 'insensitive' } }
                        });
                    }

                    // If neither, create new Ingredient
                    if (!linkedIngredient && !linkedRecipe) {
                        linkedIngredient = await tx.ingredient.create({
                            data: { name: item.name, cost_per_unit: 0, unit: item.unit || 'units' }
                        });
                    }

                    await tx.recipeItem.create({
                        data: {
                            parent_recipe_id: id,
                            child_ingredient_id: linkedIngredient?.id,
                            child_recipe_id: linkedRecipe?.id,
                            quantity: Number(item.qty) || 0,
                            unit: item.unit || 'units',
                            is_sub_recipe: String(item.is_sub_recipe) === 'true',
                            section_name: item.section_name || null,
                            section_batch: Number(item.section_batch) || 1.0
                        }
                    });
                }
            }
            return updated.id;
        });

        return NextResponse.json({ success: true, id: updatedId });

    } catch (error: any) {
        console.error('Error updating recipe:', error);
        // Extract more info if available
        if (error.code) console.error('Prisma Error Code:', error.code);
        if (error.meta) console.error('Prisma Error Meta:', error.meta);

        return NextResponse.json({ error: 'Failed to update recipe: ' + error.message }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        await prisma.$transaction([
            // 1. Delete items where this recipe is the PARENT (it owns these links)
            prisma.recipeItem.deleteMany({
                where: { parent_recipe_id: id }
            }),
            // 2. Delete items where this recipe is a CHILD (it is used in other recipes)
            prisma.recipeItem.deleteMany({
                where: { child_recipe_id: id }
            }),
            // 3. Delete bundle associations
            prisma.bundleContent.deleteMany({
                where: { recipe_id: id }
            }),
            // 4. Delete the Recipe itself
            prisma.recipe.delete({
                where: { id }
            })
        ]);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Delete Error:", error);
        return NextResponse.json({ error: 'Failed to delete recipe: ' + error.message }, { status: 500 });
    }
}
