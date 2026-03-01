import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { auth } from '@/auth';

const prisma = new PrismaClient();

// GET /api/delivery/labels
// List all label templates
export async function GET(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const templates = await prisma.labelTemplate.findMany({
            where: {
                business_id: session.user.businessId
            },
            include: {
                _count: {
                    select: { packagingItems: true }
                }
            },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(templates);
    } catch (error) {
        console.error("Failed to fetch label templates:", error);
        return NextResponse.json({ error: 'Failed to fetch templates' }, { status: 500 });
    }
}

// POST /api/delivery/labels
// Create a new label template
export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const body = await req.json();
        const { name, width, height, elements, isDefault, packagingItemId } = body;

        // Create the template
        const template = await prisma.labelTemplate.create({
            data: {
                name,
                width,
                height,
                elements: elements || [], // Default empty array if no elements provided
                isDefault: isDefault || false,
                business_id: session.user.businessId
            }
        });

        // If packagingItemId is provided, link it
        if (packagingItemId) {
            await prisma.packagingItem.update({
                where: { id: packagingItemId },
                data: { defaultLabelId: template.id }
            });
        }

        return NextResponse.json(template);
    } catch (error) {
        console.error("Failed to create label template:", error);
        return NextResponse.json({ error: 'Failed to create template' }, { status: 500 });
    }
}
