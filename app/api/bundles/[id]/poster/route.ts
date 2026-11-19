import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';
import { getGeminiApiKey } from '@/lib/ai/gemini';
import { normalizeBackgroundInstructions, posterBackgroundPlan } from '@/lib/poster/backgroundPrompt';
import { buildPosterModel, posterFileName, posterPhotoHosts } from '@/lib/poster/posterModel';
import { POSTER_BUNDLE_SELECT, posterBundleFingerprint, posterNotesDigest, posterSigningSecret, sha256Hex, signPosterReceipt } from '@/lib/poster/posterPublish';
import { resolvePosterTheme } from '@/lib/poster/posterThemes';
import { isPosterRenderError, renderBundlePoster } from '@/lib/poster/renderBundlePoster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// An AI backdrop (up to 40 s, then the drawn fallback) plus the render.
export const maxDuration = 60;

/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — POST /api/bundles/[id]/poster → one JPEG poster for this bundle.
 *
 * Body: { theme: 'spring'|'summer'|'fall'|'winter'|'custom', backgroundInstructions?: string,
 *         showBadge?: boolean }
 *
 * Tenant-scoped like every bundle route (middleware does not cover /api): the bundle is read with
 * `business_id` in the WHERE clause, so another tenant's bundle is a 404, indistinguishable from one
 * that does not exist. The bundle and its linked recipes are read NOW, on every call — the poster
 * always shows the current composition, order and photos — and nothing is written or stored.
 *
 * The response is the image itself (same origin, so the editor can preview and download it) with
 * non-sensitive status headers: which backdrop was used and why, and how many meals had a photo.
 *
 * BUNDLE-POSTER-USE-AS-IMAGE-1: it also carries `X-Poster-Receipt`, a signed statement of exactly
 * which bytes were made for which tenant, bundle and settings (lib/poster/posterPublish.ts). Only
 * that receipt lets POST /api/bundles/[id]/poster/publish turn these bytes into the bundle image.
 * Generating still writes and stores nothing.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    const businessId = session?.user?.businessId;
    if (!businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;

    let body: any;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'Invalid request.', code: 'BAD_REQUEST' }, { status: 400 });
    }

    // Validated before any read or paid call.
    const themeResult = resolvePosterTheme(body?.theme);
    if (!themeResult.ok) {
        return NextResponse.json({ error: 'Please choose a season / theme.', code: 'INVALID_POSTER_THEME' }, { status: 400 });
    }
    const notes = normalizeBackgroundInstructions(body?.backgroundInstructions);
    if (!notes.ok) return NextResponse.json({ error: notes.message, code: notes.code }, { status: 400 });
    if (body?.showBadge !== undefined && typeof body.showBadge !== 'boolean') {
        return NextResponse.json({ error: 'Invalid request.', code: 'BAD_REQUEST' }, { status: 400 });
    }

    const bundle = await prisma.bundle.findFirst({
        where: { id, business_id: businessId },
        select: POSTER_BUNDLE_SELECT,
    });
    if (!bundle) return NextResponse.json({ error: 'Bundle not found', code: 'BUNDLE_NOT_FOUND' }, { status: 404 });

    const theme = themeResult.theme;
    const model = buildPosterModel(bundle, { theme, allowedHosts: posterPhotoHosts(), showBadge: body?.showBadge !== false });
    if (model.meals.length === 0) {
        return NextResponse.json({ error: 'Add recipes to this bundle before making its poster.', code: 'BUNDLE_HAS_NO_MEALS' }, { status: 422 });
    }

    const plan = posterBackgroundPlan(theme, notes.value);
    const apiKey = plan.mode === 'ai' ? await getGeminiApiKey(businessId) : null;

    try {
        // The theme, the meal count and the note's LENGTH only — never the note, the key or the prompt.
        console.log(`[BundlePoster] Generating: theme=${theme.id} meals=${model.meals.length} notes=${notes.value.length} chars backdrop=${plan.mode}`);
        const poster = await renderBundlePoster({ model, theme, background: plan, apiKey });
        const missing = poster.photos.filter((p) => p !== 'placed').length;
        console.log(`[BundlePoster] Done: theme=${theme.id} background=${poster.background} note=${poster.backgroundNote ?? 'none'} photos_missing=${missing} bytes=${poster.bytes.length}`);
        // Without a signing secret the poster is still made; it just cannot be published.
        const secret = posterSigningSecret();
        const receipt = secret
            ? signPosterReceipt({
                biz: businessId,
                bundle: bundle.id,
                sha: sha256Hex(poster.bytes),
                fp: posterBundleFingerprint(bundle),
                theme: theme.id,
                notes: posterNotesDigest(notes.value),
                badge: body?.showBadge !== false,
            }, secret)
            : null;
        return new Response(new Uint8Array(poster.bytes), {
            status: 200,
            headers: {
                ...(receipt ? { 'X-Poster-Receipt': receipt } : {}),
                'Content-Type': poster.contentType,
                'Content-Disposition': `inline; filename="${posterFileName(bundle.name, model.sizeLabel, 'jpg')}"`,
                'X-Poster-Theme': theme.id,
                'X-Poster-Background': poster.background,
                'X-Poster-Background-Note': poster.backgroundNote ?? 'none',
                'X-Poster-Meals': String(model.meals.length),
                'X-Poster-Photos': poster.photos.join(','),
                'X-Poster-Omitted-Meals': String(model.omittedMeals),
                'X-Poster-Size': `${poster.width}x${poster.height}`,
            },
        });
    } catch (e) {
        if (isPosterRenderError(e)) {
            console.error(`[BundlePoster] Failed: code=${e.code}`);
            return NextResponse.json({ error: e.message, code: e.code }, { status: 500 });
        }
        console.error(`[BundlePoster] Failed: ${(e as any)?.name ?? 'Error'}`);
        return NextResponse.json({ error: 'The poster could not be made. Please try again.', code: 'POSTER_FAILED' }, { status: 500 });
    }
}
