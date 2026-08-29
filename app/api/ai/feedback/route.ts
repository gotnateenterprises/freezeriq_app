
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

// SEC-PUBLIC-ROUTE-1. No auth() call: an unauthenticated, unrate-limited INSERT
// of an arbitrary-size JSON blob. The SQL itself is parameterised and is not an
// injection risk; the exposure is unbounded anonymous writes into ai_feedback.
// The table has no tenant column, so the session guard is the whole fix — there
// is nothing here to scope by business_id.
export async function POST(req: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

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
