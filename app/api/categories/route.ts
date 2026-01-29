
import { NextResponse } from 'next/server';
import { PrismaAdapter } from '@/lib/prisma_adapter';

// Force dynamic to ensure fresh data
export const dynamic = 'force-dynamic';

export async function GET() {
    const adapter = new PrismaAdapter();
    try {
        const categories = await adapter.getCategories();
        return NextResponse.json(categories);
    } catch (error) {
        console.error('Error fetching categories:', error);
        return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const adapter = new PrismaAdapter();
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
