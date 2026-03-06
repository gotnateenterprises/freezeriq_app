// A robust utility to ensure perfect contrast text colors

/**
 * Converts any valid hex or rgb(a) color to a relative luminance value
 * @param color The color string (e.g., "#FF0000", "rgb(255, 0, 0)")
 * @returns Luminance value between 0 and 1
 */
function getLuminance(color: string): number {
    let r = 0, g = 0, b = 0;

    // Handle Hex
    if (color.startsWith('#')) {
        let hex = color.replace('#', '');
        if (hex.length === 3) {
            hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        }
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
    }
    // Handle rgb/rgba
    else if (color.startsWith('rgb')) {
        const match = color.match(/\d+/g);
        if (match && match.length >= 3) {
            r = parseInt(match[0], 10);
            g = parseInt(match[1], 10);
            b = parseInt(match[2], 10);
        }
    }

    // Convert to sRGB mapping
    const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });

    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

/**
 * Returns either white or black text depending on which has better contrast against the background
 * @param backgroundColor The primary theme color chosen by the tenant
 * @returns "text-white" or "text-slate-900" 
 */
export function getContrastTextClass(backgroundColor: string): string {
    if (!backgroundColor) return 'text-white';

    try {
        const luminance = getLuminance(backgroundColor);
        // Standard Web Content Accessibility Guidelines (WCAG) threshold
        return luminance > 0.179 ? 'text-slate-900' : 'text-white';
    } catch (e) {
        // Fallback to white if parsing fails
        return 'text-white';
    }
}
