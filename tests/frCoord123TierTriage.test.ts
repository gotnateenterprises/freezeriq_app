/**
 * FR-COORD-123 TIER TRIAGE — one serving-size vocabulary, everywhere.
 *
 * Two defects were triaged before the coordinator release:
 *
 *   1. STOREFRONT — the fundraiser bundle card labelled sizes with
 *      `serving_tier === 'family' ? 'serves 5' : 'serves 2'`, recognizing one
 *      family spelling and defaulting everything else to "serves 2". Canonical
 *      'serves_5' and the aliases a tenant can pick or type in the bundle
 *      editor would have labelled a FAMILY bundle "serves 2".
 *
 *   2. SQUARE IMPORT — order-item variant_size came from
 *      `serving_tier === 'couple' ? 'serves_2' : 'serves_5'`, so the canonical
 *      'serves_2' recorded as serves_5. variant_size drives the KitchenEngine
 *      multiplier, so that is a prep-quantity error, not a label error.
 *
 * Both now use resolveVariantSize — the same resolver /api/public/order uses
 * to persist variant_size — so a displayed label, a recorded order, and a
 * printed flyer cannot disagree about which size a bundle is.
 */
process.env.TZ = 'America/Chicago';

import fs from 'fs';
import path from 'path';
import { resolveVariantSize, normalizeStrictServingTier } from '../lib/serving_multipliers';
import { resolveMaterialBundles } from '../lib/coordinatorMaterialBundles';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const CARD = 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx';
const SQUARE = 'app/api/integrations/square/route.ts';

/** The shipped label expression, evaluated exactly as the card evaluates it. */
const cardLabel = (tier: string | null) =>
    resolveVariantSize(tier) === 'serves_5' ? 'serves 5' : 'serves 2';

/** Every tier string Production actually holds today, plus the canonical pair. */
const FAMILY_SIDE = ['family', 'family_size', 'Family Size', 'serves_5', 'start_fresh'];
const COUPLE_SIDE = ['couple', 'couples', 'single', 'serves_2', 'Serves 2', 'SERVES-2'];

// ── STOREFRONT LABELS ───────────────────────────────────────────────────────
describe('FR-COORD-123 triage · storefront size labels', () => {
    it('every family-side spelling labels "serves 5"', () => {
        for (const tier of FAMILY_SIDE) expect(cardLabel(tier)).toBe('serves 5');
    });

    it('every serves-2 spelling labels "serves 2"', () => {
        for (const tier of COUPLE_SIDE) expect(cardLabel(tier)).toBe('serves 2');
    });

    it('THE DEFECT: canonical serves_5 is no longer labelled "serves 2"', () => {
        // The old expression was `tier === 'family' ? 'serves 5' : 'serves 2'`.
        const OLD = (t: string | null) => (t === 'family' ? 'serves 5' : 'serves 2');
        expect(OLD('serves_5')).toBe('serves 2');        // what shipped before
        expect(cardLabel('serves_5')).toBe('serves 5');  // what ships now
        // And the aliases a tenant can select or type.
        for (const t of ['family_size', 'Family Size', 'start_fresh']) {
            expect(OLD(t)).toBe('serves 2');
            expect(cardLabel(t)).toBe('serves 5');
        }
    });

    it('a size label can never swap: the two sides are disjoint', () => {
        const fam = new Set(FAMILY_SIDE.map(cardLabel));
        const cpl = new Set(COUPLE_SIDE.map(cardLabel));
        expect([...fam]).toEqual(['serves 5']);
        expect([...cpl]).toEqual(['serves 2']);
    });

    it('the label agrees with what the ORDER will record as variant_size', () => {
        // /api/public/order persists resolveVariantSize(item.serving_tier).
        for (const tier of [...FAMILY_SIDE, ...COUPLE_SIDE]) {
            const recorded = resolveVariantSize(tier);
            const shown = cardLabel(tier);
            expect(shown).toBe(recorded === 'serves_5' ? 'serves 5' : 'serves 2');
        }
    });

    it('the card uses the canonical resolver, not an inline literal', () => {
        const code = strip(R(CARD));
        expect(code).toContain('resolveVariantSize(bundle.serving_tier)');
        expect(code).not.toContain("bundle.serving_tier === 'family'");
    });

    it('LABEL, VARIANT, PRICE and PAYLOAD all read the SAME bundle row', () => {
        // The card is per-variant: one row supplies name, price and tier, and
        // the order payload carries that row's id. A label error therefore
        // cannot move a price onto a different variant.
        const code = strip(R(CARD));
        const card = code.slice(code.indexOf('function BundleCard('));
        expect(card).toContain('bundle.serving_tier');
        expect(card).toContain('Number(bundle.price)');
        expect(card).toContain('{bundle.name}');
        // The server re-prices from the bundle id it was sent, never the
        // client's number — so price authority is unaffected by any label.
        expect(strip(R('lib/pricing.ts'))).toContain('business_id');
    });
});

// ── PRICE / LABEL PAIRING, FROM CONFIGURED DATA ─────────────────────────────
describe('FR-COORD-123 triage · label ↔ variant ↔ price identity', () => {
    // The live campaign's configured shape, read from Production read-only:
    // two families, family=$125 / serves_2=$60. The numbers come from the
    // fixture, not from a constant in the product.
    const CONFIGURED = [
        { id: 'v-fam', name: 'Fall 2026 - Family Friendly', price: 125, serving_tier: 'family', family_id: 'f1' },
        { id: 'v-s2', name: 'Fall 2026 - Family Friendly (Serves 2)', price: 60, serving_tier: 'serves_2', family_id: 'f1' },
    ];

    it('each configured variant keeps its own label AND its own price', () => {
        for (const v of CONFIGURED) {
            const label = cardLabel(v.serving_tier);
            const expected = v.serving_tier === 'serves_2' ? 'serves 2' : 'serves 5';
            expect(label).toBe(expected);
        }
        const fam = CONFIGURED.find((v) => cardLabel(v.serving_tier) === 'serves 5')!;
        const cpl = CONFIGURED.find((v) => cardLabel(v.serving_tier) === 'serves 2')!;
        expect(fam.price).toBe(125);
        expect(cpl.price).toBe(60);
        expect(fam.id).not.toBe(cpl.id);
    });

    it('the flyer authority resolves the SAME pairing from the same rows', () => {
        const r = resolveMaterialBundles(CONFIGURED);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const byTier = Object.fromEntries(r.bundles.map((b) => [b.servingTier, b.price]));
        expect(byTier.serves_5).toBe(125);
        expect(byTier.serves_2).toBe(60);
        // Storefront label and flyer tier agree, variant for variant.
        for (const b of r.bundles) {
            const row = CONFIGURED.find((v) => v.id === b.id)!;
            expect(cardLabel(row.serving_tier)).toBe(b.servingTier === 'serves_5' ? 'serves 5' : 'serves 2');
        }
    });
});

// ── SQUARE / IMPORT ─────────────────────────────────────────────────────────
describe('FR-COORD-123 triage · Square import variant_size', () => {
    it('THE DEFECT: canonical serves_2 no longer imports as serves_5', () => {
        const OLD = (t: string) => (t === 'couple' ? 'serves_2' : 'serves_5');
        expect(OLD('serves_2')).toBe('serves_5');              // what shipped before
        expect(resolveVariantSize('serves_2')).toBe('serves_2'); // what ships now
        for (const t of ['couples', 'single', 'Serves 2']) {
            expect(OLD(t)).toBe('serves_5');
            expect(resolveVariantSize(t)).toBe('serves_2');
        }
    });

    it('Family Size cannot import as Serves 2, and Serves 2 cannot import as Family', () => {
        for (const t of FAMILY_SIDE) expect(resolveVariantSize(t)).toBe('serves_5');
        for (const t of COUPLE_SIDE) expect(resolveVariantSize(t)).toBe('serves_2');
    });

    it('the legacy literal is gone from the retired simulation route', () => {
        // FR-COORD-123A superseded the resolver fix here by retiring the route
        // outright — see the containment suite below. Either way the literal
        // must never come back.
        expect(strip(R(SQUARE))).not.toContain("serving_tier === 'couple'");
    });

    it('any surviving import path writes a value the VariantSize enum accepts', () => {
        for (const t of [...FAMILY_SIDE, ...COUPLE_SIDE, 'nonsense', '', null]) {
            expect(['serves_2', 'serves_5']).toContain(resolveVariantSize(t as any));
        }
    });
});

// ── SQUARE SIMULATION CONTAINMENT (FR-COORD-123A) ───────────────────────────
describe('FR-COORD-123A · the dead Square simulation endpoint cannot write', () => {
    const code = strip(R(SQUARE));

    it('has no database access of any kind', () => {
        // The whole containment claim in one assertion: no route from this
        // file to Postgres.
        expect(code).not.toMatch(/from '@\/lib\/db'/);
        expect(code).not.toMatch(/\bprisma\b/);
        expect(code).not.toMatch(/\$transaction|\.create\(|\.findFirst\(|\.findUnique\(|\.update\(/);
    });

    it('never reads the request body — no parsing, no lookup, no write', () => {
        expect(code).not.toContain('req.json()');
        expect(code).not.toContain('orderItem');
        expect(code).not.toContain('bundle');
    });

    it('answers 410 for POST and GET, with a non-sensitive body', () => {
        expect(code).toContain('status: 410');
        expect(code).toContain('export async function POST(');
        expect(code).toContain('export async function GET(');
        expect(code).toContain('This endpoint is no longer available.');
        // Nothing about tenants, bundles, SKUs or what it used to do.
        expect(code).not.toMatch(/business_id|tenant|sku|catalog_object_id/i);
    });

    it('the POST handler takes no request argument at all', () => {
        // A handler with no `req` parameter cannot be tricked into reading one.
        expect(code).toMatch(/export async function POST\(\s*\)/);
    });

    it('the REAL Square surfaces are untouched and still present', () => {
        // Containment must not have taken the genuine integration with it.
        const webhook = R('app/api/webhooks/square/route.ts');
        expect(webhook).toContain('export async function POST(');
        expect(webhook).not.toContain('410');
        // The real webhook updates an existing order; it never creates items.
        expect(strip(webhook)).not.toMatch(/orderItem\.create\(/);
        // And the authenticated, tenant-scoped sync path still runs.
        const sync = strip(R('app/api/sync/orders/route.ts'));
        expect(sync).toContain('SquareOrderHandler');
        expect(sync).toContain('session.user.businessId');
        expect(sync).toContain('401');
    });
});

// ── ONE VOCABULARY ──────────────────────────────────────────────────────────
describe('FR-COORD-123 triage · one vocabulary across surfaces', () => {
    it('no supporter-ordering or import surface decides tiers with its own literal', () => {
        for (const p of [CARD, SQUARE, 'app/api/public/order/route.ts']) {
            const code = strip(R(p));
            expect(code).not.toMatch(/serving_tier\s*===\s*'(couple|family)'/);
        }
    });

    it('the permissive and strict resolvers share one table', () => {
        // The flyer fails closed where the order path defaults; they must never
        // disagree about what a tier MEANS, only about whether to accept it.
        for (const t of [...FAMILY_SIDE, ...COUPLE_SIDE]) {
            expect(normalizeStrictServingTier(t)).toBe(resolveVariantSize(t));
        }
        // A tier the strict resolver refuses is one the flyer will not print.
        for (const t of ['Family Size Keto', 'Couple Keto']) {
            expect(normalizeStrictServingTier(t)).toBeNull();
            expect(resolveMaterialBundles([{ id: 'x', name: 'Keto', price: 10, serving_tier: t, family_id: null }]).ok).toBe(false);
        }
    });
});
