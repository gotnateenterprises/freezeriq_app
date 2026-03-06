import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGeminiApiKey, callGemini } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.email) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        let businessId = session.user.businessId;

        if (!businessId) {
            return NextResponse.json({ error: 'Internal Error: Business ID not found' }, { status: 500 });
        }

        const { name, ingredients } = await req.json();
        if (!name) {
            return NextResponse.json({ error: 'Recipe name is required' }, { status: 400 });
        }

        // 1. Fetch Gemini API Key
        const apiKey = await getGeminiApiKey(businessId);
        if (!apiKey) {
            return NextResponse.json({
                error: 'Gemini API Key missing. Please go to Settings > AI Content to add your key.'
            }, { status: 400 });
        }

        // 2. Prepare Gemini Prompt
        const ingredientText = (ingredients && Array.isArray(ingredients) && ingredients.length > 0)
            ? ` It features ${ingredients.slice(0, 5).join(', ')}.`
            : "";

        const prompt = `Write a mouth-watering, punchy 2-sentence marketing description for a meal prep recipe called "${name}".${ingredientText} Focus on flavor, texture, and the unique appeal of the ingredients. Highlight what makes this specific dish delicious and "must-have", without mentioning any specific service or brand.
        
        IMPORTANT: Provide only ONE single high-quality description. Do not provide multiple options, explanatory text, or labels like "Option 1". Return only the description text itself. Keep it under 200 characters.`;

        // 3. Call Gemini API
        console.log(`[Gemini] Generating description for: ${name}`);
        const description = await callGemini(apiKey, prompt, {
            temperature: 0.7,
            maxTokens: 100
        });

        // Cleanup: remove any quotes Gemini might add
        const cleanDescription = description.replace(/^["']|["']$/g, '');

        return NextResponse.json({ description: cleanDescription });

    } catch (error: any) {
        console.error('[GenerateDescription] Exception details:', {
            message: error.message,
            stack: error.stack
        });
        return NextResponse.json({
            error: 'System error generating description',
            details: error.message
        }, { status: 500 });
    }
}
