'use client';

/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the "Bundle Poster" section under the bundle editor.
 *
 * Season / Theme (single select) + optional background instructions → Generate. The server reads the
 * bundle as SAVED at that moment (its linked recipes, their order and their saved photos), so the panel
 * says so, and any change of theme, instructions or badge after a poster was made marks that poster
 * as out of date until Regenerate. The poster lives only in this browser tab (an object URL): nothing
 * is stored, so no old poster can quietly stay authoritative.
 *
 * BUNDLE-POSTER-USE-AS-IMAGE-1: generating, regenerating, previewing and downloading never change the
 * bundle. Only "Use as Bundle Image" does: after a light confirmation it sends the poster bytes and the
 * poster route's signed receipt to /api/bundles/[id]/poster/publish, which stores the poster with the
 * existing media storage and sets THIS bundle's image. It is disabled while the poster is out of date.
 * On success the editor above is told the new image URL (lib/bundles/bundleImageEvents.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { POSTER_THEMES, type PosterThemeId } from '@/lib/poster/posterThemes';
import { POSTER_BACKGROUND_INSTRUCTIONS_MAX } from '@/lib/poster/backgroundPrompt';
import { announceBundleImagePublished } from '@/lib/bundles/bundleImageEvents';

export const POSTER_INSTRUCTIONS_PLACEHOLDER = 'Snowy farmhouse window, pine branches and warm lantern';
export const POSTER_REGENERATE_FIRST = 'Regenerate the poster before using it as the bundle image.';
export const POSTER_PUBLISHED_MESSAGE = 'Bundle image updated successfully.';
const PUBLISH_FAILED = 'The bundle image could not be updated. Your bundle image was not changed.';

export interface BundlePosterPanelProps {
    bundleId: string;
    bundleName: string;
    sizeLabel: string | null;
    mealCount: number;
    photoCount: number;
    defaultTheme: PosterThemeId;
    /** The badge the bundle's own name supports, or null (then no badge option is shown). */
    derivedBadge: string | null;
}

interface PosterMeta {
    background: string;
    backgroundNote: string;
    photos: string[];
    omittedMeals: number;
    themeLabel: string;
    generatedAt: string;
}

/** A plain-English line for how the backdrop was made. */
export function backgroundNoteText(meta: Pick<PosterMeta, 'background' | 'backgroundNote' | 'themeLabel'>): string {
    if (meta.background === 'ai') return `Background: AI-generated ${meta.themeLabel} scene.`;
    switch (meta.backgroundNote) {
        case 'custom_neutral': return 'Background: neutral (add background instructions for a custom scene).';
        case 'no_api_key': return `Background: built-in ${meta.themeLabel} design (no Gemini key is set up in Settings > AI Content).`;
        case 'AI_QUOTA': return `Background: built-in ${meta.themeLabel} design (the AI service is busy or out of credits).`;
        default: return `Background: built-in ${meta.themeLabel} design (the AI background could not be made this time).`;
    }
}

export function photoNoteText(photos: string[]): string | null {
    const missing = photos.filter((p) => p !== 'placed');
    if (missing.length === 0) return null;
    const host = photos.filter((p) => p === 'unsupported_host' || p === 'not_https').length;
    const base = `${missing.length} of ${photos.length} meal${photos.length === 1 ? '' : 's'} had no usable photo and show${missing.length === 1 ? 's' : ''} a "Photo coming soon" card.`;
    return host > 0 ? `${base} Photos must be uploaded on the recipe (linked images from other websites can't be used).` : base;
}

export default function BundlePosterPanel(props: BundlePosterPanelProps) {
    const [theme, setTheme] = useState<PosterThemeId>(props.defaultTheme);
    const [instructions, setInstructions] = useState('');
    const [showBadge, setShowBadge] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [posterUrl, setPosterUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState('bundle-poster.jpg');
    const [meta, setMeta] = useState<PosterMeta | null>(null);
    const [madeWith, setMadeWith] = useState<string | null>(null);
    // BUNDLE-POSTER-USE-AS-IMAGE-1
    const [receipt, setReceipt] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [publishing, setPublishing] = useState(false);
    const [published, setPublished] = useState(false);
    const [mustRegenerate, setMustRegenerate] = useState(false);
    const [publishError, setPublishError] = useState<string | null>(null);
    const [publishedMessage, setPublishedMessage] = useState<string | null>(null);
    const inFlight = useRef(false);
    const urlRef = useRef<string | null>(null);
    const blobRef = useRef<Blob | null>(null);

    // Free the in-memory poster when the panel goes away.
    useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

    const settingsKey = `${theme}|${instructions.trim()}|${showBadge}`;
    const stale = !!posterUrl && madeWith !== settingsKey;
    const themeLabel = POSTER_THEMES.find((t) => t.id === theme)?.label ?? theme;
    const working = busy || publishing;
    const canGenerate = props.mealCount > 0 && !working;
    const canPublish = !!posterUrl && !!receipt && !stale && !mustRegenerate && !working && !published;
    // Read by publish() at click time, so a click that lands just after a settings change is refused.
    const publishable = useRef(false);
    publishable.current = canPublish;

    async function generate() {
        if (inFlight.current || props.mealCount === 0) return;
        inFlight.current = true;
        setBusy(true);
        setError(null);
        setConfirming(false);
        const requested = settingsKey;
        try {
            const res = await fetch(`/api/bundles/${encodeURIComponent(props.bundleId)}/poster`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme, backgroundInstructions: instructions, showBadge }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setError(data?.error || 'The poster could not be made. Please try again.');
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            if (urlRef.current) URL.revokeObjectURL(urlRef.current);
            urlRef.current = url;
            blobRef.current = blob;
            setPosterUrl(url);
            // A new poster: it has not been used as the bundle image yet.
            setReceipt(res.headers.get('X-Poster-Receipt'));
            setPublished(false);
            setMustRegenerate(false);
            setPublishError(null);
            setPublishedMessage(null);
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = /filename="([^"]+)"/.exec(disposition);
            setFileName(match ? match[1] : 'bundle-poster.jpg');
            setMeta({
                background: res.headers.get('X-Poster-Background') || 'template',
                backgroundNote: res.headers.get('X-Poster-Background-Note') || 'none',
                photos: (res.headers.get('X-Poster-Photos') || '').split(',').filter(Boolean),
                omittedMeals: Number(res.headers.get('X-Poster-Omitted-Meals') || 0),
                themeLabel,
                generatedAt: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
            });
            setMadeWith(requested);
        } catch {
            setError('The poster could not be made. Please check your connection and try again.');
        } finally {
            inFlight.current = false;
            setBusy(false);
        }
    }

    /** "Use as Bundle Image" → confirm → store the poster and set it as THIS bundle's image. */
    async function publish() {
        if (inFlight.current || !publishable.current || !blobRef.current || !receipt) return;
        inFlight.current = true;
        setPublishing(true);
        setConfirming(false);
        setPublishError(null);
        setPublishedMessage(null);
        try {
            const form = new FormData();
            form.append('poster', blobRef.current, fileName);
            form.append('receipt', receipt);
            // The settings shown NOW: the server refuses them unless they are the poster's own.
            form.append('theme', theme);
            form.append('backgroundInstructions', instructions);
            form.append('showBadge', String(showBadge));
            const res = await fetch(`/api/bundles/${encodeURIComponent(props.bundleId)}/poster/publish`, { method: 'POST', body: form });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || typeof data?.imageUrl !== 'string' || !data.imageUrl) {
                setPublishError(data?.error || PUBLISH_FAILED);
                if (res.status === 409) setMustRegenerate(true);
                return;
            }
            setPublished(true);
            setPublishedMessage(POSTER_PUBLISHED_MESSAGE);
            announceBundleImagePublished(props.bundleId, data.imageUrl);
        } catch {
            setPublishError('The bundle image could not be updated. Please check your connection and try again.');
        } finally {
            inFlight.current = false;
            setPublishing(false);
        }
    }

    const photoNote = meta ? photoNoteText(meta.photos) : null;
    const publishHelp = !posterUrl || published || working
        ? null
        : stale || mustRegenerate
            ? POSTER_REGENERATE_FIRST
            : !receipt
                ? 'This poster can\'t be used as the bundle image. Regenerate it and try again.'
                : null;

    return (
        <section className="bg-white dark:bg-slate-800 p-6 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm space-y-4" aria-labelledby="bundle-poster-heading">
            <div>
                <h2 id="bundle-poster-heading" className="text-lg font-bold text-slate-900 dark:text-slate-100">Bundle Poster</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    A portrait poster made from this bundle&apos;s own recipes and their saved photos
                    {props.sizeLabel ? ` (${props.sizeLabel})` : ''}. It uses the bundle as last saved — save any changes first.
                </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                    <label htmlFor="bundle-poster-theme" className="block text-sm font-semibold text-slate-700 dark:text-slate-300">Season / Theme</label>
                    <select
                        id="bundle-poster-theme"
                        value={theme}
                        onChange={(e) => setTheme((POSTER_THEMES.find((t) => t.id === e.target.value)?.id ?? props.defaultTheme))}
                        disabled={working}
                        className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-60"
                    >
                        {POSTER_THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        {props.photoCount} of {props.mealCount} meal{props.mealCount === 1 ? '' : 's'} have a saved photo.
                    </p>
                </div>
                {props.derivedBadge && (
                    <div className="space-y-1">
                        <span className="block text-sm font-semibold text-slate-700 dark:text-slate-300">Badge</span>
                        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                            <input type="checkbox" checked={showBadge} disabled={working} onChange={(e) => setShowBadge(e.target.checked)} />
                            Show &ldquo;{props.derivedBadge}&rdquo; <span className="text-xs text-slate-500">(from the bundle name)</span>
                        </label>
                    </div>
                )}
            </div>

            <div className="space-y-1">
                <label htmlFor="bundle-poster-instructions" className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Background instructions <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
                </label>
                <textarea
                    id="bundle-poster-instructions"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value.slice(0, POSTER_BACKGROUND_INSTRUCTIONS_MAX))}
                    maxLength={POSTER_BACKGROUND_INSTRUCTIONS_MAX}
                    rows={2}
                    disabled={working}
                    placeholder={POSTER_INSTRUCTIONS_PLACEHOLDER}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 outline-none resize-none disabled:opacity-60"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                    Changes only the background scene. The meal photos and names always come from the recipes.
                    {instructions.length > 0 ? ` ${instructions.length}/${POSTER_BACKGROUND_INSTRUCTIONS_MAX}` : ''}
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={generate}
                    disabled={!canGenerate}
                    className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50"
                >
                    {busy ? 'Making poster…' : posterUrl ? 'Regenerate' : 'Generate Poster'}
                </button>
                {posterUrl && (
                    <>
                        <a href={posterUrl} target="_blank" rel="noopener noreferrer" className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
                            Preview Poster
                        </a>
                        <a href={posterUrl} download={fileName} className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700">
                            Download Poster
                        </a>
                        <button
                            type="button"
                            onClick={() => { if (publishable.current) { setPublishError(null); setConfirming(true); } }}
                            disabled={!canPublish}
                            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {publishing ? 'Saving…' : published ? 'Bundle Image Updated' : 'Use as Bundle Image'}
                        </button>
                    </>
                )}
                {props.mealCount === 0 && <span className="text-sm text-slate-500">Add recipes to this bundle to make a poster.</span>}
                {busy && <span className="text-sm text-slate-500" aria-live="polite">This can take up to a minute.</span>}
            </div>

            {publishHelp && <p className="text-sm text-slate-600 dark:text-slate-300">{publishHelp}</p>}

            {confirming && canPublish && (
                <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20" role="group" aria-label="Confirm bundle image">
                    <span className="text-sm text-slate-800 dark:text-slate-100">Use this poster as the bundle image? It replaces the image shown at the top of this page.</span>
                    <button type="button" onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800">
                        Cancel
                    </button>
                    <button type="button" onClick={publish} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700">
                        Use Poster
                    </button>
                </div>
            )}

            {publishedMessage && <p role="status" className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">{publishedMessage}</p>}
            {publishError && <p role="alert" className="text-sm text-rose-600">{publishError}</p>}
            {error && <p role="alert" className="text-sm text-rose-600">{error}</p>}

            {posterUrl && meta && (
                <div className="space-y-2">
                    {stale && (
                        <p className="text-sm font-semibold text-amber-700 dark:text-amber-400" role="status">
                            Settings changed since this poster was made. Click Regenerate to update it.
                        </p>
                    )}
                    <img src={posterUrl} alt={`${props.bundleName} poster`} className="w-full max-w-sm rounded-lg border border-slate-200 dark:border-slate-700 shadow" />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                        Made at {meta.generatedAt} from the saved bundle. {backgroundNoteText(meta)}
                        {photoNote ? ` ${photoNote}` : ''}
                        {meta.omittedMeals > 0 ? ` ${meta.omittedMeals} more meal${meta.omittedMeals === 1 ? '' : 's'} did not fit (the poster shows the first 6).` : ''}
                    </p>
                </div>
            )}
        </section>
    );
}
