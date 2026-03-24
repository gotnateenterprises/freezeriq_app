import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.id || !(session.user as any).businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = (session.user as any).businessId;

        const body = await req.json();
        const { id } = body;

        if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

        // Verify ingredient belongs to this business before deleting
        const ingredient = await prisma.ingredient.findFirst({
            where: { id, business_id: businessId }
        });
        if (!ingredient) {
            return NextResponse.json({ error: "Ingredient not found" }, { status: 404 });
        }

        try {
            await prisma.ingredient.delete({
                where: { id }
            });
        } catch (e: any) {
            if (e.code === 'P2003') {
                return NextResponse.json({ error: "Cannot delete: This ingredient is used in recipes." }, { status: 400 });
            }
            throw e;
        }

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("Delete Error:", e);
        return NextResponse.json({ error: "Failed to delete ingredient" }, { status: 500 });
    }
}
