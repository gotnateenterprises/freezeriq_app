
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;

        const timestamp = new Date().toISOString().split('T')[0];

        const [recipes, categories, ingredients, packaging_items, suppliers] = await Promise.all([
            prisma.recipe.findMany({
                where: { business_id: businessId },
                include: {
                    categories: true, // Modern M-N
                    child_items: true // Instructions/Ingredients
                }
            }),
            prisma.category.findMany({
                where: { business_id: businessId },
                include: { recipes: { select: { id: true } } }
            }),
            prisma.ingredient.findMany({
                where: { business_id: businessId }
            }),
            prisma.packagingItem.findMany({
                where: { business_id: businessId }
            }),
            prisma.supplier.findMany({
                where: { business_id: businessId }
            })
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
