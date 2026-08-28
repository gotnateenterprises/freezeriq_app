/**
 * Coordinator AI Content Generator
 *
 * ACCESS MODEL: Token-based (same as coordinator portal)
 * - POST gated by `portal_token` on FundraiserCampaign
 * - Generates marketing copy using Gemini, auto-populated with campaign data
 * - Hard cap: 40 generations per campaign (shared across all channels)
 *
 * ACTOR: Fundraiser Coordinator
 * SCOPE: Single campaign (resolved from portal_token)
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { callGemini, getGeminiApiKey } from '@/lib/ai/gemini';
import { resolveOutreachOrigin } from '@/lib/fundraiserUrls';
import { buildSupporterOrderUrl } from '@/lib/previousSupporterInvite';
import { customerFacingBusinessName } from '@/lib/tenantBrand';
import { requireCoordinatorSession } from '@/lib/coordinatorSession';
import { resolveBundleGoal } from '@/lib/fundraiserMetrics';

const MAX_GENERATIONS = 40;

function buildPrompt(channel: string, campaign: any, publicUrl: string, tenantName: string): string {
    const name = campaign.name || 'Our Fundraiser';
    const org = campaign.customer?.name || 'Our Organization';
    const bundleGoal = resolveBundleGoal(campaign.bundle_goal);
    // totalBundlesSold is passed from the caller or estimated from orders
    const totalOrders = (campaign.orders || []).length;
    const endDate = campaign.end_date
        ? new Date(campaign.end_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
        : 'soon';

    // FR-SHARE-COPY-1: this used to hardcode "Freezer Chef meals" — a
    // multi-tenant product cannot put one tenant's brand into every other
    // tenant's AI-generated marketing copy. tenantName is the caller's
    // resolved customerFacingBusinessName (display_name -> name).
    const base = `Fundraiser: "${name}" by ${org}. Goal: ${bundleGoal} bundles. Orders placed: ${totalOrders}. Orders due: ${endDate}. Order link: ${publicUrl}. They are selling ${tenantName} meals — delicious, easy-to-prepare freezer meals that solve dinner.`;

    switch (channel) {
        case 'facebook':
            return `Write an energetic Facebook post for this fundraiser. ${base} Keep it under 300 characters. Use 2-3 emojis. Make it feel urgent and exciting. Include the order link. Do not use hashtags.`;
        case 'text':
            return `Write a short, friendly text message for this fundraiser. ${base} Keep it under 160 characters. Use 1-2 emojis. Include the order link. Make it personal and casual.`;
        case 'email':
            return `Write a fundraiser email body (no subject line) for this fundraiser. ${base} Structure it with a greeting, 2-3 short paragraphs, emoji bullet points for key details (goal, deadline, link), and a warm closing. Keep it under 200 words. Make it persuasive but authentic.`;
        case 'instagram':
            return `Write an Instagram caption for this fundraiser. ${base} Keep it under 200 characters. Use 3-4 emojis. Make it visually engaging. Don't include the link in the text (say "link in bio" instead). Add 3-5 relevant hashtags.`;
        default:
            return `Write marketing copy for this fundraiser. ${base} Keep it concise and exciting.`;
    }
}

export async function POST(req: Request) {
    try {
        // FR-COORD-SEC-1B: authority comes from the session cookie, never a URL.
        const guard = await requireCoordinatorSession(req);
        if (!guard.ok) return guard.response as NextResponse;
        const campaignId = guard.campaignId;
        const body = await req.json();
        const { channel } = body;

        if (!channel || !['facebook', 'text', 'email', 'instagram'].includes(channel)) {
            return NextResponse.json({ error: 'Invalid channel. Use: facebook, text, email, or instagram.' }, { status: 400 });
        }

        // 1. Fetch campaign with org name
        const campaign = await prisma.fundraiserCampaign.findFirst({
            where: { id: campaignId },
            include: {
                customer: {
                    select: {
                        name: true,
                        business_id: true,
                        // FR-SHARE-COPY-1: needed to build the SAME canonical
                        // supporter URL every other share action uses (below) —
                        // this route used to build its own, deprecated one —
                        // and to resolve the tenant's actual brand name rather
                        // than a hardcoded one.
                        business: { select: { name: true, display_name: true, slug: true, custom_domain: true } },
                    }
                }
            }
        });

        if (!campaign) {
            return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
        }

        const businessId = (campaign.customer as any)?.business_id;

        // 2. Check generation limit
        if (campaign.ai_generation_count >= MAX_GENERATIONS) {
            return NextResponse.json({
                error: `AI generation limit reached (${MAX_GENERATIONS}/${MAX_GENERATIONS}). Contact support for more.`,
                remaining: 0
            }, { status: 429 });
        }

        // 3. Resolve API key and build prompt
        const apiKey = await getGeminiApiKey(businessId);
        if (!apiKey) {
            return NextResponse.json({ error: 'AI generation not configured. Contact support.' }, { status: 503 });
        }

        // FR-SHARE-COPY-1: the SAME canonical supporter URL every other share
        // action uses (lib/previousSupporterInvite.buildSupporterOrderUrl) —
        // this used to build the deprecated /fundraiser/{public_token}
        // scoreboard shape via buildPublicFundraiserUrl, so AI-generated copy
        // could point supporters somewhere different from every other button.
        const business = (campaign.customer as any)?.business ?? null;
        const publicUrl = buildSupporterOrderUrl(
            resolveOutreachOrigin(req),
            { id: campaign.id, public_token: campaign.public_token },
            { customDomain: business?.custom_domain ?? null, slug: business?.slug ?? null },
        ) ?? '';
        const tenantName = business ? customerFacingBusinessName(business) : 'freezer meal';
        const prompt = buildPrompt(channel, campaign, publicUrl, tenantName);

        let content: string;
        try {
            content = await callGemini(apiKey, prompt, { temperature: 0.8, maxTokens: 500 });
        } catch (aiError: any) {
            console.error('[AI Generate] Gemini call failed:', aiError.message);
            return NextResponse.json({ error: 'AI generation temporarily unavailable. Please try again.' }, { status: 503 });
        }

        // 4. Increment counter
        const updated = await prisma.fundraiserCampaign.update({
            where: { id: campaign.id },
            data: { ai_generation_count: { increment: 1 } }
        });

        return NextResponse.json({
            content,
            remaining: MAX_GENERATIONS - updated.ai_generation_count
        });

    } catch (e: any) {
        console.error('[AI Generate] Error:', e.message);
        return NextResponse.json({ error: 'Failed to generate content' }, { status: 500 });
    }
}
