
import { NextResponse } from 'next/server';
import { ViralChef } from '@/lib/ai/recipe_generator';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getGeminiApiKey } from '@/lib/ai/gemini';

export async function POST(req: Request) {
    try {
        const { vibe } = await req.json();

        // Check for Tenant Key
        const session = await auth();
        let tenantKey = null;

        if (session?.user?.businessId) {
            tenantKey = await getGeminiApiKey(session.user.businessId);
        }

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
