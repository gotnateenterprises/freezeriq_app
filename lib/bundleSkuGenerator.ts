/**
 * BUNDLE-EDITOR-UX-1 — the bundle SKU generator, in ONE place.
 *
 * It used to be two inconsistent copies inside components/BundleEditor.tsx (the platform dropdown handled
 * custom tiers, the "Auto Generate" button did not). The format is unchanged:
 *
 *     <platform prefix><4 digits><size suffix>     e.g. QB4821FS, SQ1093S2, OT7712FSK
 *
 *   prefix  SQ (Square), QB (QuickBooks), OT (Other — the default; a tenant never has to pick a platform)
 *   suffix  FS family / Serves 5, S2 couple / Serves 2, SS single; a custom tier keeps its base plus the
 *           initials of the rest ("Family Size Keto" -> FSK); a fundraiser add-on is AO (it has no serving
 *           size, so its SKU must not read as Family Size on kitchen screens).
 *
 * Bundle.sku is unique across ALL tenants and the database enforces it. A generated SKU that happens to
 * collide is refused by the API (409) and the editor simply generates another (lib/bundleEditorSave.ts).
 * Nothing here ever changes an existing bundle's SKU — it only produces a candidate when asked.
 */

export type SkuPlatform = 'square' | 'qb' | 'other';

export function skuPlatformPrefix(platform: unknown): 'SQ' | 'QB' | 'OT' {
    if (platform === 'square') return 'SQ';
    if (platform === 'qb') return 'QB';
    return 'OT';
}

const initials = (text: string): string => text
    .split(' ')
    .filter((w) => w.trim().length > 0)
    .map((w) => w[0].toUpperCase())
    .join('');

/** The size part of a generated SKU. */
export function skuSizeSuffix(servingTier: unknown, bundleType?: unknown): string {
    if (bundleType === 'addon') return 'AO';
    const tier = typeof servingTier === 'string' && servingTier.trim() !== '' ? servingTier.trim() : 'family';
    const t = tier.toLowerCase();

    if (t === 'family' || t === 'serves_5') return 'FS';
    if (t === 'couple' || t === 'serves_2') return 'S2';
    if (t === 'single') return 'SS';

    // A custom tier: a recognisable base plus the initials of the extra words.
    let base: string;
    let extra: string;
    if (t.includes('family')) {
        base = 'FS';
        extra = tier.replace(/family/i, '').replace(/size/i, '').trim();
    } else if (t.includes('couple') || t.includes('serves 2')) {
        base = 'S2';
        extra = tier.replace(/couple/i, '').replace(/serves 2/i, '').trim();
    } else if (t.includes('single')) {
        base = 'SS';
        extra = tier.replace(/single/i, '').replace(/serve/i, '').trim();
    } else {
        // No recognisable base: the first two letters, then the initials of the rest.
        base = tier.split(' ')[0].substring(0, 2).toUpperCase();
        extra = tier.substring(base.length);
    }
    return base + initials(extra);
}

/** A random 4-digit number, 1000–9999. */
export function skuNumber(random: () => number = Math.random): string {
    return String(Math.floor(random() * 9000) + 1000);
}

export function generateBundleSku(input: {
    platform?: unknown;
    servingTier?: unknown;
    bundleType?: unknown;
    random?: () => number;
}): string {
    return `${skuPlatformPrefix(input.platform)}${skuNumber(input.random)}${skuSizeSuffix(input.servingTier, input.bundleType)}`;
}
