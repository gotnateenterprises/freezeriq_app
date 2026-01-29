
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const { recipe, rating, feedback_text } = await req.json();

        if (!recipe) return NextResponse.json({ error: "No recipe provided" }, { status: 400 });

        await prisma.$executeRawUnsafe(
            `INSERT INTO ai_feedback (id, recipe_name, recipe_json, rating, feedback_text, created_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
            crypto.randomUUID(),
            recipe.name,
            JSON.stringify(recipe),
            rating,
            feedback_text || null
        );

        return NextResponse.json({ success: true });

    } catch (e: any) {
        console.error("Feedback Save Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
