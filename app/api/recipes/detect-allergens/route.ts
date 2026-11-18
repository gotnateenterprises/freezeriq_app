import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getGeminiApiKey, callGeminiStructured, isStructuredTextError } from '@/lib/ai/gemini';
import { ALLERGEN_RESPONSE_SCHEMA, parseAllergenResponse } from '@/lib/ai/allergenClassification';

export const dynamic = 'force-dynamic';

// FreezerIQ confirmed-allergen categories (product decision: Dairy not Milk, no Gluten).
// RECIPE-AI-RECOVERY-1: the allowlist, the alias map and the shape check now live in
// lib/ai/allergenClassification.ts, unchanged in substance, where they are unit-tested.

/**
 * RECIPE-AI-RECOVERY-1 — the answer when the AI result cannot be trusted.
 *
 * Deliberately NO `allergens` key. RecipeEditor writes `data.allergens` straight into the recipe's
 * allergen field, so the old fallback ("AI analysis could not be parsed…" sent AS `allergens`) could
 * be saved as the recipe's allergen text and printed on a meal label. With `error` instead, the
 * editor shows the message and leaves the field as it was. `parseError` / `structured.parseError`
 * keep the review-required state explicit. Nothing is invented: confirmed stays empty.
 */
function reviewFallback(reason: string) {
    return NextResponse.json({
        error: 'AI allergen analysis could not be completed. Please review the ingredients manually.',
        parseError: true,
        reason,
        confirmed: [],
        reviewRequired: [],
        structured: { confirmed: [], reviewRequired: [], parseError: true },
    });
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

        let answer;
        try {
            answer = await callGeminiStructured(apiKey, prompt, ALLERGEN_RESPONSE_SCHEMA, { temperature: 0.1 });
        } catch (err) {
            if (isStructuredTextError(err)) {
                console.error(`[DetectAllergens] AI call failed: code=${err.code} http=${err.httpStatus ?? 'n/a'}`);
                if (err.code === 'AI_QUOTA') {
                    return NextResponse.json({ error: err.message, code: err.code }, { status: 429 });
                }
                if (err.code === 'AI_EMPTY' || err.code === 'AI_MALFORMED' || err.code === 'AI_BLOCKED') {
                    return reviewFallback(err.code.toLowerCase());
                }
                return NextResponse.json({ error: 'Failed to analyze allergens', details: 'Something went wrong. Please try again.', code: err.code }, { status: 502 });
            }
            throw err;
        }

        const parsed = parseAllergenResponse(answer.text, answer.finishReason);
        if (!parsed.ok) {
            // Diagnosis without content: why, how it ended, which model, how long — never the text.
            console.error(
                `[DetectAllergens] Structured answer rejected: reason=${parsed.reason} finishReason=${answer.finishReason} `
                + `model=${answer.model} schemaEnforced=${answer.schemaEnforced} textLength=${answer.text.length}`
            );
            return reviewFallback(parsed.reason);
        }
        if (parsed.droppedCategories > 0) {
            console.warn(`[DetectAllergens] Dropped ${parsed.droppedCategories} category value(s) outside the FreezerIQ list`);
        }

        const confirmed = parsed.confirmed;

        // allergens field: confirmed categories only, or "None Confirmed".
        // Review-required ingredients are NEVER appended to this string.
        // They are returned separately for a future compact review panel (INGREDIENT-LABEL-1).
        const allergenDisplayText = confirmed.length > 0
            ? confirmed.join(', ')
            : 'None Confirmed';

        return NextResponse.json({
            allergens: allergenDisplayText,
            confirmed,
            reviewRequired: parsed.reviewRequired
        });

    } catch (error: any) {
        console.error('[DetectAllergens] Error:', error?.name ?? 'Error');
        return NextResponse.json({
            error: 'Failed to analyze allergens',
            details: 'Something went wrong. Please try again.'
        }, { status: 500 });
    }
}
