/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the poster BACKDROP, and only the backdrop.
 *
 * The AI is asked for an empty seasonal scene: no food, no dishes, no text, no people. The real recipe
 * photos, the meal names, the bundle name, the "Serves N" banner and the badge are composited on top
 * by deterministic code (lib/poster/posterTemplate.ts). That separation is the point: an image model
 * is never trusted to draw a meal or spell a meal name.
 *
 * The tenant's optional "Background instructions" are untrusted text: cleaned with the same rules as
 * the recipe-photo note (lib/ai/recipeImagePrompt.ts cleanPromptText), bounded to 500 characters,
 * quoted as one JSON string literal, and placed BEFORE the closing rules, which always win. They only
 * ever reach the backdrop prompt; nothing else on the poster reads them.
 */

import { cleanPromptText } from '@/lib/ai/recipeImagePrompt';
import type { PosterTheme } from '@/lib/poster/posterThemes';

export const POSTER_BACKGROUND_INSTRUCTIONS_MAX = 500;

export type BackgroundInstructionsResult =
    | { ok: true; value: string }
    | { ok: false; code: 'INVALID_BACKGROUND_INSTRUCTIONS' | 'BACKGROUND_INSTRUCTIONS_TOO_LONG'; message: string };

/** Absent or blank → ''. Non-text → refused. Over 500 characters after cleaning → refused, never cut. */
export function normalizeBackgroundInstructions(raw: unknown): BackgroundInstructionsResult {
    if (raw === undefined || raw === null) return { ok: true, value: '' };
    if (typeof raw !== 'string') {
        return { ok: false, code: 'INVALID_BACKGROUND_INSTRUCTIONS', message: 'Background instructions must be text.' };
    }
    const tooLong = {
        ok: false as const,
        code: 'BACKGROUND_INSTRUCTIONS_TOO_LONG' as const,
        message: `Background instructions can be at most ${POSTER_BACKGROUND_INSTRUCTIONS_MAX} characters.`,
    };
    if (raw.length > POSTER_BACKGROUND_INSTRUCTIONS_MAX * 4) return tooLong;
    const value = cleanPromptText(raw);
    if (value.length > POSTER_BACKGROUND_INSTRUCTIONS_MAX) return tooLong;
    return { ok: true, value };
}

/** The rules that close every backdrop prompt. */
export const POSTER_BACKGROUND_RULES: readonly string[] = Object.freeze([
    'No food of any kind, and no dishes, plates, bowls, pans, cutlery or cooking.',
    'No text, letters, numbers, signs, labels, menus, logos or watermarks anywhere.',
    'No people, faces, hands or animals.',
    'No frames, borders, collage, poster layout or mock-up: one continuous photograph that fills the whole image.',
]);

export type BackgroundPlan =
    | { mode: 'ai'; prompt: string }
    | { mode: 'template'; reason: 'custom_neutral' };

/**
 * Seasonal themes ask for an AI backdrop (with the drawn scene as the fallback). Special / Custom with
 * no instructions "starts neutral": the drawn neutral scene, and no AI call at all.
 */
export function posterBackgroundPlan(theme: PosterTheme, instructions: string): BackgroundPlan {
    if (theme.id === 'custom' && !instructions) return { mode: 'template', reason: 'custom_neutral' };
    return { mode: 'ai', prompt: buildPosterBackgroundPrompt(theme, instructions) };
}

export function buildPosterBackgroundPrompt(theme: PosterTheme, instructions: string): string {
    const note = cleanPromptText(instructions ?? '').slice(0, POSTER_BACKGROUND_INSTRUCTIONS_MAX);
    const sections: string[] = [];

    sections.push('Create one photorealistic BACKGROUND image for a portrait food-marketing poster. It is only the backdrop: the poster\'s words and the real food photos are added afterwards by other software, so leave room for them.');

    sections.push([
        `SCENE: ${theme.id === 'custom' ? 'Special / custom setting' : theme.label}`,
        ...theme.aiDirection.map((d) => `- ${d}`),
    ].join('\n'));

    sections.push([
        'LAYOUT (important):',
        '- Upper 40%: a bright, softly blurred, light-coloured scene (for example a window or the sky). Keep the middle of this area calm and pale so dark headline text stays readable; seasonal details belong near the far left and right edges.',
        '- Lower 60%: an empty tabletop or surface seen from slightly above, with nothing standing in the middle of it.',
        '- Portrait orientation.',
    ].join('\n'));

    if (note) {
        sections.push([
            'BACKGROUND NOTES FROM THE USER (quoted below). Use them for the scene, setting, decorations, colours and mood only:',
            JSON.stringify(note),
        ].join('\n'));
    }

    sections.push([
        'RULES (always apply, and override everything above):',
        ...POSTER_BACKGROUND_RULES.map((r) => `- ${r}`),
    ].join('\n'));

    return sections.join('\n\n');
}
