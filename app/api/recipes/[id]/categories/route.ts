import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

/**
 * PUT /api/recipes/[id]/categories
 * Update a recipe's category assignments
 * Body: { categoryIds: string[] }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id: recipeId } = await params;
        const { categoryIds } = await req.json();

        console.log('--- Recipe Categories Update ---');
        console.log('Recipe ID:', recipeId);
        console.log('Category IDs:', categoryIds);

        // Ownership check
        const recipe = await prisma.recipe.findUnique({ where: { id: recipeId }, select: { business_id: true } });
        if (!recipe) return NextResponse.json({ error: 'Recipe not found' }, { status: 404 });
        if (recipe.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        // Validate that all category IDs exist and belong to this tenant
        const validCategories = await prisma.category.findMany({
            where: { id: { in: categoryIds }, business_id: session.user.businessId },
            select: { id: true, name: true }
        });
        const validIds = validCategories.map(c => c.id);

        console.log('[API] Valid Categories:', validCategories.map(c => c.name));

        if (categoryIds.length > 0 && validIds.length !== categoryIds.length) {
            console.warn(`[API] Some category IDs were invalid or cross-tenant:`, categoryIds.filter((id: string) => !validIds.includes(id)));
            return NextResponse.json({ error: 'One or more category IDs are invalid or do not belong to your account' }, { status: 403 });
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
