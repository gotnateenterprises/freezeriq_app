import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
    const session = await auth();
    if (!session || !session.user || !session.user.businessId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await request.json();
        const { id, type, newQty } = body;

        if (!id || !type || typeof newQty !== 'number') {
            return NextResponse.json({ error: "Missing or invalid parameters" }, { status: 400 });
        }

        if (type === 'recipe') {
            // No stock column on recipe per schema initially, but user wants PWA
            // Since recipe doesn't have an inventory_count field we will just log a proxy 
            // string for now or skip to not crash. I'll mock throwing since it wouldn't compile.
            return NextResponse.json({ error: "Recipe stock updates not implemented in schema" }, { status: 400 });

        } else if (type === 'ingredient') {
            await prisma.ingredient.updateMany({
                where: {
                    id: id,
                    business_id: session.user.businessId
                },
                data: {
                    stock_quantity: newQty
                }
            });

            return NextResponse.json({ success: true });
        }

        return NextResponse.json({ error: "Unsupported scanning type" }, { status: 400 });

    } catch (error) {
        console.error("Scanner Update Error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
