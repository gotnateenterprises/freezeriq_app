/**
 * FR-COORD-123 — coordinator marketing materials tell the pricing truth.
 *
 * The owner-reported defect: the printable flyer showed Family Size at ~$60
 * when the campaign's configured prices were Serves 2 = $60 and Family
 * Size = $125. Root cause: routes passed bundles.serving_tier RAW and the
 * renderer recognized only the literal 'couple' as the small tier, so a
 * canonical 'serves_2' row landed in the family branch and overwrote the
 * family price.
 *
 * The renderer is driven for real (jsPDF, uncompressed content streams) and
 * assertions read the PDF's own text-showing operators IN DRAW ORDER, so a
 * swapped price cannot pass by both numbers merely being present somewhere.
 */
process.env.TZ = 'America/Chicago';

import fs from 'fs';
import path from 'path';
import {
    resolveMaterialBundles,
    groupMaterialMenus,
    type MaterialBundleRow,
} from '../lib/coordinatorMaterialBundles';
import { generateFlyer, type FlyerBundle } from '../lib/generateFlyer';
import { generateQrCode } from '../lib/generateQrCode';
import { generatePromoScripts } from '../lib/generatePromoScripts';
import { buildSupporterOrderUrl } from '../lib/previousSupporterInvite';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every text string the PDF draws, in draw order. jsPDF (no `compress`
 * option) writes literal `(text) Tj` operators, so the sequence of shown
 * strings is recoverable from the raw bytes.
 */
function pdfTexts(buffer: Buffer): string[] {
    const raw = buffer.toString('latin1');
    const out: string[] = [];
    for (const m of raw.matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g)) {
        out.push(
            m[1]
                .replace(/\\([()\\])/g, '$1')
                // jsPDF standard fonts write WinAnsi: the en dash the menu
                // labels use is byte 0x96, not UTF-8.
                .replace(/\x96/g, '–'),
        );
    }
    return out;
}

/** The text drawn immediately after `label` — the value printed beside it. */
function textAfter(texts: string[], label: string, from = 0): string | null {
    const i = texts.indexOf(label, from);
    return i >= 0 && i + 1 < texts.length ? texts[i + 1] : null;
}

// ── The Production shape that produced the owner's report ───────────────────
const row = (over: Partial<MaterialBundleRow> = {}): MaterialBundleRow => ({
    id: 'b-fam', name: 'Fall 2026 - Family Friendly', price: 125,
    serving_tier: 'family', family_id: 'fam-1', ...over,
});

const CAMPAIGN_ROWS: MaterialBundleRow[] = [
    row(),
    row({ id: 'b-s2', name: 'Fall 2026 - Family Friendly (Serves 2)', price: 60, serving_tier: 'serves_2' }),
    row({ id: 'b2-fam', name: 'Fall 2026 - Clean Eating/Paleo', family_id: 'fam-2' }),
    row({ id: 'b2-s2', name: 'Fall 2026 - Clean Eating/Paleo (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'fam-2' }),
];

const bundlesOf = (rows: MaterialBundleRow[]): FlyerBundle[] => {
    const r = resolveMaterialBundles(rows);
    if (!r.ok) throw new Error(r.error);
    return r.bundles.map((b) => ({
        name: b.name, price: b.price, servingTier: b.servingTier, familyId: b.familyId,
        meals: b.servingTier === 'serves_5'
            ? ['Creamy Italian Chicken', 'Taco Casserole']
            : ['Creamy Italian Chicken (Serves 2)', 'Taco Casserole (Serves 2)'],
    }));
};

const URL_ = 'https://myfreezerchef.com/shop/my-freezer-chef/fundraiser/camp-1';

const flyerInput = (bundles: FlyerBundle[]) => ({
    campaignName: 'The Best Brew Test 3 Fundraiser',
    organizationName: 'The Best Brew',
    businessName: 'Freezer Chef',
    endDate: '2026-08-31',
    deliveryDate: '2026-09-12',
    pickupLocation: 'Church parking lot',
    checksPayable: 'The Best Brew',
    publicUrl: URL_,
    bundles,
});

// ── THE CANONICAL AUTHORITY ─────────────────────────────────────────────────
describe('FR-COORD-123 · resolveMaterialBundles is the ordering path vocabulary', () => {
    it('classifies every alias the CB-5 ordering validator accepts, identically', () => {
        // DB_MAP in lib/serving_multipliers.ts — the SAME table the supporter
        // order path resolves tiers with.
        const cases: [string, 'serves_2' | 'serves_5'][] = [
            ['family', 'serves_5'], ['family_size', 'serves_5'], ['Family Size', 'serves_5'],
            ['serves_5', 'serves_5'], ['start_fresh', 'serves_5'],
            ['couple', 'serves_2'], ['couples', 'serves_2'], ['single', 'serves_2'],
            ['serves_2', 'serves_2'], ['Serves 2', 'serves_2'], ['SERVES-2', 'serves_2'],
        ];
        for (const [tier, want] of cases) {
            const r = resolveMaterialBundles([row({ serving_tier: tier })]);
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.bundles[0].servingTier).toBe(want);
        }
    });

    it('REFUSES a tier the ordering path would refuse — never guesses a size', () => {
        // 'Family Size Keto' and 'Couple Keto' exist in Production. Guessing
        // either way prints a price under the wrong size on paper.
        for (const tier of ['Family Size Keto', 'Couple Keto', 'weird', '']) {
            const r = resolveMaterialBundles([row({ serving_tier: tier, name: 'Keto Menu' })]);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.code).toBe('unknown_serving_tier');
                expect(r.error).toContain('Keto Menu');
            }
        }
    });

    it('REFUSES a missing, zero, or non-finite price — $0.00 is not a price', () => {
        for (const price of [null, undefined, 0, -5, NaN, 'not-a-number']) {
            const r = resolveMaterialBundles([row({ price, name: 'Unpriced Menu' })]);
            expect(r.ok).toBe(false);
            if (!r.ok) {
                expect(r.code).toBe('missing_price');
                expect(r.error).toContain('Unpriced Menu');
            }
        }
    });

    it('prices are EXACTLY the storefront charge column, uncoerced', () => {
        // The supporter page renders Number(bundles.price) and the order route
        // charges from the same column (lib/pricing.ts buildBundlePriceMap).
        // '125.00' as Prisma Decimal arrives stringly — same Number() rule.
        const r = resolveMaterialBundles([row({ price: '125.00' })]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.bundles[0].price).toBe(125);
    });

    it('groups one menu per family with both sizes attached', () => {
        const r = resolveMaterialBundles(CAMPAIGN_ROWS);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const menus = groupMaterialMenus(r.bundles);
        expect(menus).toHaveLength(2);
        for (const m of menus) {
            expect(m.familyPrice).toBe(125);
            expect(m.couplePrice).toBe(60);
            expect(m.baseName).not.toMatch(/serves/i);
        }
    });

    it('a RENAMED sibling still pairs with its family — the key is structural', () => {
        const r = resolveMaterialBundles([
            row(),
            row({ id: 'b-s2', name: 'Totally Renamed Small Option', price: 60, serving_tier: 'serves_2' }),
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const menus = groupMaterialMenus(r.bundles);
        expect(menus).toHaveLength(1);
        expect(menus[0].familyPrice).toBe(125);
        expect(menus[0].couplePrice).toBe(60);
        expect(menus[0].baseName).toBe('Fall 2026 - Family Friendly');
    });
});

// ── THE FLYER ITSELF ────────────────────────────────────────────────────────
describe('FR-COORD-123 · the rendered flyer', () => {
    let texts: string[];
    beforeAll(async () => {
        texts = pdfTexts(await generateFlyer(flyerInput(bundlesOf(CAMPAIGN_ROWS))));
    });

    it('THE OWNER\'S REPORT: Family Size shows $125.00, never the Serves-2 price', () => {
        // Draw-order adjacency: the value printed BESIDE each label, page 1.
        expect(textAfter(texts, 'Family Size:')).toBe('$125.00');
        expect(textAfter(texts, 'Serves 2:')).toBe('$60.00');
    });

    it('the sizes cannot swap anywhere in the document', () => {
        // Every "Family Size" label in the flyer — page-1 box and both page-2
        // order-form rows — is followed by $125.00; every Serves 2 by $60.00.
        let seenFamily = 0;
        let seenCouple = 0;
        texts.forEach((t, i) => {
            if (/^Family Size:?$/.test(t)) { seenFamily++; expect(texts[i + 1]).toBe('$125.00'); }
            if (/^Serves 2:?$/.test(t)) { seenCouple++; expect(texts[i + 1]).toBe('$60.00'); }
        });
        expect(seenFamily).toBeGreaterThanOrEqual(3); // pricing box + 2 order-form rows
        expect(seenCouple).toBeGreaterThanOrEqual(3);
        expect(texts).not.toContain('$0.00');
    });

    it('both selected menus appear, no unselected extras, canonical names', () => {
        const all = texts.join('\n');
        expect(all).toContain('#1 – Fall 2026 - Family Friendly Bundle');
        expect(all).toContain('#2 – Fall 2026 - Clean Eating/Paleo Bundle');
        // Exactly two menu cards — a size variant must not become a third.
        expect(texts.filter((t) => /^#\d – /.test(t))).toHaveLength(4); // 2 cards + 2 order-form sections
    });

    it('meals are the FAMILY variant\'s canonical recipe names', () => {
        const all = texts.join('\n');
        expect(all).toContain('-  Creamy Italian Chicken');
        // The serves-2 sibling's suffixed copies must not replace them.
        expect(all).not.toContain('Creamy Italian Chicken (Serves 2)');
    });

    it('the deadline is the CURRENT campaign\'s, on both pages', () => {
        const all = texts.join('\n');
        expect(all).toContain('August 31, 2026');
        expect(all).toContain('ORDERS DUE BY: August 31, 2026');
    });

    it('the printed order URL is the canonical one handed in — both pages', () => {
        // Page 1 prints the URL wide enough to fit one text op; page 2 wraps
        // it beside the small QR, so its consecutive ops only contain it when
        // re-joined.
        expect(texts.some((t) => t.includes(URL_))).toBe(true);
        const joined = texts.join('');
        expect(joined.indexOf(URL_)).toBeGreaterThan(-1);
        expect(joined.indexOf(URL_)).not.toBe(joined.lastIndexOf(URL_));
    });

    it('REFUSES a non-canonical tier outright', async () => {
        const bad = [{ ...bundlesOf(CAMPAIGN_ROWS)[0], servingTier: 'couple' as any }];
        await expect(generateFlyer(flyerInput(bad))).rejects.toThrow(/unrecognized servingTier/);
    });

    it('a menu missing one size gets no row for it — no $0.00, no borrowed price', async () => {
        // One menu family-only at $95, one complete at 125/60. The page-1
        // global box must OMIT the family line (menus disagree: 95 vs 125)
        // and print nothing at $0.00 or from another menu.
        const t2 = pdfTexts(await generateFlyer(flyerInput(bundlesOf([
            row({ id: 'solo', name: 'Solo Menu', price: 95, family_id: 'fam-solo' }),
            row(), row({ id: 'b-s2', name: 'Fall 2026 - Family Friendly (Serves 2)', price: 60, serving_tier: 'serves_2' }),
        ]))));
        expect(t2).not.toContain('$0.00');
        // Page-1 global family line suppressed (95 ≠ 125); Serves 2 agreed at 60.
        expect(t2).not.toContain('Family Size:');
        expect(textAfter(t2, 'Serves 2:')).toBe('$60.00');
        // Solo Menu's order-form family row carries ITS OWN price.
        const soloIdx = t2.findIndex((x) => x.startsWith('#') && x.includes('Solo Menu'));
        expect(soloIdx).toBeGreaterThan(-1);
        const after = t2.slice(soloIdx);
        expect(textAfter(after, 'Family Size')).toBe('$95.00');
        // And it has no Serves 2 row of its own: the next Serves 2 belongs to
        // the complete menu and prints that menu's own $60.00.
        expect(textAfter(after, 'Serves 2')).toBe('$60.00');
    });

    it('the "also available in Serves 2" claim only prints when it is true', async () => {
        const partial = pdfTexts(await generateFlyer(flyerInput(bundlesOf([
            row({ id: 'solo', name: 'Solo Menu', price: 95, family_id: 'fam-solo' }),
        ]))));
        expect(partial.join('\n')).not.toContain('also available in Serves 2');
        expect(texts.join('\n')).toContain('also available in Serves 2');
    });
});

// ── QR PAYLOAD ──────────────────────────────────────────────────────────────
describe('FR-COORD-123 · QR truth', () => {
    jest.setTimeout(30_000); // three QR encodes; the PNG encoder is not fast here
    it('the QR encodes exactly the URL it is given — deterministic bytes', async () => {
        // Same encoder, same parameters: byte-identical PNG ⇔ identical
        // payload. This pins the QR to whatever URL the route resolved, which
        // the route tests below pin to the canonical authority.
        const a = await generateQrCode(URL_);
        const b = await generateQrCode(URL_);
        const other = await generateQrCode(URL_ + '-tampered');
        expect(a.pngBuffer.equals(b.pngBuffer)).toBe(true);
        expect(a.pngBuffer.equals(other.pngBuffer)).toBe(false);
        expect(a.dataUrl).toBe(b.dataUrl);
    });

    it('the canonical authority prefers the tenant storefront domain and ignores hosts', () => {
        // buildSupporterOrderUrl takes a PINNED origin argument — there is no
        // request in its signature to leak a Host header through.
        const url = buildSupporterOrderUrl(
            'https://www.freezeriqapp.com',
            { id: 'camp-1', public_token: 'tok' },
            { customDomain: 'myfreezerchef.com', slug: 'my-freezer-chef' },
        );
        expect(url).toBe('https://myfreezerchef.com/shop/my-freezer-chef/fundraiser/camp-1');
        // No slug at all → scoreboard fallback, still never a request host.
        const fallback = buildSupporterOrderUrl(
            'https://www.freezeriqapp.com',
            { id: 'camp-1', public_token: 'tok' },
            { customDomain: null, slug: null },
        );
        expect(fallback).toBe('https://www.freezeriqapp.com/fundraiser/tok');
    });
});

// ── PROMO SCRIPTS ───────────────────────────────────────────────────────────
describe('FR-COORD-123 · promo scripts', () => {
    it('one line per menu with BOTH sizes — never the same menu twice', () => {
        const r = resolveMaterialBundles(CAMPAIGN_ROWS);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const menus = groupMaterialMenus(r.bundles);
        const scripts = generatePromoScripts({
            campaignName: 'C', organizationName: 'The Best Brew', publicUrl: URL_,
            endDate: '2026-08-31',
            bundles: menus.map((m) => ({
                name: m.baseName, price: (m.familyPrice ?? m.couplePrice)!,
                couplePrice: m.familyPrice !== null ? m.couplePrice : null,
            })),
        });
        const fb = scripts.scripts.facebook;
        expect(fb).toContain('Fall 2026 - Family Friendly – $125 (Family) / $60 (Serves 2)');
        expect(fb.match(/Fall 2026 - Family Friendly/g)).toHaveLength(1);
        expect(fb).not.toContain('(Serves 2) –'); // no variant-row line items
        expect(fb).not.toContain('$0');
    });
});

// ── THE ROUTES CONSUME THE ONE AUTHORITY ────────────────────────────────────
describe('FR-COORD-123 · every material route uses the canonical authority', () => {
    const ROUTES = [
        'app/api/flyer/download/route.ts',
        'app/api/flyer/generate/route.ts',
        'app/api/packet/download/route.ts',
        'app/api/promo-scripts/route.ts',
        'app/api/qr/download/route.ts',
    ];

    it.each(ROUTES)('%s builds its order URL from the pinned authority, never the request host', (p) => {
        const code = strip(R(p));
        expect(code).toContain('buildSupporterOrderUrl(');
        expect(code).toContain('resolveOutreachOrigin(');
        expect(code).not.toContain('new URL(req.url).origin');
        // The scoreboard shape only ever comes out of buildSupporterOrderUrl's
        // own no-slug fallback — no direct request-derived builder.
        expect(code).not.toContain('buildPublicFundraiserUrl(');
    });

    it.each(ROUTES.slice(0, 4))('%s validates bundles through resolveMaterialBundles and refuses config errors', (p) => {
        const code = strip(R(p));
        expect(code).toContain('resolveMaterialBundles(');
        expect(code).toContain('422');
        // The silent-$0 laundering is gone.
        expect(code).not.toMatch(/COALESCE\(price/i);
        // Structural family pairing rides along.
        expect(code).toContain('family_id');
        // The raw tier never reaches a renderer again.
        expect(code).not.toContain("b.serving_tier || 'family'");
        // A campaign that cannot take orders cannot produce materials.
        expect(code).toContain('if (!orderMode.allowed)');
    });

    it('flyer/generate targets the CURRENT campaign — Active first, closed never', () => {
        const code = strip(R('app/api/flyer/generate/route.ts'));
        expect(code).toContain("status: 'Active'");
        expect(code).toContain('CLOSED_STATUSES');
        expect(code).toContain('closed_at: null');
        // And it now selects the lifecycle fields the mode resolver branches
        // on — omitting them made every request fail closed to 'invalid'.
        expect(code).toContain('bundle_selection_status: true');
        expect(code).toContain('bundle_selection_limit: true');
    });

    it('the renderer type refuses the old vocabulary at compile time', () => {
        const lib = R('lib/generateFlyer.ts');
        expect(lib).toContain("servingTier: 'serves_2' | 'serves_5'");
        expect(strip(lib)).not.toContain("=== 'couple'");
    });

    it('the flyer and the storefront read the SAME price column', () => {
        // The storefront authority (lib/pricing.ts) prices from
        // bundles.price; the material authority coerces the same raw column
        // value with the same Number() rule and no fallback table.
        const authority = strip(R('lib/coordinatorMaterialBundles.ts'));
        expect(authority).toContain('Number(row.price)');
        expect(authority).not.toMatch(/125|60/); // no hardcoded price anywhere
        expect(strip(R('lib/pricing.ts'))).toContain('price');
    });
});
