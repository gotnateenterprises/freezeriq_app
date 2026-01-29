
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

function splitCsvLine(line: string): string[] {
    const re = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;
    return line.split(re).map(v => {
        v = v.trim();
        if (v.startsWith('"') && v.endsWith('"')) {
            return v.slice(1, -1).replace(/""/g, '"');
        }
        return v;
    });
}

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
        }

        const text = await file.text();
        const isJson = file.name.endsWith('.json');

        // ==========================================
        // 1. JSON BACKUP RESTORE
        // ==========================================
        if (isJson) {
            try {
                const backup = JSON.parse(text);
                const { categories, ingredients, recipes } = backup.data || backup; // Support wrapped or direct

                const logs: string[] = [];

                // A. Restore Categories (2-Pass to handle hierarchy)
                if (categories && Array.isArray(categories)) {
                    // Pass 1: Create/Upsert all categories (without parents initially to avoid missing FK)
                    for (const cat of categories) {
                        await prisma.category.upsert({
                            where: { id: cat.id },
                            create: { id: cat.id, name: cat.name },
                            update: { name: cat.name }
                        });
                    }
                    // Pass 2: Link Parents
                    for (const cat of categories) {
                        if (cat.parent_id) {
                            await prisma.category.update({
                                where: { id: cat.id },
                                data: { parent_id: cat.parent_id }
                            });
                        }
                    }
                    logs.push(`Restored ${categories.length} categories.`);
                }

                // B. Restore Ingredients
                if (ingredients && Array.isArray(ingredients)) {
                    for (const ing of ingredients) {
                        await prisma.ingredient.upsert({
                            where: { id: ing.id },
                            create: {
                                id: ing.id,
                                name: ing.name,
                                cost_per_unit: ing.cost_per_unit,
                                unit: ing.unit,
                                stock_quantity: ing.stock_quantity,
                                supplier_id: ing.supplier_id
                            },
                            update: {
                                name: ing.name,
                                cost_per_unit: ing.cost_per_unit,
                                unit: ing.unit
                            }
                        });
                    }
                    logs.push(`Restored ${ingredients.length} ingredients.`);
                }

                // C. Restore Recipes
                if (recipes && Array.isArray(recipes)) {
                    for (const r of recipes) {
                        // 1. Upsert Recipe
                        await prisma.recipe.upsert({
                            where: { id: r.id },
                            create: {
                                id: r.id,
                                name: r.name,
                                type: r.type,
                                base_yield_qty: r.base_yield_qty,
                                base_yield_unit: r.base_yield_unit,
                                label_text: r.label_text,
                                allergens: r.allergens,
                                instructions: r.instructions,
                                category_id: r.category_id, // Legacy support
                                categories: {
                                    connect: (r.categories || []).map((c: any) => ({ id: c.id }))
                                }
                            },
                            update: {
                                name: r.name,
                                type: r.type,
                                base_yield_qty: r.base_yield_qty,
                                base_yield_unit: r.base_yield_unit,
                                categories: {
                                    set: (r.categories || []).map((c: any) => ({ id: c.id }))
                                }
                            }
                        });

                        // 2. Restore Recipe Items (Clear & Re-create)
                        if (r.child_items) {
                            await prisma.recipeItem.deleteMany({ where: { parent_recipe_id: r.id } });

                            for (const item of r.child_items) {
                                await prisma.recipeItem.create({
                                    data: {
                                        parent_recipe_id: r.id,
                                        child_recipe_id: item.child_recipe_id,
                                        child_ingredient_id: item.child_ingredient_id,
                                        quantity: item.quantity,
                                        unit: item.unit
                                    }
                                });
                            }
                        }
                    }
                    logs.push(`Restored ${recipes.length} recipes.`);
                }

                return NextResponse.json({ success: true, message: "System Restored from Backup", logs });

            } catch (e: any) {
                return NextResponse.json({ error: "Invalid JSON Backup File: " + e.message }, { status: 400 });
            }
        }

        // ==========================================
        // 2. CSV LEGACY IMPORT
        // ==========================================
        const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
        const dataLines = lines.slice(1); // Skip header

        const recipesMap = new Map<string, { type: string, yieldQty: number, yieldUnit: string, ingredients: any[] }>();

        // Parse CSV
        for (const line of dataLines) {
            const cols = splitCsvLine(line);
            if (cols.length < 7) continue;
            const [rName, rType, rYieldQty, rYieldUnit, iName, iQty, iUnit] = cols;
            if (!rName) continue;

            if (!recipesMap.has(rName)) {
                recipesMap.set(rName, {
                    type: rType,
                    yieldQty: parseFloat(rYieldQty) || 5, // Default logic
                    yieldUnit: rYieldUnit || 'servings',
                    ingredients: []
                });
            }
            if (iName) {
                recipesMap.get(rName)?.ingredients.push({ name: iName, qty: parseFloat(iQty) || 0, unit: iUnit });
            }
        }

        const logs: string[] = [];
        let createdCount = 0;
        let updatedCount = 0;

        // Pass 1: Upsert Recipes
        const recipeIds = new Map<string, string>(); // Name -> ID

        for (const [rName, rData] of recipesMap) {
            let dbType = 'menu_item';
            const lowerType = (rData.type || '').toLowerCase();
            if (lowerType.includes('seasoning') || lowerType.includes('mix') || lowerType.includes('prep') || lowerType.includes('sauce')) {
                dbType = 'prep';
            }

            // Check if exists
            const existing = await prisma.recipe.findFirst({ where: { name: rName } });
            let rId = existing?.id;

            if (existing) {
                // Update basic info? Maybe skip to avoid overwriting user edits.
                // For now, let's update yield info but keep ID.
                await prisma.recipe.update({
                    where: { id: existing.id },
                    data: {
                        base_yield_qty: rData.yieldQty,
                        base_yield_unit: rData.yieldUnit,
                        type: dbType as any
                    }
                });
                updatedCount++;
                logs.push(`Updated meta for: ${rName}`);
            } else {
                const newRecipe = await prisma.recipe.create({
                    data: {
                        name: rName,
                        type: dbType as any,
                        base_yield_qty: rData.yieldQty,
                        base_yield_unit: rData.yieldUnit
                    }
                });
                rId = newRecipe.id;
                createdCount++;
                logs.push(`Created new recipe: ${rName}`);
            }
            if (rId) recipeIds.set(rName, rId);
        }

        // Pass 2: Upsert Ingredients & Links
        // Strategy: For a bulk upload, we should probably REPLACE the ingredient list for that recipe to match the CSV?
        // Or append? Replacing feels safer for "Importing a Version".
        // Let's go with: Delete existing items for these recipes and recreate them.

        for (const [rName, rData] of recipesMap) {
            const parentId = recipeIds.get(rName);
            if (!parentId) continue;

            // Clear existing items for this recipe to avoid duplicates/stale data
            await prisma.recipeItem.deleteMany({ where: { parent_recipe_id: parentId } });

            for (const ing of rData.ingredients) {
                // Check if it matches another Recipe (Sub-Recipe)
                const subRecipeId = recipeIds.get(ing.name) || (await prisma.recipe.findFirst({ where: { name: ing.name } }))?.id;

                if (subRecipeId) {
                    await prisma.recipeItem.create({
                        data: {
                            parent_recipe_id: parentId,
                            child_recipe_id: subRecipeId,
                            quantity: ing.qty,
                            unit: ing.unit
                        }
                    });
                } else {
                    // Ingredient
                    let ingId = '';
                    const existingIng = await prisma.ingredient.findFirst({ where: { name: ing.name } });
                    if (existingIng) {
                        ingId = existingIng.id;
                    } else {
                        const newIng = await prisma.ingredient.create({
                            data: { name: ing.name, cost_per_unit: 0, unit: ing.unit }
                        });
                        ingId = newIng.id;
                    }

                    await prisma.recipeItem.create({
                        data: {
                            parent_recipe_id: parentId,
                            child_ingredient_id: ingId,
                            quantity: ing.qty,
                            unit: ing.unit
                        }
                    });
                }
            }
        }

        return NextResponse.json({
            success: true,
            message: `Imported ${createdCount} new, Updated ${updatedCount} recipes.`,
            logs
        });

    } catch (e: any) {
        console.error("Upload Error:", e);
        return NextResponse.json({ error: e.message || 'Server Error' }, { status: 500 });
    }
}
