/**
 * CRM-ARCHIVED-VIEW-1 — a dedicated "Archived" filter/view on the Campaigns
 * dashboard, so an owner has somewhere obvious to find fundraisers that
 * CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1 already correctly hides from every
 * operational bucket. Discoverability only -- no archive semantics, no new
 * archive predicate, no schema, no finance.
 *
 * REUSE, NOT REINVENTION: membership in the new view is decided by the exact
 * same lib/growth/nextAction.ts::isArchivedForDashboard the predecessor phase
 * already uses to EXCLUDE these campaigns from operational grouping. There is
 * only one definition of "archived" in this codebase; this phase adds a
 * second READER of it, never a second AUTHORITY.
 *
 * WHY A SEPARATE COMPONENT, NOT A NEW CampaignPriorityList BRANCH: passing
 * archived campaigns into CampaignPriorityList would not work at all --
 * groupCampaignsByPriority calls triageCampaign on every row, which returns
 * priority: null for anything isArchivedForDashboard() is true for, so the
 * SAME campaigns that matched the new pill would immediately be filtered
 * back OUT by the very grouping logic that already exists to hide them. The
 * Archived view is therefore its own small, read-only presentational
 * component (components/crm2/ArchivedCampaignList.tsx) that never calls
 * triageCampaign/groupCampaignsByPriority at all -- proven directly below,
 * not assumed.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const NOW = new Date('2026-08-30T12:00:00.000Z');

const statusArchived = (over: Record<string, any> = {}) => ({
    id: 'a1', name: 'Edgar County Fall Sale', status: 'Archived',
    customer_id: 'c1', customer: { name: 'Edgar County' },
    end_date: '2025-11-01', settlement_total: 2065, sales_total: 2065,
    weighted_bundles_sold: 40, organization_archived: false,
    ...over,
});

const orgArchived = (over: Record<string, any> = {}) => ({
    id: 'a2', name: 'Spring Drive', status: 'Active',
    customer_id: 'c2', customer: { name: 'Old Mill PTO' },
    end_date: '2025-04-01', settlement_total: null, sales_total: 800,
    weighted_bundles_sold: 12, organization_archived: true,
    ...over,
});

const closedNotArchived = (over: Record<string, any> = {}) => ({
    id: 'c1', name: 'Coles County Farm Bureau', status: 'Closed',
    customer_id: 'c3', customer: { name: 'Coles County Farm Bureau' },
    end_date: '2026-07-01', settlement_total: 500, sales_total: 500,
    weighted_bundles_sold: 10, organization_archived: false,
    ...over,
});

const activeCampaign = (over: Record<string, any> = {}) => ({
    id: 'ac1', name: 'Live Fundraiser', status: 'Active',
    customer_id: 'c4', customer: { name: 'Live Org' },
    end_date: '2026-09-01', settlement_total: null, sales_total: 100,
    weighted_bundles_sold: 3, organization_archived: false,
    ...over,
});

// ═════════════════════════════════════════════════════════════════════════════
// PART C — before-fix proof: archived campaigns exist, operational grouping
// correctly excludes them, and (before this phase) nothing shows them
// anywhere on the dashboard.
// ═════════════════════════════════════════════════════════════════════════════
describe('before-fix: the discoverability gap', () => {
    it('1. archived campaigns exist and are recognized by the authoritative predicate', () => {
        const { isArchivedForDashboard } = require('@/lib/growth/nextAction');
        expect(isArchivedForDashboard(statusArchived())).toBe(true);
        expect(isArchivedForDashboard(orgArchived())).toBe(true);
    });

    it('2. operational grouping correctly excludes both archived shapes (unchanged, reconfirmed)', () => {
        const { groupCampaignsByPriority } = require('@/lib/growth/campaignSections');
        const sections = groupCampaignsByPriority([statusArchived(), orgArchived(), closedNotArchived()], NOW);
        const ids = sections.flatMap((s: any) => s.campaigns.map((c: any) => c.id));
        expect(ids).not.toContain('a1');
        expect(ids).not.toContain('a2');
        expect(ids).toContain('c1');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART E/K — membership: the SAME predicate, both signals, no disagreement
// with operational exclusion possible because it is the same function call.
// ═════════════════════════════════════════════════════════════════════════════
describe('filterArchivedCampaigns: the Archived view membership', () => {
    const { filterArchivedCampaigns } = require('@/components/crm2/ArchivedCampaignList');

    it('3. a campaign-status-archived fundraiser appears', () => {
        const result = filterArchivedCampaigns([statusArchived()], '');
        expect(result.map((c: any) => c.id)).toEqual(['a1']);
    });

    it('4. an organization-archived fundraiser appears (status still Active)', () => {
        const result = filterArchivedCampaigns([orgArchived()], '');
        expect(result.map((c: any) => c.id)).toEqual(['a2']);
    });

    it('5. a non-archived Closed campaign does NOT appear', () => {
        const result = filterArchivedCampaigns([closedNotArchived()], '');
        expect(result).toEqual([]);
    });

    it('6. an Active campaign does NOT appear', () => {
        const result = filterArchivedCampaigns([activeCampaign()], '');
        expect(result).toEqual([]);
    });

    it('search narrows the archived set by campaign or organization name, same as every other pill', () => {
        const all = [statusArchived(), orgArchived()];
        expect(filterArchivedCampaigns(all, 'edgar').map((c: any) => c.id)).toEqual(['a1']);
        expect(filterArchivedCampaigns(all, 'old mill').map((c: any) => c.id)).toEqual(['a2']);
        expect(filterArchivedCampaigns(all, 'nonexistent-org')).toEqual([]);
    });

    it('13. zero archived campaigns produces an empty array cleanly, not an error', () => {
        expect(filterArchivedCampaigns([closedNotArchived(), activeCampaign()], '')).toEqual([]);
    });

    it('reuses isArchivedForDashboard directly rather than a second archive definition', () => {
        const src = read('components/crm2/ArchivedCampaignList.tsx');
        expect(src).toMatch(/import\s*\{[^}]*isArchivedForDashboard[^}]*\}\s*from\s*['"]@\/lib\/growth\/nextAction['"]/);
        // filterArchivedCampaigns (membership) must call the shared predicate,
        // not re-derive archived-ness itself. archivedReasonLabel's OWN
        // status === 'Archived' check is a separate, legitimate thing — which
        // of the two real signals to LABEL, never a membership gate — so this
        // is scoped to filterArchivedCampaigns's own body, not the whole file.
        const fnBody = src.match(/export function filterArchivedCampaigns[\s\S]*?\n\}/)?.[0] ?? '';
        expect(fnBody).toMatch(/isArchivedForDashboard\(c\)/);
        expect(fnBody).not.toMatch(/status\s*===\s*['"]Archived['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F — archived card content and forbidden operational CTAs.
// ═════════════════════════════════════════════════════════════════════════════
describe('archivedReasonLabel and the card itself', () => {
    const { archivedReasonLabel } = require('@/components/crm2/ArchivedCampaignList');

    it('a campaign whose own status is Archived is labeled "Archived fundraiser"', () => {
        expect(archivedReasonLabel(statusArchived())).toBe('Archived fundraiser');
    });

    it('a campaign archived only via its organization is labeled "Organization archived"', () => {
        expect(archivedReasonLabel(orgArchived())).toBe('Organization archived');
    });

    it('the card never offers an operational call to action', () => {
        const src = read('components/crm2/ArchivedCampaignList.tsx');
        expect(src).not.toMatch(/Create invoice/);
        expect(src).not.toMatch(/Close out fundraiser/);
        expect(src).not.toMatch(/Needs attention/);
        expect(src).not.toMatch(/Open for orders/);
        // 11/G: still navigable to the existing organization/history surface.
        expect(src).toMatch(/href=\{`\/fundraisers\/\$\{c\.customer_id\}`\}/);
    });

    it('12/M: renders a plain empty state, not an error or operational prompt', () => {
        const src = read('components/crm2/ArchivedCampaignList.tsx');
        expect(src).toMatch(/No archived fundraisers\./);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — the pill row: Archived exists, sits at the far right, and its
// selection replaces (does not sit alongside) the operational sections.
// ═════════════════════════════════════════════════════════════════════════════
describe('the Archived pill and its render branch on the Campaigns dashboard', () => {
    const src = () => read('app/fundraisers/page.tsx');

    it('1/2. Archived is a pill option, positioned last (far right) after closed', () => {
        const code = src();
        const match = code.match(/\(\[('all'[\s\S]{0,120})\] as const\)\.map\(status/);
        expect(match).not.toBeNull();
        const order = match![1].split(',').map((s) => s.trim().replace(/'/g, ''));
        expect(order[order.length - 1]).toBe('archived');
        expect(order.indexOf('archived')).toBeGreaterThan(order.indexOf('closed'));
    });

    it('the pill label reads "Archived"', () => {
        expect(src()).toMatch(/archived:\s*['"]Archived['"]/);
    });

    it('selecting Archived renders ArchivedCampaignList INSTEAD of CampaignPriorityList, not alongside it', () => {
        const code = src();
        expect(code).toMatch(/filterStatus === ['"]archived['"][\s\S]{0,200}<ArchivedCampaignList/);
        expect(code).toMatch(/import\s*\{[^}]*ArchivedCampaignList[^}]*\}\s*from\s*['"]@\/components\/crm2\/ArchivedCampaignList['"]/);
    });

    it('7. no count badge was invented -- no existing pill shows one either, reconfirmed from source', () => {
        const code = src();
        const pillLabelsLine = code.match(/\{\{\s*all:\s*'All'[\s\S]{0,300}\}\[status\]\}/);
        expect(pillLabelsLine).not.toBeNull();
        // Plain label strings only -- no `${count}` interpolation on any pill.
        expect(pillLabelsLine![0]).not.toMatch(/\$\{/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART H — the individual-archive-action -> Archived-view sequence.
// ═════════════════════════════════════════════════════════════════════════════
describe('the archive-then-discover sequence', () => {
    it('a campaign the individual Archive action just set to Archived is picked up by the SAME predicate the view uses', () => {
        const { isArchivedForDashboard } = require('@/lib/growth/nextAction');
        const { filterArchivedCampaigns } = require('@/components/crm2/ArchivedCampaignList');
        // Exactly what app/api/campaigns/[id]/route.ts writes: only status changes.
        const justArchived = { ...closedNotArchived(), status: 'Archived' };
        expect(isArchivedForDashboard(justArchived)).toBe(true);
        expect(filterArchivedCampaigns([justArchived], '').map((c: any) => c.id)).toEqual(['c1']);
    });

    it('handleArchiveCampaign patches local state the same way it already did before this phase (no forced navigation into Archived)', () => {
        const src = read('app/fundraisers/page.tsx');
        expect(src).toMatch(/setFundraisers\(prev\s*=>\s*prev\.map\(x\s*=>\s*\(x\.id\s*===\s*f\.id[\s\S]{0,40}status:\s*['"]Archived['"]/);
        // Not forcing setFilterStatus('archived') as a side effect of archiving.
        expect(src).not.toMatch(/handleArchiveCampaign[\s\S]{0,600}setFilterStatus\(['"]archived['"]\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART I — no restore/unarchive invented this phase.
// ═════════════════════════════════════════════════════════════════════════════
describe('no restore/unarchive UI was added', () => {
    it('ArchivedCampaignList contains no restore/unarchive action', () => {
        const src = read('components/crm2/ArchivedCampaignList.tsx');
        expect(src).not.toMatch(/[Rr]estore/);
        expect(src).not.toMatch(/[Uu]narchive/);
    });
});
