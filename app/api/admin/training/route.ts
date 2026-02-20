
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// POST /api/admin/training
// Super Admin: Create a new resource
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
        }

        const data = await req.json();

        // Validate required fields
        if (!data.title || !data.type || !data.category) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const resource = await prisma.trainingResource.create({
            data: {
                title: data.title,
                description: data.description,
                type: data.type, // VIDEO, SOP, FAQ
                category: data.category,
                url: data.url,
                content: data.content,
                thumbnail: data.thumbnail,
                isActive: true, // Default to active
                business_id: data.business_id || null // Global if null
            }
        });

        return NextResponse.json(resource);
    } catch (error) {
        console.error("[Admin Training API] Create Error:", error);
        return NextResponse.json({ error: "Failed to create resource" }, { status: 500 });
    }
}
