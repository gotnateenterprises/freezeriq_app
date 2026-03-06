
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Recipe } from '@/types';
import { auth } from '@/auth';

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
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, type, yield_qty, yield_unit, container_type, items, category_id, allergens, instructions, label_text, macros, image_url, description, cook_time } = body;

        // Interactive Transaction to ensure atomicity
        console.log(`[Recipe API] Updating recipe ${id} with data:`, JSON.stringify({ ...body, items: undefined }));
        const updatedId = await prisma.$transaction(async (tx) => {
            // 1. Update Base Info (scalars)
            const updated = await tx.recipe.update({
                where: { id },
                data: {
                    name,
                    type,
                    base_yield_qty: Number(yield_qty) || 1,
                    base_yield_unit: yield_unit || 'servings',
                    container_type: container_type || 'tray',
                    category_id: category_id || null,
                    categories: {
                        set: (body.category_ids || (category_id ? [category_id] : [])).map((id: string) => ({ id }))
                    },
                    allergens: allergens || null,
                    instructions: instructions || null,
                    label_text: label_text || null,
                    macros: macros || null
                }
            });

            // HOTFIX: Update specific fields via Raw SQL to bypass Prisma Client sync issues
            if (image_url !== undefined) {
                console.log(`[Recipe API] Updating image_url for ${id}`);
                await tx.$executeRawUnsafe(`UPDATE recipes SET image_url = $1 WHERE id = $2`, image_url || null, id);
            }
            if (description !== undefined) {
                console.log(`[Recipe API] Updating description for ${id}`);
                await tx.$executeRawUnsafe(`UPDATE recipes SET description = $1 WHERE id = $2`, description || null, id);
            }
            if (allergens !== undefined) {
                console.log(`[Recipe API] Updating allergens for ${id}`);
                await tx.$executeRawUnsafe(`UPDATE recipes SET allergens = $1 WHERE id = $2`, allergens || null, id);
            }
            if (cook_time !== undefined) {
                console.log(`[Recipe API] Updating cook_time for ${id}: "${cook_time}"`);
                await tx.$executeRawUnsafe(`UPDATE recipes SET cook_time = $1 WHERE id = $2`, cook_time || null, id);
            }

            // 2. Update Items (Full Replacement Strategy)
            if (items !== undefined) {
                // Delete all existing links
                await tx.recipeItem.deleteMany({
                    where: { parent_recipe_id: id }
                });

                if (items && items.length > 0) {
                    const names: string[] = [...new Set(items.map((i: any) => i.name).filter(Boolean))] as string[];

                    // Batch fetch existing ingredients and recipes
                    const [existingIngs, existingRecipes] = await Promise.all([
                        tx.ingredient.findMany({
                            where: { business_id: session?.user?.businessId as string, name: { in: names, mode: 'insensitive' } }
                        }),
                        tx.recipe.findMany({
                            where: { business_id: session?.user?.businessId as string, name: { in: names, mode: 'insensitive' } }
                        })
                    ]);

                    const ingMap = new Map<string, any>(existingIngs.map((i: any) => [i.name.toLowerCase(), i]));
                    const recMap = new Map<string, any>(existingRecipes.map((r: any) => [r.name.toLowerCase(), r]));

                    const itemsToCreate = [];

                    for (const item of items) {
                        if (!item.name) continue;
                        const nameKey = item.name.toLowerCase();
                        const isSub = String(item.is_sub_recipe) === 'true';

                        let childRecipeId = null;
                        let childIngredientId = null;

                        const subRecipeMatch = recMap.get(nameKey);
                        if (subRecipeMatch) {
                            childRecipeId = subRecipeMatch.id;
                        } else {
                            let ing = ingMap.get(nameKey);
                            if (!ing) {
                                // Create ingredient if it doesn't exist
                                ing = await tx.ingredient.create({
                                    data: {
                                        name: item.name,
                                        unit: item.unit || 'units',
                                        cost_per_unit: 0,
                                        business_id: session?.user?.businessId,
                                        needs_review: true // Mark for review
                                    }
                                });
                                ingMap.set(nameKey, ing);
                            }
                            childIngredientId = ing.id;
                        }

                        itemsToCreate.push({
                            parent_recipe_id: id,
                            child_recipe_id: childRecipeId,
                            child_ingredient_id: childIngredientId,
                            quantity: Number(item.qty) || 0,
                            unit: item.unit || 'units',
                            is_sub_recipe: isSub,
                            section_name: item.section_name || null,
                            section_batch: Number(item.section_batch) || 1.0
                        });
                    }

                    if (itemsToCreate.length > 0) {
                        await tx.recipeItem.createMany({
                            data: itemsToCreate
                        });
                    }
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
