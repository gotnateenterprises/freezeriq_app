/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the drawn backdrop: always available, no AI, no network.
 *
 * Used when the AI backdrop is not requested (Special / Custom with no instructions), when no key is
 * configured, and whenever the AI call fails — so a poster can always be produced. Same layout as the
 * AI brief: a light, calm upper scene with the theme's motif only at the edges, and a plank tabletop
 * across the lower part where the meal photos sit. Positions come from a fixed seed, so the same theme
 * always draws the same scene.
 */

import type { PosterTheme } from '@/lib/poster/posterThemes';
import { motifIconSvg } from '@/lib/poster/posterDecor';
import { POSTER_HEIGHT, POSTER_WIDTH } from '@/lib/poster/posterLayout';

const TABLE_Y = 900;

/** Deterministic pseudo-random sequence (LCG) so scenes are identical run to run. */
function seeded(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const nested = (svg: string, x: number, y: number, size: number, rotate = 0) =>
    svg.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" viewBox="0 0 100 100" overflow="visible">`)
        .replace('<g opacity', `<g transform="rotate(${rotate.toFixed(0)} 50 50)" opacity`);

/** Edge positions only: the middle of the header stays calm for the title. */
function edgePoints(rand: () => number, count: number): { x: number; y: number }[] {
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) {
        const left = i % 2 === 0;
        const x = left ? 10 + rand() * 260 : 1330 + rand() * 250;
        const y = 360 + rand() * 520; // below the badge, above the table
        pts.push({ x, y });
    }
    return pts;
}

function pine(x: number, base: number, height: number, color: string, opacity: number): string {
    const w = height * 0.55;
    let tiers = '';
    for (let t = 0; t < 4; t++) {
        const top = base - height + t * height * 0.2;
        const bottom = top + height * 0.42;
        const half = (w / 2) * (0.55 + t * 0.15);
        tiers += `<path d="M${x} ${top.toFixed(0)} L${(x + half).toFixed(0)} ${bottom.toFixed(0)} L${(x - half).toFixed(0)} ${bottom.toFixed(0)} Z"/>`;
    }
    return `<g fill="${color}" opacity="${opacity}">${tiers}<rect x="${x - 8}" y="${base - 30}" width="16" height="30"/></g>`;
}

export function fallbackBackgroundSvg(theme: PosterTheme): string {
    const f = theme.fallback;
    const rand = seeded(theme.id.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
    const parts: string[] = [];

    parts.push(`<defs>`
        + `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.skyTop}"/><stop offset="1" stop-color="${f.skyBottom}"/></linearGradient>`
        + `<linearGradient id="table" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${f.tableTop}"/><stop offset="1" stop-color="${f.tableBottom}"/></linearGradient>`
        + `<linearGradient id="edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.28"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient>`
        + `<radialGradient id="vignette" cx="50%" cy="55%" r="75%"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.28"/></radialGradient>`
        + (f.glow ? `<radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${f.glow}" stop-opacity="0.75"/><stop offset="1" stop-color="${f.glow}" stop-opacity="0"/></radialGradient>` : '')
        + `</defs>`);

    // Upper scene.
    parts.push(`<rect x="0" y="0" width="${POSTER_WIDTH}" height="${TABLE_Y + 40}" fill="url(#sky)"/>`);
    if (f.glow) {
        const gx = theme.motif === 'sun' ? 230 : 190;
        const gy = theme.motif === 'sun' ? 200 : 660;
        parts.push(`<circle cx="${gx}" cy="${gy}" r="${theme.motif === 'sun' ? 360 : 260}" fill="url(#glow)"/>`);
    }

    const colors = f.motifColors.length ? f.motifColors : ['#FFFFFF'];
    switch (theme.motif) {
        case 'snowflake': {
            parts.push(pine(110, TABLE_Y + 20, 520, colors[1] ?? '#9FB6CC', 0.5));
            parts.push(pine(250, TABLE_Y + 30, 380, colors[2] ?? '#5E7F66', 0.35));
            parts.push(pine(1480, TABLE_Y + 20, 560, colors[1] ?? '#9FB6CC', 0.5));
            parts.push(pine(1340, TABLE_Y + 30, 360, colors[2] ?? '#5E7F66', 0.35));
            parts.push(`<ellipse cx="200" cy="${TABLE_Y + 25}" rx="420" ry="70" fill="#FFFFFF" opacity="0.85"/>`);
            parts.push(`<ellipse cx="1420" cy="${TABLE_Y + 25}" rx="420" ry="70" fill="#FFFFFF" opacity="0.85"/>`);
            for (let i = 0; i < 26; i++) {
                const x = rand() * POSTER_WIDTH, y = 20 + rand() * (TABLE_Y - 60);
                const centre = x > 330 && x < 1270 && y > 40 && y < 860;
                const size = centre ? 10 + rand() * 12 : 22 + rand() * 30;
                parts.push(nested(motifIconSvg('snowflake', '#FFFFFF', centre ? 0.45 : 0.85), x, y, size, rand() * 60));
            }
            break;
        }
        case 'leaf':
        case 'blossom':
        case 'sun': {
            const motif = theme.motif === 'sun' ? 'leaf' : theme.motif;
            for (const [i, p] of edgePoints(rand, 22).entries()) {
                const size = 50 + rand() * 70;
                parts.push(nested(motifIconSvg(motif, colors[i % colors.length], 0.8), p.x, p.y, size, rand() * 360));
            }
            if (theme.motif === 'sun') parts.push(nested(motifIconSvg('sun', '#FFC94D', 0.9), 120, 90, 220));
            break;
        }
        default:
            break;
    }

    // Tabletop: gradient, planks, grain, a soft back-edge shadow and a vignette.
    parts.push(`<rect x="0" y="${TABLE_Y}" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT - TABLE_Y}" fill="url(#table)"/>`);
    for (let y = TABLE_Y + 120; y < POSTER_HEIGHT; y += 150) {
        parts.push(`<rect x="0" y="${y}" width="${POSTER_WIDTH}" height="4" fill="${f.plank}" opacity="0.35"/>`);
    }
    for (let i = 0; i < 70; i++) {
        const y = TABLE_Y + 10 + rand() * (POSTER_HEIGHT - TABLE_Y - 20);
        const x = rand() * POSTER_WIDTH, w = 120 + rand() * 420;
        parts.push(`<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="2" fill="${f.plank}" opacity="${(0.08 + rand() * 0.12).toFixed(2)}"/>`);
    }
    parts.push(`<rect x="0" y="${TABLE_Y}" width="${POSTER_WIDTH}" height="70" fill="url(#edge)"/>`);
    parts.push(`<rect x="0" y="0" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" fill="url(#vignette)"/>`);

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${POSTER_WIDTH}" height="${POSTER_HEIGHT}" viewBox="0 0 ${POSTER_WIDTH} ${POSTER_HEIGHT}">${parts.join('')}</svg>`;
}
