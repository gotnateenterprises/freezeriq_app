
import { NextResponse } from 'next/server';
import { PrismaAdapter } from '@/lib/prisma_adapter';
import { auth } from '@/auth';

// Force dynamic to ensure fresh data
export const dynamic = 'force-dynamic';

export async function GET() {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const adapter = new PrismaAdapter(session.user.businessId);
    try {
        const categories = await adapter.getCategories();
        return NextResponse.json(categories);
    } catch (error) {
        console.error('Error fetching categories:', error);
        return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const adapter = new PrismaAdapter(session.user.businessId);
    try {
        const body = await request.json();
        const { name, parent_id } = body;

        if (!name) {
            return NextResponse.json({ error: 'Name is required' }, { status: 400 });
        }

        const category = await adapter.createCategory({
            name,
            parent_id: parent_id || null
        });

        return NextResponse.json(category);
    } catch (error) {
        console.error('Error creating category:', error);
        return NextResponse.json({ error: 'Failed to create category' }, { status: 500 });
    }
}
