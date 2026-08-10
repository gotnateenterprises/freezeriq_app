/**
 * SF-4 — RoundOutRow eligibility tests.
 *
 * The suggestion rule is deliberately small, which is exactly why it needs
 * pinning: every clause here is a rule someone could "helpfully" relax later.
 * A suggestion that is inactive, hidden, already in the bag, or unaddable is a
 * bug the customer meets at the last step before paying.
 */

import { selectRoundOutBundles } from '@/components/storefront/RoundOutRow';

const bundle = (over: Partial<Record<string, unknown>> & { id: string; price: number }) => ({
    name: `Bundle ${over.id}`,
    serving_tier: 'serves_5',
    is_active: true,
    show_on_storefront: true,
    ...over,
});

const noneInBag = new Set<string>();

describe('1. the cheapest-three rule', () => {
    it('returns the three cheapest eligible bundles, cheapest first', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'e', price: 50 }),
            bundle({ id: 'a', price: 10 }),
            bundle({ id: 'c', price: 30 }),
            bundle({ id: 'b', price: 20 }),
            bundle({ id: 'd', price: 40 }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['a', 'b', 'c']);
    });

    it('never returns more than three', () => {
        const many = Array.from({ length: 20 }, (_, i) => bundle({ id: `b${i}`, price: i + 1 }));
        expect(selectRoundOutBundles(many, noneInBag)).toHaveLength(3);
    });

    it('returns only what legitimately exists when fewer than three qualify', () => {
        const out = selectRoundOutBundles([bundle({ id: 'a', price: 10 }), bundle({ id: 'b', price: 20 })], noneInBag);
        expect(out.map(b => b.id)).toEqual(['a', 'b']);
    });

    it('returns an empty list rather than a broken strip when nothing qualifies', () => {
        expect(selectRoundOutBundles([], noneInBag)).toEqual([]);
        expect(selectRoundOutBundles([bundle({ id: 'a', price: 10, is_active: false })], noneInBag)).toEqual([]);
    });

    it('survives a missing or malformed payload', () => {
        expect(selectRoundOutBundles(undefined as never, noneInBag)).toEqual([]);
        expect(selectRoundOutBundles(null as never, noneInBag)).toEqual([]);
    });
});

describe('2. eligibility filters', () => {
    it('excludes inactive bundles — the storefront payload does NOT filter is_active', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'inactive', price: 1, is_active: false }),
            bundle({ id: 'ok', price: 99 }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['ok']);
    });

    it('excludes bundles the tenant has hidden from the storefront', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'hidden', price: 1, show_on_storefront: false }),
            bundle({ id: 'ok', price: 99 }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['ok']);
    });

    it('excludes anything already in the bag, however cheap', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'inbag', price: 1 }),
            bundle({ id: 'ok', price: 99 }),
        ], new Set(['inbag']));
        expect(out.map(b => b.id)).toEqual(['ok']);
    });

    it('excludes a bundle with no serving_tier — the cart contract requires one', () => {
        // SF-3 already excludes the manual-upsell sentinel for this exact reason.
        const out = selectRoundOutBundles([
            bundle({ id: 'sentinel', price: 1, serving_tier: undefined }),
            bundle({ id: 'ok', price: 99 }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['ok']);
    });

    it('excludes a bundle with a non-numeric price', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'bad', price: Number.NaN }),
            bundle({ id: 'ok', price: 99 }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['ok']);
    });

    it('treats an absent is_active/show_on_storefront flag as permissive, not as a reason to drop', () => {
        // The storefront payload spreads the Prisma row; a field could be absent
        // on a legacy record. Absent must not silently empty the strip.
        const out = selectRoundOutBundles(
            [{ id: 'legacy', name: 'Legacy', price: 12, serving_tier: 'serves_5' }],
            noneInBag,
        );
        expect(out.map(b => b.id)).toEqual(['legacy']);
    });
});

describe('3. no invented ranking', () => {
    it('orders purely by price — not by name, position, or payload order', () => {
        const out = selectRoundOutBundles([
            bundle({ id: 'z', price: 5, name: 'Aaa first alphabetically' }),
            bundle({ id: 'a', price: 4, name: 'Zzz last alphabetically' }),
        ], noneInBag);
        expect(out.map(b => b.id)).toEqual(['a', 'z']);
    });

    it('does not mutate the caller’s array', () => {
        const input = [bundle({ id: 'b', price: 20 }), bundle({ id: 'a', price: 10 })];
        const order = input.map(b => b.id);
        selectRoundOutBundles(input, noneInBag);
        expect(input.map(b => b.id)).toEqual(order);
    });
});
