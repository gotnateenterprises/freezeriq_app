/**
 * INV-A — per-campaign organization share.
 *
 * Failure modes pinned here: a fraction stored where a percent belongs (a 100x
 * money error), an out-of-range share accepted, a blank form field silently
 * becoming 0%, and the gross/share/balance identity drifting apart.
 */

import {
    parseOrgSharePercent,
    organizationShareAmount,
    balanceDueToTenant,
    DEFAULT_ORG_SHARE_PERCENT,
    MIN_ORG_SHARE_PERCENT,
    MAX_ORG_SHARE_PERCENT,
} from '@/lib/fundraiserOrgShare';

describe('1. the default is 20.00 and it is a PERCENT', () => {
    it('defaults to 20, not 0.2', () => {
        expect(DEFAULT_ORG_SHARE_PERCENT).toBe(20);
        expect(DEFAULT_ORG_SHARE_PERCENT).not.toBe(0.2);
    });

    it('25 means twenty-five percent, and is stored as 25 not 0.25', () => {
        const r = parseOrgSharePercent(25);
        expect(r.ok && r.percent).toBe(25);
    });

    it('bounds are 0 and 100 inclusive', () => {
        expect(MIN_ORG_SHARE_PERCENT).toBe(0);
        expect(MAX_ORG_SHARE_PERCENT).toBe(100);
    });
});

describe('2. parsing accepts what a form actually sends', () => {
    it('accepts numbers and numeric strings alike', () => {
        expect(parseOrgSharePercent(28)).toEqual({ ok: true, percent: 28 });
        expect(parseOrgSharePercent('28')).toEqual({ ok: true, percent: 28 });
        expect(parseOrgSharePercent('28.5')).toEqual({ ok: true, percent: 28.5 });
    });

    it('accepts the inclusive boundaries', () => {
        expect(parseOrgSharePercent(0)).toEqual({ ok: true, percent: 0 });
        expect(parseOrgSharePercent(100)).toEqual({ ok: true, percent: 100 });
    });

    it('normalises to two decimals, matching NUMERIC(5,2)', () => {
        const r = parseOrgSharePercent('25.555');
        expect(r.ok && r.percent).toBe(25.56);
    });
});

describe('3. parsing refuses everything that would corrupt the money', () => {
    it('rejects out-of-range values on both sides', () => {
        expect(parseOrgSharePercent(-0.01).ok).toBe(false);
        expect(parseOrgSharePercent(100.01).ok).toBe(false);
        expect(parseOrgSharePercent(-1).ok).toBe(false);
        expect(parseOrgSharePercent(1000).ok).toBe(false);
    });

    it('rejects blank rather than silently meaning 0%', () => {
        expect(parseOrgSharePercent('').ok).toBe(false);
        expect(parseOrgSharePercent('   ').ok).toBe(false);
        expect(parseOrgSharePercent(null).ok).toBe(false);
        expect(parseOrgSharePercent(undefined).ok).toBe(false);
    });

    it('rejects non-numeric text and NaN/Infinity', () => {
        expect(parseOrgSharePercent('twenty').ok).toBe(false);
        expect(parseOrgSharePercent('20%').ok).toBe(false);
        expect(parseOrgSharePercent(NaN).ok).toBe(false);
        expect(parseOrgSharePercent(Infinity).ok).toBe(false);
    });

    it('rejects types that JS would happily coerce to a number', () => {
        // true -> 1 and [] -> 0 without an explicit type guard.
        expect(parseOrgSharePercent(true as unknown).ok).toBe(false);
        expect(parseOrgSharePercent([] as unknown).ok).toBe(false);
        expect(parseOrgSharePercent({} as unknown).ok).toBe(false);
    });
});

describe('4. the approved invoice identity: gross − share = balance due tenant', () => {
    it('the worked example from the product contract', () => {
        // $1,000 gross at 25% -> org keeps $250, tenant is owed $750.
        expect(organizationShareAmount(1000, 25)).toBe(250);
        expect(balanceDueToTenant(1000, 25)).toBe(750);
    });

    it('holds at the 20% default', () => {
        expect(organizationShareAmount(1000, 20)).toBe(200);
        expect(balanceDueToTenant(1000, 20)).toBe(800);
    });

    it('share + balance always reconstructs gross', () => {
        for (const [gross, pct] of [[1000, 25], [4850.5, 28], [9125.75, 30], [0, 20], [123.45, 0]] as const) {
            const share = organizationShareAmount(gross, pct);
            const balance = balanceDueToTenant(gross, pct);
            expect(Math.abs(share + balance - gross)).toBeLessThanOrEqual(0.01);
        }
    });

    it('0% means the tenant is owed the whole gross; 100% means nothing', () => {
        expect(balanceDueToTenant(500, 0)).toBe(500);
        expect(balanceDueToTenant(500, 100)).toBe(0);
    });

    it('treats the percent as a percent — 25 is NOT 2500%', () => {
        // The 100x error this whole module exists to prevent.
        expect(organizationShareAmount(100, 25)).toBe(25);
        expect(organizationShareAmount(100, 25)).not.toBe(2500);
    });

    it('rounds to cents rather than leaking floating-point dust', () => {
        // 333.33 * 28% = 93.3324
        expect(organizationShareAmount(333.33, 28)).toBe(93.33);
    });
});
