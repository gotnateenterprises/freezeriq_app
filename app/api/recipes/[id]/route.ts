
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Recipe } from '@/types';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

    if (recipe.business_id !== session.user.businessId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
            // 1. Update Base Info (scalars + metadata)
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
                    macros: macros || null,
                    image_url: image_url !== undefined ? (image_url || null) : undefined,
                    description: description !== undefined ? (description || null) : undefined,
                    cook_time: cook_time !== undefined ? (cook_time || null) : undefined
                } as any
            });

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
                        const isSub = item.is_sub_recipe === true || item.is_sub_recipe === 'true';

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

        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        // Ownership check
        const existing = await prisma.recipe.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        // RECIPE-DELETE-GUARD-1. This handler used to clear the recipe out of
        // every bundle (`bundleContent.deleteMany`) and out of every other
        // recipe that used it as a component, and only then delete it — so an
        // ordinary "delete recipe" click silently shrank bundles the user was
        // not looking at. BUNDLE-DATA-RECONCILIATION-1 traced 21 lost bundle
        // rows to exactly this: 19 of the 20 missing recipe ids no longer exist.
        //
        // The database already had the right answer. bundle_contents.recipe_id
        // is ON DELETE RESTRICT, so Postgres would have refused the delete; the
        // manual deleteMany above is what defeated that protection. The fix is
        // to stop defeating it and report the impact instead.
        //
        // Counts are taken over ALL references so a leftover cross-tenant row
        // can never be silently destroyed, but only THIS tenant's bundle and
        // recipe names are ever returned.
        const [bundleRefs, subRecipeRefs, ownedBundleRows, ownedParentRows] = await Promise.all([
            prisma.bundleContent.count({ where: { recipe_id: id } }),
            prisma.recipeItem.count({ where: { child_recipe_id: id } }),
            prisma.bundleContent.findMany({
                where: { recipe_id: id, bundle: { business_id: session.user.businessId } },
                select: { bundle: { select: { id: true, name: true } } }
            }),
            prisma.recipeItem.findMany({
                where: { child_recipe_id: id, parent_recipe: { business_id: session.user.businessId } },
                select: { parent_recipe: { select: { id: true, name: true } } }
            }),
        ]);

        if (bundleRefs > 0 || subRecipeRefs > 0) {
            const uniq = <T extends { id: string }>(rows: (T | null)[]) => {
                const seen = new Map<string, T>();
                for (const r of rows) if (r && !seen.has(r.id)) seen.set(r.id, r);
                return [...seen.values()];
            };
            const bundles = uniq(ownedBundleRows.map(r => r.bundle));
            const recipes = uniq(ownedParentRows.map(r => r.parent_recipe));

            // The message has to stand on its own: one delete surface shows only
            // this string, so "in use" alone would leave the user stuck.
            const parts: string[] = [];
            if (bundles.length > 0) {
                parts.push(`${bundles.length} bundle${bundles.length === 1 ? '' : 's'} (${bundles.map(b => b.name).join(', ')})`);
            }
            if (recipes.length > 0) {
                parts.push(`${recipes.length} other recipe${recipes.length === 1 ? '' : 's'} (${recipes.map(r => r.name).join(', ')})`);
            }
            const where = parts.length > 0 ? ` It is currently used in ${parts.join(' and ')}.` : ' It is currently in use.';

            return NextResponse.json({
                error: `Can't delete this recipe yet.${where} Remove or replace it there first, then delete the recipe.`,
                code: 'RECIPE_IN_USE',
                bundleCount: bundles.length,
                bundles,
                recipeCount: recipes.length,
                recipes,
            }, { status: 409 });
        }

        // Nothing depends on it. Only rows the recipe itself owns are cleaned up
        // — its own ingredient list — and that plus the delete stay atomic.
        await prisma.$transaction([
            prisma.recipeItem.deleteMany({
                where: { parent_recipe_id: id }
            }),
            prisma.recipe.delete({
                where: { id }
            })
        ]);

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Delete Error:", error);
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}
