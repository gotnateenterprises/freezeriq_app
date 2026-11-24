/**
 * FLYER-TAX-TOTAL-1 — printed and promotional fundraiser prices include the campaign's frozen tax.
 *
 * The four material routes are run for real (flyer download, CRM flyer, packet, promo scripts),
 * with Prisma, the session and the order-mode resolver stubbed. The PDF is read through its own
 * text operators, the packet ZIP is opened and its flyer and tracker read, and the promo scripts
 * are read as returned. Every figure is checked against computeSupporterOrderTax — the function
 * checkout charges with — not against a number restated here.
 *
 * Fictional names only; the repository is public.
 */
process.env.TZ = 'America/Chicago';

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { computeSupporterOrderTax } from '@/lib/fundraiserTax';
import {
    supporterBundlePrice,
    supporterTaxRatePercent,
    salesTaxIncludedNote,
    priceMaterialBundlesForSupporters,
} from '@/lib/supporterMaterialPricing';
import { generatePromoScripts } from '@/lib/generatePromoScripts';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ftDb; } }));
jest.mock('@/auth', () => ({ auth: async () => (global as any).__ftAuth ?? null }));
jest.mock('@/lib/coordinatorSession', () => ({
    resolveCoordinatorSession: async () => ({ session: {}, campaignId: 'camp-ft-1' }),
    requireCoordinatorSession: async () => ({ ok: true, campaignId: 'camp-ft-1', sessionId: 's-1' }),
}));
jest.mock('@/lib/campaignOrderBundles', () => ({
    resolveCampaignOrderMode: async () => ({ allowed: true, mode: 'selected', activeOrderableBundleIds: ['b-ck', 'b-ck2', 'b-keto', 'b-keto2'] }),
}));

const ROOT = path.join(__dirname, '..');
const R = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s: string) => s.replace(/\r\n/g, '\n');
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' });

const TAXABLE_1 = { tax_status: 'TAXABLE', tax_rate_percent: '1.00' }; // Prisma Decimal arrives stringly
const EXEMPT = { tax_status: 'TAX_EXEMPT', tax_rate_percent: '1.00' };

// ── the Jasper/Clark shape, with fictional menu names ───────────────────────
const BUNDLE_ROWS = [
    { id: 'b-ck', name: 'Winter Comfort Classics', price: '125.00', serving_tier: 'family', family_id: 'fam-ck' },
    { id: 'b-ck2', name: 'Winter Comfort Classics (Serves 2)', price: '60.00', serving_tier: 'serves_2', family_id: 'fam-ck' },
    { id: 'b-keto', name: 'Winter Low Carb', price: '125.00', serving_tier: 'family', family_id: 'fam-keto' },
    { id: 'b-keto2', name: 'Winter Low Carb (Serves 2)', price: '60.00', serving_tier: 'serves_2', family_id: 'fam-keto' },
];

function makeDb(tax: Record<string, unknown>) {
    const campaign = {
        id: 'camp-ft-1', name: 'Riverbend Robotics Fundraiser', status: 'Active', closed_at: null,
        bundle_selection_status: 'selected', bundle_selection_limit: 2,
        end_date: new Date('2026-12-05T00:00:00.000Z'), delivery_date: new Date('2026-12-12T00:00:00.000Z'),
        pickup_location: 'School gym', checks_payable: 'Riverbend Robotics', public_token: 'pub-ft',
        customer_id: 'org-ft', customer: { name: 'Riverbend Robotics Club', contact_name: 'Pat Example', business_id: 'biz-ft' },
        ...tax,
    };
    const selects: any[] = [];
    return {
        selects,
        fundraiserCampaign: { findFirst: async (args: any) => { selects.push(args); return campaign; } },
        customer: { findFirst: async () => ({ id: 'org-ft', name: 'Riverbend Robotics Club', business_id: 'biz-ft' }) },
        tenantBranding: { findFirst: async () => null },
        business: { findUnique: async () => ({ name: 'Example Kitchen', display_name: 'Example Kitchen', slug: 'example-kitchen', custom_domain: null }) },
        $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (/bundle_contents/.test(sql)) {
                return BUNDLE_ROWS.flatMap((b) => [{ bundle_id: b.id, recipe_name: `${b.name} Chili` }, { bundle_id: b.id, recipe_name: `${b.name} Pasta` }]);
            }
            return BUNDLE_ROWS;
        },
    };
}

/** Every string the PDF draws, in order (jsPDF writes uncompressed `(text) Tj`). */
function pdfTexts(buffer: Buffer): string[] {
    const out: string[] = [];
    for (const m of buffer.toString('latin1').matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)\s*Tj/g)) {
        out.push(m[1].replace(/\\([()\\])/g, '$1').replace(/\x96/g, '–'));
    }
    return out;
}
const after = (t: string[], label: string, from = 0) => { const i = t.indexOf(label, from); return i >= 0 ? t[i + 1] : null; };
const allAfter = (t: string[], label: string) => t.flatMap((s, i) => (s === label ? [t[i + 1]] : []));

async function coordinatorFlyer(tax: Record<string, unknown>) {
    (global as any).__ftDb = makeDb(tax);
    const { GET } = await import('@/app/api/flyer/download/route');
    const res = await GET(new Request('https://www.freezeriqapp.com/api/flyer/download'));
    expect(res.status).toBe(200);
    return pdfTexts(Buffer.from(await res.arrayBuffer()));
}
async function crmFlyer(tax: Record<string, unknown>) {
    const db = makeDb(tax);
    (global as any).__ftDb = db;
    (global as any).__ftAuth = { user: { businessId: 'biz-ft' } };
    const { POST } = await import('@/app/api/flyer/generate/route');
    const res = await POST(new Request('https://www.freezeriqapp.com/api/flyer/generate', { method: 'POST', body: JSON.stringify({ customerId: 'org-ft' }) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    return { texts: pdfTexts(Buffer.from(body.content, 'base64')), selects: db.selects };
}
async function packet(tax: Record<string, unknown>) {
    (global as any).__ftDb = makeDb(tax);
    const { GET } = await import('@/app/api/packet/download/route');
    const res = await GET(new Request('https://www.freezeriqapp.com/api/packet/download'));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const flyer = pdfTexts(Buffer.from(await zip.file('flyer.pdf')!.async('uint8array')));
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await zip.file('printable-tracker.xlsx')!.async('uint8array')) as any);
    const ws = wb.worksheets[0];
    return { flyer, trackerA10: String(ws.getCell('A10').value), trackerA11: String(ws.getCell('A11').value) };
}
async function promo(tax: Record<string, unknown>) {
    (global as any).__ftDb = makeDb(tax);
    const { GET } = await import('@/app/api/promo-scripts/route');
    const res = await GET(new Request('https://www.freezeriqapp.com/api/promo-scripts'));
    expect(res.status).toBe(200);
    return (await res.json()).scripts as Record<string, string>;
}

jest.setTimeout(60000); // real route imports + real PDF/ZIP/XLSX generation
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });

// ── A–D · the shared helper ─────────────────────────────────────────────────
describe('A–D · supporterBundlePrice is checkout\'s own calculation for one bundle', () => {
    it('A · taxable 1%: $60.00 → $60.60 and $125.00 → $126.25', () => {
        expect(supporterBundlePrice(60, TAXABLE_1)).toBe(60.6);
        expect(supporterBundlePrice(125, TAXABLE_1)).toBe(126.25);
        expect(supporterBundlePrice(60, { tax_status: 'TAXABLE', tax_rate_percent: 1 })).toBe(60.6);
        expect(supporterTaxRatePercent(TAXABLE_1)).toBe(1);
    });

    it('B · tax-exempt: prices unchanged, no rate', () => {
        expect(supporterBundlePrice(60, EXEMPT)).toBe(60);
        expect(supporterBundlePrice(125, EXEMPT)).toBe(125);
        expect(supporterTaxRatePercent(EXEMPT)).toBe(0);
    });

    it('C · zero-rate and legacy campaigns are unchanged', () => {
        for (const c of [
            { tax_status: 'TAXABLE', tax_rate_percent: '0.00' },
            { tax_status: 'TAXABLE', tax_rate_percent: null },
            { tax_status: null, tax_rate_percent: '1.00' },   // pre-snapshot campaign
            { tax_status: 'UNKNOWN', tax_rate_percent: '1.00' },
            {},
            null,
        ]) {
            expect(supporterBundlePrice(60, c as any)).toBe(60);
            expect(supporterBundlePrice(125, c as any)).toBe(125);
            expect(supporterTaxRatePercent(c as any)).toBe(0);
        }
    });

    it('D · matches computeSupporterOrderTax(...).total for the same single-bundle subtotal', () => {
        for (const rate of ['1.00', '1.5', '6.25', '7.25', '8.875', '0', null]) {
            for (const price of [60, 125, 59.99, 124.5, 33.33]) {
                const campaign = { tax_status: 'TAXABLE', tax_rate_percent: rate };
                const checkout = computeSupporterOrderTax({ subtotal: price, snapshot: { status: 'TAXABLE', ratePercent: rate } });
                expect(supporterBundlePrice(price, campaign)).toBe(checkout.total);
                expect(supporterTaxRatePercent(campaign)).toBe(checkout.ratePercent);
            }
        }
        // And the helper module does not carry its own arithmetic.
        const src = R('lib/supporterMaterialPricing.ts').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        expect(src).toMatch(/computeSupporterOrderTax\(/);
        expect(src).not.toMatch(/roundCents|Math\.round|\* *rate|\/ *100/);
    });

    it('priceMaterialBundlesForSupporters re-prices every bundle and reports the rate', () => {
        const out = priceMaterialBundlesForSupporters([{ id: 'x', price: 125 }, { id: 'y', price: 60 }], TAXABLE_1);
        expect(out.bundles.map((b) => b.price)).toEqual([126.25, 60.6]);
        expect(out.bundles.map((b) => b.id)).toEqual(['x', 'y']);
        expect(out.taxRatePercent).toBe(1);
    });

    it('a one-of-each order at checkout equals the two flyer prices added up', () => {
        const order = computeSupporterOrderTax({ subtotal: 185, snapshot: { status: 'TAXABLE', ratePercent: '1.00' } });
        expect(order.total).toBe(186.85);
        expect(Math.round((supporterBundlePrice(60, TAXABLE_1) + supporterBundlePrice(125, TAXABLE_1)) * 100) / 100).toBe(order.total);
    });
});

// ── E · the coordinator's printable flyer ───────────────────────────────────
describe('E · Coordinator Panel printable flyer (/api/flyer/download)', () => {
    it('taxable 1%: both pricing areas print $126.25 / $60.60, with the 1% note on both pages', async () => {
        const t = await coordinatorFlyer(TAXABLE_1);
        expect(after(t, 'Family Size:')).toBe('$126.25');
        expect(after(t, 'Serves 2:')).toBe('$60.60');
        expect(allAfter(t, 'Family Size')).toEqual(['$126.25', '$126.25']); // page-2 order table, both menus
        expect(allAfter(t, 'Serves 2')).toEqual(['$60.60', '$60.60']);
        expect(t.filter((s) => s === 'Prices include 1% sales tax.')).toHaveLength(2);
        expect(t.join('|')).not.toMatch(/\$125\.00|\$60\.00/);
    });

    it('tax-exempt: base prices and no note', async () => {
        const t = await coordinatorFlyer(EXEMPT);
        expect(after(t, 'Family Size:')).toBe('$125.00');
        expect(after(t, 'Serves 2:')).toBe('$60.00');
        expect(allAfter(t, 'Family Size')).toEqual(['$125.00', '$125.00']);
        expect(t.join('|')).not.toMatch(/sales tax/i);
    });

    it('legacy (no snapshot) and zero-rate campaigns print exactly what they did before', async () => {
        for (const tax of [{ tax_status: null, tax_rate_percent: null }, { tax_status: 'TAXABLE', tax_rate_percent: '0.00' }]) {
            const t = await coordinatorFlyer(tax);
            expect(after(t, 'Family Size:')).toBe('$125.00');
            expect(t.join('|')).not.toMatch(/sales tax/i);
        }
    });
});

// ── F · the CRM flyer ───────────────────────────────────────────────────────
describe('F · CRM flyer (/api/flyer/generate) matches the coordinator flyer', () => {
    it('reads the campaign tax columns and prints the same supporter prices and note', async () => {
        const crm = await crmFlyer(TAXABLE_1);
        const coord = await coordinatorFlyer(TAXABLE_1);
        expect(crm.selects[0].select).toMatchObject({ tax_status: true, tax_rate_percent: true });
        expect(after(crm.texts, 'Family Size:')).toBe('$126.25');
        expect(after(crm.texts, 'Serves 2:')).toBe('$60.60');
        const prices = (t: string[]) => t.filter((s) => /^\$\d/.test(s) || /sales tax/.test(s));
        expect(prices(crm.texts)).toEqual(prices(coord));
    });

    it('tax-exempt CRM flyer keeps base prices and no note', async () => {
        const crm = await crmFlyer(EXEMPT);
        expect(after(crm.texts, 'Family Size:')).toBe('$125.00');
        expect(crm.texts.join('|')).not.toMatch(/sales tax/i);
    });
});

// ── G · the coordinator packet ──────────────────────────────────────────────
describe('G · coordinator packet (/api/packet/download)', () => {
    it('its flyer.pdf carries the same supporter prices and note; its tracker sheet agrees', async () => {
        const p = await packet(TAXABLE_1);
        const coord = await coordinatorFlyer(TAXABLE_1);
        const prices = (t: string[]) => t.filter((s) => /^\$\d/.test(s) || /sales tax/.test(s));
        expect(prices(p.flyer)).toEqual(prices(coord));
        expect(p.trackerA10).toContain('($126.25)');
        expect(p.trackerA11).toContain('($126.25)');
    });

    it('tax-exempt packet: base prices, no note', async () => {
        const p = await packet(EXEMPT);
        expect(after(p.flyer, 'Family Size:')).toBe('$125.00');
        expect(p.flyer.join('|')).not.toMatch(/sales tax/i);
        expect(p.trackerA10).toContain('($125.00)');
    });
});

// ── H · promo scripts ───────────────────────────────────────────────────────
describe('H · promo scripts (/api/promo-scripts)', () => {
    it('taxable 1%: every script advertises $126.25 / $60.60 and says tax is included', async () => {
        const s = await promo(TAXABLE_1);
        expect(s.facebook).toContain('Winter Comfort Classics – $126.25 (Family) / $60.60 (Serves 2)');
        expect(s.emailBlurb).toContain('Winter Low Carb – $126.25 (Family) / $60.60 (Serves 2)');
        expect(s.emailBlurbHtml).toContain('Winter Comfort Classics – $126.25 (Family) / $60.60 (Serves 2)');
        expect(s.textMessage).toContain('Winter Comfort Classics ($126.25/$60.60)');
        for (const k of ['facebook', 'textMessage', 'emailBlurb', 'emailBlurbHtml']) {
            expect(s[k]).toContain('Prices include 1% sales tax.');
            // No base price and no whole-dollar rounding of the taxed price ("$126", "$61").
            expect(s[k]).not.toMatch(/\$(125|60|126|61)(?![.\d])|\$125\.00|\$60\.00/);
        }
    });

    it('tax-exempt: the copy is unchanged — "$125 (Family) / $60 (Serves 2)", no note', async () => {
        const s = await promo(EXEMPT);
        expect(s.facebook).toContain('Winter Comfort Classics – $125 (Family) / $60 (Serves 2)');
        expect(s.textMessage).toContain('Winter Comfort Classics ($125/$60)');
        for (const k of Object.keys(s)) expect(s[k]).not.toMatch(/sales tax/i);
    });

    it('an untaxed generator call is byte-identical to the pre-change format', () => {
        const input = { campaignName: 'C', organizationName: 'Riverbend Robotics Club', publicUrl: 'https://example.invalid/o', endDate: null, bundles: [{ name: 'Menu', price: 125, couplePrice: 60 }] };
        const s = generatePromoScripts(input).scripts;
        expect(s.facebook).toContain('Menu – $125 (Family) / $60 (Serves 2)\n\n🛒 Order online');
        expect(s.emailBlurb).toContain('Menu – $125 (Family) / $60 (Serves 2)\n\n👉 Order');
        expect(s.emailBlurbHtml).toContain('Menu – $125 (Family) / $60 (Serves 2)</p>');
        expect(s.textMessage).toContain('Easy meal bundles like Menu ($125/$60). Order here:');
    });
});

// ── I · the note ────────────────────────────────────────────────────────────
describe('I · the tax note shows only when tax applies, with the campaign\'s own rate', () => {
    it('formats the frozen rate, never a constant', () => {
        expect(salesTaxIncludedNote(1)).toBe('Prices include 1% sales tax.');
        expect(salesTaxIncludedNote(1.5)).toBe('Prices include 1.5% sales tax.');
        expect(salesTaxIncludedNote(7.25)).toBe('Prices include 7.25% sales tax.');
        for (const none of [0, null, undefined, -1, NaN]) expect(salesTaxIncludedNote(none as any)).toBeNull();
    });

    it('a 1.5% campaign prints 1.5% on the flyer and in the scripts', async () => {
        const tax = { tax_status: 'TAXABLE', tax_rate_percent: '1.50' };
        const t = await coordinatorFlyer(tax);
        expect(t.filter((s) => s === 'Prices include 1.5% sales tax.')).toHaveLength(2);
        expect(after(t, 'Family Size:')).toBe(`$${supporterBundlePrice(125, tax).toFixed(2)}`); // 126.88 (1.875 rounds up)
        expect(after(t, 'Family Size:')).toBe('$126.88');
        const s = await promo(tax);
        expect(s.facebook).toContain('Prices include 1.5% sales tax.');
        expect(s.facebook).toContain('$126.88 (Family) / $60.90 (Serves 2)');
    });

    it('no material file hard-codes a rate or a price', () => {
        for (const p of ['lib/supporterMaterialPricing.ts', 'lib/generateFlyer.ts', 'lib/generatePromoScripts.ts']) {
            const src = R(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            expect(src).not.toMatch(/\b1(\.0+)?%|126\.25|60\.60/);
        }
    });
});

// ── J · checkout is untouched ───────────────────────────────────────────────
describe('J · supporter checkout and the order page are untouched', () => {
    it.each([
        'lib/fundraiserTax.ts',
        // (lib/fundraiserCloseoutMath.ts — SUPERSEDED PIN (S2), see the history check below.)
        // (app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx — SUPERSEDED PIN, see the history check below.)
        'lib/pricing.ts',
        'lib/coordinatorMaterialBundles.ts',
        // (app/api/tracker/download/route.ts — SUPERSEDED PIN (S3), see the history check below.)
    ])('%s is byte-identical to Production c4e528b', (p) => {
        expect(lf(R(p))).toBe(lf(git(`show c4e528b:"${p}"`)));
    });

    // SUPERSEDED PIN (SUPPORTER-CONSENT-1, owner-approved 2026-11-19). These three were pinned to
    // c4e528b to prove FLYER-TAX-TOTAL-1 left checkout alone. A later, separately approved release
    // adds the optional consent checkboxes to them, so the same guarantee is now checked against
    // history: this release's own commit (b1af1d7, on c4e528b) changed none of them.
    // SUPERSEDED PIN (FR-SUPPORTER-ADDON-UPSELL-1 S1, owner-approved 2026-11-23): the order page's
    // progress query now also selects each line's item_role (an add-on counts 0 bundle units), so it
    // joins this history check.
    it.each([
        'app/api/public/order/route.ts',
        'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx',
        'prisma/schema.prisma',
        'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx',
        // SUPERSEDED PIN (FR-SUPPORTER-ADDON-UPSELL-1 S2, owner-approved 2026-11-24): the closeout money
        // model now adds the add-on's recorded, tiered share to the meal share; FLYER-TAX-TOTAL-1 never touched it.
        'lib/fundraiserCloseoutMath.ts',
        // SUPERSEDED PIN (FR-SUPPORTER-ADDON-UPSELL-1 S3): the tracker route now picks the add-on variant of the
        // template when the campaign has an add-on; FLYER-TAX-TOTAL-1 never touched it.
        'app/api/tracker/download/route.ts',
    ])('%s was not changed by FLYER-TAX-TOTAL-1 (c4e528b..b1af1d7)', (p) => {
        expect(git(`diff --name-only c4e528b b1af1d7 -- "${p}"`).trim()).toBe('');
    });

    it('no migration was added', () => {
        // SUPERSEDED PIN (SUPPORTER-CONSENT-1): FLYER-TAX-TOTAL-1's own commit range, not the working tree.
        expect(git('diff --name-only c4e528b b1af1d7 -- prisma').trim()).toBe('');
    });

    it('every material route prices through the one helper, after validation', () => {
        for (const p of ['app/api/flyer/download/route.ts', 'app/api/flyer/generate/route.ts', 'app/api/packet/download/route.ts', 'app/api/promo-scripts/route.ts']) {
            const src = R(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
            expect(src).toMatch(/priceMaterialBundlesForSupporters\(resolved\.bundles, campaign\)/);
            // Nothing printable is built from the unpriced list (the id list for recipe lookup is fine).
            expect(src).not.toMatch(/FlyerBundle\[\] = resolved\.bundles|groupMaterialMenus\(resolved\.bundles\)/);
            expect(src).toMatch(/taxRatePercent: priced\.taxRatePercent/);
        }
    });
});
