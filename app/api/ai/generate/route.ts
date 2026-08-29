
import { NextResponse } from 'next/server';
import { ViralChef } from '@/lib/ai/recipe_generator';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getGeminiApiKey } from '@/lib/ai/gemini';

export async function POST(req: Request) {
    try {
        // SEC-PUBLIC-ROUTE-1. auth() was called but never gated on, so an
        // anonymous caller fell through to the platform GEMINI_API_KEY and spent
        // billable third-party LLM credit. No database read or write is involved;
        // the protected asset is the API key. Guard first, then read the body.
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { vibe } = await req.json();

        // Check for Tenant Key
        const tenantKey = await getGeminiApiKey(session.user.businessId);

        // If no tenant key AND no system key, error out.
        if (!tenantKey && !process.env.GEMINI_API_KEY) {
            return NextResponse.json(
                { error: "Gemini API Key is missing. Please add it to Settings." },
                { status: 400 }
            );
        }

        const chef = new ViralChef(tenantKey);
        const recipe = await chef.generateRecipe(vibe || "Trending");

        return NextResponse.json({ success: true, recipe });

    } catch (e: any) {
        console.error("AI Generation Error:", e);
        return NextResponse.json(
            { error: e.message || "Failed to generate recipe" },
            { status: 500 }
        );
    }
}
