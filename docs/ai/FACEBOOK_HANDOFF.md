# Facebook & Link-Routing Phases (FB-1 → FB-4) — Implementation Handoff

Governing spec: docs/ai/UI_REDESIGN_SPEC.md §4 — if this handoff and the spec disagree, the spec wins.
Law: every outward-facing fundraiser link routes supporters to the ORDER page (/shop/{businessSlug}/fundraiser/{campaignId}). The scoreboard (/fundraiser/{public_token}) is display-only and must link onward to the order page.

HARD RULES
Implement the phases in order (FB-1 → FB-4), each as its own reviewable diff.
FB-1 is proposal-first (coordinator-flow API): produce the diff, stop, get human approval before applying.
No Stripe/Square anywhere. No Meta Graph API / auto-posting — permanently rejected; the copy-then-share-dialog flow is the sanctioned pattern.
No changes to the 40-generation AI cap, PII masking, token auth, or any file not listed in the phase you're implementing.
Diff gate after each phase: git diff --stat shows only that phase's files.
FB-1 — AI generator order-link fix (PROPOSAL-FIRST)
File: app/api/coordinator/[token]/generate/route.ts (only file in this phase)

Currently the campaign query selects only customer: { name, business_id }, and line ~91 builds the "Order link" with buildPublicFundraiserUrl() — the scoreboard. Fix both:

Change 1 — add the business slug to the existing query (additive select only):

const campaign = await prisma.fundraiserCampaign.findFirst({
    where: { portal_token: token },
    include: {
        customer: {
            select: {
                name: true,
                business_id: true,
                business: { select: { slug: true } },   // ← ADD THIS LINE ONLY
            }
        }
    }
});
Change 2 — build the order URL, scoreboard as fallback only (mirrors the already-fixed pattern in app/api/flyer/download/route.ts:138, including its comment style):

// Build public URL → shop order page (not the old scoreboard)
const origin = new URL(req.url).origin;
const businessSlug = (campaign.customer as any)?.business?.slug;
const publicUrl = businessSlug
    ? `${origin}/shop/${businessSlug}/fundraiser/${campaign.id}`
    : buildPublicFundraiserUrl(req, campaign.public_token!);
const prompt = buildPrompt(channel, campaign, publicUrl);
Nothing else in the file changes: buildPrompt, the channel validation, the 40-cap check, getGeminiApiKey, and the Gemini call stay byte-identical.

Validate: with a dev portal token, generate one post per channel (facebook, text, email, instagram) and confirm each contains /shop/<slug>/fundraiser/<campaignId> — not /fundraiser/<token>.

FB-2 — Scoreboard "Order Now" CTA
Files: app/api/fundraiser/[token]/route.ts + app/fundraiser/[token]/ScoreboardClient.tsx (only these two)

Part A — API: expose the business slug (additive; the select currently ends at customer: { select: { name: true } }):

customer: {
    select: {
        name: true,
        business: { select: { slug: true } },   // ← ADD — slug is already public (it's in every shop URL)
    }
},
Do NOT touch the orders select, maskName, or the computed total_sales — PII masking stays exactly as is.

Part B — client: order URL + CTA + retargeted shares. In ScoreboardClient.tsx, after campaign is loaded:

const businessSlug = (campaign as any)?.customer?.business?.slug;
const orderUrl = businessSlug
    ? `${window.location.origin}/shop/${businessSlug}/fundraiser/${campaign.id}`
    : null;
Order Now button — render prominently near the progress card (above the share buttons):
{orderUrl ? (
    <a href={orderUrl}
        className="block w-full rounded-2xl bg-indigo-600 py-4 text-center text-base font-black text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-700 transition">
        🛒 Order Now &amp; Support {campaign.customer?.name || 'the Cause'}
    </a>
) : (
    <p className="rounded-2xl bg-slate-50 border border-slate-200 py-3 text-center text-sm font-semibold text-slate-500">
        Contact your coordinator to place an order
    </p>
)}
Retarget the existing share handlers (currently ~lines 59–71, they use window.location.href): the copy-link button and the share-text builder switch to orderUrl ?? window.location.href. Update the share text so the link is framed as ordering, e.g. ...Order here to support us: ${orderUrl ?? window.location.href}. Keep the existing handler names/state (copied, etc.) — change only the URL and copy text.
Validate: open a real scoreboard link in dev → Order Now navigates to the shop fundraiser page; the copy button copies the shop URL; temporarily null the slug to confirm the coordinator-contact fallback renders.

FB-3 — Dynamic Open Graph image
Files: ONE new file — app/shop/[slug]/fundraiser/[fundraiserId]/opengraph-image.tsx. Next.js's file convention auto-wires the og:image tag; do NOT edit the existing generateMetadata in this phase.

import { ImageResponse } from 'next/og';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const alt = 'Fundraiser — order freezer meals and support the cause';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ slug: string; fundraiserId: string }> }) {
    const { slug, fundraiserId } = await params;

    const business = await prisma.business.findUnique({
        where: { slug }, select: { id: true, name: true },
    });
    const campaign = business ? await prisma.fundraiserCampaign.findFirst({
        where: { id: fundraiserId },
        select: { name: true, end_date: true, customer: { select: { name: true } } },
    }) : null;

    const orgName = campaign?.customer?.name ?? 'Fundraiser';
    const tenantName = business?.name ?? 'Freezer Meals';
    const endDate = campaign?.end_date
        ? new Date(campaign.end_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
        : null;

    return new ImageResponse(
        (
            <div style={{
                width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
                justifyContent: 'center', padding: '80px',
                background: 'linear-gradient(135deg, #312e81 0%, #4f46e5 60%, #6366f1 100%)',
                color: '#fff', fontFamily: 'sans-serif',
            }}>
                <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 4 }}>
                    🍲 {tenantName} Fundraiser
                </div>
                <div style={{ display: 'flex', fontSize: 72, fontWeight: 900, lineHeight: 1.1, marginTop: 24, maxWidth: 1000 }}>
                    Support {orgName}
                </div>
                <div style={{ display: 'flex', fontSize: 34, marginTop: 28, opacity: 0.9 }}>
                    Order easy freezer meals — every bundle helps the cause.
                </div>
                {endDate && (
                    <div style={{ display: 'flex', marginTop: 40, fontSize: 28, fontWeight: 700,
                        background: 'rgba(255,255,255,0.15)', borderRadius: 16, padding: '14px 28px', alignSelf: 'flex-start' }}>
                        ⏰ Orders due {endDate}
                    </div>
                )}
            </div>
        ),
        { ...size }
    );
}
Notes: next/og JSX requires explicit display: 'flex' on multi-child divs (done above). Optional follow-up (same phase, second new file): a scoreboard variant at app/fundraiser/[token]/opengraph-image.tsx showing live bundle progress — same pattern, query by public_token.

Validate: hit /shop/<slug>/fundraiser/<id>/opengraph-image directly in the browser and confirm a rendered PNG; then check the page's <head> contains the og:image tag; then paste the URL into Facebook's Sharing Debugger (developers.facebook.com/tools/debug) and confirm the card shows the image.

FB-4 — Facebook post pack (phase-matched variants)
Files: app/api/coordinator/[token]/generate/route.ts (additive, builds on FB-1) + the coordinator ShareCenter UI.

Part A — API: optional variant param. Channel validation and cap logic unchanged; add variant handling:

const FB_VARIANTS = ['launch', 'midway', 'final_week', 'last_day', 'thank_you'] as const;
const { channel, variant } = body;
// existing channel validation stays; then:
if (variant && (channel !== 'facebook' || !FB_VARIANTS.includes(variant))) {
    return NextResponse.json({ error: 'Invalid variant.' }, { status: 400 });
}
In buildPrompt, extend the 'facebook' case (keep the existing text as the default when no variant):

case 'facebook': {
    const fbBase = `Write an energetic Facebook post for this fundraiser. ${base} Keep it under 300 characters. Use 2-3 emojis. Include the order link. Do not use hashtags.`;
    switch (variant) {
        case 'launch':     return `${fbBase} Angle: we just launched — announce it proudly and invite friends to be among the first to order.`;
        case 'midway':     return `${fbBase} Angle: progress update — celebrate how far we've come and ask for help reaching the goal.`;
        case 'final_week': return `${fbBase} Angle: one week left — friendly urgency, don't miss out.`;
        case 'last_day':   return `${fbBase} Angle: LAST DAY to order — maximum urgency, deadline tonight.`;
        case 'thank_you':  return `${fbBase} Angle: the campaign just ended — heartfelt thank-you to everyone who ordered, share the final result. The order link is optional in this one.`;
        default:           return fbBase;
    }
}
Pass variant through to buildPrompt (add the parameter). Each generation still counts against the existing 40-cap — no cap changes.

Part B — UI: variant picker in ShareCenter. Where the AI generator opens for the facebook channel, show five variant chips (Launch / Midway update / Final week / Last day / Thank you), with the default pre-selected by campaignPhase: setup|launch → 'launch', push → 'final_week', lastDay → 'last_day', complete → 'thank_you'. Send { channel: 'facebook', variant } in the existing fetch body. Note: if the coordinator page itself hasn't been redesigned yet (phases 7C/7D pending), add the picker to the existing AI generator section instead — same fetch, same state (aiChannel, aiContent); do not block this phase on the redesign. Touching app/coordinator/[token]/page.tsx is proposal-first.

Validate: generate all five variants with a dev token — each reads distinctly, stays under ~300 chars, contains the order link (except thank-you where optional), and the remaining-generations counter decrements correctly.
