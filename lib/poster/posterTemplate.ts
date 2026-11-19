/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the reusable poster template.
 *
 * Five layers, bottom to top, composited by code:
 *   1. background  — the AI backdrop or the drawn scene (one raster image, full bleed);
 *   2. template    — header glow, flourishes, divider (theme colours, fixed shapes);
 *   3. photos      — each meal's OWN saved photo, cropped to its slot (or the neutral card);
 *   4. labels      — a brush-stroke label per meal, carrying that meal's name;
 *   5. header text — season word, bundle name, "Serves N" banner, supporting line, round badge.
 *
 * All text is laid out HERE with the real font metrics (posterTextPlan) — explicit lines, explicit
 * sizes — and drawn with the bundled fonts. The image model never draws a word or a meal.
 */

import React from 'react';
import type { FontMetrics } from '@/lib/poster/fontMetrics';
import { fitText, measureText, type FittedText } from '@/lib/poster/fontMetrics';
import type { PosterModel } from '@/lib/poster/posterModel';
import type { PosterTheme } from '@/lib/poster/posterThemes';
import {
    BADGE, POSTER_HEIGHT, POSTER_WIDTH, headerLayout, labelTextBox, mealSlots,
    type HeaderLayout, type MealSlot, type Rect,
} from '@/lib/poster/posterLayout';
import {
    badgeSvg, brushBannerSvg, dividerSvg, flourishSvg, headerGlowSvg, labelBrushSvg, missingPhotoSvg, motifIconSvg, svgDataUri,
} from '@/lib/poster/posterDecor';

export const FONT_TITLE = 'Anton';
export const FONT_SCRIPT = 'Pacifico';
export const FONT_LABEL = 'Bebas Neue';

/** The card border around each photo; the photo itself is cropped to the slot minus this. */
export const PHOTO_BORDER = 10;

export interface PosterMetrics { anton: FontMetrics; pacifico: FontMetrics; bebas: FontMetrics }

export interface PosterTextPlan {
    header: HeaderLayout;
    season: FittedText | null;
    title: FittedText;
    serves: FittedText | null;
    tagline: FittedText | null;
    badge: FittedText | null;
    meals: { slot: MealSlot; label: FittedText }[];
}

export const photoInnerSize = (slot: MealSlot) => ({ w: slot.photo.w - 2 * PHOTO_BORDER, h: slot.photo.h - 2 * PHOTO_BORDER });

const inset = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy });

/** Every line of text on the poster, sized and wrapped with the real fonts. Pure. */
export function posterTextPlan(model: PosterModel, theme: PosterTheme, m: PosterMetrics): PosterTextPlan {
    const header = headerLayout(!!theme.seasonWord, !!model.badge);
    const season = theme.seasonWord && header.season
        ? fitText(m.pacifico, theme.seasonWord, { maxWidth: header.season.w - 240, maxHeight: header.season.h, maxLines: 1, sizes: [200, 184, 168, 152, 136], lineHeight: 1.25 })
        : null;
    const title = fitText(m.anton, model.title.toUpperCase(), {
        maxWidth: header.title.w, maxHeight: header.title.h, maxLines: header.titleMaxLines,
        sizes: [190, 176, 162, 150, 138, 126, 116, 106, 98, 90], lineHeight: 1.0, letterSpacing: 2,
    });
    const servesBox = inset(header.serves, 90, 12);
    const serves = model.sizeLabel
        ? fitText(m.pacifico, model.sizeLabel, { maxWidth: servesBox.w, maxHeight: servesBox.h, maxLines: 1, sizes: [96, 88, 80, 72], lineHeight: 1.2 })
        : null;
    const tagline = model.tagline
        ? fitText(m.bebas, model.tagline.toUpperCase(), { maxWidth: header.tagline.w, maxHeight: header.tagline.h, maxLines: 2, sizes: [50, 46, 42, 38, 34], lineHeight: 1.05, letterSpacing: 2.5 })
        : null;
    const badge = model.badge
        ? fitText(m.bebas, model.badge.toUpperCase(), { maxWidth: 196, maxHeight: 168, maxLines: 3, sizes: [60, 56, 52, 48, 44, 40], lineHeight: 1.0, letterSpacing: 1 })
        : null;
    const slots = mealSlots(model.meals.length);
    const meals = model.meals.map((meal, i) => {
        const box = labelTextBox(slots[i].label);
        return {
            slot: slots[i],
            label: fitText(m.bebas, meal.label.toUpperCase(), { maxWidth: box.w, maxHeight: box.h, maxLines: 2, sizes: [54, 50, 46, 42, 38, 34], lineHeight: 1.0, letterSpacing: 1 }),
        };
    });
    return { header, season, title, serves, tagline, badge, meals };
}

// ── element helpers (plain objects the renderer understands; no JSX) ────────────────────────────

type El = React.ReactElement;
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): El =>
    React.createElement(type, { style }, ...(children as React.ReactNode[]));
const abs = (r: Rect, extra: Record<string, unknown> = {}) => ({ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, display: 'flex', ...extra });
const img = (src: string, r: Rect, extra: Record<string, unknown> = {}): El =>
    React.createElement('img', { src, width: r.w, height: r.h, style: { position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, ...extra } });

function textBlock(r: Rect, fitted: FittedText, font: string, color: string, extra: Record<string, unknown> = {}): El {
    return h('div', abs(r, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }),
        ...fitted.lines.map((line) => h('div', {
            display: 'flex', fontFamily: font, fontSize: fitted.fontSize, lineHeight: fitted.lineHeight, color, whiteSpace: 'nowrap', ...extra,
        }, line)));
}

export interface PosterImages {
    /** data: URI of the full-bleed backdrop (AI or drawn). */
    background: string;
    /** One per meal, in order: data: URI of that meal's own cropped photo, or null for the neutral card. */
    photos: (string | null)[];
}

/** The poster as an element tree, 1600 × 2000. */
export function buildPosterTree(model: PosterModel, theme: PosterTheme, plan: PosterTextPlan, images: PosterImages, m: PosterMetrics): El {
    const p = theme.palette;
    const H = plan.header;
    const layers: El[] = [];

    // 1. Background.
    layers.push(img(images.background, { x: 0, y: 0, w: POSTER_WIDTH, h: POSTER_HEIGHT }, { objectFit: 'cover' }));

    // 2. Template layer.
    layers.push(img(svgDataUri(headerGlowSvg()), { x: 0, y: 0, w: POSTER_WIDTH, h: 960 }));
    layers.push(img(svgDataUri(dividerSvg(p.accent, theme.motif)), H.divider));
    if (plan.serves) {
        layers.push(img(svgDataUri(flourishSvg(p.accent)), { x: H.serves.x - 110, y: H.serves.y + 40, w: 90, h: 70 }));
        layers.push(img(svgDataUri(flourishSvg(p.accent, true)), { x: H.serves.x + H.serves.w + 20, y: H.serves.y + 40, w: 90, h: 70 }));
    }

    // 3. Photos — each meal's own photo, or the neutral card.
    plan.meals.forEach(({ slot }, i) => {
        const inner = photoInnerSize(slot);
        const photo = images.photos[i];
        const content = photo
            ? React.createElement('img', { src: photo, width: inner.w, height: inner.h, style: { width: inner.w, height: inner.h, borderRadius: 18, objectFit: 'cover' } })
            : h('div', { display: 'flex', position: 'relative', width: inner.w, height: inner.h, borderRadius: 18, overflow: 'hidden' },
                React.createElement('img', { src: svgDataUri(missingPhotoSvg()), width: inner.w, height: inner.h, style: { position: 'absolute', left: 0, top: 0, width: inner.w, height: inner.h, objectFit: 'cover' } }),
                h('div', { position: 'absolute', left: 0, top: Math.round(inner.h * 0.62), width: inner.w, display: 'flex', justifyContent: 'center', fontFamily: FONT_LABEL, fontSize: 34, letterSpacing: 2, color: '#8C7F6E' }, 'PHOTO COMING SOON'));
        layers.push(h('div', abs(slot.photo, {
            padding: PHOTO_BORDER, backgroundColor: '#FFFFFF', borderRadius: 26, boxShadow: '0 18px 36px rgba(0,0,0,0.35)',
        }), content));
    });

    // 4. Labels — one per meal, on its own photo's bottom edge.
    plan.meals.forEach(({ slot, label }) => {
        layers.push(img(svgDataUri(labelBrushSvg(p.accent)), slot.label));
        layers.push(textBlock(labelTextBox(slot.label), label, FONT_LABEL, p.onAccent, { letterSpacing: 1 }));
    });

    // 5. Header text, banner and badge.
    if (plan.season && H.season) {
        layers.push(textBlock(H.season, plan.season, FONT_SCRIPT, p.season));
        const word = measureText(m.pacifico, theme.seasonWord!, plan.season.fontSize);
        const cx = H.season.x + H.season.w / 2, cy = H.season.y + H.season.h / 2;
        const left = cx - word / 2 - 120, right = cx + word / 2 + 40;
        if (left >= H.season.x && right + 80 <= H.season.x + H.season.w) {
            layers.push(img(svgDataUri(motifIconSvg(theme.motif, p.season)), { x: Math.round(left), y: Math.round(cy - 40), w: 80, h: 80 }));
            layers.push(img(svgDataUri(motifIconSvg(theme.motif, p.season)), { x: Math.round(right), y: Math.round(cy - 40), w: 80, h: 80 }));
        }
    }
    layers.push(textBlock(H.title, plan.title, FONT_TITLE, p.title, { letterSpacing: 2, textShadow: '0 0 22px rgba(255,255,255,0.9)' }));
    if (plan.serves) {
        layers.push(img(svgDataUri(brushBannerSvg(p.accent)), H.serves));
        layers.push(textBlock(inset(H.serves, 90, 12), plan.serves, FONT_SCRIPT, p.onAccent));
    }
    if (plan.tagline) {
        layers.push(textBlock(H.tagline, plan.tagline, FONT_LABEL, p.tagline, { letterSpacing: 2.5 }));
    }
    if (plan.badge) {
        layers.push(img(svgDataUri(badgeSvg(p.accent)), BADGE));
        layers.push(textBlock({ x: BADGE.x + 52, y: BADGE.y + 46, w: 196, h: 168 }, plan.badge, FONT_LABEL, p.onAccent, { letterSpacing: 1 }));
        layers.push(img(svgDataUri(motifIconSvg(theme.motif, '#FFFFFF', 0.9)), { x: BADGE.x + 132, y: BADGE.y + 222, w: 36, h: 36 }));
    }

    return h('div', { display: 'flex', position: 'relative', width: POSTER_WIDTH, height: POSTER_HEIGHT, backgroundColor: '#FFFFFF' }, ...layers);
}
