import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { id } = body;

        if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

        // Check compatibility (optional, but Prisma throws P2003 if FK constraint fails)
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
