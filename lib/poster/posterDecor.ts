/**
 * BUNDLE-POSTER-FROM-RECIPES-1 — the template's drawn pieces, as small SVG documents.
 *
 * Brush-stroke banner and labels, the flourishes beside the banner, the divider, the round badge, the
 * season motifs and the neutral missing-photo card. They contain NO text (text is drawn by the
 * renderer with the bundled fonts), so they render identically everywhere. Colours come from the
 * theme palette; shapes never change between themes, which is what keeps the family consistent.
 */

import type { PosterMotif } from '@/lib/poster/posterThemes';

export const svgDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

const esc = (c: string) => c.replace(/[^#0-9A-Za-z(),.%\s-]/g, '');

/** A dry-brush horizontal stroke, ragged at both ends (viewBox 760 × 150, stretched to fit). */
export function brushBannerSvg(color: string): string {
    const c = esc(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 150" preserveAspectRatio="none">`
        + `<path fill="${c}" d="M22 30 L70 21 L150 27 L270 17 L400 25 L540 15 L680 24 L742 19 L733 44 L752 62 L737 80 L756 101 L739 118 L748 133 L680 127 L540 135 L400 125 L260 133 L140 123 L44 131 L23 116 L6 98 L21 80 L3 60 L17 44 Z"/>`
        + `<path fill="${c}" opacity="0.55" d="M90 10 L330 6 L520 11 L640 8 L640 14 L520 17 L330 13 L90 16 Z"/>`
        + `<path fill="${c}" opacity="0.5" d="M120 138 L360 142 L560 137 L700 141 L700 146 L560 144 L360 148 L120 144 Z"/>`
        + `</svg>`;
}

/** The meal-label stroke (viewBox 560 × 118, stretched to fit). */
export function labelBrushSvg(color: string): string {
    const c = esc(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 118" preserveAspectRatio="none">`
        + `<path fill="${c}" d="M18 14 L90 8 L200 13 L320 6 L440 12 L548 7 L540 30 L556 50 L541 68 L558 88 L543 104 L546 112 L440 108 L320 113 L200 106 L80 112 L16 107 L24 90 L4 72 L20 54 L6 34 Z"/>`
        + `<path fill="${c}" opacity="0.5" d="M60 2 L260 0 L420 3 L420 7 L260 5 L60 7 Z"/>`
        + `</svg>`;
}

/** Three fanned strokes beside the banner; `mirror` flips them for the right-hand side. */
export function flourishSvg(color: string, mirror = false): string {
    const c = esc(color);
    const t = mirror ? ' transform="translate(90 0) scale(-1 1)"' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 70"><g${t} stroke="${c}" stroke-width="6" stroke-linecap="round">`
        + `<line x1="12" y1="14" x2="80" y2="24"/><line x1="6" y1="35" x2="84" y2="35"/><line x1="12" y1="56" x2="80" y2="46"/></g></svg>`;
}

/** A motif icon in a 100 × 100 box. */
export function motifIconSvg(motif: PosterMotif, color: string, opacity = 1): string {
    const c = esc(color);
    const o = Math.max(0, Math.min(1, opacity));
    const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g opacity="${o}">${body}</g></svg>`;
    switch (motif) {
        case 'snowflake': {
            let arms = '';
            for (let i = 0; i < 6; i++) {
                const a = i * 60;
                arms += `<g transform="rotate(${a} 50 50)"><line x1="50" y1="50" x2="50" y2="8"/><line x1="50" y1="22" x2="40" y2="13"/><line x1="50" y1="22" x2="60" y2="13"/><line x1="50" y1="34" x2="42" y2="27"/><line x1="50" y1="34" x2="58" y2="27"/></g>`;
            }
            return wrap(`<g stroke="${c}" stroke-width="5" stroke-linecap="round">${arms}</g>`);
        }
        case 'leaf':
            return wrap(`<path fill="${c}" d="M50 6 C78 22 88 52 54 94 L50 98 L46 94 C12 52 22 22 50 6 Z"/><path stroke="#FFFFFF" stroke-opacity="0.6" stroke-width="3" fill="none" d="M50 18 L50 90 M50 44 L66 32 M50 60 L34 48 M50 72 L64 62"/>`);
        case 'blossom': {
            let petals = '';
            for (let i = 0; i < 5; i++) petals += `<ellipse cx="50" cy="27" rx="15" ry="22" fill="${c}" transform="rotate(${i * 72} 50 50)"/>`;
            return wrap(`${petals}<circle cx="50" cy="50" r="10" fill="#F6D365"/>`);
        }
        case 'sun': {
            let rays = '';
            for (let i = 0; i < 8; i++) rays += `<line x1="50" y1="6" x2="50" y2="20" transform="rotate(${i * 45} 50 50)"/>`;
            return wrap(`<g stroke="${c}" stroke-width="6" stroke-linecap="round">${rays}</g><circle cx="50" cy="50" r="20" fill="${c}"/>`);
        }
        default:
            return wrap(`<path fill="${c}" d="M50 20 L62 50 L50 80 L38 50 Z"/>`);
    }
}

/** A thin rule with the motif in the middle (viewBox 940 × 34). */
export function dividerSvg(color: string, motif: PosterMotif): string {
    const c = esc(color);
    const icon = motifIconSvg(motif, color);
    const inner = icon.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">', '<svg x="453" y="0" width="34" height="34" viewBox="0 0 100 100">');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 34">`
        + `<line x1="0" y1="17" x2="430" y2="17" stroke="${c}" stroke-width="3"/><line x1="510" y1="17" x2="940" y2="17" stroke="${c}" stroke-width="3"/>`
        + `${inner}</svg>`;
}

/** The round badge: a filled disc with a thin inner ring (viewBox 300 × 300). */
export function badgeSvg(color: string): string {
    const c = esc(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">`
        + `<circle cx="150" cy="150" r="146" fill="${c}"/>`
        + `<circle cx="150" cy="150" r="132" fill="none" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="3"/></svg>`;
}

/** A soft white glow behind the header text, so it reads on any backdrop (viewBox 1600 × 960). */
export function headerGlowSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 960">`
        + `<defs><radialGradient id="g" cx="50%" cy="46%" r="58%"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.66"/>`
        + `<stop offset="55%" stop-color="#FFFFFF" stop-opacity="0.4"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs>`
        + `<ellipse cx="800" cy="450" rx="760" ry="470" fill="url(#g)"/></svg>`;
}

/** The neutral card shown where a meal has no usable photo: a plate with a fork and knife. */
export function missingPhotoSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">`
        + `<rect width="400" height="300" fill="#EFEAE2"/>`
        + `<circle cx="200" cy="108" r="60" fill="#FFFFFF" stroke="#D8CFC2" stroke-width="5"/>`
        + `<circle cx="200" cy="108" r="40" fill="none" stroke="#E6DED2" stroke-width="4"/>`
        + `<g stroke="#B9AD9C" stroke-width="7" stroke-linecap="round"><line x1="112" y1="62" x2="112" y2="160"/><line x1="100" y1="62" x2="100" y2="94"/><line x1="124" y1="62" x2="124" y2="94"/>`
        + `<line x1="288" y1="62" x2="288" y2="160"/></g><path fill="#B9AD9C" d="M288 60 C306 76 306 108 290 118 Z"/></svg>`;
}
