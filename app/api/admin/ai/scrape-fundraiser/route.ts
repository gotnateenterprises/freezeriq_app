import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getGeminiApiKey, callGemini } from '@/lib/ai/gemini';

export async function POST(request: Request) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { url } = await request.json();

        if (!url) {
            return NextResponse.json({ error: 'URL is required' }, { status: 400 });
        }

        // 1. Fetch the website content
        // Note: In some environments, internal fetches to external sites might be blocked.
        // We'll use a simple fetch with a timeout.
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const html = await response.text();

        // 2. Clean up HTML a bit to save tokens (remove scripts, styles)
        const cleanedHtml = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .substring(0, 15000); // Take first 15k chars to stay safe on context boundaries

        // 3. Extract potential logo/favicon
        let logo_url = '';
        // Look for common logo patterns
        const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/i);
        const favicon = html.match(/<link[^>]*rel="(?:icon|shortcut icon)"[^>]*href="([^"]*)"/i);
        const imgLogo = html.match(/<img[^>]*src="([^"]*)"[^>]*class="[^"]*logo[^"]*"[^>]*>/i) ||
            html.match(/<img[^>]*alt="[^"]*logo[^"]*"[^>]*src="([^"]*)"[^>]*>/i);

        if (ogImage) logo_url = ogImage[1];
        else if (imgLogo) logo_url = imgLogo[1];
        else if (favicon) logo_url = favicon[1];

        // Ensure absolute URL if it was relative
        if (logo_url && !logo_url.startsWith('http')) {
            const urlObj = new URL(url);
            logo_url = new URL(logo_url, urlObj.origin).href;
        }

        // 4. Use AI to extract the mission and about info
        const businessId = session.user.businessId;
        const apiKey = await getGeminiApiKey(businessId || '');

        if (!apiKey) {
            throw new Error('Gemini API Key missing. Please configure it in Settings.');
        }

        console.log(`[ScrapeFundraiser] Using Gemini to analyze: ${url}`);
        const geminiPrompt = `Extract the 'About Us' and 'Mission/Goal' information from the provided HTML. Summarize it concisely for a fundraiser campaign page. 
        
        Return JSON with 'about' and 'mission' fields.
        
        Here is the website HTML: \n\n${cleanedHtml}`;

        const content = await callGemini(apiKey, geminiPrompt, {
            temperature: 0.3,
            maxTokens: 1000,
            responseMimeType: 'application/json'
        });

        const result = JSON.parse(content);

        return NextResponse.json({
            about: result.about || '',
            mission: result.mission || '',
            logo_url: logo_url || null
        });

    } catch (error: any) {
        console.error('AI Scraping Error:', error);
        return NextResponse.json({
            error: 'Failed to scrape website. Please enter information manually.',
            details: error.message
        }, { status: 500 });
    }
}
