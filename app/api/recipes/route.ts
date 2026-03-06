
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const data = await req.json();
        const { name, type, yield_qty, yield_unit, container_type, items, allergens, instructions, label_text, image_url, description, cook_time } = data;

        const session = await auth();
        console.log('GET /api/recipes - Session Business ID:', session?.user?.businessId);
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // 1. Create the Parent Recipe
        console.log(`[Recipe API] Creating new recipe with name: ${name}`);
        const recipe = await prisma.recipe.create({
            data: {
                name,
                type,
                base_yield_qty: Number(yield_qty) || 1,
                base_yield_unit: yield_unit || 'servings',
                container_type: container_type || 'tray',
                // Legacy: category_id (keep for now if needed, but primary is m-n)
                category_id: data.category_id || null,
                categories: {
                    connect: (data.category_ids || (data.category_id ? [data.category_id] : [])).map((id: string) => ({ id }))
                },
                allergens: allergens || null,
                instructions: instructions || null,
                label_text: label_text || null,
                macros: data.macros || null,
                business_id: session.user.businessId
            } as any
        });

        // HOTFIX: Update specific fields via Raw SQL immediately after creation
        console.log(`[Recipe API] Updating metadata for new recipe ${recipe.id}: cook_time="${cook_time}"`);
        await prisma.$executeRawUnsafe(
            `UPDATE recipes SET description = $1, allergens = $2, image_url = $3, cook_time = $4 WHERE id = $5`,
            description || null,
            allergens || null,
            image_url || null,
            cook_time || null,
            recipe.id
        );

        // 2. Process Items
        if (items && Array.isArray(items) && items.length > 0) {
            const names: string[] = [...new Set(items.map((i: any) => i.name).filter(Boolean))] as string[];

            // Batch fetch existing ingredients and recipes
            const [existingIngs, existingRecipes] = await Promise.all([
                prisma.ingredient.findMany({
                    where: {
                        business_id: session.user.businessId,
                        name: { in: names, mode: 'insensitive' }
                    }
                }),
                prisma.recipe.findMany({
                    where: {
                        business_id: session.user.businessId,
                        name: { in: names, mode: 'insensitive' }
                    }
                })
            ]);

            const ingMap = new Map(existingIngs.map(i => [i.name.toLowerCase(), i]));
            const recMap = new Map(existingRecipes.map(r => [r.name.toLowerCase(), r]));

            const recipeItemsData = [];

            for (const item of items) {
                if (!item.name) continue;
                const trimmedName = item.name.trim();
                const nameKey = trimmedName.toLowerCase();
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
                        console.log(`[Recipe API] Automatically creating new ingredient: "${trimmedName}"`);
                        ing = await prisma.ingredient.create({
                            data: {
                                name: trimmedName,
                                unit: item.unit || 'unit',
                                cost_per_unit: 0,
                                business_id: session.user.businessId,
                                needs_review: true // Mark for review since it's auto-created
                            } as any
                        });
                        ingMap.set(nameKey, ing);
                    }
                    childIngredientId = ing.id;
                }

                recipeItemsData.push({
                    parent_recipe_id: recipe.id,
                    child_recipe_id: childRecipeId,
                    child_ingredient_id: childIngredientId,
                    quantity: Number(item.qty) || 0,
                    unit: item.unit || 'unit',
                    is_sub_recipe: isSub,
                    section_name: item.section_name || null,
                    section_batch: Number(item.section_batch) || 1.0
                });
            }

            if (recipeItemsData.length > 0) {
                await prisma.recipeItem.createMany({
                    data: recipeItemsData
                });
            }
        }

        return NextResponse.json({ success: true, recipe });

    } catch (e: any) {
        console.error("Save Recipe Error:", e);
        if (e.code) console.error('Prisma Error Code:', e.code);
        if (e.meta) console.error('Prisma Error Meta:', e.meta);
        return NextResponse.json({ error: e.message || "Failed to save recipe" }, { status: 500 });
    }
}

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const recipes = await prisma.recipe.findMany({
            where: { business_id: session.user.businessId },
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                type: true,
                base_yield_qty: true,
                base_yield_unit: true,
                child_items: {
                    include: {
                        child_ingredient: { select: { cost_per_unit: true, unit: true } },
                        child_recipe: { select: { id: true, base_yield_qty: true, base_yield_unit: true } }
                    }
                }
            }
        });

        // Improved approximation with basic unit conversion
        const { convertUnit } = await import('@/lib/unit_converter');

        const recipesWithCost = recipes.map(recipe => {
            let totalCost = 0;
            recipe.child_items.forEach(item => {
                if (item.child_ingredient) {
                    const ing = item.child_ingredient;
                    const qty = Number(item.quantity) || 0;
                    const costPerUnit = Number(ing.cost_per_unit) || 0;

                    // Simple unit check
                    let lineCost = qty * costPerUnit;
                    if (item.unit !== ing.unit) {
                        try {
                            const conversionRate = convertUnit(1, item.unit, ing.unit, recipe.name);
                            lineCost = (qty * conversionRate) * costPerUnit;
                        } catch (e) {
                            // Fallback to simple multiplier if conversion fails
                        }
                    }
                    totalCost += lineCost;
                } else if (item.child_recipe) {
                    // One level of sub-recipe support: look for the sub-recipe in our current list
                    const subRecipe = recipes.find(r => r.id === item.child_recipe_id);
                    if (subRecipe) {
                        // Recursively calculate cost for the sub-recipe (simplified)
                        let subTotal = 0;
                        subRecipe.child_items.forEach(subItem => {
                            if (subItem.child_ingredient) {
                                subTotal += (Number(subItem.quantity) * Number(subItem.child_ingredient.cost_per_unit || 0));
                            }
                        });
                        const subYield = Number(subRecipe.base_yield_qty) || 1;
                        const subCostPerUnit = subTotal / subYield;
                        totalCost += (Number(item.quantity) * subCostPerUnit);
                    }
                }
            });

            const yieldQty = Number(recipe.base_yield_qty) || 1;
            return {
                ...recipe,
                base_yield_qty: yieldQty,
                calculated_cost: totalCost,
                cost_per_unit: totalCost / yieldQty
            };
        });

        return NextResponse.json({ recipes: recipesWithCost });
    } catch (e) {
        console.error("Fetch Recipes Error:", e);
        return NextResponse.json({ error: "Failed to fetch recipes" }, { status: 500 });
    }
}

