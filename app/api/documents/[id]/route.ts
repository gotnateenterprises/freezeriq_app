import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET: Fetch single document
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    try {
        const doc = await prisma.document.findUnique({
            where: { id }
        });

        if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
        if (doc.business_id !== session.user.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 403 });

        return NextResponse.json(doc);
    } catch (e) {
        return NextResponse.json({ error: "Error fetching document" }, { status: 500 });
    }
}

// PUT: Update document (Save Draft)
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    const body = await req.json();
    const { content, status, name } = body;

    try {
        const existing = await prisma.document.findUnique({
            where: { id }
        });

        if (!existing || existing.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized or not found" }, { status: 403 });
        }

        const updated = await prisma.document.update({
            where: { id },
            data: {
                content,
                status,
                name,
                external_link: body.external_link
            }
        });

        return NextResponse.json(updated);
    } catch (e: any) {
        console.error("Error updating document", e);
        return NextResponse.json({ error: `Failed to update: ${e.message}` }, { status: 500 });
    }
}

// DELETE: Remove document
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;

    try {
        const existing = await prisma.document.findUnique({ where: { id } });
        if (!existing || existing.business_id !== session.user.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        await prisma.document.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (e) {
        return NextResponse.json({ error: "Error deleting document" }, { status: 500 });
    }
}
