import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET /api/delivery/labels/[id]
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const template = await prisma.labelTemplate.findUnique({
            where: { id }
        });

        if (!template) {
            return NextResponse.json({ error: 'Template not found' }, { status: 404 });
        }

        return NextResponse.json(template);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch template' }, { status: 500 });
    }
}

// PUT /api/delivery/labels/[id]
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
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
        const { id } = await params;
        await prisma.labelTemplate.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to delete template' }, { status: 500 });
    }
}
