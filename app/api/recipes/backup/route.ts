
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const timestamp = new Date().toISOString().split('T')[0];

        const [recipes, categories, ingredients, packaging_items, suppliers] = await Promise.all([
            prisma.recipe.findMany({
                include: {
                    categories: true, // Modern M-N
                    child_items: true // Instructions/Ingredients
                }
            }),
            prisma.category.findMany({
                include: { recipes: { select: { id: true } } }
            }),
            prisma.ingredient.findMany(),
            prisma.packagingItem.findMany(),
            prisma.supplier.findMany()
        ]);

        const backupData = {
            metadata: {
                version: "1.0",
                exported_at: new Date().toISOString(),
                type: "full_recipe_backup"
            },
            data: {
                categories,
                recipes,
                ingredients,
                packaging_items,
                suppliers
            }
        };

        const json = JSON.stringify(backupData, null, 2);

        return new NextResponse(json, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="freezeriq_recipes_backup_${timestamp}.json"`
            }
        });

    } catch (e: any) {
        console.error("Backup Failed:", e);
        return NextResponse.json({ error: "Backup failed" }, { status: 500 });
    }
}
