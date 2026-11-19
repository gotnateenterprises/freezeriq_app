/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the poster theme family, defined in ONE place.
 *
 * The owner's Winter Keto / Comfort Food posters set the design: a script season word, a heavy
 * condensed bundle name, a brush-stroke "Serves N" banner, an optional round badge, a short line, and
 * the meals on a tabletop with brush-stroke labels. Every theme below fills the SAME template
 * (lib/poster/posterTemplate.ts) — only the palette, the season word, the drawn fallback scene and
 * the AI backdrop direction change — so Spring, Summer, Fall and Winter read as one branded family.
 *
 * Pure and dependency-free: the editor panel imports the list for its control, the server for the
 * render, so a label the tenant picks always means the same scene.
 */

export const POSTER_THEME_IDS = ['spring', 'summer', 'fall', 'winter', 'custom'] as const;
export type PosterThemeId = typeof POSTER_THEME_IDS[number];

/** The decorative motif drawn by the template layer and the fallback scene. */
export type PosterMotif = 'blossom' | 'sun' | 'leaf' | 'snowflake' | 'none';

export interface PosterPalette {
    /** Brush banner, meal labels, badge, divider. */
    accent: string;
    /** Text on top of the accent colour. */
    onAccent: string;
    /** The bundle name. */
    title: string;
    /** The script season word. */
    season: string;
    /** The short supporting line. */
    tagline: string;
}

/** The drawn, non-AI scene: always available, used whenever the AI backdrop is not. */
export interface PosterFallbackScene {
    skyTop: string;
    skyBottom: string;
    tableTop: string;
    tableBottom: string;
    plank: string;
    /** Soft motif colours, drawn at the edges only. */
    motifColors: readonly string[];
    /** An optional warm glow (lantern / sun / harvest light) in the header's left edge. */
    glow: string | null;
}

export interface PosterTheme {
    readonly id: PosterThemeId;
    readonly label: string;
    /** The script word at the top of the poster; null = no season word (Special / Custom). */
    readonly seasonWord: string | null;
    readonly motif: PosterMotif;
    readonly palette: Readonly<PosterPalette>;
    /** Direction for the AI backdrop (background only — never food, never text). */
    readonly aiDirection: readonly string[];
    readonly fallback: Readonly<PosterFallbackScene>;
}

const theme = (t: PosterTheme): PosterTheme => Object.freeze({
    ...t,
    palette: Object.freeze({ ...t.palette }),
    aiDirection: Object.freeze([...t.aiDirection]),
    fallback: Object.freeze({ ...t.fallback, motifColors: Object.freeze([...t.fallback.motifColors]) }),
});

export const POSTER_THEMES: readonly PosterTheme[] = Object.freeze([
    theme({
        id: 'spring',
        label: 'Spring',
        seasonWord: 'Spring',
        motif: 'blossom',
        palette: { accent: '#3F6F4A', onAccent: '#FFFFFF', title: '#2B2A1F', season: '#B4466E', tagline: '#2B2A1F' },
        aiDirection: [
            'Bright, fresh and airy spring scene.',
            'Subtle flowers or blossoms and light greenery at the edges.',
            'Soft natural daylight.',
            'A light wood or neutral table surface.',
            'A fresh seasonal atmosphere.',
        ],
        fallback: {
            skyTop: '#EAF4E6', skyBottom: '#FFFDF7', tableTop: '#D9BC93', tableBottom: '#B98F5E', plank: '#8C6A43',
            motifColors: ['#F2B8C9', '#FFFFFF', '#9CC58D', '#E58FAE'], glow: null,
        },
    }),
    theme({
        id: 'summer',
        label: 'Summer',
        seasonWord: 'Summer',
        motif: 'sun',
        palette: { accent: '#0E6A86', onAccent: '#FFFFFF', title: '#1E2A40', season: '#D9662B', tagline: '#1E2A40' },
        aiDirection: [
            'Warm natural daylight in a bright summer setting.',
            'Bright, clean colours.',
            'A subtle outdoor patio or picnic, or a sunny kitchen, feeling.',
            'Fresh greenery and light seasonal decor at the edges.',
            'No excessive clutter.',
        ],
        fallback: {
            skyTop: '#DDF1FA', skyBottom: '#FFF9E8', tableTop: '#E2C59C', tableBottom: '#C49A66', plank: '#97724A',
            motifColors: ['#FFD166', '#7CC47F', '#4FB3BF'], glow: '#FFE7A3',
        },
    }),
    theme({
        id: 'fall',
        label: 'Fall',
        seasonWord: 'Fall',
        motif: 'leaf',
        palette: { accent: '#8A3B12', onAccent: '#FFFFFF', title: '#3A1E12', season: '#8A3B12', tagline: '#3A1E12' },
        aiDirection: [
            'Warm, cozy autumn harvest scene.',
            'Warm wood and subtle autumn foliage at the edges.',
            'Amber, golden lighting.',
            'Restrained seasonal decoration.',
            'Rich but calm and readable.',
        ],
        fallback: {
            skyTop: '#F5E3CB', skyBottom: '#FCF4E8', tableTop: '#8A5631', tableBottom: '#5E3519', plank: '#3E220F',
            motifColors: ['#D9732B', '#B5401E', '#E3A83B'], glow: '#F7C873',
        },
    }),
    theme({
        id: 'winter',
        label: 'Winter',
        seasonWord: 'Winter',
        motif: 'snowflake',
        palette: { accent: '#1E3A6E', onAccent: '#FFFFFF', title: '#3A1E14', season: '#1E3A6E', tagline: '#2A2A2A' },
        aiDirection: [
            'Soft snowy winter scene seen through a farmhouse window.',
            'Pine and evergreen branches and a few restrained snowflakes at the edges.',
            'A cozy lantern or a warm accent light at one side.',
            'A cool blue-and-white palette that balances warm food photography.',
            'A warm, dark wooden table in the lower part.',
        ],
        fallback: {
            skyTop: '#D7E6F3', skyBottom: '#F6FAFE', tableTop: '#7A4A2C', tableBottom: '#4E2C17', plank: '#33190A',
            motifColors: ['#FFFFFF', '#9FB6CC', '#5E7F66'], glow: '#F6B860',
        },
    }),
    theme({
        id: 'custom',
        label: 'Special / Custom',
        seasonWord: null,
        motif: 'none',
        palette: { accent: '#2F3B4A', onAccent: '#FFFFFF', title: '#1F2329', season: '#2F3B4A', tagline: '#2F3B4A' },
        aiDirection: [
            'A neutral, softly lit setting with no seasonal decoration unless the notes below ask for it.',
        ],
        fallback: {
            skyTop: '#F1EEE8', skyBottom: '#FBFAF7', tableTop: '#CDBBA4', tableBottom: '#A88F72', plank: '#7C6650',
            motifColors: [], glow: null,
        },
    }),
]);

export type ThemeResolution = { ok: true; theme: PosterTheme } | { ok: false };

/** A caller-supplied theme id → the theme. Exact ids only; looked up by array search, never by key. */
export function resolvePosterTheme(raw: unknown): ThemeResolution {
    if (typeof raw !== 'string') return { ok: false };
    const found = POSTER_THEMES.find((t) => t.id === raw);
    return found ? { ok: true, theme: found } : { ok: false };
}

export function posterThemeById(id: PosterThemeId): PosterTheme {
    return POSTER_THEMES.find((t) => t.id === id)!;
}

const SEASON_WORDS: readonly [PosterThemeId, RegExp][] = [
    ['spring', /\bspring\b/i],
    ['summer', /\bsummer\b/i],
    ['fall', /\b(fall|autumn)\b/i],
    ['winter', /\bwinter\b/i],
];

/**
 * The theme the panel starts on.
 *   - The bundle's own name names exactly ONE season ("Keto - Winter 27") → that season. This is the
 *     only inference made, because it is the only reliable one: it is what the tenant typed.
 *   - Otherwise the current calendar season (Northern Hemisphere, by month) — the most appropriate
 *     existing season, and the tenant can change it before generating.
 */
export function defaultPosterTheme(bundleName: string | null | undefined, now: Date = new Date()): PosterThemeId {
    const name = String(bundleName ?? '');
    const named = SEASON_WORDS.filter(([, re]) => re.test(name)).map(([id]) => id);
    if (named.length === 1) return named[0];
    const m = now.getUTCMonth(); // 0 = January
    if (m >= 2 && m <= 4) return 'spring';
    if (m >= 5 && m <= 7) return 'summer';
    if (m >= 8 && m <= 10) return 'fall';
    return 'winter';
}
