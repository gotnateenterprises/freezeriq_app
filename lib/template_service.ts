
import { prisma } from './db';

/**
 * Service to handle "Blueprint" deployments (pushing template data to other tenants)
 */
export class TemplateService {
    /**
     * Clones all Recipes, Ingredients, and Suppliers from one business to another.
     * This is useful for "PRO" users who get the master library of Freezer Chef data.
     */
    static async cloneBusinessData(sourceBusinessId: string, targetBusinessId: string, categoryIds?: string[]) {
        console.log(`[TemplateService] Cloning data from ${sourceBusinessId} to ${targetBusinessId}`);

        return await prisma.$transaction(async (tx) => {
            // ID Mapping Stores: { [oldId]: newId }
            const supplierMap = new Map<string, string>();
            const ingredientMap = new Map<string, string>();
            const recipeMap = new Map<string, string>();

            // 1. CLONE INGREDIENTS & SUPPLIERS
            // We fetch ingredients first to know WHICH suppliers we actually need
            const sourceIngredients = await tx.ingredient.findMany({
                where: { business_id: sourceBusinessId }
            });

            // Find all unique supplier IDs used by these ingredients
            const supplierIds = new Set<string>();
            sourceIngredients.forEach(i => {
                if (i.supplier_id) supplierIds.add(i.supplier_id);
            });

            // Fetch the actual supplier objects
            const sourceSuppliers = await tx.supplier.findMany({
                where: { id: { in: Array.from(supplierIds) } }
            });

            // Fetch existing suppliers in target to deduplicate
            const existingTargetSuppliers = await tx.supplier.findMany({
                where: { business_id: targetBusinessId }
            });

            // Clone Suppliers
            for (const s of sourceSuppliers) {
                // Check if we already have this supplier in target
                const existing = existingTargetSuppliers.find(
                    ex => ex.name.toLowerCase() === s.name.toLowerCase()
                );

                if (existing) {
                    console.log(`[TemplateService] Found existing supplier '${s.name}', skipping creation.`);
                    supplierMap.set(s.id, existing.id);
                } else {
                    const newSupplier = await tx.supplier.create({
                        data: {
                            name: s.name,
                            contact_email: s.contact_email,
                            logo_url: s.logo_url,
                            business_id: targetBusinessId
                        }
                    });
                    supplierMap.set(s.id, newSupplier.id);
                    existingTargetSuppliers.push(newSupplier); // Add to local cache
                }
            }

            // Clone Ingredients
            for (const ing of sourceIngredients) {
                const newIng = await tx.ingredient.create({
                    data: {
                        name: ing.name,
                        supplier_id: ing.supplier_id ? supplierMap.get(ing.supplier_id) : null,
                        sku: ing.sku,
                        cost_per_unit: ing.cost_per_unit,
                        unit: ing.unit,
                        stock_quantity: 0, // Reset stock for new tenant
                        purchase_unit: ing.purchase_unit,
                        purchase_quantity: ing.purchase_quantity,
                        purchase_cost: ing.purchase_cost,
                        business_id: targetBusinessId
                    }
                });
                ingredientMap.set(ing.id, newIng.id);
            }

            // 3. CLONE RECIPE SHELLS (Pass 1)
            const where: any = { business_id: sourceBusinessId };
            if (categoryIds && categoryIds.length > 0) {
                where.category_id = { in: categoryIds };
            }

            const sourceRecipes = await tx.recipe.findMany({
                where
            });

            for (const r of sourceRecipes) {
                const newRecipe = await tx.recipe.create({
                    data: {
                        name: r.name,
                        type: r.type,
                        base_yield_qty: r.base_yield_qty,
                        base_yield_unit: r.base_yield_unit,
                        category_id: r.category_id,
                        business_id: targetBusinessId
                    }
                });
                recipeMap.set(r.id, newRecipe.id);
            }

            // 4. CLONE RECIPE ITEMS (Pass 2)
            for (const oldRecipeId of recipeMap.keys()) {
                const sourceItems = await tx.recipeItem.findMany({
                    where: { parent_recipe_id: oldRecipeId }
                });

                const newRecipeId = recipeMap.get(oldRecipeId)!;

                for (const item of sourceItems) {
                    await tx.recipeItem.create({
                        data: {
                            parent_recipe_id: newRecipeId,
                            child_ingredient_id: item.child_ingredient_id ? ingredientMap.get(item.child_ingredient_id) : null,
                            child_recipe_id: item.child_recipe_id ? recipeMap.get(item.child_recipe_id) : null,
                            quantity: item.quantity,
                            unit: item.unit,
                            is_sub_recipe: item.is_sub_recipe,
                            section_name: item.section_name,
                            section_batch: item.section_batch
                        }
                    });
                }
            }

            console.log(`[TemplateService] Successfully cloned ${sourceRecipes.length} recipes and ${sourceIngredients.length} ingredients.`);
            return {
                recipesCloned: sourceRecipes.length,
                ingredientsCloned: sourceIngredients.length
            };
        });
    }
}
