import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { sourceId, targetId } = body;

        if (!sourceId || !targetId) {
            return NextResponse.json({ error: "Source and Target IDs are required" }, { status: 400 });
        }

        if (sourceId === targetId) {
            return NextResponse.json({ error: "Cannot merge ingredient into itself" }, { status: 400 });
        }

        // Transaction:
        // 1. Verify existence
        // 2. Re-point all RecipeItems from Source to Target
        // 3. Delete Source Ingredient

        await prisma.$transaction(async (tx) => {
            const source = await tx.ingredient.findUnique({ where: { id: sourceId } });
            const target = await tx.ingredient.findUnique({ where: { id: targetId } });

            if (!source || !target) {
                throw new Error("Ingredient not found");
            }

            // Update usages
            await tx.recipeItem.updateMany({
                where: { child_ingredient_id: sourceId },
                data: { child_ingredient_id: targetId }
            });

            // Delete source
            await tx.ingredient.delete({
                where: { id: sourceId }
            });
        });

        return NextResponse.json({ success: true });
    } catch (e: any) {
        console.error("Merge Error:", e);
        return NextResponse.json({ error: e.message || "Failed to merge" }, { status: 500 });
    }
}
