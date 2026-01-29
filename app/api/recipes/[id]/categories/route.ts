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

        console.log('Recipe ID:', recipeId);
        console.log('Category IDs:', categoryIds);

        // Disconnect all existing categories and connect new ones
        await prisma.recipe.update({
            where: { id: recipeId },
            data: {
                categories: {
                    set: categoryIds.map((id: string) => ({ id }))
                }
            }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error('Error updating recipe categories:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
