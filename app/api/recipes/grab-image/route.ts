import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGeminiApiKey, generateRecipeImage, isRecipeImageError } from '@/lib/ai/gemini';
import { v4 as uuidv4 } from 'uuid';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

/** The placeholder a recipe shows when it has no generated photo. */
const PLACEHOLDER_URL = '/images/food-placeholder.png';

/**
 * RECIPE-AI-RECOVERY-1 — every "no photo was generated" answer has ONE shape.
 *
 * `generated: false` and `source: 'placeholder'` say plainly that this is the fallback, and the
 * placeholder travels as `fallbackUrl` — deliberately NOT as `url`. RecipeEditor treats any
 * response carrying `url` as success ("Success! Image detected.") and stores it as the recipe's
 * photo, so a placeholder sent as `url` is exactly how a provider 404 used to look like a working
 * generator. `code` is a stable, non-sensitive reason; `error` is a tenant-safe sentence, never the
 * provider's raw body.
 */
function notGenerated(code: string, error: string, status: number) {
    return NextResponse.json({ generated: false, source: 'placeholder', fallbackUrl: PLACEHOLDER_URL, code, error }, { status });
}

// Helper to save image from URL
async function saveImageFromUrl(imageUrl: string): Promise<string> {
    const fallbackPath = '/images/food-placeholder.png';

    try {
        console.log(`[GrabImage] Downloading image from: ${imageUrl}`);

        // Comprehensive headers to act like a real browser
        const response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site'
            }
        });

        if (!response.ok) {
            console.warn(`[GrabImage] Fetch failed with status: ${response.status} ${response.statusText}`);
            return fallbackPath;
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // Validate content length to avoid saving empty files
        if (buffer.length < 1000) {
            console.warn(`[GrabImage] Downloaded file too small (${buffer.length} bytes). Using fallback.`);
            return fallbackPath;
        }

        const filename = `recipe-ai-${uuidv4()}.png`;
        const url = await uploadToS3(buffer, filename, 'image/png');

        console.log(`[GrabImage] Successfully saved to S3: ${url}`);
        return url;

    } catch (e: any) {
        console.error(`[GrabImage] Image save error for ${imageUrl}:`, e.message);
        return fallbackPath;
    }
}

// Main Handler
export async function POST(req: NextRequest) {
    try {
        const session = await auth();
        // Robust Check: Ensure we have at least an email
        if (!session?.user?.email) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        let businessId = session.user.businessId;

        // Robust Fallback: If session is stale (missing businessId), fetch from DB
        if (!businessId) {
            console.log(`[GrabImage] ⚠️ Session stale (missing businessId). Performing robust lookup for: ${session.user.email}`);
            const user = await prisma.user.findUnique({
                where: { email: session.user.email },
                select: { business_id: true }
            });

            if (user?.business_id) {
                businessId = user.business_id;
                console.log(`[GrabImage] ✅ Recovered BusinessID from DB: ${businessId}`);
            } else {
                console.warn(`[GrabImage] ❌ User has no associated Business ID.`);
            }
        }
        // businessId might still be undefined here if the user has no associated business.
        // The integration check below will handle this gracefully by not proceeding with AI.

        const { name, ingredients, description, recipeId } = await req.json();
        if (!name) {
            return NextResponse.json({ error: 'Recipe name is required' }, { status: 400 });
        }

        // RECIPE-AI-IMAGE-MODEL-1: Auto-Grab passes `recipeId` so this route saves ONLY image_url on that
        // recipe. (Auto-Grab used to PUT the whole list row back through PUT /api/recipes/[id], whose
        // field names differ from the row's, resetting yield to 1, the unit to "servings" and the
        // category tags.) The recipe must belong to the caller's tenant, and that is checked BEFORE
        // any billable generation. The single-recipe editor sends no recipeId and saves the form itself.
        const targetRecipeId: string | null = typeof recipeId === 'string' && recipeId.trim() ? recipeId : null;
        if (recipeId !== undefined && recipeId !== null && !targetRecipeId) {
            return NextResponse.json({ error: 'Invalid recipe id', code: 'BAD_REQUEST' }, { status: 400 });
        }
        if (targetRecipeId) {
            if (!businessId) {
                return NextResponse.json({ error: 'Unauthorized', code: 'NO_TENANT' }, { status: 401 });
            }
            const owned = await prisma.recipe.findFirst({
                where: { id: targetRecipeId, business_id: businessId },
                select: { id: true },
            });
            if (!owned) {
                return NextResponse.json({ error: 'Recipe not found', code: 'RECIPE_NOT_FOUND' }, { status: 404 });
            }
        }

        // 1. Fetch Gemini API Key
        const apiKey = await getGeminiApiKey(businessId || '');
        if (!apiKey) {
            return notGenerated('AI_KEY_MISSING', 'Gemini API Key missing. Please go to Settings > AI Content to add your key.', 400);
        }

        const contextText = (ingredients && ingredients.length > 0)
            ? ` with ingredients: ${ingredients.join(', ')}`
            : "";
        const descText = description ? `. ${description}` : "";

        const visualPrompt = `A high-end, professional studio food photograph of "${name}"${contextText}${descText}. The lighting is bright and natural, beautifully highlighting textures and colors. The dish is perfectly plated on elegant dinnerware, appearing fresh, delicious and highly appetizing. No text, no logos, no people. 8k resolution, cinematic composition.`;

        // 2. Generate. A failure is reported as an error with NO url, so no caller can ever store the
        //    old placeholder (or an empty / invalid image) as the recipe's photo.
        let image;
        try {
            console.log(`[GrabImage] Generating recipe photo: ${name}`);
            image = await generateRecipeImage(apiKey, visualPrompt);
        } catch (err: any) {
            if (isRecipeImageError(err)) {
                // Model, status and error class only — no key, no prompt, no recipe content.
                console.error(`[GrabImage] Image generation failed: code=${err.code} model=${err.model ?? 'unknown'} status=${err.httpStatus ?? 'n/a'}`);
                const status = err.code === 'AI_QUOTA' ? 429 : err.code === 'AI_BLOCKED' ? 422 : 502;
                return notGenerated(err.code, err.message, status);
            }
            throw err;
        }

        // 3. Store with the type proven from the bytes.
        let url: string;
        try {
            url = await uploadToS3(image.bytes, `recipe-ai-gen-${uuidv4()}.${image.extension}`, image.mimeType);
        } catch (uploadErr: any) {
            console.error(`[GrabImage] Image generated but storage upload failed: ${uploadErr?.name ?? 'Error'}`);
            return notGenerated('STORAGE_FAILED', 'The photo was generated but could not be stored. Please try again.', 502);
        }

        // 4. Auto-Grab only: point the recipe at the new photo (tenant-scoped, image_url only).
        if (targetRecipeId) {
            const saved = await prisma.recipe.updateMany({
                where: { id: targetRecipeId, business_id: businessId as string },
                data: { image_url: url },
            });
            if (saved.count !== 1) {
                return NextResponse.json({ error: 'Recipe not found', code: 'RECIPE_NOT_FOUND' }, { status: 404 });
            }
        }

        console.log(`[GrabImage] Generated with ${image.model} and stored: ${url}`);
        return NextResponse.json({
            url,
            generated: true,
            source: 'gemini-image',
            model: image.model,
            saved: !!targetRecipeId,
        });

    } catch (error: any) {
        console.error('[GrabImage] Global Error:', error?.name ?? 'Error');
        return notGenerated('INTERNAL', 'Something went wrong. Please try again.', 500);
    }
}
