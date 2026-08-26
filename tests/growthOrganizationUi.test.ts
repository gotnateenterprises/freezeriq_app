/**
 * CRM-CC-3 — Organizations tab display logic + the lastCampaignName addition.
 *
 * Failure modes pinned: settled subtext promoted over lifetime, a "No name"
 * placeholder where silence belongs, a last-fundraiser display invented for a
 * group with no history, and the new name field influencing anything beyond
 * display.
 */

import { money, settledNote, sinceLabel, lastFundraiserDisplay } from '@/lib/growth/organizationUi';
import { computeOrganizationImpact, type ImpactCampaignInput } from '@/lib/growth/impact';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('1. money formatting', () => {
    it('whole-dollar, comma-grouped', () => {
        expect(money(0)).toBe('$0');
        expect(money(4405)).toBe('$4,405');
        expect(money(1234567.89)).toBe('$1,234,568');
    });
});

describe('2. settledNote stays subtext-truthful', () => {
    it('silent when there are no lifetime sales', () => {
        expect(settledNote({ lifetimeFundraiserSales: 0, settledSales: 0 })).toBeNull();
    });

    // FR-HISTORY-1: the FIGURE is unchanged — it still sums the settlement
    // totals closeout froze. Only the WORDS changed, because INV-D gave "settled"
    // a second meaning (money actually received, with a method and a date) and
    // the same word carrying both meanings on one screen is how an owner comes to
    // believe they have been paid when they have not. These now say "closed out",
    // which is the fact this number actually reports.
    it('"all closed out" when closeout froze everything', () => {
        expect(settledNote({ lifetimeFundraiserSales: 500, settledSales: 500 })).toBe('all closed out');
    });

    it('"none closed out yet" when campaigns are still open', () => {
        expect(settledNote({ lifetimeFundraiserSales: 500, settledSales: 0 })).toBe('none closed out yet');
    });

    it('partial closeout names the closed-out amount', () => {
        expect(settledNote({ lifetimeFundraiserSales: 500, settledSales: 200 })).toBe('$200 closed out');
    });

    it('never claims payment — the word "paid" belongs to the invoice', () => {
        for (const r of [
            { lifetimeFundraiserSales: 500, settledSales: 500 },
            { lifetimeFundraiserSales: 500, settledSales: 0 },
            { lifetimeFundraiserSales: 500, settledSales: 200 },
        ]) {
            expect(settledNote(r)).not.toMatch(/paid/i);
        }
    });
});

describe('3. sinceLabel', () => {
    it('handles the no-history case', () => {
        expect(sinceLabel(null)).toBe('No campaigns yet');
    });

    it('near-term day labels', () => {
        expect(sinceLabel(0)).toBe('Today');
        expect(sinceLabel(1)).toBe('Yesterday');
        expect(sinceLabel(45)).toBe('45 days ago');
    });

    it('months then years', () => {
        expect(sinceLabel(90)).toBe('3 months ago');
        expect(sinceLabel(800)).toBe('2 years ago');
    });
});

describe('4. lastFundraiserDisplay', () => {
    it('null for a group with no history — no invented placeholder', () => {
        expect(lastFundraiserDisplay({ lastCampaignName: null, daysSinceLastCampaign: null })).toBeNull();
    });

    it('name + when, when the name is known', () => {
        expect(lastFundraiserDisplay({ lastCampaignName: 'Fall 2025', daysSinceLastCampaign: 90 }))
            .toEqual({ name: 'Fall 2025', when: '3 months ago' });
    });

    it('degrades to when-only for a missing or blank name', () => {
        expect(lastFundraiserDisplay({ lastCampaignName: null, daysSinceLastCampaign: 10 }))
            .toEqual({ name: null, when: '10 days ago' });
        expect(lastFundraiserDisplay({ lastCampaignName: '   ', daysSinceLastCampaign: 10 })!.name).toBeNull();
    });
});

describe('5. impact.ts lastCampaignName derivation (CRM-CC-3 addition)', () => {
    const campaign = (over: Partial<ImpactCampaignInput>): ImpactCampaignInput => ({
        id: 'c1',
        status: 'Active',
        closed_at: null,
        created_at: daysAgo(10),
        settlement_total: null,
        orders: [],
        ...over,
    });

    it('takes the NAME of the newest real campaign', () => {
        const impact = computeOrganizationImpact({
            organizationId: 'o1',
            organizationName: 'Org',
            campaigns: [
                campaign({ id: 'old', name: 'Spring 2025', created_at: daysAgo(400) }),
                campaign({ id: 'new', name: 'Fall 2026', created_at: daysAgo(5) }),
            ],
        }, NOW);
        expect(impact.lastCampaignName).toBe('Fall 2026');
        expect(impact.lastCampaignAt).toEqual(daysAgo(5));
    });

    it('is null when callers supply no names (backward compatible)', () => {
        const impact = computeOrganizationImpact({
            organizationId: 'o1',
            organizationName: 'Org',
            campaigns: [campaign({})],
        }, NOW);
        expect(impact.lastCampaignName).toBeNull();
    });

    it('ignores Lead placeholders when picking the last campaign', () => {
        const impact = computeOrganizationImpact({
            organizationId: 'o1',
            organizationName: 'Org',
            campaigns: [
                campaign({ id: 'real', name: 'Fall 2025', created_at: daysAgo(100) }),
                campaign({ id: 'lead', name: 'Placeholder', status: 'Lead', created_at: daysAgo(1) }),
            ],
        }, NOW);
        expect(impact.lastCampaignName).toBe('Fall 2025');
    });

    it('never lets a name influence money figures', () => {
        const base = {
            organizationId: 'o1',
            organizationName: 'Org',
            campaigns: [campaign({ orders: [{ total_amount: 100, canceled_at: null }] })],
        };
        const withName = computeOrganizationImpact({
            ...base,
            campaigns: [campaign({ name: 'Named', orders: [{ total_amount: 100, canceled_at: null }] })],
        }, NOW);
        const without = computeOrganizationImpact(base, NOW);
        expect(withName.lifetimeFundraiserSales).toBe(without.lifetimeFundraiserSales);
        expect(withName.settledSales).toBe(without.settledSales);
        expect(withName.estimatedGroupEarnings).toBe(without.estimatedGroupEarnings);
    });
});
