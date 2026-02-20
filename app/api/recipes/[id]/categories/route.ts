import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * PUT /api/recipes/[id]/categories
 * Update a recipe's category assignments
 * Body: { categoryIds: string[] }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: recipeId } = await params;
        const { categoryIds } = await req.json();

        console.log('--- Recipe Categories Update ---');
        console.log('Recipe ID:', recipeId);
        console.log('Category IDs:', categoryIds);

        // Validate that all category IDs exist to avoid Prisma P2025 errors
        const validCategories = await prisma.category.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true }
        });
        const validIds = validCategories.map(c => c.id);

        console.log('[API] Valid Categories:', validCategories.map(c => c.name));

        if (validIds.length !== categoryIds.length) {
            console.warn(`[API] Some category IDs were invalid and filtered out:`, categoryIds.filter((id: string) => !validIds.includes(id)));
        }

        // Disconnect all existing categories and connect new ones
        // Also update legacy category_id field for backward compatibility
        await prisma.recipe.update({
            where: { id: recipeId },
            data: {
                category_id: validIds[0] || null,
                categories: {
                    set: validIds.map((id: string) => ({ id }))
                }
            }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error('Error updating recipe categories:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
