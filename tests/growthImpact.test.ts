/**
 * GE-4 — organization lifetime impact.
 *
 * The dangerous failure here is not a crash, it is a plausible wrong number:
 * two groups silently merged into one lifetime total, a settled campaign counted
 * twice (once frozen, once from its orders), a cancelled order inflating a
 * group's worth, or gross sales presented as money the group kept. Every one of
 * those is pinned below.
 *
 * The metric split this file guards:
 *   lifetimeFundraiserSales — eligible gross to date, OPEN campaigns included
 *   settledSales            — only what closeout has frozen
 */

import {
    computeOrganizationImpact,
    sortOrganizationImpacts,
    isRealCampaign,
    hasCountableValue,
    isActiveCampaign,
    isEligibleOrder,
    computeCampaignGross,
    campaignLifetimeContribution,
    type ImpactCampaignInput,
    type ImpactOrganizationInput,
} from '@/lib/growth/impact';
import { ESTIMATED_FUNDRAISER_ORG_SHARE } from '@/lib/fundraiserMetrics';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** An eligible (non-cancelled) order. */
const order = (amount: number) => ({ total_amount: amount, canceled_at: null });
/** A cancelled order — present in the data, excluded from every total. */
const cancelled = (amount: number) => ({ total_amount: amount, canceled_at: daysAgo(1) });

const campaign = (over: Partial<ImpactCampaignInput> & { id: string }): ImpactCampaignInput => ({
    status: 'Closed',
    closed_at: daysAgo(10),
    created_at: daysAgo(40),
    settlement_total: 1000,
    orders: [],
    ...over,
});

/** A campaign still running, carrying live orders and no frozen settlement. */
const openCampaign = (over: Partial<ImpactCampaignInput> & { id: string }): ImpactCampaignInput =>
    campaign({ status: 'Active', closed_at: null, settlement_total: null, ...over });

const org = (campaigns: ImpactCampaignInput[], id = 'org-a', name = 'Alpha'): ImpactOrganizationInput => ({
    organizationId: id, organizationName: name, campaigns,
});

const run = (campaigns: ImpactCampaignInput[]) => computeOrganizationImpact(org(campaigns), NOW);

describe('1. an organization with no history', () => {
    it('reports zeros and nulls rather than fabricating a value', () => {
        const r = run([]);
        expect(r.campaignCount).toBe(0);
        expect(r.lifetimeFundraiserSales).toBe(0);
        expect(r.settledSales).toBe(0);
        expect(r.estimatedGroupEarnings).toBe(0);
        expect(r.averageCampaignSales).toBeNull();
        expect(r.bestCampaignSales).toBeNull();
        expect(r.firstCampaignAt).toBeNull();
        expect(r.lastCampaignAt).toBeNull();
        expect(r.daysSinceLastCampaign).toBeNull();
        expect(r.isRepeatOrganization).toBe(false);
    });

    it('a Lead placeholder is not a campaign — it never happened', () => {
        const r = run([campaign({ id: 'c1', status: 'Lead', settlement_total: null, closed_at: null })]);
        expect(r.campaignCount).toBe(0);
        expect(r.lifetimeFundraiserSales).toBe(0);
        expect(r.isRepeatOrganization).toBe(false);
    });

    it('a Lead placeholder carrying stray orders still contributes nothing', () => {
        const r = run([campaign({
            id: 'c1', status: 'Lead', settlement_total: null, closed_at: null,
            orders: [order(9999)],
        })]);
        expect(r.campaignCount).toBe(0);
        expect(r.lifetimeFundraiserSales).toBe(0);
    });
});

describe('2. THE CORRECTION — an open campaign with real orders is not worth $0', () => {
    const alpha = () => run([openCampaign({ id: 'live', created_at: daysAgo(5), orders: [order(300), order(200)] })]);

    it('counts eligible orders on a running campaign toward lifetime sales', () => {
        expect(alpha().lifetimeFundraiserSales).toBe(500);
    });

    it('contributes NOTHING to settled sales until closeout freezes it', () => {
        const r = alpha();
        expect(r.settledSales).toBe(0);
        expect(r.settledCampaignCount).toBe(0);
        expect(r.activeCampaignCount).toBe(1);
    });

    it('estimated group earnings follow the lifetime figure, not the settled one', () => {
        expect(alpha().estimatedGroupEarnings).toBeCloseTo(500 * ESTIMATED_FUNDRAISER_ORG_SHARE, 6);
    });

    it('regression: the whole organization surface is no longer $0 while sales exist', () => {
        // This is the exact Production shape that made the settled-only revision
        // useless: real money on campaigns nobody had closed yet.
        const r = run([
            openCampaign({ id: 'a', orders: [order(680)] }),
            openCampaign({ id: 'b', orders: [order(4785)] }),
        ]);
        expect(r.settledSales).toBe(0);
        expect(r.lifetimeFundraiserSales).toBe(5465);
    });
});

describe('3. no double-counting across the closeout boundary', () => {
    it('a settled campaign reports its frozen figure, not frozen PLUS its orders', () => {
        const r = run([campaign({ id: 'c1', settlement_total: 1000, orders: [order(1000)] })]);
        expect(r.lifetimeFundraiserSales).toBe(1000);
        expect(r.settledSales).toBe(1000);
    });

    it('the frozen settlement wins even when the orders disagree with it', () => {
        // An order edited after closeout must not retroactively rewrite history.
        const r = run([campaign({ id: 'c1', settlement_total: 1000, orders: [order(4000)] })]);
        expect(r.lifetimeFundraiserSales).toBe(1000);
        expect(campaignLifetimeContribution(campaign({ id: 'c1', settlement_total: 1000, orders: [order(4000)] }))).toBe(1000);
    });

    it('closing a campaign does not change the lifetime total — it only settles it', () => {
        const orders = [order(300), order(200)];
        const before = run([openCampaign({ id: 'x', orders })]);
        // Closeout freezes exactly the same eligible sum.
        const after = run([campaign({ id: 'x', settlement_total: 500, orders })]);
        expect(before.lifetimeFundraiserSales).toBe(500);
        expect(after.lifetimeFundraiserSales).toBe(500);
        expect(before.settledSales).toBe(0);
        expect(after.settledSales).toBe(500);
    });
});

describe('4. cancelled orders are excluded by the authoritative rule', () => {
    it('excludes cancelled orders from a running campaign', () => {
        const r = run([openCampaign({ id: 'live', orders: [order(1000), cancelled(125)] })]);
        expect(r.lifetimeFundraiserSales).toBe(1000);
    });

    it('isEligibleOrder keys on canceled_at, never on status', () => {
        expect(isEligibleOrder(order(10))).toBe(true);
        expect(isEligibleOrder(cancelled(10))).toBe(false);
        expect(isEligibleOrder({ total_amount: 0, canceled_at: null })).toBe(true);
    });

    it('rejects non-finite or negative order amounts rather than trusting them', () => {
        expect(isEligibleOrder({ total_amount: Number.NaN, canceled_at: null })).toBe(false);
        expect(isEligibleOrder({ total_amount: -50, canceled_at: null })).toBe(false);
        expect(computeCampaignGross(openCampaign({ id: 'x', orders: [order(100), { total_amount: -50, canceled_at: null }] }))).toBe(100);
    });

    it('tolerates decimal amounts arriving as strings from Prisma', () => {
        expect(computeCampaignGross(openCampaign({ id: 'x', orders: [{ total_amount: '125.50', canceled_at: null }] }))).toBe(125.5);
    });

    it('a campaign with only cancelled orders is worth nothing but still counts', () => {
        const r = run([openCampaign({ id: 'x', orders: [cancelled(500)] })]);
        expect(r.campaignCount).toBe(1);
        expect(r.lifetimeFundraiserSales).toBe(0);
    });
});

describe('5. mixed active + settled campaigns aggregate correctly', () => {
    const mixed = () => run([
        campaign({ id: 's1', settlement_total: 1000, created_at: daysAgo(400) }),
        campaign({ id: 's2', settlement_total: 3000, created_at: daysAgo(200) }),
        openCampaign({ id: 'live', created_at: daysAgo(10), orders: [order(750), cancelled(250)] }),
    ]);

    it('lifetime is settled frozen value PLUS eligible live orders', () => {
        expect(mixed().lifetimeFundraiserSales).toBe(4750);
    });

    it('settled sales remain the frozen subset only', () => {
        expect(mixed().settledSales).toBe(4000);
    });

    it('counts split into total, settled and active', () => {
        const r = mixed();
        expect(r.campaignCount).toBe(3);
        expect(r.settledCampaignCount).toBe(2);
        expect(r.activeCampaignCount).toBe(1);
    });

    it('average is over every real campaign, and best sees the live campaign too', () => {
        const r = mixed();
        expect(r.averageCampaignSales).toBeCloseTo(4750 / 3, 6);
        expect(r.bestCampaignSales).toBe(3000);
    });

    it('a live campaign can be the best one a group has ever run', () => {
        const r = run([
            campaign({ id: 's1', settlement_total: 1000 }),
            openCampaign({ id: 'live', orders: [order(5000)] }),
        ]);
        expect(r.bestCampaignSales).toBe(5000);
    });

    it('reports the true first and last campaign regardless of input order', () => {
        const r = mixed();
        expect(r.firstCampaignAt).toEqual(daysAgo(400));
        expect(r.lastCampaignAt).toEqual(daysAgo(10));
        expect(r.daysSinceLastCampaign).toBe(10);
    });
});

describe('6. money semantics — gross sales are never dressed up as proceeds', () => {
    it('lifetime sales is raw gross, untouched by any share', () => {
        expect(run([campaign({ id: 'c1', settlement_total: 5000 })]).lifetimeFundraiserSales).toBe(5000);
    });

    it('estimated earnings derive from the SHARED constant, never a local copy', () => {
        const r = run([campaign({ id: 'c1', settlement_total: 5000 })]);
        expect(r.estimatedGroupEarnings).toBeCloseTo(5000 * ESTIMATED_FUNDRAISER_ORG_SHARE, 6);
        // If someone re-typed 0.2 here, changing the shared constant would break
        // this expectation rather than silently leaving two numbers in the app.
        expect(r.estimatedGroupEarnings).not.toBe(r.lifetimeFundraiserSales);
    });

    it('the estimate is strictly smaller than gross, so the two can never be confused', () => {
        const r = run([campaign({ id: 'c1', settlement_total: 5000 })]);
        expect(r.estimatedGroupEarnings).toBeLessThan(r.lifetimeFundraiserSales);
    });
});

describe('7. identity — organizations must never be merged', () => {
    it('two organizations aggregate independently even with identical data', () => {
        // Alpha and Beta could share a coordinator or a shared inbox in the real
        // schema; impact is keyed on organization id, so they cannot merge.
        const alpha = computeOrganizationImpact(org([campaign({ id: 'a1', settlement_total: 1000 })], 'org-a', 'Alpha'), NOW);
        const beta = computeOrganizationImpact(org([campaign({ id: 'b1', settlement_total: 4000 })], 'org-b', 'Beta'), NOW);
        expect(alpha.lifetimeFundraiserSales).toBe(1000);
        expect(beta.lifetimeFundraiserSales).toBe(4000);
        expect(alpha.organizationId).not.toBe(beta.organizationId);
    });

    it('identically named organizations remain distinct records', () => {
        const a = computeOrganizationImpact(org([campaign({ id: 'a1', settlement_total: 100 })], 'tenant-a-org', 'Booster Club'), NOW);
        const b = computeOrganizationImpact(org([campaign({ id: 'b1', settlement_total: 900 })], 'tenant-b-org', 'Booster Club'), NOW);
        expect(a.organizationId).not.toBe(b.organizationId);
        expect(a.lifetimeFundraiserSales).toBe(100);
        expect(b.lifetimeFundraiserSales).toBe(900);
    });
});

describe('8. the inclusion rules are one shared definition', () => {
    it('isRealCampaign excludes only Lead placeholders', () => {
        expect(isRealCampaign({ status: 'Lead' })).toBe(false);
        for (const s of ['Active', 'Closed', 'Settled', 'Completed', 'Archived', 'Production']) {
            expect(isRealCampaign({ status: s })).toBe(true);
        }
    });

    it('hasCountableValue keys on the frozen settlement, not on status', () => {
        expect(hasCountableValue({ settlement_total: 0 })).toBe(true);
        expect(hasCountableValue({ settlement_total: 10 })).toBe(true);
        expect(hasCountableValue({ settlement_total: null })).toBe(false);
        expect(hasCountableValue({ settlement_total: Number.NaN })).toBe(false);
        expect(hasCountableValue({ settlement_total: -5 })).toBe(false);
    });

    it('isActiveCampaign requires Active AND not closed', () => {
        expect(isActiveCampaign({ status: 'Active', closed_at: null })).toBe(true);
        expect(isActiveCampaign({ status: 'Active', closed_at: NOW })).toBe(false);
        expect(isActiveCampaign({ status: 'Closed', closed_at: null })).toBe(false);
    });

    it('a zero-dollar settled campaign is still settled history', () => {
        const r = run([campaign({ id: 'c1', settlement_total: 0 })]);
        expect(r.settledCampaignCount).toBe(1);
        expect(r.lifetimeFundraiserSales).toBe(0);
        expect(r.settledSales).toBe(0);
    });

    it('an unsettled campaign in any status contributes only its eligible orders', () => {
        for (const status of ['Active', 'Closed', 'Archived', 'Production']) {
            const r = run([campaign({ id: 'x', status, settlement_total: null, orders: [order(200)] })]);
            expect(r.settledSales).toBe(0);
            expect(r.lifetimeFundraiserSales).toBe(200);
        }
    });
});

describe('9. ranking is factual only', () => {
    const rows = [
        // 'a' would LOSE under a settled-only sort (it has none) but wins on real sales.
        computeOrganizationImpact(org([openCampaign({ id: 'a', created_at: daysAgo(5), orders: [order(5000)] })], 'a', 'Aaa'), NOW),
        computeOrganizationImpact(org([
            campaign({ id: 'b1', settlement_total: 900, created_at: daysAgo(100) }),
            campaign({ id: 'b2', settlement_total: 900, created_at: daysAgo(90) }),
        ], 'b', 'Bbb'), NOW),
        computeOrganizationImpact(org([], 'c', 'Ccc'), NOW),
    ];

    it('sorts by LIFETIME fundraiser sales, so an open campaign can rank first', () => {
        expect(sortOrganizationImpacts(rows, 'lifetime_sales').map(r => r.organizationId)).toEqual(['a', 'b', 'c']);
    });

    it('sorts by campaign count, most first', () => {
        expect(sortOrganizationImpacts(rows, 'campaign_count').map(r => r.organizationId)).toEqual(['b', 'a', 'c']);
    });

    it('sorts by recency, and organizations with no campaign sort LAST', () => {
        expect(sortOrganizationImpacts(rows, 'most_recent').map(r => r.organizationId)).toEqual(['a', 'b', 'c']);
    });

    it('does not mutate the caller’s array', () => {
        const before = rows.map(r => r.organizationId);
        sortOrganizationImpacts(rows, 'lifetime_sales');
        expect(rows.map(r => r.organizationId)).toEqual(before);
    });
});

describe('10. determinism and honesty', () => {
    it('is a pure function of its inputs and the injected now', () => {
        const input = org([campaign({ id: 'c1' })]);
        expect(computeOrganizationImpact(input, NOW)).toEqual(computeOrganizationImpact(input, NOW));
    });

    it('emits no score, no prediction, and no likelihood field', () => {
        const r = run([campaign({ id: 'c1' })]);
        for (const forbidden of ['score', 'likelihood', 'prediction', 'probability', 'forecast', 'rank']) {
            expect(r).not.toHaveProperty(forbidden);
        }
    });

    it('exposes no field whose money meaning is ambiguous', () => {
        // "lifetimeValue"/"amountRaised" cannot be read without opening the
        // implementation, so neither is allowed to exist.
        const r = run([campaign({ id: 'c1' })]);
        for (const banned of ['lifetimeValue', 'value', 'amountRaised', 'raised', 'profit', 'payout']) {
            expect(r).not.toHaveProperty(banned);
        }
        expect(r).toHaveProperty('lifetimeFundraiserSales');
        expect(r).toHaveProperty('settledSales');
        expect(r).toHaveProperty('estimatedGroupEarnings');
    });

    it('repeat status is a plain fact about campaign count', () => {
        expect(run([campaign({ id: 'c1' })]).isRepeatOrganization).toBe(false);
        expect(run([campaign({ id: 'c1' }), campaign({ id: 'c2' })]).isRepeatOrganization).toBe(true);
    });

    it('settled sales can never exceed lifetime sales', () => {
        const r = run([
            campaign({ id: 's', settlement_total: 2000 }),
            openCampaign({ id: 'l', orders: [order(50)] }),
        ]);
        expect(r.settledSales).toBeLessThanOrEqual(r.lifetimeFundraiserSales);
    });
});
