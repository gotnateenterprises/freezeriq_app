
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getGeminiApiKey, callGemini } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

// FreezerIQ confirmed-allergen categories (product decision: Dairy not Milk, no Gluten)
const ALLERGEN_ALLOWLIST = new Set([
    'Dairy', 'Eggs', 'Fish', 'Crustacean Shellfish', 'Tree Nuts',
    'Peanuts', 'Wheat', 'Soy', 'Sesame'
]);

function normalizeCategory(raw: string): string | null {
    const trimmed = raw.trim();
    // Exact match (case-insensitive)
    for (const allowed of ALLERGEN_ALLOWLIST) {
        if (trimmed.toLowerCase() === allowed.toLowerCase()) return allowed;
    }
    // Alias mapping — normalizes model output to FreezerIQ categories
    const aliases: Record<string, string> = {
        // Dairy derivatives
        'milk': 'Dairy', 'cream': 'Dairy', 'heavy cream': 'Dairy',
        'heavy whipping cream': 'Dairy', 'sour cream': 'Dairy',
        'butter': 'Dairy', 'cheese': 'Dairy', 'yogurt': 'Dairy',
        'whey': 'Dairy', 'casein': 'Dairy', 'milk powder': 'Dairy',
        'dry milk': 'Dairy',
        // Egg variants
        'egg': 'Eggs',
        // Shellfish
        'shellfish': 'Crustacean Shellfish', 'crustacean': 'Crustacean Shellfish',
        // Nuts
        'peanut': 'Peanuts', 'tree nut': 'Tree Nuts', 'treenut': 'Tree Nuts',
        'tree nuts': 'Tree Nuts',
        // Soy variants
        'soybeans': 'Soy', 'soybean': 'Soy',
    };
    return aliases[trimmed.toLowerCase()] || null;
}

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

        const prompt = `You are a food allergen classifier. Analyze ONLY the ingredient names provided below against these allergen categories: Dairy, Eggs, Fish, Crustacean Shellfish, Tree Nuts, Peanuts, Wheat, Soy, Sesame.

Rules:
- "confirmed": allergens directly identifiable from the ingredient name (e.g., "milk" → Dairy, "butter" → Dairy, "soy sauce" → Soy, "peanut butter" → Peanuts, "wheat flour" → Wheat).
- "reviewRequired": compound or branded ingredients whose full sub-ingredients are unknown (e.g., "BBQ Sauce", "Ranch Dressing"). List the possible allergen categories.
- Do NOT guess sub-ingredients. If an ingredient is a simple whole food with no allergen link, omit it.
- Use ONLY categories from this list: Dairy, Eggs, Fish, Crustacean Shellfish, Tree Nuts, Peanuts, Wheat, Soy, Sesame.
- Do NOT return "Gluten" as a category. Wheat ingredients should return "Wheat" only.
- Do NOT return "Milk". All milk-derived ingredients (milk, cream, butter, cheese, yogurt, whey, casein) should return "Dairy".

Ingredients:
${ingredients.join('\n')}

Respond with ONLY this JSON object:
{
  "confirmed": ["Category1"],
  "reviewRequired": [{"ingredient": "Name", "possibleAllergens": ["Category"], "reason": "Short reason"}]
}

If no allergens found, return: {"confirmed": [], "reviewRequired": []}`;

        console.log(`[DetectAllergens] Analyzing ${ingredients.length} ingredients`);
        const responseText = await callGemini(apiKey, prompt, {
            temperature: 0.1,
            maxTokens: 500,
            responseMimeType: 'application/json'
        });

        // Parse and validate the structured response
        let parsed: { confirmed?: string[]; reviewRequired?: { ingredient: string; possibleAllergens: string[]; reason: string }[] };
        try {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            parsed = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
        } catch {
            // Model returned unparseable output — safe fallback
            console.error('[DetectAllergens] Failed to parse model JSON, returning review fallback');
            return NextResponse.json({
                allergens: 'AI analysis could not be parsed. Please review ingredients manually.',
                structured: { confirmed: [], reviewRequired: [], parseError: true }
            });
        }

        // Normalize and deduplicate confirmed categories against allowlist
        const confirmedSet = new Set<string>();
        for (const raw of (parsed.confirmed || [])) {
            const normalized = normalizeCategory(raw);
            if (normalized) confirmedSet.add(normalized);
        }

        // Normalize reviewRequired categories against allowlist
        const reviewItems: { ingredient: string; possibleAllergens: string[]; reason: string }[] = [];
        for (const item of (parsed.reviewRequired || [])) {
            const normalizedAllergens = (item.possibleAllergens || [])
                .map(a => normalizeCategory(a))
                .filter((a): a is string => a !== null);
            if (normalizedAllergens.length > 0) {
                reviewItems.push({
                    ingredient: item.ingredient || 'Unknown',
                    possibleAllergens: [...new Set(normalizedAllergens)],
                    reason: item.reason || 'Compound ingredient; verify manufacturer label'
                });
            }
        }

        const confirmed = [...confirmedSet].sort();

        // allergens field: confirmed categories only, or "None Confirmed".
        // Review-required ingredients are NEVER appended to this string.
        // They are returned separately for a future compact review panel (INGREDIENT-LABEL-1).
        const allergenDisplayText = confirmed.length > 0
            ? confirmed.join(', ')
            : 'None Confirmed';

        return NextResponse.json({
            allergens: allergenDisplayText,
            confirmed,
            reviewRequired: reviewItems
        });

    } catch (error: any) {
        console.error('[DetectAllergens] Error:', error.message);
        return NextResponse.json({
            error: 'Failed to analyze allergens',
            details: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}
