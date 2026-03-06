
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getGeminiApiKey, callGemini } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { ingredients } = await req.json();
        if (!ingredients || !Array.isArray(ingredients)) {
            return NextResponse.json({ error: 'Ingredients list is required' }, { status: 400 });
        }

        const apiKey = await getGeminiApiKey(session.user.businessId);
        if (!apiKey) {
            return NextResponse.json({ error: 'Gemini API Key missing' }, { status: 400 });
        }

        const prompt = `Analyze the following list of ingredients and identify any common allergens (Dairy, Eggs, Peanuts, Tree Nuts, Fish, Shellfish, Wheat, Soy, Sesame, Gluten). Be thorough and check for hidden allergens (e.g., "Tamari" contains Soy, "Breadcrumbs" contain Wheat/Gluten).
        
        Ingredients:
        ${ingredients.join('\n')}
        
        Return a comma-separated list of the allergens found. If none are found, return "None".
        
        Example Output: Dairy, Soy, Wheat`;

        const result = await callGemini(apiKey, prompt, { temperature: 0.1, maxTokens: 100 });

        return NextResponse.json({ allergens: result === 'None' ? '' : result });

    } catch (error: any) {
        console.error('[DetectAllergens] Error:', error);
        return NextResponse.json({
            error: 'Failed to analyze allergens',
            details: error.message
        }, { status: 500 });
    }
}
