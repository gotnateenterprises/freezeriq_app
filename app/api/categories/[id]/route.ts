
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    try {
        // Validation: Ensure category is empty
        const category = await prisma.category.findUnique({
            where: { id },
            include: {
                children: true,
                recipes: true
            }
        });

        if (!category) {
            return NextResponse.json({ error: 'Category not found' }, { status: 404 });
        }

        const hasChildren = category.children.length > 0;
        const hasRecipes = category.recipes.length > 0;

        if (hasChildren || hasRecipes) {
            return NextResponse.json({
                error: `Cannot delete folder. It contains ${hasChildren ? 'sub-folders' : ''} ${hasChildren && hasRecipes ? 'and' : ''} ${hasRecipes ? 'recipes' : ''}.`
            }, { status: 400 });
        }

        await prisma.category.delete({ where: { id } });
        return NextResponse.json({ success: true });

    } catch (error) {
        console.error('Error deleting category:', error);
        return NextResponse.json({ error: 'Failed to delete category' }, { status: 500 });
    }
}
