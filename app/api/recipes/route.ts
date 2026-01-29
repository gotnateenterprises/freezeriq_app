
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const data = await req.json();
        const { name, type, yield_qty, yield_unit, items, allergens, instructions } = data;

        // 1. Create the Parent Recipe
        const recipe = await prisma.recipe.create({
            data: {
                name,
                type,
                base_yield_qty: Number(yield_qty) || 1,
                base_yield_unit: yield_unit || 'servings',
                // Legacy: category_id (keep for now if needed, but primary is m-n)
                category_id: data.category_id || null,
                categories: {
                    connect: (data.category_ids || (data.category_id ? [data.category_id] : [])).map((id: string) => ({ id }))
                },
                allergens: allergens || null,
                instructions: instructions || null,
                macros: data.macros || null
            }
        });

        // 2. Process Items
        if (items && Array.isArray(items)) {
            for (const item of items) {
                if (!item.name) continue;

                const isSub = String(item.is_sub_recipe) === 'true';
                const sectionName = item.section_name || null;
                const sectionBatch = Number(item.section_batch) || 1.0;

                // Check for Sub-Recipe Match
                const subRecipe = await prisma.recipe.findFirst({
                    where: { name: { equals: item.name, mode: 'insensitive' } }
                });

                if (subRecipe) {
                    // Link as Sub-Recipe
                    await prisma.recipeItem.create({
                        data: {
                            parent_recipe_id: recipe.id,
                            child_recipe_id: subRecipe.id,
                            quantity: Number(item.qty) || 0,
                            unit: item.unit,
                            is_sub_recipe: isSub,
                            section_name: sectionName,
                            section_batch: sectionBatch
                        }
                    });
                } else {
                    // Link as Ingredient
                    // Find or Create Ingredient
                    let ingId: string;
                    const existingIng = await prisma.ingredient.findFirst({
                        where: { name: { equals: item.name, mode: 'insensitive' } }
                    });

                    if (existingIng) {
                        ingId = existingIng.id;
                    } else {
                        const newIng = await prisma.ingredient.create({
                            data: {
                                name: item.name, // Use original casing for creation
                                unit: item.unit || 'unit',
                                cost_per_unit: 0
                            }
                        });
                        ingId = newIng.id;
                    }

                    await prisma.recipeItem.create({
                        data: {
                            parent_recipe_id: recipe.id,
                            child_ingredient_id: ingId,
                            quantity: Number(item.qty) || 0,
                            unit: item.unit,
                            is_sub_recipe: isSub,
                            section_name: sectionName,
                            section_batch: sectionBatch
                        }
                    });
                }
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
        const recipes = await prisma.recipe.findMany({
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                type: true
            }
        });
        return NextResponse.json({ recipes });
    } catch (e) {
        console.error("Fetch Recipes Error:", e);
        return NextResponse.json({ error: "Failed to fetch recipes" }, { status: 500 });
    }
}
