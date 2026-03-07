import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function POST(
    request: Request,
    { params }: any
) {
    const session = await auth();
    if (!session || !session.user || !session.user.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { is_published } = body;

        if (typeof is_published !== 'boolean') {
            return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
        }

        const recipe = await prisma.recipe.updateMany({
            where: {
                id: params.id,
                business_id: session.user.businessId
            },
            data: {
                is_published
            }
        });

        return NextResponse.json({ success: true, is_published });
    } catch (error) {
        console.error("Error toggling extra meal publish status:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
