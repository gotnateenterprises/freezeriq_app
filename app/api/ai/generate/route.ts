
import { NextResponse } from 'next/server';
import { ViralChef } from '@/lib/ai/recipe_generator';

export async function POST(req: Request) {
    try {
        const { vibe } = await req.json();

        if (!process.env.OPENAI_API_KEY) {
            return NextResponse.json(
                { error: "OpenAI API Key is missing. Please add it to Settings." },
                { status: 400 }
            );
        }

        const chef = new ViralChef();
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
