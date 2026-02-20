
import { prisma } from '@/lib/db';

export async function getGeminiApiKey(businessId: string): Promise<string | null> {
    const integration = await prisma.integration.findUnique({
        where: {
            business_id_provider: {
                business_id: businessId,
                provider: 'gemini'
            }
        }
    });
    return integration?.access_token || process.env.GEMINI_API_KEY || null;
}

export async function callGemini(apiKey: string, prompt: string, options: { temperature?: number, maxTokens?: number, responseMimeType?: string } = {}) {
    // Corrected to use the exact string found in our diagnostic script
    const model = "gemini-2.0-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    if (apiKey) {
        console.log(`[Gemini Utility] Calling ${model} with key ending in: ...${apiKey.slice(-4)}`);
    }

    console.log(`[Gemini Utility] Calling API: ${url.split('?')[0]}`);

    const body: any = {
        contents: [{
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxTokens ?? 1000,
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    if (options.responseMimeType === 'application/json') {
        body.generationConfig.responseMimeType = 'application/json';
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorText = await res.text();
        if (res.status === 429) {
            throw new Error(`Gemini API Error: 429 Too Many Requests. You've hit the rate limit for your API key. Please wait 60 seconds and try again.`);
        }
        console.error(`[Gemini Utility] API Error on model ${model}:`, {
            status: res.status,
            statusText: res.statusText,
            body: errorText
        });
        throw new Error(`Gemini API Error: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const data = await res.json();

    // Check for candidates
    if (!data.candidates || data.candidates.length === 0) {
        // Check for safety block or other reasons
        const blockReason = data.promptFeedback?.blockReason;
        if (blockReason) {
            throw new Error(`Gemini blocked the prompt: ${blockReason}`);
        }
        console.error('[Gemini Utility] No candidates returned:', JSON.stringify(data, null, 2));
        throw new Error('Gemini returned no candidates');
    }

    const text = data.candidates[0].content?.parts?.[0]?.text;

    if (!text) {
        const finishReason = data.candidates[0].finishReason;
        if (finishReason === 'SAFETY') {
            throw new Error('Gemini blocked the response due to safety filters');
        }
        throw new Error(`Gemini returned an empty response (Reason: ${finishReason || 'Unknown'})`);
    }

    return text.trim();
}

export async function callImagen(apiKey: string, prompt: string, options: { sampleCount?: number, aspect_ratio?: string } = {}) {
    // Using Imagen 4.0 Fast as identified by diagnostic script
    const model = "imagen-4.0-fast-generate-001";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;

    console.log(`[Imagen Utility] Calling API: ${url.split('?')[0]} with model ${model}`);

    const body = {
        instances: [{ prompt }],
        parameters: {
            sampleCount: options.sampleCount ?? 1,
            aspect_ratio: options.aspect_ratio ?? "1:1",
        }
    };

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorText = await res.text();
        console.error(`[Imagen Utility] API Error: ${res.status} ${res.statusText}`, errorText);
        throw new Error(`Imagen API Error: ${res.status} ${res.statusText} - ${errorText}`);
    }

    const data = await res.json();

    if (!data.predictions || data.predictions.length === 0) {
        console.error('[Imagen Utility] No predictions returned:', JSON.stringify(data, null, 2));
        throw new Error('Imagen returned no images');
    }

    // Returns the base64 string
    return data.predictions[0].bytesBase64Encoded;
}
