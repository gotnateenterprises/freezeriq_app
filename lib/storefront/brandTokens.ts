/**
 * SF-1: derives the full storefront palette from the tenant's TenantBranding colors.
 * One injection point; every storefront component reads CSS vars, never raw hex.
 */
type HSL = { h: number; s: number; l: number };

function hexToHsl(hex: string): HSL | null {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s, l };
}
const hsl = ({ h, s, l }: HSL) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

/** WCAG-ish: white text on the primary unless it's too light. */
function onColor(c: HSL): string {
    return c.l > 0.62 ? 'hsl(0 0% 12%)' : '#ffffff';
}

export const DEFAULT_PRIMARY = '#a64d66'; // berry — the prototype default

export function buildBrandVars(primaryHex?: string | null, accentHex?: string | null): Record<string, string> {
    const p = hexToHsl(primaryHex || DEFAULT_PRIMARY) ?? hexToHsl(DEFAULT_PRIMARY)!;
    // Clamp so neon/near-white brand colors still produce a usable UI
    const primary: HSL = { h: p.h, s: Math.min(Math.max(p.s, 0.25), 0.75), l: Math.min(Math.max(p.l, 0.3), 0.55) };
    const warm = primary.h >= 330 || primary.h <= 90; // warm hues get the linen world, cool get a cooler cream
    return {
        '--sf-primary': hsl(primary),
        '--sf-on-primary': onColor(primary),
        '--sf-primary-press': hsl({ ...primary, l: primary.l - 0.07 }),
        '--sf-soft': hsl({ ...primary, s: primary.s * 0.45, l: 0.94 }),          // chips, highlight cards
        '--sf-soft-border': hsl({ ...primary, s: primary.s * 0.35, l: 0.86 }),
        '--sf-ground': warm ? 'hsl(35 45% 96%)' : 'hsl(210 25% 97%)',            // page background
        '--sf-card': '#ffffff',
        '--sf-line': warm ? 'hsl(30 30% 89%)' : 'hsl(215 20% 90%)',
        '--sf-ink': warm ? 'hsl(345 15% 20%)' : 'hsl(220 20% 18%)',
        '--sf-muted': warm ? 'hsl(20 15% 55%)' : 'hsl(220 10% 52%)',
        '--sf-gold': 'hsl(42 65% 90%)', '--sf-gold-ink': 'hsl(35 50% 33%)',      // loyalty/points
        '--sf-sage': 'hsl(105 15% 50%)',                                          // success / progress fill
        '--sf-accent': accentHex || hsl({ ...primary, h: (primary.h + 30) % 360 }),
    };
}
