
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// PUT /api/admin/training/[id]
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const resolvedParams = await params;
        const id = resolvedParams.id;
        const data = await req.json();

        const resource = await prisma.trainingResource.update({
            where: { id },
            data: {
                title: data.title,
                description: data.description,
                type: data.type,
                category: data.category,
                url: data.url,
                content: data.content,
                thumbnail: data.thumbnail,
                isActive: data.isActive,
                business_id: data.business_id
            }
        });

        return NextResponse.json(resource);
    } catch (error) {
        console.error("[Admin Training API] Update Error:", error);
        return NextResponse.json({ error: "Failed to update resource" }, { status: 500 });
    }
}

// DELETE /api/admin/training/[id]
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const resolvedParams = await params;
        const id = resolvedParams.id;

        await prisma.trainingResource.delete({
            where: { id }
        });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("[Admin Training API] Delete Error:", error);
        return NextResponse.json({ error: "Failed to delete resource" }, { status: 500 });
    }
}
