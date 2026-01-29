
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Initialize OpenAI only if key exists
const getOpenAI = () => {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("Missing OPENAI_API_KEY");
    }
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
};

export interface GeneratedRecipe {
    name: string;
    description: string;
    viral_score: number;
    ingredients: {
        name: string;
        approx_qty: number;
        unit: string;
        matched_ingredient_id?: string; // If we find a match in DB
        match_confidence?: string;
    }[];
    instructions: string[];
}

export class ViralChef {

    // Main function to generate recipe
    async generateRecipe(vibe: string = "Trending"): Promise<GeneratedRecipe> {
        // 1. Fetch In-Stock Ingredients, Preferences, and Feedback
        const [inventory, topFeedback, negFeedback, preferences] = await Promise.all([
            prisma.ingredient.findMany({
                where: { stock_quantity: { gt: 0 } },
                select: { id: true, name: true, stock_quantity: true, unit: true },
                orderBy: { stock_quantity: 'desc' } // WEIGHTING: Prioritize high-stock items
            }),
            prisma.$queryRawUnsafe(`SELECT * FROM ai_feedback WHERE rating = 1 ORDER BY created_at DESC LIMIT 3`) as Promise<any[]>,
            prisma.$queryRawUnsafe(`SELECT feedback_text FROM ai_feedback WHERE rating = -1 AND feedback_text IS NOT NULL ORDER BY created_at DESC LIMIT 3`) as Promise<any[]>,
            prisma.systemSetting.findUnique({ where: { key: 'AI_PREFERENCES' } })
        ]);

        // Format Positive Training Data
        const trainingData = topFeedback.length > 0
            ? topFeedback.map((f: any) => `Example of a HIGHLY RATED recipe we loved:\n${JSON.stringify(f.recipe_json)}`).join('\n\n')
            : "No positive feedback yet.";

        // Format Negative Constraints (Avoid these)
        const avoidData = negFeedback.length > 0
            ? negFeedback.map((f: any) => `- ${f.feedback_text}`).join('\n')
            : "No specific negative feedback yet.";

        // User Custom Preferences
        const userPrefs = preferences?.value || "Default: High-quality, viral freezer meals.";

        // Format inventory for the prompt (Top 30 items to keep prompt concise)
        const stockList = inventory.slice(0, 30).map(i => `- ${i.name} (In Stock: ${i.stock_quantity} ${i.unit})`).join('\n');

        // 2. Construct Prompt
        const prompt = `
            You are a "Viral Freezer Meal" Specialist and Chef. 
            Create a TRENDING, EXCITING recipe that is specifically designed for FREEZER PREP. 
            
            USER SETTINGS & PREFERENCES:
            ${userPrefs}

            WHAT WE LOVED (Positive Training):
            ${trainingData}

            WHAT TO AVOID (User Feedback):
            ${avoidData}

            Vibe: ${vibe}

            IN-STOCK INGREDIENTS:
            ${stockList}

            STRICT PARAMETERS:
            1. **Freezer Integration**: The recipe must be suitable for assembly raw, freezing, and then cooking later (Crockpot, Slow Cooker, or Oven Bake).
            2. **Viral Hook**: Use catchy, social-media style names and descriptions (e.g., "Dump & Go Spicy Garlic Chicken", "Viral Freezer-to-Crockpot Pot Roast").
            3. **Instructions**: Must include 2 parts: 
               a) Assembly: How to pack it into a freezer bag/container.
               b) Cooking: How to cook it from frozen (e.g., "Crockpot on High for 4 hours").
            4. **No Ingredients Outside List**: Use ONLY the ingredients provided above (plus salt, pepper, oil, water).

            OUTPUT FORMAT (JSON ONLY):
            {
                "name": "Recipe Name",
                "description": "Viral freezer prep hook",
                "viral_score": 9,
                "ingredients": [
                    { "name": "Exact Name from List", "approx_qty": 1.5, "unit": "cup" }
                ],
                "instructions": ["Pack into gallon freezer bag...", "Squeeze out air...", "When ready, cook from frozen on High for..."]
            }
        `;

        // 3. Call AI
        const openai = getOpenAI();
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", // or gpt-3.5-turbo if 4o unavailable
            messages: [{ role: "system", content: "You are a helpful JSON-speaking chef." }, { role: "user", content: prompt }],
            response_format: { type: "json_object" }
        });

        const rawJson = completion.choices[0].message.content;
        if (!rawJson) throw new Error("AI returned empty response");

        const recipeData = JSON.parse(rawJson) as GeneratedRecipe;

        // 4. Fuzzy Match Logic (Simple version)
        // We try to find the matching DB ID for the ingredients the AI chose
        recipeData.ingredients = recipeData.ingredients.map(aiIng => {
            // Find a robust match (ignoring case)
            const match = inventory.find(dbIng =>
                dbIng.name.toLowerCase().includes(aiIng.name.toLowerCase()) ||
                aiIng.name.toLowerCase().includes(dbIng.name.toLowerCase())
            );

            return {
                ...aiIng,
                matched_ingredient_id: match?.id,
                match_confidence: match ? 'High' : 'None'
            };
        });

        return recipeData;
    }
}
