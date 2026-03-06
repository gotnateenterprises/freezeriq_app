import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const session = await auth();
        // Strict Admin Check
        if (!session?.user?.id || !(session.user as any).isSuperAdmin) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }

        // Fetch all categories (since they are currently global)
        const categories = await prisma.category.findMany({
            include: {
                _count: {
                    select: { recipes: true }
                },
                children: {
                    include: {
                        _count: { select: { recipes: true } }
                    }
                }
            },
            where: {
                parent_id: null // Get top level, let children be included
            },
            orderBy: { name: 'asc' }
        });

        return NextResponse.json(categories);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
