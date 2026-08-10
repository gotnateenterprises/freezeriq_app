/**
 * Public storefront bundle eligibility.
 *
 * A deactivated bundle rendered on the public storefront with a working Add
 * button, because the payload filtered only `show_on_storefront`. These pin the
 * full rule: a customer must never be offered — or able to buy — a product the
 * tenant has switched off.
 */

import {
    PUBLIC_BUNDLE_VISIBILITY,
    isPubliclyVisibleBundle,
} from '@/lib/storefrontEligibility';

const bundle = (is_active: boolean, show_on_storefront: boolean) => ({ is_active, show_on_storefront });

describe('1. the four flag combinations', () => {
    it('active + storefront-visible is included', () => {
        expect(isPubliclyVisibleBundle(bundle(true, true))).toBe(true);
    });

    it('INACTIVE + storefront-visible is excluded — the reported defect', () => {
        expect(isPubliclyVisibleBundle(bundle(false, true))).toBe(false);
    });

    it('active + storefront-hidden is excluded', () => {
        expect(isPubliclyVisibleBundle(bundle(true, false))).toBe(false);
    });

    it('inactive + storefront-hidden is excluded', () => {
        expect(isPubliclyVisibleBundle(bundle(false, false))).toBe(false);
    });
});

describe('2. the query fragment carries the whole rule', () => {
    // The route spreads this object rather than hand-writing the flags, so a
    // regression here is a regression in the live storefront query.
    it('requires both flags', () => {
        expect(PUBLIC_BUNDLE_VISIBILITY).toEqual({ show_on_storefront: true, is_active: true });
    });

    it('never omits is_active — the exact field the payload used to ignore', () => {
        expect(PUBLIC_BUNDLE_VISIBILITY).toHaveProperty('is_active', true);
    });
});

describe('3. fails closed on unknown values', () => {
    it('treats a missing flag as ineligible rather than assuming yes', () => {
        expect(isPubliclyVisibleBundle({ show_on_storefront: true })).toBe(false);
        expect(isPubliclyVisibleBundle({ is_active: true })).toBe(false);
        expect(isPubliclyVisibleBundle({})).toBe(false);
    });

    it('treats null flags as ineligible', () => {
        expect(isPubliclyVisibleBundle({ is_active: null, show_on_storefront: true })).toBe(false);
        expect(isPubliclyVisibleBundle({ is_active: true, show_on_storefront: null })).toBe(false);
    });

    it('survives a missing bundle', () => {
        expect(isPubliclyVisibleBundle(null)).toBe(false);
        expect(isPubliclyVisibleBundle(undefined)).toBe(false);
    });
});
