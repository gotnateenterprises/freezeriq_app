import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGeminiApiKey, callGemini, callImagen } from '@/lib/ai/gemini';
import { v4 as uuidv4 } from 'uuid';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

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

        const { name, ingredients, description } = await req.json();
        if (!name) {
            return NextResponse.json({ error: 'Recipe name is required' }, { status: 400 });
        }

        // 1. Fetch Gemini API Key
        const apiKey = await getGeminiApiKey(businessId || '');

        if (apiKey) {
            try {
                console.log(`[GrabImage] Using Imagen 3 for bespoke image generation: ${name}`);

                const contextText = (ingredients && ingredients.length > 0)
                    ? ` with ingredients: ${ingredients.join(', ')}`
                    : "";
                const descText = description ? `. ${description}` : "";

                const visualPrompt = `A high-end, professional studio food photograph of "${name}"${contextText}${descText}. The lighting is bright and natural, beautifully highlighting textures and colors. The dish is perfectly plated on elegant dinnerware, appearing fresh, delicious and highly appetizing. No text, no logos, no people. 8k resolution, cinematic composition.`;

                const base64Image = await callImagen(apiKey, visualPrompt);

                if (base64Image) {
                    const buffer = Buffer.from(base64Image, 'base64');
                    const filename = `recipe-ai-gen-${uuidv4()}.png`;
                    const url = await uploadToS3(buffer, filename, 'image/png');

                    console.log(`[GrabImage] Successfully generated and saved to S3: ${url}`);
                    return NextResponse.json({
                        url,
                        source: 'imagen-3-generation'
                    });
                }
            } catch (err: any) {
                console.error('[GrabImage] Imagen Generation Error:', err.message);
                return NextResponse.json({ error: `AI Image Generation failed: ${err.message}` }, { status: 500 });
            }
        }

        return NextResponse.json({
            url: '/images/food-placeholder.png',
            source: 'placeholder'
        });

    } catch (error: any) {
        console.error('[GrabImage] Global Error:', error);
        return NextResponse.json({ url: '/images/food-placeholder.png', error: error.message }, { status: 500 });
    }
}
