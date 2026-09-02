/**
 * OPS-5 — meal-label serving-tier + ingredient + allergen hardening.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7 (meal/recipe labels
 * are a system distinct from customer outer-box labels) and §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * LIVE MEAL-LABEL LINEAGE, freshly traced at 0038d1d9 (not assumed from the
 * historical audit):
 *
 *   PATH A — the only path that produces a PHYSICAL label today
 *     ProductionCalculator "Print Batch (N)"
 *       -> localStorage `${businessId}_printBatch` = [{name, id, qty, unit}]
 *          (built from KitchenEngine prepTasks, which are keyed by RECIPE NAME
 *          alone and therefore carry NO serving tier)
 *       -> app/production/print-batch/page.tsx
 *       -> GET /api/recipes/{id} per unique id
 *       -> getLabelProps() -> <LabelTemplate> inside .print-page
 *       -> window.print()
 *
 *   PATH B — per-recipe designer
 *     ProductionCalculator "Print Labels (N)" -> /labels?recipeId&printQty
 *       -> app/labels/LabelsClient.tsx -> POST /api/production/print-label
 *
 *   PATH C — batch to the API printer
 *     ProductionCalculator "Batch Print All Labels" -> POST /api/production/print-label
 *
 *   PATHS B and C terminate in lib/label_printer.ts getLabelPrinter(), which
 *   returns a MockLabelPrinter unless DCG_API_KEY *and* DCG_LOCATION_ID are
 *   set. They still FORMAT label content, so they are in scope for allergen
 *   consistency, but PATH A is where a wrong string becomes a physical label.
 *
 * DEFECTS THIS SUITE PINS:
 *   D1  print-batch printed the literal "Ingredients loading..." on physical
 *       labels whenever the recipe fetch failed (the fetch swallowed its own
 *       error, the loading flag cleared regardless, and the Print button stayed
 *       enabled).
 *   D2  A failed ingredient load did not block printing at all.
 *   D3  FOUR divergent allergen keyword maps; the same ingredient text produced
 *       different allergens per surface, in two different vocabularies.
 *   D4  Meal labels carried no serving tier. The "Size" field printed the
 *       recipe's base_yield_unit ("servings"/"batch"), so a Serves-2 batch and
 *       a Serves-5 batch printed identical labels.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    ALLERGEN_CATEGORIES,
    allergenKeywords,
    detectAllergens,
    detectAllergenText,
    resolveLabelAllergens,
} from '@/lib/allergens';
import {
    FORBIDDEN_LABEL_VALUES,
    isUnsafeLabelValue,
    resolveLabelIngredients,
    collectBlockedLabels,
    servingTierLabel,
    planServingTier,
} from '@/lib/mealLabel';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every LIVE meal-label surface that formats allergen text.
 *
 * OPS-5D: components/production/ProductionCalculator.tsx was removed from
 * this list. It no longer builds label content (ingredients, allergens) at
 * all -- both its print actions ("Print Labels (N)" and "Batch Print All
 * Labels") now delegate entirely to the two surfaces still listed here,
 * which already resolve allergens through this same shared authority. This
 * is a consolidation, not a safety reduction: allergen resolution used to
 * happen in three places (a duplicate-map risk this whole suite exists to
 * close); it now happens in two, both already proven below.
 */
const LIVE_LABEL_SURFACES = [
    'app/production/print-batch/page.tsx',
    'app/labels/LabelsClient.tsx',
];

// ═════════════════════════════════════════════════════════════════════════════
// 1. ALLERGEN AUTHORITY — behavioural, on the real shared module.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. shared allergen authority: behaviour', () => {
    it('recognises every supported allergen class from ingredient text', () => {
        // "peanut butter" genuinely contains both keywords, and BOTH are true
        // of the food - a label must declare each.
        expect(detectAllergens('peanut butter')).toEqual(['Dairy', 'Peanuts']);
        expect(detectAllergens('roasted peanut')).toEqual(['Peanuts']);
        expect(detectAllergens('soy sauce')).toEqual(['Soy']);
        expect(detectAllergens('wheat flour')).toEqual(['Wheat']);
        expect(detectAllergens('egg noodles')).toEqual(['Eggs']);
        expect(detectAllergens('cod fish fillet')).toEqual(['Fish']);
        expect(detectAllergens('shrimp')).toEqual(['Crustacean Shellfish']);
        expect(detectAllergens('toasted almond')).toEqual(['Tree Nuts']);
        expect(detectAllergens('sesame oil')).toEqual(['Sesame']);
        expect(detectAllergens('heavy cream')).toEqual(['Dairy']);
    });

    it('uses the product-decided vocabulary from detect-allergens (Dairy not Milk, Wheat not Gluten)', () => {
        // The pre-OPS-5 keyword maps emitted "Gluten" for wheat, which
        // app/api/recipes/detect-allergens/route.ts explicitly forbids.
        expect(detectAllergens('wheat flour')).toEqual(['Wheat']);
        expect(detectAllergens('gluten')).toEqual(['Wheat']);
        expect(detectAllergens('whole milk')).toEqual(['Dairy']);
        expect(detectAllergenText('wheat flour')).not.toMatch(/Gluten/);
        expect(detectAllergenText('whole milk')).not.toMatch(/\bMilk\b/);
    });

    it('every emitted category is in the canonical allowlist', () => {
        const sample = 'peanut, soy, wheat, egg, fish, shrimp, almond, sesame, milk, '
            + 'crab, lobster, cashew, pecan, yogurt, whey, casein, lactose, half and half';
        for (const cat of detectAllergens(sample)) {
            expect(ALLERGEN_CATEGORIES).toContain(cat);
        }
    });

    it('detects multiple distinct allergens, sorted and de-duplicated', () => {
        const text = 'butter, cheese, cream, wheat flour, peanut oil';
        expect(detectAllergens(text)).toEqual(['Dairy', 'Peanuts', 'Wheat']);
        expect(detectAllergenText(text)).toBe('Dairy, Peanuts, Wheat');
    });

    it('is case-insensitive', () => {
        expect(detectAllergens('PEANUT BUTTER')).toEqual(['Dairy', 'Peanuts']);
        expect(detectAllergens('Shrimp Scampi')).toEqual(['Crustacean Shellfish']);
    });

    it('DEFECT D3: recognises the keywords ProductionCalculator was missing', () => {
        // These SEVEN keywords existed in print-batch and/or LabelsClient but
        // NOT in ProductionCalculator's map. A shrimp dish declared no allergen
        // at all from that surface.
        for (const kw of ['crab', 'lobster', 'shrimp', 'cashew', 'pecan', 'yogurt', 'whey']) {
            expect(detectAllergens(kw).length).toBeGreaterThan(0);
        }
    });

    it('DEFECT D3: recognises the keywords only LabelsClient had', () => {
        for (const kw of ['half n half', 'half-n-half', 'half and half', 'casein', 'lactose']) {
            expect(detectAllergens(kw)).toEqual(['Dairy']);
        }
    });

    it('the keyword union is the strict superset of all four replaced maps — no allergen keyword was dropped', () => {
        const union = allergenKeywords();
        const everyPreviouslyRecognisedKeyword = [
            // print-batch/page.tsx (23)
            'peanut', 'soy', 'wheat', 'gluten', 'egg', 'fish', 'shellfish', 'crab',
            'lobster', 'shrimp', 'tree nut', 'almond', 'walnut', 'cashew', 'pecan',
            'sesame', 'milk', 'dairy', 'butter', 'cheese', 'cream', 'yogurt', 'whey',
            // LabelsClient.tsx extras (5)
            'half n half', 'half-n-half', 'half and half', 'casein', 'lactose',
        ];
        for (const kw of everyPreviouslyRecognisedKeyword) {
            expect(union).toContain(kw);
        }
    });

    it('never asserts absence — empty input and no-match both yield "", never "None" or "allergen free"', () => {
        expect(detectAllergenText('')).toBe('');
        expect(detectAllergenText(null)).toBe('');
        expect(detectAllergenText(undefined)).toBe('');
        expect(detectAllergenText('rice, carrots, celery')).toBe('');
        // Assert on EXECUTABLE source, not prose: the module's own header
        // documents that it must never emit these, so a comment-inclusive
        // grep would match its own warning.
        const code = strip(read('lib/allergens.ts'));
        expect(code).not.toMatch(/allergen[- ]free/i);
        expect(code).not.toMatch(/safe for/i);
        expect(code).not.toMatch(/['"]None['"]/);
    });

    it('stored recipe allergens outrank keyword detection (human/AI review wins)', () => {
        expect(resolveLabelAllergens('Peanuts, Sesame', 'butter and cream')).toBe('Peanuts, Sesame');
        expect(resolveLabelAllergens('', 'butter and cream')).toBe('Dairy');
        expect(resolveLabelAllergens(null, 'butter and cream')).toBe('Dairy');
        expect(resolveLabelAllergens('   ', 'butter and cream')).toBe('Dairy');
    });

    it('does not conflate allergens with diet tags or recipe categories', () => {
        // Executable source only - the header prose explicitly names these as
        // concepts it refuses to merge.
        const code = strip(read('lib/allergens.ts'));
        expect(code).not.toMatch(/\bketo\b/i);
        expect(code).not.toMatch(/\bvegan\b/i);
        expect(code).not.toMatch(/\bgluten[- ]free\b/i);
        // Every emitted value is an allergen category, never a diet tag.
        for (const cat of ALLERGEN_CATEGORIES) {
            expect(cat).not.toMatch(/keto|vegan|paleo|whole30/i);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. ALLERGEN CONSISTENCY ACROSS LIVE CONSUMERS — Part J item 12.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. every live meal-label surface uses the ONE authority', () => {
    it.each(LIVE_LABEL_SURFACES)('DEFECT D3: %s imports @/lib/allergens', (file) => {
        expect(strip(read(file))).toMatch(/from ['"]@\/lib\/allergens['"]/);
    });

    it.each(LIVE_LABEL_SURFACES)('DEFECT D3: %s no longer defines its own allergen keyword map', (file) => {
        const src = strip(read(file));
        expect(src).not.toMatch(/keywordMap\s*:\s*Record<string, string>/);
        expect(src).not.toMatch(/allergenMap\s*:\s*Record<string, string>/);
        // The tell-tale inline pairing that every duplicate map contained.
        expect(src).not.toMatch(/["']peanut["']\s*:\s*["']Peanut/);
        expect(src).not.toMatch(/["']shellfish["']\s*:\s*["']Shellfish["']/);
    });

    it('the same ingredient text yields ONE answer, because there is only one implementation left', () => {
        const text = 'shrimp, cashew, yogurt, wheat flour';
        const expected = ['Crustacean Shellfish', 'Dairy', 'Tree Nuts', 'Wheat'];
        expect(detectAllergens(text)).toEqual(expected);
        // Pre-OPS-5 this same text produced three different answers:
        //   print-batch    -> Crustacean Shellfish, Dairy, Tree Nuts, Gluten (as "Shellfish/Gluten")
        //   ProductionCalc -> Gluten only (no shrimp/cashew/yogurt keywords at all)
        //   LabelsClient   -> as print-batch
        // Proven by section 2's assertions that no surface has its own map now.
        for (const file of LIVE_LABEL_SURFACES) {
            expect(strip(read(file))).toMatch(/from ['"]@\/lib\/allergens['"]/);
        }
    });

    it('OPS-5D: ProductionCalculator.tsx genuinely no longer formats allergen text -- it delegates instead', () => {
        const src = strip(read('components/production/ProductionCalculator.tsx'));
        expect(src).not.toMatch(/from ['"]@\/lib\/allergens['"]/);
        // Both print actions hand off to a surface that IS in LIVE_LABEL_SURFACES.
        expect(src).toMatch(/router\.push\(['"`]\/production\/print-batch['"`]\)/);
        expect(src).toMatch(/router\.push\(`\/labels\?recipeId=/);
    });

    it('the AI authoring-time classifier is a SEPARATE concept and is untouched', () => {
        const src = read('app/api/recipes/detect-allergens/route.ts');
        expect(src).toMatch(/ALLERGEN_ALLOWLIST/);
        expect(src).toMatch(/product decision: Dairy not Milk, no Gluten/);
        // It must NOT be rewired to the keyword matcher - it understands
        // compound ingredients that keywords cannot.
        expect(src).not.toMatch(/from ['"]@\/lib\/allergens['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. INGREDIENT TRUTH / FAIL CLOSED — behavioural, Part E + Part H.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. ingredient truth: no placeholder may reach a printed label', () => {
    it.each([
        'Ingredients loading...',
        'ingredients loading',
        'Loading...',
        'loading',
        'undefined',
        'null',
        '[object Object]',
        'NaN',
        '',
        '   ',
    ])('DEFECT D1: %p is refused as label ingredient text', (candidate) => {
        expect(isUnsafeLabelValue(candidate)).toBe(true);
        const res = resolveLabelIngredients('Chicken Teriyaki', candidate);
        expect(res.ok).toBe(false);
    });

    it.each([null, undefined, 42, {}, []])('non-string %p is refused', (candidate) => {
        expect(isUnsafeLabelValue(candidate as any)).toBe(true);
    });

    it('real ingredient text is accepted and trimmed', () => {
        const res = resolveLabelIngredients('Chicken Teriyaki', '  Chicken Breast, Soy Sauce, Rice  ');
        expect(res).toEqual({ ok: true, text: 'Chicken Breast, Soy Sauce, Rice' });
    });

    it('DEFECT D2: a failed load returns an operational error naming the meal, not a fallback string', () => {
        const res = resolveLabelIngredients('BBQ Pulled Pork', undefined);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.reason).toMatch(/BBQ Pulled Pork/);
            expect(res.reason).toMatch(/Printing has been stopped/);
        }
    });

    it('the forbidden list covers every placeholder this codebase has actually produced', () => {
        for (const s of ['ingredients loading...', 'loading...', 'undefined', 'null', '[object object]']) {
            expect(FORBIDDEN_LABEL_VALUES).toContain(s);
        }
    });

    it('DEFECT D1: no placeholder literal survives in EXECUTABLE print-batch source', () => {
        // Comments stripped: the fix's own comment quotes the removed
        // expression to document what it replaced, and a prose-inclusive grep
        // would match that explanation rather than real code.
        const code = strip(read('app/production/print-batch/page.tsx'));
        expect(code).not.toMatch(/["'`]Ingredients loading/i);
        expect(code).not.toMatch(/\|\|\s*["'`]Loading/i);
        // And the value that reaches the label must come from the fail-closed
        // resolver, not from a `||` fallback chain.
        expect(code).toMatch(/ingredients:\s*ingredientCheck\.ok\s*\?\s*ingredientCheck\.text\s*:\s*""/);
    });

    it('DEFECT D2: print-batch blocks printing when a required ingredient load failed', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        expect(src).toMatch(/from ['"]@\/lib\/mealLabel['"]/);
        expect(src).toMatch(/collectBlockedLabels/);
        const printFn = src.slice(src.indexOf('const handlePrintAll'), src.indexOf('const removeItem'));
        expect(printFn).toMatch(/blockedLabels\.length > 0/);
    });

    // ── The gate itself, exercised for real (not grepped for) ──────────────
    it('BEHAVIOURAL: a meal with NO loaded ingredients is blocked and named', () => {
        const blocked = collectBlockedLabels(
            [{ id: 'r1', name: 'Chicken Teriyaki' }],
            {}, // fetch failed -> key absent, exactly the real failure mode
            true,
        );
        expect(blocked).toHaveLength(1);
        expect(blocked[0].name).toBe('Chicken Teriyaki');
        expect(blocked[0].reason).toMatch(/Printing has been stopped/);
    });

    it('BEHAVIOURAL: a meal with real ingredients is NOT blocked', () => {
        const blocked = collectBlockedLabels(
            [{ id: 'r1', name: 'Chicken Teriyaki' }],
            { r1: 'Chicken Breast, Soy Sauce, Rice' },
            true,
        );
        expect(blocked).toEqual([]);
    });

    it('BEHAVIOURAL: one bad meal blocks the batch even when others are fine', () => {
        const blocked = collectBlockedLabels(
            [
                { id: 'ok', name: 'Good Meal' },
                { id: 'bad', name: 'Broken Meal' },
            ],
            { ok: 'Rice, Carrots' },
            true,
        );
        expect(blocked.map(b => b.name)).toEqual(['Broken Meal']);
    });

    it.each([
        ['Ingredients loading...', 'the historical placeholder'],
        ['undefined', 'a stringified undefined'],
        ['[object Object]', 'a stringified object'],
        ['', 'an empty string'],
        ['   ', 'whitespace only'],
    ])('BEHAVIOURAL: %p (%s) is blocked, never printed', (value) => {
        const blocked = collectBlockedLabels(
            [{ id: 'r1', name: 'Meal' }], { r1: value }, true,
        );
        expect(blocked).toHaveLength(1);
    });

    it('BEHAVIOURAL: duplicate meals in one batch are reported once, not once per copy', () => {
        const blocked = collectBlockedLabels(
            [
                { id: 'r1', name: 'Meal' },
                { id: 'r1', name: 'Meal' },
                { id: 'r1', name: 'Meal' },
            ],
            {}, true,
        );
        expect(blocked).toHaveLength(1);
    });

    it('BEHAVIOURAL: Part H — when the layout does not print ingredients, nothing is blocked', () => {
        // 2.25x1.25 / 4x6 take the name/qty/date path and never render an
        // ingredient list; stopping them would be a needless kitchen stoppage.
        expect(collectBlockedLabels([{ id: 'r1', name: 'Meal' }], {}, false)).toEqual([]);
    });

    it('DEFECT D2: the gate lives in the PRINTABLE DOM, not only on the button — Ctrl+P cannot bypass it', () => {
        // The print block is `hidden print:block`: CSS-hidden but always
        // mounted, so the browser's own Print command renders it regardless of
        // the button's disabled state. Refusing to render the labels is the
        // only thing that actually makes them unprintable.
        const code = strip(read('app/production/print-batch/page.tsx'));
        const printBlock = code.slice(code.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/blockedLabels\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
        // ...and the guard must come BEFORE the label fan-out it protects.
        expect(printBlock.indexOf('blockedLabels.length > 0 ?'))
            .toBeLessThan(printBlock.indexOf('batch.items.flatMap'));
    });

    it('DEFECT D1: the page-level loading state is print:hidden — Ctrl+P cannot print a "Loading batch..." sheet', () => {
        // This early return replaces the entire component, so the print block's
        // own guard never runs. Without a print rule of its own the browser
        // happily printed a physical sheet reading "Loading batch...".
        const code = strip(read('app/production/print-batch/page.tsx'));
        const line = code.split('\n').find(l => l.includes('Loading batch'));
        expect(line).toBeDefined();
        expect(line).toMatch(/print:hidden/);
    });

    it('EVERY printable placeholder string in print-batch is inside a print:hidden container', () => {
        // Any element that renders a transitional string must either be
        // print-hidden or not exist at print time.
        const code = strip(read('app/production/print-batch/page.tsx'));
        // The file has exactly two print regions: the screen-only header, which
        // opens at the first `print:hidden`, and the printable block, which
        // opens at `hidden print:block`. A transitional string is safe only if
        // it sits in the screen-only region (or carries print:hidden itself).
        const headerStart = code.indexOf('print:hidden');
        const printBlockStart = code.indexOf('hidden print:block');
        expect(headerStart).toBeGreaterThan(-1);
        expect(printBlockStart).toBeGreaterThan(headerStart);

        for (const marker of ['Loading batch', 'Loading Data...', 'Loading recipe assets']) {
            const idx = code.indexOf(marker);
            if (idx === -1) continue;
            const ownLine = code.split('\n').find(l => l.includes(marker)) || '';
            const screenOnly = idx > headerStart && idx < printBlockStart;
            expect(screenOnly || /print:hidden/.test(ownLine)).toBe(true);
        }

        // And nothing resembling a placeholder may live in the printable block.
        const printable = code.slice(printBlockStart);
        expect(printable).not.toMatch(/Loading/i);
        expect(printable).not.toMatch(/Ingredients loading/i);
    });

    it('the gate is scoped to the layout that actually prints ingredients (Part H: no needless stoppage)', () => {
        // Only the 2x6 layout renders LabelTemplate; 2.25x1.25 and 4x6 take the
        // simple name/qty/date path and never show an ingredient list. The
        // behaviour itself is proven by the `ingredientsRequired: false` test
        // above; this pins the wiring that decides it.
        const code = strip(read('app/production/print-batch/page.tsx'));
        expect(code).toMatch(/config\.showIngredients && labelSize === '2x6'/);
    });

    it('branding failure stays FAIL OPEN — a missing logo must not halt a kitchen', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        // The branding fetch must still swallow its own error rather than
        // feeding the print gate.
        expect(src).toMatch(/\/api\/tenant\/branding/);
        const printFn = src.slice(src.indexOf('const handlePrintAll'), src.indexOf('const removeItem'));
        expect(printFn).not.toMatch(/branding/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SERVING TIER ON THE LABEL — behavioural, Part D.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. serving tier: truthful or absent, never guessed', () => {
    it('maps only the canonical VariantSize vocabulary', () => {
        expect(servingTierLabel('serves_5')).toBe('Serves 5');
        expect(servingTierLabel('serves_2')).toBe('Serves 2');
    });

    it('refuses to guess a tier from free text or a bundle tier string', () => {
        // Deliberately NOT normalised here - normalising would make printing a
        // third tier authority, which the OPS-5 contract forbids.
        expect(servingTierLabel('family')).toBeNull();
        expect(servingTierLabel('couple')).toBeNull();
        expect(servingTierLabel('Serves 2')).toBeNull();
        expect(servingTierLabel(null)).toBeNull();
        expect(servingTierLabel(undefined)).toBeNull();
        expect(servingTierLabel('')).toBeNull();
    });

    it('a single-tier plan can truthfully claim that tier', () => {
        expect(planServingTier(['serves_5', 'serves_5'])).toBe('Serves 5');
        expect(planServingTier(['serves_2', 'serves_2', 'serves_2'])).toBe('Serves 2');
        expect(planServingTier(['serves_2'])).toBe('Serves 2');
    });

    it('DEFECT D4 / Part D: a MIXED plan claims NO tier — prepTasks already merged the meals, so any tier would be false for some of them', () => {
        expect(planServingTier(['serves_5', 'serves_2'])).toBeNull();
        expect(planServingTier(['serves_2', 'serves_5', 'serves_2'])).toBeNull();
    });

    it('an unknown or legacy-null tier anywhere makes the plan unprovable, not ignorable', () => {
        expect(planServingTier(['serves_5', null])).toBeNull();
        expect(planServingTier(['serves_5', 'family'])).toBeNull();
        expect(planServingTier([])).toBeNull();
    });

    it('S5 and S2 for the same meal are never confusable: distinct claims, or no claim at all', () => {
        const s5 = planServingTier(['serves_5']);
        const s2 = planServingTier(['serves_2']);
        expect(s5).not.toBe(s2);
        expect(s5).toBe('Serves 5');
        expect(s2).toBe('Serves 2');
        expect(planServingTier(['serves_5', 'serves_2'])).toBeNull();
    });

    it('DEFECT D4: print-batch renders the authoritative tier and no longer prints base_yield_unit as a serving size', () => {
        const src = strip(read('app/production/print-batch/page.tsx'));
        expect(src).toMatch(/servingTier/);
        // base_yield_unit ("servings"/"batch") is a recipe yield unit, never a
        // serving tier - it must not be presented as the label's Size.
        expect(src).not.toMatch(/mealSize:\s*detail\.base_yield_unit/);
    });

    it('DEFECT D4: the tier is genuinely WIRED from the batch into the label content, not merely mentioned', () => {
        // A source grep for "servingTier" alone is satisfied by the interface
        // declaration and the comments, so it cannot tell a live wire from a
        // dead one. These two assertions pin the actual data flow:
        //   batch.servingTier -> tier -> content.mealSize
        // SUPERSEDED BY OPS-5A: the tier is now resolved PER ITEM, because the
        // meal manifest yields one batch row per (recipe, tier). The batch-level
        // tier remains as the fallback. The wiring assertion is unchanged in
        // intent — prove the value actually flows into content.mealSize.
        const code = strip(read('app/production/print-batch/page.tsx'));
        expect(code).toMatch(/const tier = item\.servingTier \?\? batch\?\.servingTier;/);
        expect(code).toMatch(/mealSize:\s*tier \|\|/);
        // and it must not be hard-wired to a constant.
        expect(code).not.toMatch(/const tier = (null|undefined|['"`])/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. THE TIER SOURCE — /api/production/plan returns the authority it already
//    resolved. Real handler execution.
// ═════════════════════════════════════════════════════════════════════════════
const RECIPE_ROW = {
    id: 'recipe-chicken', name: 'Base Chicken', type: 'menu_item',
    base_yield_qty: 1, base_yield_unit: 'batch', container_type: 'tray', category_id: null,
    label_text: null, macros: null, image_url: null, description: null, allergens: null, cook_time: null,
    child_items: [{
        id: 'ri-1', parent_recipe_id: 'recipe-chicken',
        child_recipe_id: null, child_ingredient_id: 'ing-chicken',
        child_ingredient: { name: 'Chicken', unit: 'lb', cost_per_unit: 1, stock_quantity: 0, supplier: null },
        child_recipe: null, quantity: 5, unit: 'lb',
        is_sub_recipe: false, section_name: null, section_batch: null,
    }],
};
const B_S5 = 'bundle-s5';
const B_S2 = 'bundle-s2';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ops5Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__ops5Prisma = m.client; };
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const BIZ = 'biz-ops5';
const planMock = (bundles: { id: string; serving_tier: string }[]) => ({
    'recipe.findMany': [RECIPE_ROW],
    'bundleContent.findMany': (args: any) =>
        [B_S5, B_S2].includes(args.where.bundle_id)
            ? [{ bundle_id: args.where.bundle_id, recipe_id: RECIPE_ROW.id, position: 1, quantity: 1 }]
            : [],
    'bundle.findMany': (args: any) => bundles.filter(b => args.where.id.in.includes(b.id)),
});

const postPlan = async (body: any) => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', businessId: BIZ } });
    const { POST } = await import('@/app/api/production/plan/route');
    const res = await POST(new Request('http://localhost/api/production/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as any);
    return res.json();
};

describe('5. /api/production/plan exposes the tier it already resolved', () => {
    beforeEach(() => jest.clearAllMocks());

    it('DEFECT D4: a synced Serves-2 plan reports servingTier "Serves 2"', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: B_S2, quantity: 1, variant_size: 'serves_2' }] });
        expect(body.servingTier).toBe('Serves 2');
    });

    it('DEFECT D4: a synced Serves-5 plan reports servingTier "Serves 5"', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: B_S5, quantity: 1, variant_size: 'serves_5' }] });
        expect(body.servingTier).toBe('Serves 5');
    });

    it('a MANUAL row reports the tenant-scoped Bundle tier — never a client-supplied one (OPS-4A rule preserved)', async () => {
        useMock(createPrismaMock({ results: planMock([{ id: B_S2, serving_tier: 'serves_2' }]) }));
        const body = await postPlan({
            // Malicious client claim; must be ignored for a manual row.
            manualOrders: [{ bundle_id: B_S2, quantity: 1, variant_size: 'serves_5' }],
        });
        expect(body.servingTier).toBe('Serves 2');
    });

    it('a MIXED plan reports servingTier null so no label can claim a tier', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({
            syncedOrders: [
                { bundle_id: B_S5, quantity: 1, variant_size: 'serves_5' },
                { bundle_id: B_S2, quantity: 1, variant_size: 'serves_2' },
            ],
        });
        expect(body.servingTier).toBeNull();
    });

    it('the ingredient math is untouched by this phase — a Serves-2 line is still 0.5x', async () => {
        useMock(createPrismaMock({ results: planMock([]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: B_S2, quantity: 1, variant_size: 'serves_2' }] });
        expect(Number(body.rawIngredients['ing-chicken'].qty)).toBe(2.5);
    });

    it('OPS-4/4A preserved: sold snapshot still wins over the current Bundle tier', async () => {
        // Bundle now says serves_5; the sold line says serves_2.
        useMock(createPrismaMock({ results: planMock([{ id: B_S2, serving_tier: 'serves_5' }]) }));
        const body = await postPlan({ syncedOrders: [{ bundle_id: B_S2, quantity: 1, variant_size: 'serves_2' }] });
        expect(body.servingTier).toBe('Serves 2');
        expect(Number(body.rawIngredients['ing-chicken'].qty)).toBe(2.5);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE CLIENT HANDOFF — ProductionCalculator carries the tier to the batch.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. ProductionCalculator threads the plan tier into the print batch', () => {
    const src = () => strip(read('components/production/ProductionCalculator.tsx'));

    it('DEFECT D4: PlanResult carries servingTier', () => {
        expect(src()).toMatch(/servingTier/);
    });

    it('DEFECT D4: the printBatch payload carries servingTier', () => {
        // SUPERSEDED BY OPS-5E: the localStorage key literal moved into
        // lib/printBatchStorage.ts (one storage-key authority), so this
        // anchors on the write call instead of the raw key. The assertion
        // itself is unchanged: the payload must still carry a tier.
        const s = src();
        const batchBlock = s.slice(s.indexOf('writePrintBatch('), s.indexOf('writePrintBatch(') + 500);
        expect(batchBlock).toMatch(/servingTier/);
    });

    it('SUPERSEDED BY OPS-5A: PrepList — the OTHER live _printBatch writer — now uses the shared count authority AND carries a tier', () => {
        // components/production/PrepList.tsx (live: imported by
        // app/production/page.tsx) is a SECOND writer of the same localStorage
        // key. At OPS-5 it fanned out per meal but could not name a tier,
        // because the Kitchen Board's prep lane carried none. OPS-5A made that
        // lane tier-aware and moved the count formula into lib/mealManifest.ts,
        // so this writer no longer multiplies quantities inline.
        // SUPERSEDED BY OPS-5E: PrepList is still that second live writer, but
        // it now writes through the shared lib/printBatchStorage.ts authority
        // rather than constructing `${businessId}_printBatch` itself, so the
        // key literal no longer appears here. Everything else is unchanged.
        const s = strip(read('components/production/PrepList.tsx'));
        expect(s).toMatch(/writePrintBatch\(/);
        expect(s).toMatch(/physicalMealCount\(item\.total_quantity, r\.quantity\)/);
        expect(s).not.toMatch(/copies:\s*item\.total_quantity \* r\.quantity/);
        expect(s).toMatch(/servingTier/);
    });

    it('an absent servingTier still claims no tier rather than guessing', () => {
        // Unchanged contract: a line that cannot prove a tier omits the claim.
        expect(planServingTier([])).toBeNull();
        expect(servingTierLabel(undefined)).toBeNull();
    });

    it('SUPERSEDED BY OPS-5A: the batch item shape is preserved, now sourced from the meal manifest', () => {
        // OPS-5 built the batch from prepTasks (ingredient demand). OPS-5A
        // builds it from assemblyTasks (the physical meal manifest), so the
        // field SOURCES changed from `data.*` to `row.*` while the item shape
        // itself — name/id/qty/unit — is unchanged, plus a real copies count.
        const s = src();
        const batchBlock = s.slice(s.indexOf('const selectedRecipes'), s.indexOf('router.push(\'/production/print-batch\')'));
        expect(batchBlock).toMatch(/name:\s*row\.name/);
        expect(batchBlock).toMatch(/id:\s*row\.id/);
        expect(batchBlock).toMatch(/qty:\s*row\.qty/);
        expect(batchBlock).toMatch(/unit:\s*row\.unit/);
        expect(batchBlock).toMatch(/copies:\s*row\.qty/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. PRIVACY — Part I. Meal labels carry no supporter identity.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. privacy: no supporter PII on a meal label', () => {
    const MEAL_LABEL_FILES = [
        'app/production/print-batch/page.tsx',
        'components/LabelTemplate.tsx',
        'lib/mealLabel.ts',
        'lib/allergens.ts',
    ];

    it.each(MEAL_LABEL_FILES)('%s references no supporter contact field', (file) => {
        const s = strip(read(file));
        expect(s).not.toMatch(/\bcustomer_email\b|\bsupporter_email\b/);
        expect(s).not.toMatch(/\bcustomer_phone\b|\bsupporter_phone\b/);
        expect(s).not.toMatch(/delivery_address|shipping_address|\bstreet\b/i);
    });

    it('LabelTemplate\'s content contract admits only food fields', () => {
        const s = read('components/LabelTemplate.tsx');
        const iface = s.slice(s.indexOf('interface LabelContent'), s.indexOf('interface LabelConfig'));
        expect(iface).toMatch(/name/);
        expect(iface).toMatch(/ingredients/);
        expect(iface).toMatch(/allergens/);
        // No identity fields may be added to a MEAL label - outer-box labels
        // are a separate, unbuilt system (contract section 7).
        expect(iface).not.toMatch(/email|phone|address|supporter|recipient/i);
    });

    it('GUARD: the Labels page never reads the supporter identity params DeliveryQueue puts in the URL', () => {
        // components/production/DeliveryQueue.tsx:55-57 appends `customer`
        // (supporter name), `address` (delivery address) and `orderId` to the
        // /labels URL. LabelsClient reads recipeId/qty/unit/bundleHint/printQty/
        // sku and NOTHING else, so none of it reaches a meal label today.
        //
        // Delivery is explicitly out of scope this phase, so those params are
        // REPORTED, not removed. This guard is the tripwire: if a future change
        // wires supporter identity into the label content, it fails here.
        const code = strip(read('app/labels/LabelsClient.tsx'));
        expect(code).not.toMatch(/params\.get\(['"]customer['"]\)/);
        expect(code).not.toMatch(/params\.get\(['"]address['"]\)/);
        expect(code).not.toMatch(/searchParams\.get\(['"](customer|address)['"]\)/);
        // ...and the label content object must never gain an identity field.
        const contentState = code.slice(code.indexOf('const [labelContent, setLabelContent]'), code.indexOf('const [branding'));
        expect(contentState).not.toMatch(/customer|address|email|phone/i);
    });

    it('this phase did NOT build outer-box / Box N of M labels', () => {
        const s = strip(read('app/production/print-batch/page.tsx'));
        expect(s).not.toMatch(/Box \d+ of|boxNumber|box_number/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. REGRESSION GUARD — the locked authorities this phase must not touch.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. regression guard: kitchen quantity authorities untouched', () => {
    it('lib/kitchen_engine.ts is untouched — multiplier applied once per line', () => {
        const s = read('lib/kitchen_engine.ts');
        expect(s).toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
        expect(s).toMatch(/const multiplier = order\.quantity \* bundleContentQty \* servingMultiplier;/);
    });

    it('lib/serving_multipliers.ts is untouched (LOCKED)', () => {
        const s = read('lib/serving_multipliers.ts');
        expect(s).toMatch(/LOCK STATUS: PERMANENT/);
        expect(s).toMatch(/serves_5:\s*1\.0,/);
        expect(s).toMatch(/serves_2:\s*0\.5,/);
    });

    it('OPS-4 sync tier preservation is untouched', () => {
        const s = strip(read('app/api/production/sync/route.ts'));
        expect(s).toMatch(/const key = `\$\{bid\}::\$\{variant \?\? ''\}`;/);
    });

    it('OPS-4A manual/synced split is untouched', () => {
        const s = strip(read('app/api/production/plan/route.ts'));
        expect(s).toMatch(/variant_size: resolveVariantSize\(o\.variant_size \?\? o\.serving_tier \?\? 'family'\)/);
        expect(s).toMatch(/business_id: session\.user\.businessId/);
    });

    it('no schema change', () => {
        const schema = read('prisma/schema.prisma');
        const model = schema.slice(schema.indexOf('model Bundle {'), schema.indexOf('model BundleContent'));
        expect(model).toMatch(/serving_tier\s+String\s+@default\("family"\)/);
    });
});
