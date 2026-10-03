/**
 * DATA-CLEANUP-GUARDS-1A.1 — legacy paid history truthfulness.
 *
 * A PAID fundraiser invoice with no campaign link is real fundraiser history. After
 * DATA-CLEANUP-GUARDS-1 an organization whose only campaign was a false start ran no
 * fundraiser by CAMPAIGN rows — and the dashboard said "No fundraisers yet" although its
 * paid history is on file. These prove the wording is now truthful, that nothing is
 * manufactured from the invoice (no campaign, no count, no month, no sales), and that
 * the false-start rule and every other figure are exactly what they were.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    buildOrganizationDashboard,
    describeTimingPattern,
    isLegacyPaidFundraiserInvoice,
    LEGACY_HISTORY_NOTE,
    LEGACY_HISTORY_TIMING_LABEL,
    type DashboardCampaignInput,
    type DashboardLegacyInvoiceInput,
    type DashboardOrderInput,
    type OrganizationDashboardInput,
} from '@/lib/organizationDashboard';
import { loadOrganizationDashboardInput } from '@/lib/organizationDashboardData';
import { createPrismaMock } from './helpers/routeHarness';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
const D = (s: string) => new Date(s);
const NOW = D('2026-10-03T12:00:00Z');
const BIZ = 'biz-a';
const ORG = 'org-legacy';

/** A Production legacy settlement: PAID, no campaign, the organization's 20% share recorded. */
const legacyPaid = (over: Partial<DashboardLegacyInvoiceInput> = {}): DashboardLegacyInvoiceInput => ({
    id: 'inv-legacy', status: 'PAID', campaign_id: null, fundraiser_profit_percent: '20.00', fundraiser_profit_amount: '1000.00', ...over,
});

const camp = (over: Partial<DashboardCampaignInput>): DashboardCampaignInput => ({
    id: 'c', name: 'Fundraiser', status: 'Closed', closed_at: null, created_at: D('2026-03-01T00:00:00Z'),
    start_date: null, end_date: null, delivery_date: null, settlement_total: null, settled_externally: false,
    bundle_selection_status: 'selected', invoices: [], activeBundles: [], ...over,
});
/** The Production false-start shape: closed out at $0.00 before any order, a $0.00 draft, archived. */
const falseStart = (id = 'fs', over: Partial<DashboardCampaignInput> = {}) => camp({
    id, name: 'False start', status: 'Archived', closed_at: D('2026-09-10T15:00:00Z'), created_at: D('2026-08-30T00:00:00Z'),
    delivery_date: D('2026-09-09T00:00:00Z'), settlement_total: '0.00', bundle_selection_status: 'pending',
    invoices: [{ id: `inv-${id}`, status: 'DRAFT', total_amount: '0.00', paid_at: null, fundraiser_profit_amount: '0', items: [] }], ...over,
});
const order = (id: string, campaign: string, amount: number, canceled = false): DashboardOrderInput => ({
    id, campaign_id: campaign, total_amount: String(amount), canceled_at: canceled ? D('2026-09-01T00:00:00Z') : null,
    items: [{ quantity: 1, item_name: 'Comfort Classics', variant_size: 'serves_5', bundle_id: null }],
});

const dash = (campaigns: DashboardCampaignInput[], orders: DashboardOrderInput[] = [], legacyInvoices?: DashboardLegacyInvoiceInput[]) => {
    const input: OrganizationDashboardInput = {
        organization: { id: ORG, name: 'Maple County Farm Bureau', archived: false },
        timeZone: 'America/Chicago',
        campaigns, orders,
        audience: { businessId: BIZ, organizationCustomerId: ORG, priorCampaignIds: campaigns.map((c) => c.id), organizationCustomerIds: new Set([ORG]), orders: [], suppressedEmails: new Set() },
        openOpportunity: null,
        marketing: { seasonal: [], previousSupporters: [], rebookingResponses: [] },
        ...(legacyInvoices ? { legacyInvoices } : {}),
    };
    return buildOrganizationDashboard(input, NOW);
};

/** Every place the dashboard could say there has been no fundraiser. */
const claimsNoFundraisers = (d: ReturnType<typeof dash>) =>
    d.kpis.lifetimeSalesHelper === 'No fundraisers yet' || d.intelligence.timing.label === 'No fundraisers yet';

describe('GUARDS-1A.1 · isLegacyPaidFundraiserInvoice — the evidence', () => {
    it('a PAID, campaign-less invoice with the organization\'s share recorded is legacy fundraiser history', () => {
        expect(isLegacyPaidFundraiserInvoice(legacyPaid())).toBe(true);
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ fundraiser_profit_percent: null, fundraiser_profit_amount: '200.00' }))).toBe(true);
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ fundraiser_profit_percent: '20', fundraiser_profit_amount: null }))).toBe(true);
    });

    it.each(['DRAFT', 'CANCELED', 'SENT', 'PENDING', 'OVERDUE'])('a campaign-less %s invoice is NOT completed fundraiser history', (status) => {
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ status }))).toBe(false);
    });

    it('a PAID invoice with no organization share is not a fundraiser settlement (an org\'s own meal order)', () => {
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ fundraiser_profit_percent: '0', fundraiser_profit_amount: '0.00' }))).toBe(false);
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ fundraiser_profit_percent: null, fundraiser_profit_amount: null }))).toBe(false);
    });

    it('a campaign-linked invoice is its campaign\'s history, never legacy evidence', () => {
        expect(isLegacyPaidFundraiserInvoice(legacyPaid({ campaign_id: 'camp-1' }))).toBe(false);
        expect(isLegacyPaidFundraiserInvoice(null)).toBe(false);
    });
});

describe('GUARDS-1A.1 · the organization dashboard', () => {
    it('1. no real campaign and no legacy invoice → "No fundraisers yet", exactly as before', () => {
        const d = dash([]);
        expect(d.kpis).toMatchObject({ lifetimeSalesLabel: '—', lifetimeSalesHelper: 'No fundraisers yet', campaignsRun: 0, campaignsHelper: null });
        expect(d.intelligence.timing.label).toBe('No fundraisers yet');
        expect(d.intelligence.legacyHistoryNote).toBeNull();
        expect(d.legacyHistory).toBeNull();
    });

    it('2. a false start only, no legacy paid invoice → it is Not run, and "No fundraisers yet" stays true', () => {
        const d = dash([falseStart()]);
        expect(d.history).toHaveLength(1);
        expect(d.history[0].isSetupAttempt).toBe(true);
        expect(d.kpis.campaignsRun).toBe(0);
        expect(claimsNoFundraisers(d)).toBe(true);
        expect(d.legacyHistory).toBeNull();
    });

    it('3. a false start only + a campaign-less PAID legacy invoice → still Not run, but never "No fundraisers yet"', () => {
        const d = dash([falseStart()], [], [legacyPaid()]);
        // The false start is exactly what it was.
        expect(d.history.map((r) => [r.id, r.isSetupAttempt, r.metricsLabel])).toEqual([
            ['fs', true, 'Never ran — closed before any orders · not counted as a fundraiser'],
        ]);
        // Nothing claims there was no fundraiser...
        expect(claimsNoFundraisers(d)).toBe(false);
        expect(d.kpis.lifetimeSalesHelper).toBe('Legacy fundraiser history on file — not included in this total');
        expect(d.kpis.campaignsHelper).toBe('Historical paid fundraiser activity is also on file.');
        expect(d.intelligence.timing).toEqual({ label: LEGACY_HISTORY_TIMING_LABEL, muted: true, datedCount: 0 });
        expect(d.intelligence.legacyHistoryNote).toBe(LEGACY_HISTORY_NOTE);
        expect(d.legacyHistory).toEqual({ paidFundraiserInvoices: 1, note: LEGACY_HISTORY_NOTE });
        // ...and nothing is manufactured from the invoice: no campaign, no count, no money, no date, no month.
        expect(d.kpis.campaignsRun).toBe(0);
        expect(d.kpis.lifetimeSales).toBe(0);
        expect(d.kpis.lifetimeSalesLabel).toBe('—');
        expect(d.intelligence.lastFundraiser).toBeNull();
        expect(d.intelligence.timing.datedCount).toBe(0);
        expect(d.history).toHaveLength(1);
    });

    it('3b. no campaign row at all + a legacy paid invoice (a record with no campaign row at all) → no "No fundraisers yet"', () => {
        const d = dash([], [], [legacyPaid({ fundraiser_profit_amount: '200.00' })]);
        expect(claimsNoFundraisers(d)).toBe(false);
        expect(d.history).toHaveLength(0);
        expect(d.legacyHistory).toEqual({ paidFundraiserInvoices: 1, note: LEGACY_HISTORY_NOTE });
    });

    it('4. a real historical campaign + a legacy invoice → the normal campaign history is exactly as without it', () => {
        const real = camp({
            id: 'fall', name: 'Fall Fundraiser', status: 'Closed', closed_at: D('2026-10-01T15:00:00Z'), delivery_date: D('2026-10-14T00:00:00Z'),
            settlement_total: '1980.00', invoices: [{ id: 'inv-fall', status: 'PAID', total_amount: '1584.00', paid_at: D('2026-10-02T12:00:00Z'), fundraiser_profit_amount: '396.00', items: [] }],
        });
        const without = dash([real], [order('o1', 'fall', 1980)]);
        const withLegacy = dash([real], [order('o1', 'fall', 1980)], [legacyPaid()]);
        expect(withLegacy.kpis).toEqual(without.kpis);
        expect(withLegacy.history).toEqual(without.history);
        expect(withLegacy.intelligence).toEqual(without.intelligence);
        expect(withLegacy.current).toEqual(without.current);
        expect(withLegacy.intelligence.lastFundraiser?.campaignId).toBe('fall');
        expect(withLegacy.legacyHistory).toEqual({ paidFundraiserInvoices: 1, note: LEGACY_HISTORY_NOTE }); // a fact, unused by the words here
    });

    it('5–7. campaign-less DRAFT, CANCELED, SENT, PENDING, OVERDUE — and a PAID one with no share — are not history', () => {
        for (const inv of [
            legacyPaid({ status: 'DRAFT' }), legacyPaid({ status: 'CANCELED' }), legacyPaid({ status: 'SENT' }),
            legacyPaid({ status: 'PENDING' }), legacyPaid({ status: 'OVERDUE' }),
            legacyPaid({ fundraiser_profit_percent: '0', fundraiser_profit_amount: '0' }),
        ]) {
            const d = dash([falseStart()], [], [inv]);
            expect([inv.status, claimsNoFundraisers(d), d.legacyHistory]).toEqual([inv.status, true, null]);
        }
    });

    it('a running fundraiser + a legacy paid invoice: counts and timing unchanged; the empty "Last fundraiser" row names the legacy record', () => {
        const live = camp({ id: 'live', name: 'Live Fundraiser', status: 'Active', created_at: D('2026-09-11T00:00:00Z'), delivery_date: D('2026-10-27T00:00:00Z') });
        const without = dash([falseStart(), live], [order('l1', 'live', 1410)]);
        const withLegacy = dash([falseStart(), live], [order('l1', 'live', 1410)], [legacyPaid()]);
        expect(withLegacy.kpis).toEqual(without.kpis);
        expect(withLegacy.intelligence.timing).toEqual(without.intelligence.timing);
        expect(withLegacy.history).toEqual(without.history);
        expect(without.intelligence.legacyHistoryNote).toBeNull();
        expect(withLegacy.intelligence.lastFundraiser).toBeNull();
        expect(withLegacy.intelligence.legacyHistoryNote).toBe(LEGACY_HISTORY_NOTE);
    });

    it('describeTimingPattern keeps every existing answer; the legacy flag only replaces the zero-fundraiser one', () => {
        expect(describeTimingPattern([], 0).label).toBe('No fundraisers yet');
        expect(describeTimingPattern([], 0, true).label).toBe(LEGACY_HISTORY_TIMING_LABEL);
        expect(describeTimingPattern([], 2, true).label).toBe('No fundraiser dates recorded');
        expect(describeTimingPattern([D('2026-10-14T00:00:00Z')], 1, true).label).toBe('Not enough history (1 fundraiser)');
    });
});

describe('GUARDS-1A.1 · 8–10. the false-start rule and every live classification are untouched', () => {
    it('8. Production shapes: the empty shells and the five $0.00 false starts all stay Not run', () => {
        // An organization whose only campaign was a false start, holding its legacy paid settlement.
        const falseStartWithLegacy = dash([falseStart('org1-fs')], [], [legacyPaid()]);
        // A duplicate record holding three closed $0.00 shells, no invoice and no legacy settlement.
        const shells = ['s1', 's2', 's3'].map((id) => camp({ id, status: 'Closed', closed_at: D('2026-07-11T00:00:00Z'), settlement_total: '0.00', bundle_selection_status: 'not_required' }));
        const shellsOnly = dash(shells);
        // A false start beside a live fundraiser — without, and with, a legacy settlement on the record.
        const live = (id: string) => camp({ id, name: 'Live', status: 'Active', created_at: D('2026-09-11T00:00:00Z'), delivery_date: D('2026-10-27T00:00:00Z') });
        const liveA = dash([falseStart('a-fs'), live('a-live')], [order('a1', 'a-live', 245)]);
        const liveB = dash([falseStart('b-fs'), live('b-live')], [order('b1', 'b-live', 1410)], [legacyPaid({ fundraiser_profit_amount: '150.00' })]);
        const liveC = dash([falseStart('c-fs'), live('c-live')], [order('c1', 'c-live', 120)], [legacyPaid({ fundraiser_profit_amount: '160.00' })]);

        expect(falseStartWithLegacy.history.filter((r) => r.isSetupAttempt).map((r) => r.id)).toEqual(['org1-fs']);
        expect(shellsOnly.history.every((r) => r.isSetupAttempt)).toBe(true);
        expect(shellsOnly.kpis.campaignsRun).toBe(0);
        expect(claimsNoFundraisers(shellsOnly)).toBe(true); // no paid history on THAT record — still true there
        for (const d of [liveA, liveB, liveC]) {
            expect(d.history.filter((r) => r.isSetupAttempt)).toHaveLength(1);
            expect(d.kpis.campaignsRun).toBe(1);
        }
    });

    it('9–10. no lifecycle, setup-attempt or invoice rule changed: those files are byte-identical to the GUARDS-1 Preview (588c547)', () => {
        // The live and closed-awaiting-payment classifications are additionally re-checked against the real
        // Production shapes offline; here: nothing they depend on moved.
        const { execFileSync } = require('child_process');
        const at = (file: string) => execFileSync('git', ['show', `588c547713552c311f5fe17b4e2e7cd91494f089:${file}`],
            { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).replace(/\r\n/g, '\n');
        for (const file of ['lib/growth/impact.ts', 'lib/growth/campaignLifecycle.ts', 'lib/growth/nextAction.ts', 'lib/invoiceRemoval.ts',
            'app/api/campaigns/[id]/closeout/route.ts', 'app/api/campaigns/route.ts', 'lib/fundraiserWizardSubmit.ts']) {
            expect([file, read(file) === at(file)]).toEqual([file, true]);
        }
    });
});

describe('GUARDS-1A.1 · the loader and the page', () => {
    it('reads only this organization\'s PAID campaign-less invoices, tenant-scoped, on the existing organization query', async () => {
        const mock = createPrismaMock({
            results: {
                'customer.findFirst': (args: any) => (args?.where?.business_id === BIZ && args?.where?.id === ORG
                    ? { id: ORG, name: 'Maple County Farm Bureau', archived: false, invoices: [{ id: 'inv-legacy', status: 'PAID', campaign_id: null, fundraiser_profit_percent: '20.00', fundraiser_profit_amount: '1000.00' }] }
                    : null),
            },
        });
        const loaded = await loadOrganizationDashboardInput(mock.client, { businessId: BIZ, organizationId: ORG, now: NOW });
        const select = mock.firstCall('customer.findFirst')!.args.select;
        expect(select.invoices.where).toEqual({ business_id: BIZ, campaign_id: null, status: 'PAID' });
        expect(loaded.ok && loaded.input.legacyInvoices).toEqual([
            { id: 'inv-legacy', status: 'PAID', campaign_id: null, fundraiser_profit_percent: '20.00', fundraiser_profit_amount: '1000.00' },
        ]);
        // Nothing about the organization itself changed shape.
        expect(loaded.ok && loaded.input.organization).toEqual({ id: ORG, name: 'Maple County Farm Bureau', archived: false });
    });

    it('an organization row without the relation (older doubles, or none loaded) means no legacy evidence', async () => {
        const mock = createPrismaMock({ results: { 'customer.findFirst': { id: ORG, name: 'x', archived: false } } });
        const loaded = await loadOrganizationDashboardInput(mock.client, { businessId: BIZ, organizationId: ORG, now: NOW });
        expect(loaded.ok && loaded.input.legacyInvoices).toEqual([]);
    });

    it('the history empty state and the Last-fundraiser row use the legacy wording only when it is on file', () => {
        const page = read('app/fundraisers/[id]/page.tsx');
        expect(page).toContain("{dashboard.legacyHistory ? 'No campaigns on record' : 'No fundraisers yet'}");
        const card = read('components/crm2/orgDashboard/RelationshipIntelligenceCard.tsx');
        expect(card).toContain('<Row label="Last fundraiser" value="Legacy record" muted sub={intelligence.legacyHistoryNote} />');
        expect(card).toContain('<Row label="Last fundraiser" value="None yet" muted />');
    });
});
