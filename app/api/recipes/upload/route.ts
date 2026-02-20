
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

                // B. Restore Suppliers (must come before ingredients)
                if (backup.data?.suppliers && Array.isArray(backup.data.suppliers)) {
                    for (const sup of backup.data.suppliers) {
                        await prisma.supplier.upsert({
                            where: { id: sup.id },
                            create: {
                                id: sup.id,
                                name: sup.name,
                                contact_email: sup.contact_email,
                                phone_number: sup.phone_number,
                                website_url: sup.website_url,
                                business_id: sup.business_id
                            },
                            update: {
                                name: sup.name,
                                contact_email: sup.contact_email
                            }
                        });
                    }
                    logs.push(`Restored ${backup.data.suppliers.length} suppliers.`);
                }

                // C. Restore Ingredients
                if (ingredients && Array.isArray(ingredients)) {
                    for (const ing of ingredients) {
                        // Check if supplier exists before trying to reference it
                        let validSupplierId = null;
                        if (ing.supplier_id) {
                            const supplierExists = await prisma.supplier.findUnique({
                                where: { id: ing.supplier_id }
                            });
                            if (supplierExists) {
                                validSupplierId = ing.supplier_id;
                            }
                        }

                        await prisma.ingredient.upsert({
                            where: { id: ing.id },
                            create: {
                                id: ing.id,
                                name: ing.name,
                                cost_per_unit: ing.cost_per_unit,
                                unit: ing.unit,
                                stock_quantity: ing.stock_quantity || 0,
                                supplier_id: validSupplierId, // Only set if supplier exists
                                business_id: ing.business_id,
                                needs_review: ing.needs_review ?? true // Default to true if not specified in backup
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

                // C2. Restore Packaging Items
                if (backup.data?.packaging_items && Array.isArray(backup.data.packaging_items)) {
                    for (const item of backup.data.packaging_items) {
                        await prisma.packagingItem.upsert({
                            where: { id: item.id },
                            create: {
                                id: item.id,
                                name: item.name,
                                type: item.type,
                                cost_per_unit: item.cost_per_unit || 0,
                                quantity: item.quantity || 0,
                                reorderUrl: item.reorderUrl,
                                lowStockThreshold: item.lowStockThreshold || 10,
                                business_id: item.business_id
                            },
                            update: {
                                name: item.name,
                                type: item.type,
                                cost_per_unit: item.cost_per_unit || 0,
                                quantity: item.quantity || 0,
                                reorderUrl: item.reorderUrl,
                                lowStockThreshold: item.lowStockThreshold || 10
                            }
                        });
                    }
                    logs.push(`Restored ${backup.data.packaging_items.length} packaging items.`);
                }

                // D. Restore Recipes
                if (recipes && Array.isArray(recipes)) {
                    // PASS 1: Upsert All Recipe Headers (to ensure IDs exist)
                    for (const r of recipes) {
                        try {
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
                                    category_id: r.category_id,
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

                            // Clear existing items to prepare for fresh import
                            await prisma.recipeItem.deleteMany({ where: { parent_recipe_id: r.id } });

                        } catch (err) {
                            console.error(`Failed to upsert recipe ${r.name}:`, err);
                            logs.push(`Error upserting ${r.name}`);
                        }
                    }

                    // PASS 2: Create Relationships (Items)
                    // Now that all recipes exist, we can safely link them.
                    let restoredItems = 0;
                    for (const r of recipes) {
                        if (r.child_items) {
                            for (const item of r.child_items) {
                                try {
                                    // Verify target exists if it's a sub-recipe
                                    if (item.child_recipe_id) {
                                        const targetExists = await prisma.recipe.count({ where: { id: item.child_recipe_id } });
                                        if (!targetExists) {
                                            console.warn(`Skipping missing sub-recipe link: ${item.child_recipe_id} for ${r.name}`);
                                            continue;
                                        }
                                    }

                                    await prisma.recipeItem.create({
                                        data: {
                                            parent_recipe_id: r.id,
                                            child_recipe_id: item.child_recipe_id,
                                            child_ingredient_id: item.child_ingredient_id,
                                            quantity: item.quantity,
                                            unit: item.unit,
                                            // Handle legacy fields if present in backup (optional)
                                            is_sub_recipe: item.is_sub_recipe,
                                            section_name: item.section_name,
                                            section_batch: item.section_batch
                                        }
                                    });
                                    restoredItems++;
                                } catch (err) {
                                    console.error(`Failed to link item for ${r.name}:`, err);
                                }
                            }
                        }
                    }
                    logs.push(`Restored ${recipes.length} recipes and ${restoredItems} items.`);
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
                            data: { 
                                name: ing.name, 
                                cost_per_unit: 0, 
                                unit: ing.unit,
                                needs_review: true // Mark for review since it's auto-created
                            } as any
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
