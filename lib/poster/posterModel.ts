/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — WHAT a bundle poster says, derived only from the bundle as stored.
 *
 * Nothing here is invented:
 *   - the meals are the bundle's own linked recipes, in the bundle's own order;
 *   - each photo is that recipe's saved image_url (or nothing — never a substitute);
 *   - "Serves 5" / "Serves 2" comes from the bundle's serving tier through the existing strict
 *     authority (bundleSizeLabel), and is omitted when the tier is not recognised — and always for a
 *     fundraiser add-on, which has no serving size (posterSizeLabel);
 *   - the badge appears only when the bundle's NAME already says Keto / Comfort Food / Family
 *     Friendly / Gluten-Free; no other dietary wording is ever produced;
 *   - the supporting line is the bundle's own description, only when it is short enough to print.
 *
 * Pure: the route, the editor panel and the tests all build the same model from the same rows.
 */

import { bundleDisplayName, bundleSizeLabel } from '@/lib/bundleSummary';
import { ADD_ON_BUNDLE_TYPE, normalizeBundleType } from '@/lib/campaignAddOns';
import type { PosterTheme } from '@/lib/poster/posterThemes';

/** The template has balanced layouts for one to six meals. */
export const POSTER_MAX_MEALS = 6;
/** A description longer than this is not squeezed onto the poster. */
export const POSTER_TAGLINE_MAX = 120;

export type PhotoIssue = 'missing' | 'not_https' | 'unsupported_host';

export interface PosterMeal {
    recipeId: string;
    /** The recipe's name, without a "(Serves N)" marker that only repeats the poster's size. */
    label: string;
    /** The recipe's saved photo, when it can be placed; otherwise null and `photoIssue` says why. */
    photoUrl: string | null;
    photoIssue: PhotoIssue | null;
}

export interface PosterModel {
    bundleId: string;
    bundleName: string;
    title: string;
    sizeLabel: 'Serves 5' | 'Serves 2' | null;
    badge: string | null;
    tagline: string | null;
    meals: PosterMeal[];
    /** Linked recipes beyond POSTER_MAX_MEALS (not drawn; reported to the tenant). */
    omittedMeals: number;
}

export interface PosterBundleRow {
    id: string;
    name: string;
    serving_tier: string | null;
    /** FR-SUPPORTER-ADDON-UPSELL-1: 'addon' for a fundraiser add-on (no serving size on its poster). */
    bundle_type?: string | null;
    description: string | null;
    contents: { position: number | null; recipe: { id: string; name: string; image_url: string | null } | null }[];
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const EDGE = /^[\s\-–—:|,·]+|[\s\-–—:|,·]+$/g;

/**
 * The bundle name as the poster headline. The size marker goes (the banner says it), and when the
 * theme prints a season word, that season word — with a year after it ("Winter 27", "Fall 2026") —
 * is not repeated in the headline. "Bundle" is added when the name does not already say it.
 */
export function posterTitle(bundleName: string, sizeLabel: string | null, theme: Pick<PosterTheme, 'seasonWord'>): string {
    let title = bundleDisplayName(bundleName, sizeLabel);
    if (theme.seasonWord) {
        const season = theme.seasonWord.toLowerCase() === 'fall' ? '(?:fall|autumn)' : theme.seasonWord;
        const without = squash(title.replace(new RegExp(`\\b${season}\\b(?:\\s*'?\\d{2,4}\\b)?`, 'gi'), ' '))
            .replace(/\s*[-–—:|,·]\s*[-–—:|,·]\s*/g, ' - ')
            .replace(EDGE, '');
        if (without) title = without;
    }
    title = squash(title);
    return /\bbundle\b/i.test(title) ? title : `${title} Bundle`;
}

const BADGES: readonly [RegExp, string][] = [
    [/\bketo\b/i, 'Keto Meal Favorites'],
    [/\bcomfort\s+foods?\b/i, 'Comfort Food Favorites'],
    [/\bfamily[\s-]+friendly\b/i, 'Family Friendly Favorites'],
    [/\bgluten[\s-]+free\b/i, 'Gluten-Free Favorites'],
];

/** The round badge — only from words the bundle's own name already uses; otherwise none. */
export function posterBadge(bundleName: string | null | undefined): string | null {
    const name = String(bundleName ?? '');
    for (const [re, text] of BADGES) if (re.test(name)) return text;
    return null;
}

/** The bundle's own description as the supporting line, when it is short enough to print whole. */
export function posterTagline(description: string | null | undefined): string | null {
    const text = squash(String(description ?? ''));
    if (!text || text.length > POSTER_TAGLINE_MAX) return null;
    return text;
}

/** A meal's label: the recipe name, minus a "(Serves N)" marker that matches the poster's size. */
export function posterMealLabel(recipeName: string | null | undefined, sizeLabel: string | null): string {
    const raw = squash(String(recipeName ?? ''));
    if (!raw) return 'Meal';
    return squash(bundleDisplayName(raw, sizeLabel));
}

/**
 * Which photo hosts the server may fetch from: the platform's own media domain (S3_PUBLIC_DOMAIN).
 * A recipe's image_url is free text, so fetching any URL it names would let a tenant point the
 * server at an internal address; every real recipe photo is uploaded to the media domain.
 */
export function posterPhotoHosts(env: NodeJS.ProcessEnv = process.env): string[] {
    const domain = String(env.S3_PUBLIC_DOMAIN ?? '').trim();
    if (!domain) return [];
    try {
        const u = new URL(domain);
        return u.protocol === 'https:' ? [u.hostname.toLowerCase()] : [];
    } catch {
        return [];
    }
}

/** The recipe's saved photo URL, if it can be placed; otherwise why not. Never a substitute image. */
export function posterPhotoSource(imageUrl: string | null | undefined, allowedHosts: readonly string[]):
    { url: string; issue: null } | { url: null; issue: PhotoIssue } {
    const raw = String(imageUrl ?? '').trim();
    if (!raw || /food-placeholder/i.test(raw)) return { url: null, issue: 'missing' };
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return { url: null, issue: 'missing' }; // relative paths (local dev uploads, the placeholder)
    }
    if (u.protocol !== 'https:') return { url: null, issue: 'not_https' };
    if (!allowedHosts.includes(u.hostname.toLowerCase())) return { url: null, issue: 'unsupported_host' };
    return { url: u.toString(), issue: null };
}

/** The bundle's meals in the bundle's own order: position, then name, then id (fully deterministic). */
export function orderedRecipes(contents: PosterBundleRow['contents']) {
    return contents
        .filter((c) => c.recipe)
        .map((c, i) => ({ position: c.position, recipe: c.recipe!, i }))
        .sort((a, b) => {
            const pa = a.position ?? Number.MAX_SAFE_INTEGER, pb = b.position ?? Number.MAX_SAFE_INTEGER;
            if (pa !== pb) return pa - pb;
            const n = a.recipe.name.localeCompare(b.recipe.name);
            return n !== 0 ? n : a.recipe.id.localeCompare(b.recipe.id);
        })
        .map((x) => x.recipe);
}

export interface PosterModelOptions {
    theme: Pick<PosterTheme, 'seasonWord'>;
    allowedHosts: readonly string[];
    /** The tenant may hide a derived badge; it is never added when the name does not support one. */
    showBadge?: boolean;
}

/**
 * The poster's serving-size line. A meal bundle keeps its "Serves 5" / "Serves 2" exactly as before. A
 * fundraiser add-on has NO serving size: it is stored with the internal 'family' tier only for kitchen
 * compatibility, and must never be presented as "Serves 5" (FR-SUPPORTER-ADDON-UPSELL-1).
 */
export function posterSizeLabel(servingTier: string | null | undefined, bundleType: unknown): PosterModel['sizeLabel'] {
    if (normalizeBundleType(bundleType) === ADD_ON_BUNDLE_TYPE) return null;
    return bundleSizeLabel(servingTier) as PosterModel['sizeLabel'];
}

export function buildPosterModel(bundle: PosterBundleRow, opts: PosterModelOptions): PosterModel {
    const sizeLabel = posterSizeLabel(bundle.serving_tier, bundle.bundle_type);
    const recipes = orderedRecipes(bundle.contents);
    const shown = recipes.slice(0, POSTER_MAX_MEALS);
    return {
        bundleId: bundle.id,
        bundleName: bundle.name,
        title: posterTitle(bundle.name, sizeLabel, opts.theme),
        sizeLabel,
        badge: opts.showBadge === false ? null : posterBadge(bundle.name),
        tagline: posterTagline(bundle.description),
        meals: shown.map((r) => {
            const photo = posterPhotoSource(r.image_url, opts.allowedHosts);
            return { recipeId: r.id, label: posterMealLabel(r.name, sizeLabel), photoUrl: photo.url, photoIssue: photo.issue };
        }),
        omittedMeals: Math.max(0, recipes.length - shown.length),
    };
}

/** A safe download name: "Keto-Winter-27-Serves-5-poster.jpg". */
export function posterFileName(bundleName: string, sizeLabel: string | null, ext: 'jpg' | 'png'): string {
    const base = `${bundleDisplayName(bundleName, sizeLabel)} ${sizeLabel ?? ''}`
        .normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'bundle';
    return `${base}-poster.${ext}`;
}
