/**
 * FR-GOAL-CONFIG-1 — the tenant-controlled weighted bundle goal.
 *
 * Failure modes pinned here:
 *  - the old arbitrary 100 default reappearing on any surface
 *  - a blank/omitted goal at CREATE time being rejected instead of resolving
 *    to the default
 *  - an explicit invalid value (0, negative, NaN, Infinity, malformed string)
 *    being silently coerced to something "safe" instead of refused
 *  - an EDIT that omits the goal accidentally resetting an already-configured
 *    value back to the default (omission must mean "no change" at edit time,
 *    unlike at create time, where omission means "use the default")
 *  - changing the goal retroactively altering the numerator (weighted bundles
 *    already sold) instead of only moving the denominator
 *  - a closed-out campaign's goal being changeable after the fact
 *  - any of the four campaign-creation code paths, or any display surface,
 *    deciding its own independent fallback instead of using this one module
 */

import {
    DEFAULT_BUNDLE_GOAL,
    resolveBundleGoal,
    parseBundleGoal,
    decideBundleGoalChange,
    isBundleGoalRejected,
    computeFundraiserProgress,
} from '@/lib/fundraiserMetrics';

describe('1. the default is 20, not the old 100', () => {
    it('DEFAULT_BUNDLE_GOAL is 20', () => {
        expect(DEFAULT_BUNDLE_GOAL).toBe(20);
        expect(DEFAULT_BUNDLE_GOAL).not.toBe(100);
    });
});

describe('2. resolveBundleGoal — the DISPLAY fallback, never rejects', () => {
    it('a valid positive stored value passes through unchanged', () => {
        expect(resolveBundleGoal(30)).toBe(30);
        expect(resolveBundleGoal('45')).toBe(45);
    });

    it('null, undefined, and 0 all resolve to the default', () => {
        expect(resolveBundleGoal(null)).toBe(20);
        expect(resolveBundleGoal(undefined)).toBe(20);
        expect(resolveBundleGoal(0)).toBe(20);
    });

    it('negative, NaN, Infinity, and malformed legacy data resolve to the default', () => {
        expect(resolveBundleGoal(-5)).toBe(20);
        expect(resolveBundleGoal(NaN)).toBe(20);
        expect(resolveBundleGoal(Infinity)).toBe(20);
        expect(resolveBundleGoal('not-a-number')).toBe(20);
    });

    it('never returns the old 100 for any falsy/invalid input', () => {
        for (const bad of [null, undefined, 0, -1, NaN, Infinity, '', 'x']) {
            expect(resolveBundleGoal(bad as any)).not.toBe(100);
        }
    });
});

describe('3. parseBundleGoal — CREATE-time validation: blank resolves, junk is refused', () => {
    it('absent/blank resolves to the default, never rejected', () => {
        expect(parseBundleGoal(undefined)).toEqual({ ok: true, goal: 20 });
        expect(parseBundleGoal(null)).toEqual({ ok: true, goal: 20 });
        expect(parseBundleGoal('')).toEqual({ ok: true, goal: 20 });
        expect(parseBundleGoal('   ')).toEqual({ ok: true, goal: 20 });
    });

    it('accepts a valid positive number or numeric string', () => {
        expect(parseBundleGoal(30)).toEqual({ ok: true, goal: 30 });
        expect(parseBundleGoal('75')).toEqual({ ok: true, goal: 75 });
    });

    it('rejects 0 explicitly rather than treating it as blank', () => {
        expect(parseBundleGoal(0).ok).toBe(false);
        expect(parseBundleGoal('0').ok).toBe(false);
    });

    it('rejects negative numbers', () => {
        expect(parseBundleGoal(-1).ok).toBe(false);
        expect(parseBundleGoal('-20').ok).toBe(false);
    });

    it('rejects NaN and Infinity', () => {
        expect(parseBundleGoal(NaN).ok).toBe(false);
        expect(parseBundleGoal(Infinity).ok).toBe(false);
        expect(parseBundleGoal(-Infinity).ok).toBe(false);
    });

    it('rejects malformed non-numeric strings', () => {
        expect(parseBundleGoal('abc').ok).toBe(false);
        expect(parseBundleGoal('twenty').ok).toBe(false);
        expect(parseBundleGoal('20 bundles').ok).toBe(false);
    });

    it('rejects types JS would happily coerce to a number', () => {
        expect(parseBundleGoal(true as unknown).ok).toBe(false);
        expect(parseBundleGoal([] as unknown).ok).toBe(false);
        expect(parseBundleGoal({} as unknown).ok).toBe(false);
    });

    it('prefers whole numbers by rounding rather than rejecting', () => {
        expect(parseBundleGoal(20.5)).toEqual({ ok: true, goal: 21 });
        expect(parseBundleGoal('30.4')).toEqual({ ok: true, goal: 30 });
    });

    it('has no invented upper bound — a large organization is not capped', () => {
        expect(parseBundleGoal(5000)).toEqual({ ok: true, goal: 5000 });
        expect(parseBundleGoal(1_000_000)).toEqual({ ok: true, goal: 1_000_000 });
    });

    it('an invalid value is refused truthfully, never silently downgraded to the default', () => {
        const r = parseBundleGoal(-5);
        expect(r.ok).toBe(false);
        expect((r as any).goal).toBeUndefined();
    });
});

describe('4. decideBundleGoalChange — EDIT-time: omission means "leave it alone"', () => {
    const onEditOpen = (requested: unknown) => decideBundleGoalChange({ requested, campaignClosed: false });
    const onEditClosed = (requested: unknown) => decideBundleGoalChange({ requested, campaignClosed: true });

    it('omitting the goal on an open campaign is not a change', () => {
        for (const omitted of [undefined, null, '']) {
            const d = onEditOpen(omitted);
            expect(d).toEqual({ change: false });
            expect(isBundleGoalRejected(d)).toBe(false);
        }
    });

    it('a valid explicit value on an open campaign is accepted', () => {
        expect(onEditOpen(40)).toEqual({ change: true, goal: 40 });
        expect(onEditOpen('30')).toEqual({ change: true, goal: 30 });
    });

    it('an invalid explicit value is refused with 400, not coerced', () => {
        for (const bad of [0, -5, 'abc', NaN, Infinity]) {
            const d = onEditOpen(bad);
            expect(isBundleGoalRejected(d) && d.status).toBe(400);
        }
    });

    it('a closed campaign refuses an explicit change with 409', () => {
        const d = onEditClosed(40);
        expect(isBundleGoalRejected(d) && d.status).toBe(409);
    });

    it('a closed campaign still accepts an omitted goal (non-goal edits unaffected)', () => {
        expect(onEditClosed(undefined)).toEqual({ change: false });
    });

    it('closeout is checked before value validity, so an invalid value on a closed campaign is still 409', () => {
        const d = onEditClosed('not-a-number');
        expect(isBundleGoalRejected(d) && d.status).toBe(409);
    });

    it('there is no role gate — unlike org share, no user object is required at all', () => {
        // decideBundleGoalChange's signature has no `user` field; this is a
        // structural fact, not a runtime check — pinned so a future change
        // that adds a role gate is a deliberate decision, not an accident.
        expect(decideBundleGoalChange.length).toBe(1);
    });
});

describe('5. changing the goal only ever moves the denominator', () => {
    const orders = [
        { items: [{ quantity: 5, variant_size: 'serves_5' }] },
        { items: [{ quantity: 5, variant_size: 'serves_2' }] },
    ]; // 5*1.0 + 5*0.5 = 7.5 weighted bundles sold

    it('the worked example: 7.5/20 becomes 7.5/40 when the goal changes, never 15/40', () => {
        const before = computeFundraiserProgress(20, 1000, orders);
        const after = computeFundraiserProgress(40, 1000, orders);
        expect(before.totalBundlesSold).toBe(7.5);
        expect(before.bundleGoal).toBe(20);
        expect(after.totalBundlesSold).toBe(7.5);
        expect(after.bundleGoal).toBe(40);
        expect(after.totalBundlesSold).toBe(before.totalBundlesSold);
    });

    it('progress percent moves with the denominator while the numerator holds', () => {
        const before = computeFundraiserProgress(20, 1000, orders);
        const after = computeFundraiserProgress(40, 1000, orders);
        expect(before.progressPercent).toBeCloseTo(37.5, 5); // 7.5/20
        expect(after.progressPercent).toBeCloseTo(18.75, 5); // 7.5/40
    });
});

describe('6. computeFundraiserProgress uses the new default, and respects a stored legacy value', () => {
    it('a missing goal now resolves to 20, not 100', () => {
        const r = computeFundraiserProgress(undefined, 0, []);
        expect(r.bundleGoal).toBe(20);
    });

    it('an existing campaign that stored the OLD 100 default keeps reading 100 (no retroactive rewrite)', () => {
        const r = computeFundraiserProgress(100, 0, []);
        expect(r.bundleGoal).toBe(100);
    });

    it('the weighting math itself is untouched by this phase', () => {
        const r = computeFundraiserProgress(20, 500, [
            { items: [{ quantity: 2, variant_size: 'serves_5' }, { quantity: 4, variant_size: 'serves_2' }] },
        ]);
        expect(r.totalBundlesSold).toBe(4); // 2*1.0 + 4*0.5
    });
});

describe('7. create and edit deliberately DIFFER on what blank means', () => {
    it('at CREATE, blank resolves immediately to the default', () => {
        expect(parseBundleGoal('').ok && parseBundleGoal('').goal).toBe(20);
    });

    it('at EDIT, the equivalent omission is a no-op, not a reset to the default', () => {
        expect(decideBundleGoalChange({ requested: '', campaignClosed: false })).toEqual({ change: false });
    });

    it('for every PRESENT value, create-time and edit-time validation agree', () => {
        const cases: unknown[] = [30, '45', 0, -5, 'abc', NaN, Infinity, 20.5];
        for (const requested of cases) {
            const created = parseBundleGoal(requested);
            const edited = decideBundleGoalChange({ requested, campaignClosed: false });
            if (created.ok) {
                expect(edited).toEqual({ change: true, goal: created.goal });
            } else {
                expect(isBundleGoalRejected(edited) && edited.status).toBe(400);
            }
        }
    });
});

describe('8. no surface reintroduces its own independent fallback', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

    it('the campaign-creation branch uses the resolved goal, not a bare `|| 100`', () => {
        // OPS-2 collapsed the three creation branches (coordinator_selects,
        // explicit not_required, and the silent-omission bypass) down to the
        // one safe coordinator_selects path, so there is now exactly one
        // .create() call site to check instead of three.
        const src = read('app', 'api', 'campaigns', 'route.ts');
        expect(src.includes('bundleGoal ? Number(bundleGoal)')).toBe(false);
        expect((src.match(/bundle_goal: resolvedBundleGoal/g) || []).length).toBe(1);
    });

    it('campaign creation actually refuses an invalid bundle goal instead of silently accepting it', () => {
        const src = read('app', 'api', 'campaigns', 'route.ts');
        expect(src).toMatch(/if \(!bundleGoalParsed\.ok\)\s*\{\s*return NextResponse\.json\(\{ error: bundleGoalParsed\.error \}, \{ status: 400 \}\);\s*\}/);
    });

    it('the campaign PATCH route never writes bundle_goal unconditionally', () => {
        const src = read('app', 'api', 'campaigns', '[id]', 'route.ts');
        expect(src.includes('bundle_goal: body.bundleGoal')).toBe(false);
        expect(src.includes('decideBundleGoalChange')).toBe(true);
    });

    it('the PATCH route actually persists the decided goal into the update data object', () => {
        const src = read('app', 'api', 'campaigns', '[id]', 'route.ts');
        expect(src.includes('...(bundleGoalValue !== undefined')).toBe(true);
        expect(src).toMatch(/\{\s*bundle_goal:\s*bundleGoalValue\s*\}/);
    });

    it('the opportunity-launch funnel writes an explicit goal rather than relying on an implicit DB default', () => {
        const src = read('app', 'api', 'opportunities', '[id]', 'launch', 'route.ts');
        expect(src.includes('bundle_goal: DEFAULT_BUNDLE_GOAL')).toBe(true);
    });

    it('no fixed display surface still contains a literal 100-bundle fallback', () => {
        const files = [
            ['components', 'crm', 'FundraisersTab.tsx'],
            ['components', 'crm', 'FundraiserOverview.tsx'],
            ['components', 'crm', 'CustomerOverview.tsx'],
            ['components', 'marketing', 'MarketingAssetGenerator.tsx'],
            ['app', 'coordinator', 'portal', 'guide', 'page.tsx'],
            ['app', 'api', 'coordinator', 'generate', 'route.ts'],
        ];
        for (const parts of files) {
            const src = read(...parts);
            expect(src).not.toMatch(/\|\|\s*['"]?100['"]?/);
        }
    });
});

describe('9. the DB-level default is defense-in-depth only, matching the JS constant', () => {
    it('schema.prisma carries the same default value as DEFAULT_BUNDLE_GOAL', () => {
        const fs = require('fs');
        const path = require('path');
        const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
        expect(schema.includes(`bundle_goal           Int?       @default(${DEFAULT_BUNDLE_GOAL})`)).toBe(true);
    });
});
