'use client';

/**
 * RECIPE-AI-IMAGE-STYLING-1 — "Image style" + "Additional image instructions" for the recipe
 * editor's Auto-Grab photo.
 *
 * Controlled and hook-free: RecipeEditor owns the two values (so the last choice stays put while the
 * editor is open) and sends them with Auto-Grab. The preset list comes from lib/ai/recipeImagePrompt,
 * the same list the server builds the prompt from, so a label here always means the direction there.
 * Nothing here is required: with no change the editor generates exactly as easily as before, in the
 * default Restaurant / Menu style.
 */

import {
    DEFAULT_RECIPE_IMAGE_STYLE,
    RECIPE_IMAGE_INSTRUCTIONS_MAX,
    RECIPE_IMAGE_STYLES,
    type RecipeImageStyleId,
} from '@/lib/ai/recipeImagePrompt';

// Re-exported so RecipeEditor (a proposal-first file) needs a single import for this feature.
export { DEFAULT_RECIPE_IMAGE_STYLE };
export type { RecipeImageStyleId };

export const IMAGE_STYLE_HELP = 'Choose how you want the finished meal photographed.';
export const IMAGE_INSTRUCTIONS_PLACEHOLDER = 'Example: Large close-up, white bowl, minimal background';

/** A select value → a known style id; anything unexpected falls back to the default. */
export function toImageStyleId(value: string): RecipeImageStyleId {
    return RECIPE_IMAGE_STYLES.find((s) => s.id === value)?.id ?? DEFAULT_RECIPE_IMAGE_STYLE;
}

interface Props {
    style: RecipeImageStyleId;
    instructions: string;
    onStyleChange: (style: RecipeImageStyleId) => void;
    onInstructionsChange: (instructions: string) => void;
    disabled?: boolean;
}

export default function RecipeImageStyleControls({ style, instructions, onStyleChange, onInstructionsChange, disabled }: Props) {
    const used = instructions.length;
    return (
        <div className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-900/40 p-2.5 print:hidden">
            <div className="space-y-1">
                <label htmlFor="recipe-image-style" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Image style
                </label>
                <select
                    id="recipe-image-style"
                    value={style}
                    onChange={(e) => onStyleChange(toImageStyleId(e.target.value))}
                    disabled={disabled}
                    aria-describedby="recipe-image-style-help"
                    className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-60"
                >
                    {RECIPE_IMAGE_STYLES.map((s) => (
                        <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                </select>
                <p id="recipe-image-style-help" className="text-[11px] text-slate-500 dark:text-slate-400">{IMAGE_STYLE_HELP}</p>
            </div>
            <div className="space-y-1">
                <label htmlFor="recipe-image-instructions" className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Additional image instructions <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
                </label>
                <textarea
                    id="recipe-image-instructions"
                    value={instructions}
                    onChange={(e) => onInstructionsChange(e.target.value.slice(0, RECIPE_IMAGE_INSTRUCTIONS_MAX))}
                    disabled={disabled}
                    maxLength={RECIPE_IMAGE_INSTRUCTIONS_MAX}
                    rows={2}
                    placeholder={IMAGE_INSTRUCTIONS_PLACEHOLDER}
                    className="w-full px-2.5 py-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-600 focus:ring-2 focus:ring-indigo-500 outline-none resize-none disabled:opacity-60"
                />
                {used > 0 && (
                    <p className="text-right text-[10px] text-slate-500 dark:text-slate-400" aria-live="polite">
                        {used}/{RECIPE_IMAGE_INSTRUCTIONS_MAX}
                    </p>
                )}
            </div>
        </div>
    );
}
