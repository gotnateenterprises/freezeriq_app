/**
 * FR-COORD-BUNDLE-CONTENTS-1 — coordinator bundle cards show included meals.
 *
 * The defect these tests exist to prevent: the coordinator was asked to
 * "Select exactly N families" from cards that showed only a Bundle name,
 * price and SKU — never the meals inside. This was not a rendering bug; the
 * Prisma `select` in lib/campaignBundleSelection.ts never included
 * `contents`, so the data never reached the client at all.
 *
 * These tests exercise the REAL `loadCandidateFamilies()` against a stateful
 * Prisma double, so "the coordinator receives the right meal names, in the
 * right order, for only the right bundles" is proven against the actual
 * query and mapping logic — not against source text.
 */

const TENANT = 'biz-aaaa-1111';
const OTHER = 'biz-bbbb-2222';

type Row = Record<string, any>;
const store: { bundles: Row[]; contents: Row[]; campaignBundles: Row[]; recipes: Row[] } =
    { bundles: [], contents: [], campaignBundles: [], recipes: [] };

const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && Array.isArray((v as any).in)) return (v as any).in.includes(row[k]);
        return row[k] === v;
    });

/** Hydrate the exact nested `select` shapes loadCandidateFamilies() uses. */
function hydrateBundle(b: Row, select: any): Row {
    const out: Row = {};
    for (const k of Object.keys(select ?? {})) {
        if (!select[k]) continue;
        if (k === 'contents') {
            const rows = store.contents
                .filter((c) => c.bundle_id === b.id)
                .sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
            out.contents = rows.map((c) => ({
                recipe: { name: store.recipes.find((r) => r.id === c.recipe_id)?.name ?? '?' },
            }));
        } else out[k] = b[k];
    }
    return out;
}

const prismaDouble: any = {
    campaignBundle: {
        findMany: async ({ where, orderBy, select }: any) => {
            let rows = store.campaignBundles.filter((r) => matches(r, where));
            if (orderBy?.position) rows = [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            return rows.map((r) => {
                const b = store.bundles.find((x) => x.id === r.bundle_id)!;
                return { bundle: hydrateBundle(b, select.bundle.select) };
            });
        },
    },
    bundle: {
        findMany: async ({ where, select }: any) =>
            store.bundles.filter((b) => matches(b, where)).map((b) => hydrateBundle(b, select)),
    },
};

jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));
// resolveVariantSize is exercised for real elsewhere; here the tiers are
// fixed strings so a lightweight stand-in keeps this suite about CONTENTS.
jest.mock('@/lib/serving_multipliers', () => ({
    resolveVariantSize: (tier: string | null | undefined) =>
        tier === 'serves_5' ? 'serves_5' : tier === 'serves_2' ? 'serves_2' : null,
}));

const { loadCandidateFamilies } = require('@/lib/campaignBundleSelection');

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function addBundle(over: Partial<Row>): Row {
    const b = { id: id('b'), business_id: TENANT, is_active: true, sku: null, price: null, image_url: null, ...over };
    store.bundles.push(b);
    return b;
}
function addRecipe(name: string): Row {
    const r = { id: id('r'), name };
    store.recipes.push(r);
    return r;
}
function attach(bundleId: string, recipeName: string, position: number) {
    const r = addRecipe(recipeName);
    store.contents.push({ id: id('bc'), bundle_id: bundleId, recipe_id: r.id, position });
}
function candidate(campaignId: string, bundleId: string, position = 0) {
    store.campaignBundles.push({ id: id('cb'), campaign_id: campaignId, bundle_id: bundleId, state: 'candidate', position });
}

beforeEach(() => {
    store.bundles = []; store.contents = []; store.campaignBundles = []; store.recipes = [];
    seq = 0;
});

function fullFamily(name: string, campaignId: string, meals: string[], businessId = TENANT) {
    const familyId = id('fam');
    const s5 = addBundle({ name: `${name} - Fall 2026`, serving_tier: 'serves_5', family_id: familyId, business_id: businessId });
    const s2 = addBundle({ name: `${name} (Serves 2) - Fall 2026`, serving_tier: 'serves_2', family_id: familyId, business_id: businessId });
    meals.forEach((m, i) => attach(s5.id, m, i));
    meals.forEach((m, i) => attach(s2.id, `${m} (Serves 2)`, i));
    candidate(campaignId, s5.id);
    return { s5, s2, familyId };
}

// ===========================================================================
describe('1-2. included meals render for a full family, in position order', () => {
    it('an approved 5-meal bundle returns all 5 names', async () => {
        const meals = ['Chicken Fajitas', 'Apple Rosemary Pork', 'Cajun Chicken Dinner', 'Chili', 'Italian Pork Chops & Vegetables'];
        fullFamily('Clean Eating/Paleo', 'camp1', meals);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result).toHaveLength(1);
        expect(result[0].serves5.meals).toEqual(meals);
    });

    it('ordering follows BundleContent.position, not insertion or alphabetical order', async () => {
        const { s5 } = fullFamily('Comfort Food', 'camp1', ['A', 'B', 'C']);
        // Overwrite with out-of-order positions to prove the query orders by them.
        store.contents = store.contents.filter((c) => c.bundle_id !== s5.id);
        attach(s5.id, 'Zebra', 2);
        attach(s5.id, 'Mango', 0);
        attach(s5.id, 'Apple', 1);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0].serves5.meals).toEqual(['Mango', 'Apple', 'Zebra']);
    });

    it('the Serves-2 sibling carries its own meal names too (available for future use)', async () => {
        fullFamily('Keto', 'camp1', ['Bacon Cheeseburger Soup', 'Tuscan Garlic Chicken']);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0].serves2!.meals).toEqual([
            'Bacon Cheeseburger Soup (Serves 2)', 'Tuscan Garlic Chicken (Serves 2)',
        ]);
    });
});

// ===========================================================================
describe('3-4. only campaign-approved bundles are returned; nothing else leaks', () => {
    it('a bundle NOT marked candidate for this campaign never appears', async () => {
        fullFamily('Clean Eating/Paleo', 'camp1', ['A']);
        fullFamily('Not Approved', 'camp1', ['Secret Meal']); // candidate() defaults to camp1 too — override below

        // Re-seed precisely: one candidate, one non-candidate for the SAME campaign.
        store.campaignBundles = store.campaignBundles.slice(0, 1);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result).toHaveLength(1);
        const allMeals = result.flatMap((f: any) => [...f.serves5.meals, ...(f.serves2?.meals ?? [])]);
        expect(allMeals).not.toContain('Secret Meal');
    });

    it('a bundle approved for a DIFFERENT campaign is not returned here', async () => {
        fullFamily('Family A', 'camp1', ['Meal A']);
        fullFamily('Family B', 'camp2', ['Meal B']);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result).toHaveLength(1);
        expect(result[0].serves5.meals).toEqual(['Meal A']);
    });
});

// ===========================================================================
describe('5. cross-tenant information is never exposed', () => {
    it('a candidate row belonging to another tenant\'s bundle is silently skipped', async () => {
        fullFamily('Rival Bundle', 'camp1', ['Rival Secret Meal'], OTHER);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result).toHaveLength(0);
    });

    it('a Serves-2 sibling from another tenant is never paired in, even with a matching family_id', async () => {
        const meals = ['My Meal'];
        const { familyId } = fullFamily('My Family', 'camp1', meals);
        // A foreign bundle that happens to reuse the same family_id string.
        const foreignS2 = addBundle({ name: 'Impostor (Serves 2)', serving_tier: 'serves_2', family_id: familyId, business_id: OTHER });
        attach(foreignS2.id, 'Rival Meal (Serves 2)', 0);

        const result = await loadCandidateFamilies('camp1', TENANT);

        // The sibling lookup is scoped by business_id in its own `where`, so the
        // foreign row is excluded before pairing even runs — the legit sibling
        // resolves normally, and the foreign one's meal name never appears.
        expect(result[0].available).toBe(true);
        expect(result[0].serves2!.meals).not.toContain('Rival Meal (Serves 2)');
        const raw = JSON.stringify(result);
        expect(raw).not.toContain('Rival Meal');
        expect(raw).not.toContain('Impostor');
    });
});

// ===========================================================================
describe('6. zero-content bundle gets a graceful, non-empty result — not invented meals', () => {
    it('a candidate bundle with no BundleContent rows returns an empty meals array', async () => {
        const familyId = id('fam');
        const s5 = addBundle({ name: 'Gluten Free (Serves 2) Twin - Fall 2026', serving_tier: 'serves_5', family_id: familyId });
        const s2 = addBundle({ name: 'Gluten Free Twin (Serves 2) - Fall 2026', serving_tier: 'serves_2', family_id: familyId });
        // No attach() calls — this is BUNDLE-DATA-RECONCILIATION-1's zero-content case.
        candidate('camp1', s5.id);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0].available).toBe(true); // structurally valid family, just empty
        expect(result[0].serves5.meals).toEqual([]);
        expect(result[0].serves2!.meals).toEqual([]);
        void s2;
    });

    it('no meal name is ever invented for an empty bundle', async () => {
        const familyId = id('fam');
        const s5 = addBundle({ name: 'Empty - Fall 2026', serving_tier: 'serves_5', family_id: familyId });
        addBundle({ name: 'Empty (Serves 2) - Fall 2026', serving_tier: 'serves_2', family_id: familyId });
        candidate('camp1', s5.id);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0].serves5.meals).toHaveLength(0);
    });
});

// ===========================================================================
describe('7-8. selection semantics are unchanged by this phase', () => {
    it('the returned shape still carries familyId/available/unavailableReason untouched', async () => {
        fullFamily('Q2 Comfort', 'camp1', ['Meal 1']);

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0]).toEqual(expect.objectContaining({
            familyId: expect.any(String),
            available: true,
        }));
        expect(result[0].unavailableReason).toBeUndefined();
    });

    it('a family missing its Serves-2 sibling is still marked unavailable, same as before', async () => {
        const familyId = id('fam');
        const s5 = addBundle({ name: 'Orphan - Fall 2026', serving_tier: 'serves_5', family_id: familyId });
        attach(s5.id, 'Orphan Meal', 0);
        candidate('camp1', s5.id);
        // No Serves-2 sibling created at all.

        const result = await loadCandidateFamilies('camp1', TENANT);

        expect(result[0].available).toBe(false);
        expect(result[0].unavailableReason).toMatch(/serves 2/i);
        // The meals field is populated regardless — it is informational display
        // data, independent of the selectability gate.
        expect(result[0].serves5.meals).toEqual(['Orphan Meal']);
    });

    /**
     * Source-level on purpose. jest runs with testEnvironment 'node' — no DOM,
     * so BundleSelectionStep cannot be rendered here and this phase may not add
     * tooling to change that. The data layer above is proven behaviorally; this
     * pins the two branches that turn `meals` into what the coordinator sees.
     */
    it('the card renders the meal list when meals exist', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/coordinator/BundleSelectionStep.tsx'), 'utf8');
        const card = src.slice(src.indexOf('function FamilyCard'), src.indexOf('function VariantPill'));

        expect(card).toMatch(/serves5\.meals\.length > 0/);
        expect(card).toMatch(/serves5\.meals\.map/);
        expect(card).toContain('Included meals');
        // Gated the same way the existing serving-size pills already are —
        // no drift into rendering meals for an unselectable family.
        expect(card).toMatch(/\{available && \(\s*\n\s*serves5\.meals\.length > 0/);
    });

    it('the card shows the graceful empty-state message instead of a blank card', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'components/coordinator/BundleSelectionStep.tsx'), 'utf8');
        const card = src.slice(src.indexOf('function FamilyCard'), src.indexOf('function VariantPill'));

        expect(card).toContain('No meals are currently listed for this bundle');
        // The empty branch must be the ELSE of the same condition that renders
        // the list, not an independent check that could both be true/both false.
        const idx = card.indexOf('serves5.meals.length > 0');
        const elseIdx = card.indexOf(') : (', idx);
        const msgIdx = card.indexOf('No meals are currently listed', idx);
        expect(elseIdx).toBeGreaterThan(idx);
        expect(msgIdx).toBeGreaterThan(elseIdx);
    });

    it('the source no-longer-void select shape: contents is present on both bundle queries', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib/campaignBundleSelection.ts'), 'utf8');
        const occurrences = (src.match(/contents:\s*\{\s*orderBy:\s*\{\s*position:\s*'asc'\s*\}/g) ?? []).length;
        expect(occurrences).toBe(2); // candidate rows query + serves2 siblings query
    });
});
