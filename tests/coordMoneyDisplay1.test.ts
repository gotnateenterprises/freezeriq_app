/**
 * COORD-MONEY-DISPLAY-1 — Coordinator Recent Orders shows what a supporter owes TO THE CENT.
 *
 * Production audit (2026-09-15), read-only: an order on a TAXABLE 1% campaign stored
 * total_amount $120.00 (one each of two $60.00 Serves 2 bundles) and tax_amount $1.20. The
 * coordinator API's amount_due was 121.2, exactly as lib/fundraiserTax.ts derives it, but
 * components/coordinator/RecentOrders.tsx rendered it with toFixed(0) as "$121". Nothing stored
 * or calculated was wrong. The defect was the display alone, so the fix is the display alone.
 */

import * as fs from 'fs';
import * as path from 'path';
import { toSupporterOrder } from '@/lib/coordinatorSupporterOrders';

const ROOT = path.join(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const RECENT = read('components', 'coordinator', 'RecentOrders.tsx');
const PICKUP = read('app', 'coordinator', 'portal', 'pickup-tracker', 'page.tsx');

/** The exact expression RecentOrders renders after its "$", as a function of one order. */
function renderedAmount(): (order: Record<string, unknown>) => string {
    const m = RECENT.match(/\$\{(Number\(o\.amount_due \?\? o\.total_amount \?\? 0\)\.toFixed\(\d\))\}/);
    if (!m) throw new Error('the amount expression was not found in RecentOrders.tsx');
    return new Function('o', `return ${m[1]};`) as (order: Record<string, unknown>) => string;
}

describe('COORD-MONEY-DISPLAY-1 · Recent Orders shows the amount due to the cent', () => {
    it('renders the tax-inclusive amount due with two decimals, never whole dollars', () => {
        expect(RECENT).toContain('${Number(o.amount_due ?? o.total_amount ?? 0).toFixed(2)}');
        expect(RECENT).not.toMatch(/toFixed\(0\)/);
    });

    it('the audited order: $120.00 of food + $1.20 tax renders "$121.20", not "$121"', () => {
        const order = toSupporterOrder({ id: 'audited', total_amount: '120.00', tax_amount: '1.20' }, null);
        expect(order.amount_due).toBe(121.2);
        expect(`$${renderedAmount()(order as unknown as Record<string, unknown>)}`).toBe('$121.20');
    });

    it.each([
        [{ total_amount: '60.00', tax_amount: '0.60' }, '$60.60'],
        [{ total_amount: '125.00', tax_amount: '1.25' }, '$126.25'],
        [{ total_amount: '375.00', tax_amount: '3.75' }, '$378.75'],
        [{ total_amount: '120.00', tax_amount: '0.00' }, '$120.00'],
    ])('amount due for %j renders %s', (row, expected) => {
        const order = toSupporterOrder({ id: 'row', ...row }, null);
        expect(`$${renderedAmount()(order as unknown as Record<string, unknown>)}`).toBe(expected);
    });

    it('a response shaped before amount_due existed still shows its total to the cent', () => {
        expect(`$${renderedAmount()({ total_amount: 35.5 })}`).toBe('$35.50');
    });

    it('matches the printed pickup tracker, which already prints the same collection figure to the cent', () => {
        expect(PICKUP).toMatch(/\$\{Number\(g\.total \|\| 0\)\.toFixed\(2\)\}/);
    });

    it('only the display changed: the figure is still the server-derived amount_due', () => {
        expect(RECENT).toMatch(/o\.amount_due\s*\?\?\s*o\.total_amount/);
    });
});
