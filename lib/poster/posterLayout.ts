/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the poster's geometry: fixed, deterministic rectangles.
 *
 * Portrait 4:5 at 1600 × 2000 px: 8 × 10 in at 200 dpi for a printed handout, and the 4:5 shape
 * social feeds show uncropped. The header (season word, bundle name, Serves banner, line, badge)
 * sits above y = HEADER_BOTTOM; the meals sit in the FOOD area below it.
 *
 * Every meal has a photo rectangle and a label rectangle. The label overlaps the bottom edge of its
 * OWN photo (like the reference posters) and nothing else: tests/bundlePosterFromRecipes1 proves that
 * for 1–6 meals no label touches another meal's photo or label and everything stays inside the food
 * area — so overlap is impossible by construction, whatever the text.
 */

export const POSTER_WIDTH = 1600;
export const POSTER_HEIGHT = 2000;

export interface Rect { x: number; y: number; w: number; h: number }

export const BADGE: Rect = { x: 1262, y: 34, w: 300, h: 300 };

export interface HeaderLayout {
    season: Rect | null;
    title: Rect;
    titleMaxLines: number;
    serves: Rect;
    divider: Rect;
    tagline: Rect;
}

/**
 * With a season word the title sits under it; without one the title moves up into its place — kept
 * centred on the poster, and narrowed symmetrically so it can never reach the badge.
 */
export function headerLayout(hasSeasonWord: boolean, hasBadge: boolean): HeaderLayout {
    const sideClear = POSTER_WIDTH - BADGE.x + 24; // badge width + a margin, mirrored on both sides
    const title: Rect = hasSeasonWord
        ? { x: 90, y: 345, w: 1420, h: 250 }
        : hasBadge
            ? { x: sideClear, y: 70, w: POSTER_WIDTH - 2 * sideClear, h: 520 }
            : { x: 90, y: 110, w: 1420, h: 470 };
    return {
        season: hasSeasonWord ? { x: 330, y: 30, w: 900, h: 300 } : null,
        title,
        titleMaxLines: hasSeasonWord ? 2 : 3,
        serves: { x: 420, y: 615, w: 760, h: 150 },
        divider: { x: 330, y: 785, w: 940, h: 34 },
        tagline: { x: 150, y: 826, w: 1300, h: 92 },
    };
}

export const FOOD_AREA: Rect = { x: 40, y: 930, w: 1520, h: 1045 };

/** How far a label rides up over the bottom of its photo, and how tall it is. */
export const LABEL_OVERLAP = 56;
export const LABEL_HEIGHT = 118;
const LABEL_MAX_W = 560;
const LABEL_SIDE_INSET = 15;

export interface MealSlot { photo: Rect; label: Rect }

const row = (count: number, w: number, h: number, gap: number, y: number): Rect[] => {
    const total = count * w + (count - 1) * gap;
    const x0 = Math.round((POSTER_WIDTH - total) / 2);
    return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (w + gap), y, w, h }));
};

const PHOTO_ROWS: Record<number, Rect[]> = {
    1: row(1, 1100, 850, 0, 960),
    2: row(2, 700, 800, 60, 980),
    3: [...row(2, 680, 400, 60, 940), ...row(1, 760, 440, 0, 1450)],
    4: [...row(2, 680, 390, 60, 940), ...row(2, 680, 390, 60, 1440)],
    5: [...row(3, 470, 380, 35, 940), ...row(2, 640, 440, 60, 1430)],
    6: [...row(3, 470, 380, 35, 940), ...row(3, 470, 380, 35, 1440)],
};

export function labelFor(photo: Rect): Rect {
    const w = Math.min(photo.w - 2 * LABEL_SIDE_INSET, LABEL_MAX_W);
    return { x: photo.x + Math.round((photo.w - w) / 2), y: photo.y + photo.h - LABEL_OVERLAP, w, h: LABEL_HEIGHT };
}

/** The slots for `count` meals (1–6), in bundle order: left to right, top row first. */
export function mealSlots(count: number): MealSlot[] {
    const photos = PHOTO_ROWS[count];
    if (!photos) throw new Error(`no poster layout for ${count} meals`);
    return photos.map((photo) => ({ photo, label: labelFor(photo) }));
}

/** Inner text box of a label (brush padding removed). */
export function labelTextBox(label: Rect): Rect {
    return { x: label.x + 30, y: label.y + 10, w: label.w - 60, h: label.h - 20 };
}

export const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const inside = (inner: Rect, outer: Rect) =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
