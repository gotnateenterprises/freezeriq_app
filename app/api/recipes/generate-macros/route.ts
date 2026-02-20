import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
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

        const { name, yield_qty, yield_unit, items } = await req.json();
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
        const ingredientText = (items && Array.isArray(items) && items.length > 0)
            ? items.map(i => `- ${i.qty ?? ''} ${i.unit ?? ''} ${i.name}`).join('\n')
            : "No specific ingredients provided.";

        const prompt = `Calculate the full nutritional information for a recipe called "${name}".
        
Yield: ${yield_qty || 1} ${yield_unit || 'servings'}

Ingredients:
${ingredientText}

TASK:
Provide the nutritional breakdown PER SERVING as a JSON object.
Include mandatory FDA fields. Estimates are okay.

JSON Format:
{
  "summary": "Calories: X, Protein: Xg, Carbs: Xg, Fat: Xg",
  "fullData": {
    "servingSize": "e.g. 1 package (450g)",
    "servingsPerContainer": "${yield_qty || 1}",
    "calories": X,
    "totalFat": "Xg",
    "saturatedFat": "Xg",
    "transFat": "0g",
    "cholesterol": "Xmg",
    "sodium": "Xmg",
    "totalCarbohydrate": "Xg",
    "dietaryFiber": "Xg",
    "totalSugars": "Xg",
    "addedSugars": "0g",
    "protein": "Xg",
    "vitaminD": "0mcg",
    "calcium": "Xmg",
    "iron": "Xmg",
    "potassium": "Xmg"
  }
}

IMPORTANT:
- Values must be estimates based on ingredients.
- Return ONLY the JSON object. No explanations.`;

        // 3. Call Gemini API
        console.log(`[Gemini] Generating full nutrition for: ${name}`);
        const responseText = await callGemini(apiKey, prompt, {
            temperature: 0.1,
            maxTokens: 500
        });

        // Cleanup and Parse JSON
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return NextResponse.json({ error: "Failed to parse AI response as JSON" }, { status: 500 });
        }

        const data = JSON.parse(jsonMatch[0]);

        return NextResponse.json({
            macros: data.summary,
            fullNutrition: data.fullData
        });

    } catch (error: any) {
        console.error('[GenerateMacros] Exception:', {
            message: error.message,
            stack: error.stack
        });
        return NextResponse.json({
            error: 'System error generating macros',
            details: error.message
        }, { status: 500 });
    }
}
