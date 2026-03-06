import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getGeminiApiKey, callGemini } from '@/lib/ai/gemini';
import { v4 as uuidv4 } from 'uuid';
import { uploadToS3 } from '@/lib/s3';

export const dynamic = 'force-dynamic';

// Helper to save image from URL
async function saveImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        const filename = `ai-gen-${uuidv4()}.png`;

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const url = await uploadToS3(buffer, filename, contentType);
        return url;
    } catch (e) {
        console.error('Image save error:', e);
        return null;
    }
}

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { prompt, provider, bundleName } = await request.json();

        if (!prompt) {
            return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
        }

        // 1. Fetch Gemini API Key
        const apiKey = await getGeminiApiKey(businessId);
        if (!apiKey) {
            return NextResponse.json({ error: 'Gemini is not connected' }, { status: 400 });
        }

        console.log(`[GenerateImage] Using Gemini for bundle: ${bundleName}`);

        // Gemini Logic: Determine the best aesthetic category for the bundle
        const geminiPrompt = `Given the bundle name "${bundleName}" and description "${prompt}", pick the best aesthetic category for a high-end marketing photo from this list: 
        pizza, taco, steak, chicken, pasta, soup, salad, burger, dessert, healthy, or generic. 
        
        Just respond with the single word category.`;

        try {
            const category = (await callGemini(apiKey, geminiPrompt, { temperature: 0.3, maxTokens: 10 })).toLowerCase();
            console.log(`[GenerateImage] Gemini selected category: ${category}`);

            const curatedFallbacks: Record<string, string> = {
                'pizza': 'https://images.unsplash.com/photo-1513104890138-7c749659a591?q=80&w=1000&auto=format&fit=crop',
                'taco': 'https://images.unsplash.com/photo-1565299585323-38d6b0865b47?q=80&w=1000&auto=format&fit=crop',
                'steak': 'https://images.unsplash.com/photo-1558030006-45c675171f23?q=80&w=1000&auto=format&fit=crop',
                'chicken': 'https://images.unsplash.com/photo-1598515214211-89d3c73ae83b?q=80&w=1000&auto=format&fit=crop',
                'pasta': 'https://images.unsplash.com/photo-1563379091339-0efb179b9703?q=80&w=1000&auto=format&fit=crop',
                'soup': 'https://images.unsplash.com/photo-1547592166-23acbe3a624b?q=80&w=1000&auto=format&fit=crop',
                'salad': 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=1000&auto=format&fit=crop',
                'burger': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?q=80&w=1000&auto=format&fit=crop',
                'dessert': 'https://images.unsplash.com/photo-1551024601-bec78aea704b?q=80&w=1000&auto=format&fit=crop',
                'healthy': 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=1000&auto=format&fit=crop'
            };

            const imageUrl = curatedFallbacks[category] || curatedFallbacks['healthy'] || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=1000&auto=format&fit=crop';

            const localUrl = await saveImageFromUrl(imageUrl);
            if (localUrl) {
                return NextResponse.json({ url: localUrl });
            }
        } catch (e) {
            console.error('[GenerateImage] Gemini error:', e);
        }

        return NextResponse.json({ error: "Failed to generate bundle image via Gemini" }, { status: 500 });

    } catch (error) {
        console.error('Generation Error:', error);
        return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
    }
}
