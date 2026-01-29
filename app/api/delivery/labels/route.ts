import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// GET /api/delivery/labels
// List all label templates
export async function GET() {
    try {
        const templates = await prisma.labelTemplate.findMany({
            include: {
                _count: {
                    select: { packagingItems: true }
                }
            },
            orderBy: { createdAt: 'desc' }
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
        const body = await req.json();
        const { name, width, height, elements, isDefault, packagingItemId } = body;

        // Create the template
        const template = await prisma.labelTemplate.create({
            data: {
                name,
                width,
                height,
                elements: elements || [], // Default empty array if no elements provided
                isDefault: isDefault || false
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
