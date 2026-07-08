import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

/**
 * PUT /api/categories/[id]/parent
 * Move a category to a new parent (or make it root-level)
 * Body: { parentId: string | null }
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id: categoryId } = await params;
        const { parentId } = await req.json();

        console.log('Category ID:', categoryId);
        console.log('Parent ID:', parentId);

        // Ownership check
        const category = await prisma.category.findUnique({ where: { id: categoryId }, select: { business_id: true } });
        if (!category) return NextResponse.json({ error: 'Category not found' }, { status: 404 });
        if (category.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

        // Prevent circular references
        if (parentId) {
            // Verify the target parent category belongs to this tenant
            const parentCategory = await prisma.category.findUnique({ where: { id: parentId }, select: { business_id: true } });
            if (!parentCategory) return NextResponse.json({ error: 'Parent category not found' }, { status: 404 });
            if (parentCategory.business_id !== session.user.businessId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

            const isDescendant = await checkIfDescendant(categoryId, parentId);
            if (isDescendant) {
                return NextResponse.json(
                    { error: 'Cannot move a category into its own descendant' },
                    { status: 400 }
                );
            }
        }

        await prisma.category.update({
            where: { id: categoryId },
            data: { parent_id: parentId }
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error('Error updating category parent:', e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

/**
 * Check if targetId is a descendant of categoryId
 * (prevents moving a folder into its own children)
 */
async function checkIfDescendant(categoryId: string, targetId: string): Promise<boolean> {
    if (categoryId === targetId) return true;

    // Load moving category to check its children
    const category = await prisma.category.findUnique({
        where: { id: categoryId },
        include: { children: true }
    });

    if (!category) return false;

    // Check if any child of the moving category is the target (new parent)
    for (const child of category.children) {
        if (child.id === targetId) return true;
        // Recursively check deeper
        if (await checkIfDescendant(child.id, targetId)) return true;
    }

    return false;
}
