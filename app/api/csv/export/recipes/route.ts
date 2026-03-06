
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const businessId = session.user.businessId;

        const recipes = await prisma.recipe.findMany({
            where: { business_id: businessId },
            include: {
                child_items: {
                    include: {
                        child_recipe: true,
                        child_ingredient: true
                    }
                }
            }
        });

        const headers = ["Recipe Name", "Type", "Yield", "Yield Unit", "Ingredient Name", "Ingredient Qty", "Ingredient Unit"];
        let csvContent = headers.join(",") + "\n";

        recipes.forEach(recipe => {
            const recipeName = `"${recipe.name.replace(/"/g, '""')}"`;
            const recipeType = recipe.type || '';
            const yieldQty = recipe.base_yield_qty || '';
            const yieldUnit = recipe.base_yield_unit || '';

            if (recipe.child_items.length === 0) {
                csvContent += `${recipeName},${recipeType},${yieldQty},${yieldUnit},,,\n`;
            } else {
                recipe.child_items.forEach(item => {
                    const itemName = `"${(item.child_recipe?.name || item.child_ingredient?.name || '').replace(/"/g, '""')}"`;
                    const itemQty = item.quantity || 0;
                    const itemUnit = item.unit || '';
                    csvContent += `${recipeName},${recipeType},${yieldQty},${yieldUnit},${itemName},${itemQty},${itemUnit}\n`;
                });
            }
        });

        return new NextResponse(csvContent, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': 'attachment; filename=recipes.csv'
            }
        });

    } catch (e: any) {
        console.error("Recipe Export Error:", e);
        return NextResponse.json({ error: e.message || 'Server Error' }, { status: 500 });
    }
}
