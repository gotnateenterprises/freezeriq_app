import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/delivery/labels/[id]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;
        const template = await prisma.labelTemplate.findUnique({
            where: { id }
        });

        if (!template) {
            return NextResponse.json({ error: 'Template not found' }, { status: 404 });
        }

        if (template.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        return NextResponse.json(template);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch template' }, { status: 500 });
    }
}

// PUT /api/delivery/labels/[id]
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;

        // Ownership Check
        const existing = await prisma.labelTemplate.findUnique({ where: { id } });
        if (!existing) return NextResponse.json({ error: "Not Found" }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        const body = await req.json();
        const { name, elements, width, height, isDefault } = body;

        const updated = await prisma.labelTemplate.update({
            where: { id },
            data: {
                name,
                elements,
                width,
                height,
                isDefault
            }
        });

        return NextResponse.json(updated);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to update template' }, { status: 500 });
    }
}

// DELETE /api/delivery/labels/[id]
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const { id } = await params;

        // Ownership Check
        const existing = await prisma.labelTemplate.findUnique({ where: { id } });
        if (!existing) return NextResponse.json({ error: "Not Found" }, { status: 404 });
        if (existing.business_id !== session.user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        await prisma.labelTemplate.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
    }
}
