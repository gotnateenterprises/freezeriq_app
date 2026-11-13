/**
 * RECIPE-LIST-READABILITY-1 — the Recipes table gives the recipe name the room.
 *
 * Presentation only. The real RecipeList is rendered to static markup (no DOM environment in this
 * repo); only the drag wrapper is replaced, by one that hands its children the same render-prop
 * shape (attributes / listeners) that @dnd-kit supplies. Recipes are fictional.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'fs';
import path from 'path';

jest.mock('@/components/DraggableComponents', () => ({
    DraggableRecipe: ({ id, children }: any) =>
        require('react').createElement('div', { 'data-draggable': id }, children({ attributes: {}, listeners: {} })),
}));

import { RecipeList } from '@/components/recipes/RecipeList';

const LONG = 'Breakfast Casserole (Sausage, Egg & Cheddar — Family Size)';
const recipes = [
    { id: 'r1', name: LONG, base_yield_qty: 5, base_yield_unit: 'servings', calculated_cost: 21.456,
      categories: [{ name: 'Breakfast' }, { name: 'Family Favorites' }, { name: 'Freezer Meals' }] },
    { id: 'r2', name: 'BBQ Pulled Pork (Serves 2)', base_yield_qty: '2', base_yield_unit: 'Servings', calculated_cost: '8.5',
      categories: [] },
    { id: 'r3', name: 'Black Bean Chicken (no yield)', base_yield_qty: null, base_yield_unit: null, calculated_cost: null,
      categories: [{ name: 'Mains' }], matchReason: 'ingredient match' },
];
const render = () => renderToStaticMarkup(createElement(RecipeList, { recipes, selectedId: 'r2', onSelect: () => undefined }));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'components/recipes/RecipeList.tsx'), 'utf8');

const NEW_MD = 'md:grid-cols-[20px_minmax(0,1fr)_minmax(0,0.45fr)_44px_60px_24px]';
const NEW_SM = 'grid-cols-[20px_minmax(0,1fr)_60px_24px]';

describe('RECIPE-LIST-READABILITY-1 · column layout', () => {
    it('header and every row use the same rebalanced template (name dominant, category 0.45 of its share, narrow yield, compact cost)', () => {
        const m = render();
        // 1 header + 3 rows.
        expect(m.split(NEW_MD).length - 1).toBe(4);
        expect(m.split(NEW_SM).length - 1).toBe(4);
        // The old fixed Category/Yield/Cost widths are gone.
        // Built from parts so Tailwind (which also scans tests/) does not emit the old rule into the CSS.
        const OLD_MD = ['md:grid-cols-[24px', '1fr', '140px', '90px', '80px', '32px]'].join('_');
        expect(m).not.toContain(OLD_MD);
        expect(SRC).not.toContain(['140px', '90px', '80px'].join('_'));
    });

    it('Tailwind can see the template: it is a complete literal class string in the source', () => {
        expect(SRC).toContain(`const COLUMNS = '${NEW_SM} ${NEW_MD} gap-1.5';`);
    });

    it('Category and Yield are still hidden below md (no horizontal scroll on small screens)', () => {
        const m = render();
        expect(m).toContain('<span class="hidden md:block">Category</span>');
        expect(m).toContain('<span class="hidden md:block text-center">Yield</span>');
    });
});

describe('RECIPE-LIST-READABILITY-1 · cells', () => {
    it('the full recipe name is always available on hover, and the row stays one truncated line', () => {
        const m = render();
        expect(m).toContain(`title="${LONG.replace(/&/g, '&amp;')}"`);
        expect(m).toContain('title="BBQ Pulled Pork (Serves 2)"');
        // The name button truncates (one line) rather than wrapping.
        expect(m).toMatch(/<button title="BBQ Pulled Pork \(Serves 2\)" class="min-w-0 truncate /);
        // A search match reason still renders inside the name cell, but is not part of the hover name.
        expect(m).toContain('title="Black Bean Chicken (no yield)"');
        expect(m).toContain('ingredient match');
    });

    it('yield shows only the number, centred; the unit moves to the hover title', () => {
        const m = render();
        expect(m).toMatch(/<span class="hidden md:block whitespace-nowrap text-center text-xs tabular-nums text-slate-500" title="5 servings">5<\/span>/);
        expect(m).toMatch(/title="2 Servings">2<\/span>/);
        expect(m).not.toMatch(/>5 servings</);
        expect(m).not.toMatch(/>2 Servings</);
        // No yield → the same em dash as before, and no empty title.
        expect(m).toMatch(/text-center text-xs tabular-nums text-slate-500">—<\/span>/);
    });

    it('category text is unchanged, truncates, and carries the full value on hover', () => {
        const m = render();
        const full = 'Breakfast · Family Favorites · Freezer Meals';
        expect(m).toContain(`<span class="hidden md:block min-w-0 truncate text-xs text-slate-500" title="${full}">${full}</span>`);
        expect(m).toContain('title="—">—</span>'); // no categories → the same em dash
    });

    it('cost formatting and alignment are unchanged; a hidden cost is still blank', () => {
        const m = render();
        expect(m).toContain('<span class="text-right text-xs font-bold tabular-nums text-emerald-600">$21.46</span>');
        expect(m).toContain('<span class="text-right text-xs font-bold tabular-nums text-emerald-600">$8.50</span>');
        expect(m).toContain('<span class="text-right text-xs font-bold tabular-nums text-emerald-600"></span>');
    });

    it('drag handle, selection highlight and the print button are preserved', () => {
        const m = render();
        expect(m.split('title="Drag to a category"').length - 1).toBe(3);
        expect(m.split('title="Print recipe"').length - 1).toBe(3);
        expect(m.split('bg-indigo-50').length - 1).toBe(1); // r2 selected
        expect(m.split('data-draggable=').length - 1).toBe(3);
    });
});
