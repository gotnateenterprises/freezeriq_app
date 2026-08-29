
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// GET /api/training
// Authenticated tenant: fetch active training resources (global + this tenant's).
//
// SEC-PUBLIC-ROUTE-1. This handler called auth() but never gated on it. With no
// session, businessId was `undefined`, and Prisma STRIPS undefined from a where
// clause — so `{ business_id: undefined }` collapsed to `{}`, which matches every
// row, and the OR returned every tenant's TrainingResource rows to an anonymous
// caller. Both callers (app/training/page.tsx, app/admin/training/page.tsx) are
// already behind an authenticated page, so requiring a session breaks nothing.
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const userId = session.user.id;

        const resources = await prisma.trainingResource.findMany({
            where: {
                isActive: true,
                OR: [
                    { business_id: null }, // Global resources
                    { business_id: businessId } // Tenant specific resources
                ]
            },
            include: {
                user_progress: {
                    where: { user_id: userId }
                }
            },
            orderBy: [
                { category: 'asc' },
                { title: 'asc' }
            ]
        });

        // Transform to include isCompleted boolean
        const enhancedResources = resources.map(r => ({
            ...r,
            user_progress: undefined, // Remove raw relation
            isCompleted: r.user_progress.length > 0
        }));

        return NextResponse.json(enhancedResources);
    } catch (error) {
        console.error("[Training API] Error:", error);
        return NextResponse.json({ error: "Failed to fetch resources" }, { status: 500 });
    }
}

// POST /api/training
// Super Admin: Create a new training resource
export async function POST(req: Request) {
    try {
        const session = await auth();
        // Check for super admin status
        if (!session?.user?.isSuperAdmin) {
            return NextResponse.json({ error: "Unauthorized: Super Admin only" }, { status: 403 });
        }

        const data = await req.json();
        const { title, description, type, category, url, content, thumbnail, isActive, business_id } = data;

        if (!title || !type || !category) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        const resource = await prisma.trainingResource.create({
            data: {
                title,
                description,
                type,
                category,
                url,
                content,
                thumbnail,
                isActive: isActive ?? true,
                business_id: business_id || null // Global if not specified
            }
        });

        return NextResponse.json(resource);
    } catch (error) {
        console.error("[Training API] POST Error:", error);
        return NextResponse.json({ error: "Failed to create resource" }, { status: 500 });
    }
}
