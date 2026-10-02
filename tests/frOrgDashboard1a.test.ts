/**
 * FR-ORG-DASHBOARD-1A — the organization mini-dashboard.
 *
 * What this suite proves, in the owner's order:
 *   DASHBOARD   lifetime sales is computeOrganizationImpact's figure, history is
 *               complete (no five-campaign cap), canceled orders never count, and
 *               incomplete legacy history stays truthful.
 *   SUPPORTERS  distinct people, not orders; the Previous Supporters identity
 *               rule; organizations never counted; email-ready is the invitation
 *               audience's own reachable count, through ONE shared loader.
 *   CURRENT     an opportunity is never presented as a campaign.
 *   DISCARD     only an empty tenant-created draft can be hard-deleted, the delete
 *               re-asserts every fact, and mark_lost is untouched.
 *   HISTORY     frozen invoice lines win; today's catalog cannot rewrite history.
 *   MARKETING   only recorded activity; no opened/clicked state anywhere.
 *   REGRESSION  the legacy workflow is gone from the page; Start Next, Tax,
 *               Contact, Notes, QuickBooks and Documents remain.
 *
 * Route handlers run for real over the shared Prisma double, loaded lazily after
 * the module mocks exist (a static import would construct a real PrismaClient).
 */

import fs from 'fs';
import path from 'path';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    buildOrganizationDashboard,
    describeTimingPattern,
    buildMarketingEntries,
    type DashboardCampaignInput,
    type DashboardOrderInput,
    type OrganizationDashboardInput,
} from '@/lib/organizationDashboard';
import { computeOrganizationImpact } from '@/lib/growth/impact';
import { derivePreviousSupporters, type PreviousSupporterOrderInput } from '@/lib/previousSupporters';
import { evaluateDraftDiscard, draftDiscardWhere, type DraftDiscardOpportunity } from '@/lib/opportunityDraftDiscard';
import { loadPreviousSupporterAudience, loadPreviousSupporterAudienceInputs } from '@/lib/previousSupporterAudience';

// ── Module doubles, installed before any route module loads ─────────────────
jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__orgDashPrisma; },
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => (global as any).__orgDashSession),
}));
jest.mock('@/lib/coordinatorSession', () => ({
    requireCoordinatorSession: jest.fn(async () => (global as any).__orgDashCoordinator),
}));
jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn(async () => ({ id: 'x' })) } })),
}));
jest.mock('@/lib/email', () => ({
    getTenantSender: jest.fn(async () => ({ from: 'Tenant <t@example.com>', replyTo: undefined })),
}));

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const code = (p: string) => read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__orgDashPrisma = m.client; };
const useSession = (s: any) => { (global as any).__orgDashSession = s; };
const BIZ = 'biz-own';
const OTHER_BIZ = 'biz-other';
const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2027-10-01T12:00:00.000Z');
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock());
    useSession(null);
    (global as any).__orgDashCoordinator = { ok: false, response: new Response('{}', { status: 401 }) };
});

// ═══════════════════════════════════════════════════════════════════════════
// FIXTURE — one organization with a real-looking history
// ═══════════════════════════════════════════════════════════════════════════
const d = (s: string) => new Date(s);

function campaign(over: Partial<DashboardCampaignInput> & { id: string }): DashboardCampaignInput {
    return {
        name: over.id,
        status: 'Closed',
        closed_at: d('2026-10-20T15:00:00Z'),
        created_at: d('2026-08-01T00:00:00Z'),
        start_date: null,
        end_date: null,
        delivery_date: null,
        settlement_total: null,
        settled_externally: false,
        bundle_selection_status: 'selected',
        invoices: [],
        activeBundles: [],
        ...over,
    };
}

/** One order, written once, read as both the money/bundle row and the supporter row. */
interface FixtureOrder {
    id: string;
    campaign: string;
    amount: number;
    canceled?: boolean;
    email?: string | null;          // the supporter Customer's contact_email (individual orders)
    orderEmail?: string | null;     // Order.email (organization-linked, coordinator-entered orders)
    phone?: string | null;
    name?: string;
    orgLinked?: boolean;
    items?: { quantity: number; item_name: string; variant_size: string; bundle_id?: string }[];
}

const A = 'camp-a-fall-2026';
const B = 'camp-b-fall-2025';
const C = 'camp-c-fall-2024-legacy';
const D = 'camp-d-spring-2027-live';
const LEAD = 'camp-imported-lead';

const ORDERS: FixtureOrder[] = [
    // A — Pat orders twice (case-different email), Sam has a phone only, one canceled order.
    { id: 'a1', campaign: A, amount: 125, email: 'Pat@Example.com', name: 'Pat', items: [{ quantity: 1, item_name: 'Family Favorites', variant_size: 'serves_5' }] },
    { id: 'a2', campaign: A, amount: 125, email: 'pat@example.com', name: 'Pat', items: [{ quantity: 1, item_name: 'Family Favorites', variant_size: 'serves_5' }] },
    { id: 'a3', campaign: A, amount: 60, orgLinked: true, orderEmail: null, phone: '(217) 555-0101', name: 'Sam', items: [{ quantity: 1, item_name: 'Keto', variant_size: 'serves_2' }] },
    { id: 'a4', campaign: A, amount: 125, canceled: true, email: 'gone@example.com', name: 'Gone', items: [{ quantity: 9, item_name: 'Family Favorites', variant_size: 'serves_5' }] },
    // B — Pat again, Lee (opted out), Kim (coordinator-entered, Order.email), a blank order.
    { id: 'b1', campaign: B, amount: 125, email: 'PAT@example.COM', name: 'Pat' },
    { id: 'b2', campaign: B, amount: 125, email: 'lee@example.com', name: 'Lee' },
    { id: 'b3', campaign: B, amount: 60, orgLinked: true, orderEmail: 'kim@example.com', name: 'Kim' },
    { id: 'b4', campaign: B, amount: 60, orgLinked: true, orderEmail: null, phone: null, name: '' },
    // D — running now: one live order and one canceled order.
    { id: 'd1', campaign: D, amount: 100, email: 'new@example.com', name: 'New', items: [{ quantity: 1, item_name: 'Comfort Classics', variant_size: 'serves_5' }] },
    { id: 'd2', campaign: D, amount: 50, canceled: true, email: 'new2@example.com', name: 'Canceled', items: [{ quantity: 3, item_name: 'Comfort Classics', variant_size: 'serves_5' }] },
];

const ORG_CONTACT_EMAIL = 'coach@school.example';

const dashboardOrders = (orders: FixtureOrder[] = ORDERS): DashboardOrderInput[] => orders.map((o) => ({
    id: o.id,
    campaign_id: o.campaign,
    total_amount: String(o.amount),
    canceled_at: o.canceled ? d('2026-10-01T00:00:00Z') : null,
    items: (o.items ?? []).map((it) => ({
        quantity: it.quantity, item_name: it.item_name, variant_size: it.variant_size, bundle_id: it.bundle_id ?? null,
    })),
}));

const supporterOrders = (orders: FixtureOrder[] = ORDERS): PreviousSupporterOrderInput[] => orders.map((o) => ({
    id: o.id,
    campaign_id: o.campaign,
    canceled_at: o.canceled ? d('2026-10-01T00:00:00Z') : null,
    customer_id: o.orgLinked ? ORG : `cust-${o.id}`,
    customer_name: o.name ?? null,
    phone: o.phone ?? null,
    email: o.orgLinked ? o.orderEmail ?? null : null,
    customer: o.orgLinked
        ? { id: ORG, business_id: BIZ, contact_email: ORG_CONTACT_EMAIL, contact_phone: '2175550000', name: 'Maple Grove Youth Group' }
        : { id: `cust-${o.id}`, business_id: BIZ, contact_email: o.email ?? null, contact_phone: null, name: o.name ?? null },
}));

const FROZEN_A = [
    { bundle_id: 'b-ff5', description: 'Family Friendly - Fall 2026', variant_size: 'serves_5', quantity: '30', total: '3750' },
    { bundle_id: 'b-ff2', description: 'Family Friendly (Serves 2) - Fall 2026', variant_size: 'serves_2', quantity: '11', total: '660' },
    { bundle_id: 'b-k5', description: 'Keto - Fall 2026', variant_size: 'serves_5', quantity: '20', total: '1000' },
    { bundle_id: 'b-k2', description: 'Keto (Serves 2) - Fall 2026', variant_size: 'serves_2', quantity: '10', total: '345' },
];

const CAMPAIGNS: DashboardCampaignInput[] = [
    campaign({
        id: A, name: 'Fall 2026 Fundraiser', delivery_date: d('2026-10-14T00:00:00Z'), end_date: d('2026-10-01T00:00:00Z'),
        settlement_total: '5755.00',
        invoices: [{ id: 'inv-a', status: 'PAID', fundraiser_profit_amount: '1151.00', items: FROZEN_A }],
        // Today's assignment was rewritten after closeout — it must NOT be read for history.
        activeBundles: [{ name: 'Renamed After Closeout', serving_tier: 'serves_5' }],
    }),
    campaign({
        id: B, name: 'Fall 2025 Fundraiser', delivery_date: d('2025-10-16T00:00:00Z'), closed_at: d('2025-10-30T00:00:00Z'),
        settlement_total: '7240.00',
        invoices: [{
            id: 'inv-b', status: 'PAID', fundraiser_profit_amount: '1448.00',
            items: [{ bundle_id: null, description: 'Comfort Classics', variant_size: 'serves_5', quantity: '88', total: '7240' }],
        }],
    }),
    // Legacy: archived, never closed out, no settlement, no orders, no invoice.
    campaign({ id: C, name: 'Fall 2024 Fundraiser', status: 'Archived', closed_at: null, created_at: d('2024-09-01T00:00:00Z') }),
    campaign({
        id: D, name: 'Spring 2027 Fundraiser', status: 'Active', closed_at: null, bundle_selection_status: 'pending',
        delivery_date: d('2027-04-15T00:00:00Z'), end_date: d('2027-04-01T00:00:00Z'),
    }),
    // A CSV-imported Lead row: never a real campaign.
    campaign({ id: LEAD, name: 'Imported lead', status: 'Lead', closed_at: null }),
];

function world(over: Partial<OrganizationDashboardInput> = {}): OrganizationDashboardInput {
    return {
        organization: { id: ORG, name: 'Maple Grove Youth Group', archived: false },
        timeZone: 'America/Chicago',
        campaigns: CAMPAIGNS,
        orders: dashboardOrders(),
        audience: {
            businessId: BIZ,
            organizationCustomerId: ORG,
            priorCampaignIds: CAMPAIGNS.map((c) => c.id),
            organizationCustomerIds: new Set([ORG]),
            orders: supporterOrders(),
            suppressedEmails: new Set(['lee@example.com']),
        },
        openOpportunity: null,
        marketing: { seasonal: [], previousSupporters: [], rebookingResponses: [] },
        ...over,
    };
}

const row = (dash: ReturnType<typeof buildOrganizationDashboard>, id: string) => dash.history.find((r) => r.id === id)!;

// ═══════════════════════════════════════════════════════════════════════════
describe('DASHBOARD · lifetime sales and campaigns run', () => {
    const dash = buildOrganizationDashboard(world(), NOW);

    it('1. lifetime sales IS computeOrganizationImpact over the same rows (the Organizations tab authority)', () => {
        const impact = computeOrganizationImpact({
            organizationId: ORG,
            organizationName: 'Maple Grove Youth Group',
            campaigns: CAMPAIGNS.map((c) => ({
                id: c.id, status: c.status, name: c.name, closed_at: c.closed_at, created_at: c.created_at,
                settlement_total: c.settlement_total === null ? null : Number(c.settlement_total),
                orders: dashboardOrders().filter((o) => o.campaign_id === c.id).map((o) => ({
                    total_amount: Number(o.total_amount), canceled_at: o.canceled_at as Date | null,
                })),
            })),
        }, NOW);
        expect(dash.kpis.lifetimeSales).toBe(impact.lifetimeFundraiserSales);
        // Frozen settlements for A and B, live non-canceled orders for D, nothing for C.
        expect(dash.kpis.lifetimeSales).toBe(5755 + 7240 + 100);
        expect(dash.kpis.lifetimeSalesLabel).toBe('$13,095');
    });

    it('1b. the history rows add up to the lifetime figure — one contribution per campaign', () => {
        const sum = dash.history.reduce((s, r) => s + (r.gross ?? 0), 0);
        expect(sum).toBe(dash.kpis.lifetimeSales);
        expect(row(dash, A).grossSource).toBe('settlement');
        expect(row(dash, A).gross).toBe(5755);          // the frozen figure, not a recount of today's orders
        expect(row(dash, D).grossSource).toBe('live_orders');
    });

    it('2. campaigns run = impact.campaignCount = history length; the never-started Lead row is excluded from both', () => {
        expect(dash.kpis.campaignsRun).toBe(4);
        expect(dash.history.map((r) => r.id)).toEqual([D, A, B, C]);   // newest first
        expect(dash.history.find((r) => r.id === LEAD)).toBeUndefined();
    });

    it('2b. history is complete — a sixth, seventh… campaign is not cut off at five', () => {
        const many = Array.from({ length: 8 }, (_, i) => campaign({
            id: `c${i}`, name: `Campaign ${i}`, settlement_total: '100', delivery_date: d(`20${10 + i}-05-01T00:00:00Z`),
        }));
        const big = buildOrganizationDashboard(world({
            campaigns: many, orders: [],
            audience: { ...world().audience, priorCampaignIds: many.map((c) => c.id), orders: [] },
        }), NOW);
        expect(big.kpis.campaignsRun).toBe(8);
        expect(big.history).toHaveLength(8);
        expect(big.kpis.lifetimeSales).toBe(800);
    });

    it('3. canceled orders never count — not in gross, orders, bundles or supporters', () => {
        const a = row(dash, A);
        expect(a.orderCount).toBe(3);                        // a4 is canceled
        const dRow = row(dash, D);
        expect(dRow.gross).toBe(100);                        // d2 ($50) is canceled
        expect(dRow.orderCount).toBe(1);
        expect(dRow.physicalBundles).toBe(1);                // not 1 + 3
        expect(dRow.supporterCount).toBe(1);
        expect(dash.kpis.supportersOnFile).toBe(6);          // gone@ / new2@ never appear
    });

    it('4. incomplete legacy history is truthful — never "$0", never invented bundles', () => {
        const c = row(dash, C);
        expect(c.metricsLabel).toBeNull();                   // renders "No sales data recorded"
        expect(c.gross).toBeNull();
        expect(c.grossSource).toBe('none');
        expect(c.bundleFamilies).toEqual([]);
        expect(c.bundleNote).toBe('Bundles not recorded');
        expect(c.invoiceLabel).toBe('No invoice on record');
        expect(c.dateLabel).toBe('No delivery date recorded');
        expect(dash.kpis.lifetimeSalesHelper).toBe('1 past campaign has no sales data recorded');
    });

    it('5. an organization with no history shows "—", not $0, and says why', () => {
        const empty = buildOrganizationDashboard(world({
            campaigns: [], orders: [], audience: { ...world().audience, priorCampaignIds: [], orders: [] },
        }), NOW);
        expect(empty.kpis.lifetimeSalesLabel).toBe('—');
        expect(empty.kpis.lifetimeSalesHelper).toBe('No fundraisers yet');
        expect(empty.kpis.campaignsRun).toBe(0);
        expect(empty.kpis.supportersOnFile).toBe(0);
        expect(empty.kpis.supportersHelper).toBe('Supporters are added as orders come in');
        expect(empty.kpis.emailReadyHelper).toBeNull();
        expect(empty.history).toEqual([]);
        expect(empty.intelligence.lastFundraiser).toBeNull();
        expect(empty.intelligence.timing.label).toBe('No fundraisers yet');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('SUPPORTERS · the Previous Supporters identity rule, unchanged', () => {
    const w = world();
    const dash = buildOrganizationDashboard(w, NOW);
    const canonical = derivePreviousSupporters(w.audience);

    it('6. one person who ordered twice is ONE supporter — supporters are not orders', () => {
        expect(row(dash, A).orderCount).toBe(3);
        expect(row(dash, A).supporterCount).toBe(2);         // Pat (twice) + Sam
    });

    it('7. normalization and dedupe are exactly derivePreviousSupporters — email (any case), then phone, then the order', () => {
        expect(dash.kpis.supportersOnFile).toBe(canonical.supporterCount);
        expect(canonical.supporterCount).toBe(6);            // Pat, Sam, Lee, Kim, the blank order, New
        expect(canonical.supporters.filter((s) => s.email === 'pat@example.com')[0].orderCount).toBe(3);
        expect(canonical.supporters.some((s) => s.key === 'phone:2175550101')).toBe(true);
        expect(canonical.supporters.some((s) => s.key === 'order:b4')).toBe(true);
    });

    it('8. the organization itself is never a supporter — its own inbox is never adopted', () => {
        expect(canonical.supporters.some((s) => s.email === ORG_CONTACT_EMAIL)).toBe(false);
        expect(canonical.supporters.find((s) => s.email === 'kim@example.com')).toBeTruthy();   // from Order.email
    });

    it('9. canceled orders are not supporters', () => {
        expect(canonical.supporters.some((s) => s.email === 'gone@example.com' || s.email === 'new2@example.com')).toBe(false);
    });

    it('10/11. no usable email and opted-out addresses are not email-ready, and are reported', () => {
        expect(dash.kpis.emailReady).toBe(3);                // Pat, Kim, New
        expect(dash.kpis.noUsableEmail).toBe(2);             // Sam (phone only), the blank order
        expect(dash.kpis.optedOut).toBe(1);                  // Lee
        expect(dash.intelligence.emailReadyBreakdown).toBe('2 without a usable email · 1 opted out');
    });

    it('12. email-ready IS the invitation audience’s reachable count, worded as the owner asked', () => {
        expect(dash.kpis.emailReady).toBe(canonical.reachableCount);
        expect(dash.kpis.emailReadyHelper).toBe('3 of 6 previous supporters can currently be invited by email.');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('SUPPORTERS · ONE loader for the dashboard and the real invitation', () => {
    const CAMPAIGN_ROWS = [A, B, C, D].map((id) => ({ id }));
    const PREFS = [
        { scope: 'email_address', status: 'unsubscribed', effective_until: null, normalized_email: 'lee@example.com' },
        // An ELAPSED pause no longer suppresses — the send rule, not a guess.
        { scope: 'email_address', status: 'paused', effective_until: d('2020-01-01T00:00:00Z'), normalized_email: 'kim@example.com' },
        // A pause still in force does.
        { scope: 'email_address', status: 'paused', effective_until: d('2028-01-01T00:00:00Z'), normalized_email: 'new@example.com' },
    ];
    const audienceDb = () => createPrismaMock({
        results: {
            'fundraiserCampaign.findMany': (args: any) => {
                if (args?.distinct) return [{ customer_id: ORG }];
                const exclude = args?.where?.id?.not;
                return CAMPAIGN_ROWS.filter((c) => c.id !== exclude);
            },
            'order.findMany': (args: any) => {
                const ids: string[] = args?.where?.campaign_id?.in ?? [];
                return supporterOrders().filter((o) => ids.includes(o.campaign_id!) && o.canceled_at === null);
            },
            'marketingPreference.findMany': PREFS,
        },
    });

    it('12b. the coordinator mode excludes its own campaign by id; the dashboard mode excludes nothing', async () => {
        const m1 = audienceDb();
        await loadPreviousSupporterAudienceInputs(m1.client, { businessId: BIZ, organizationCustomerId: ORG, excludeCampaignId: D, now: NOW });
        expect(m1.callsTo('fundraiserCampaign.findMany')[0].args.where).toEqual({ customer_id: ORG, id: { not: D } });

        const m2 = audienceDb();
        const inputs = await loadPreviousSupporterAudienceInputs(m2.client, { businessId: BIZ, organizationCustomerId: ORG, excludeCampaignId: null, now: NOW });
        expect(m2.callsTo('fundraiserCampaign.findMany')[0].args.where).toEqual({ customer_id: ORG });
        expect(inputs.priorCampaignIds.sort()).toEqual([A, B, C, D].sort());
        // Orders are read non-canceled only, and opt-outs only at email-address scope, for THIS tenant.
        expect(m2.firstCall('order.findMany')!.args.where.canceled_at).toBeNull();
        expect(m2.firstCall('marketingPreference.findMany')!.args.where).toEqual({ business_id: BIZ, scope: 'email_address', normalized_email: { not: null } });
        // Suppression went through evaluateSuppression: elapsed pause out, live pause in.
        expect([...inputs.suppressedEmails].sort()).toEqual(['lee@example.com', 'new@example.com']);
    });

    it('12c. the REAL coordinator GET and the REAL dashboard GET count through the same loader', async () => {
        // The coordinator portal for campaign D: its audience is every OTHER campaign.
        (global as any).__orgDashCoordinator = { ok: true, campaignId: D, sessionId: 's1' };
        const coordinatorWorld = audienceDb();
        coordinatorWorld.client.fundraiserCampaign.findFirst.mockImplementation(async () => ({
            id: D, name: 'Spring 2027 Fundraiser', end_date: d('2027-04-01T00:00:00Z'), public_token: 'pub-d',
            customer_id: ORG,
            customer: { id: ORG, name: 'Maple Grove Youth Group', business_id: BIZ, business: { id: BIZ, name: 'Kitchen', display_name: null, custom_domain: null, contact_email: null, slug: 'kitchen' } },
        }));
        useMock(coordinatorWorld);
        const { GET: coordinatorGET } = await import('@/app/api/coordinator/previous-supporters/route');
        const coord = await readJson(await coordinatorGET(new Request('https://www.freezeriqapp.com/api/coordinator/previous-supporters')));
        expect(coord.status).toBe(200);

        const direct = await loadPreviousSupporterAudience(audienceDb().client, {
            businessId: BIZ, organizationCustomerId: ORG, excludeCampaignId: D, now: new Date(),
        });
        expect(coord.body.counts.supporters).toBe(direct.supporterCount);
        expect(coord.body.counts.reachable).toBe(direct.reachableCount);
        expect(coord.body.counts.supporters).toBe(5);        // New (campaign D) is a CURRENT supporter there
        expect(coord.body.counts.reachable).toBe(2);         // Pat, Kim
        // Nothing was written by viewing the audience.
        for (const c of coordinatorWorld.calls) expect(['findFirst', 'findMany', 'findUnique']).toContain(c.method);
    });

    it('12d. the shipped code paths: the route delegates, the dashboard loader passes null, the builder derives', () => {
        const route = code('app/api/coordinator/previous-supporters/route.ts');
        expect(route).toContain('return loadPreviousSupporterAudience(prisma, {');
        expect(route).toContain('excludeCampaignId: input.campaignId,');
        expect(route).not.toContain('marketingPreference.findMany');   // no second copy of the assembly
        const loader = code('lib/organizationDashboardData.ts');
        expect(loader).toContain('await loadPreviousSupporterAudienceInputs(db, {');
        expect(loader).toContain('excludeCampaignId: null,');
        const builder = code('lib/organizationDashboard.ts');
        expect(builder).toContain('const audience = derivePreviousSupporters(input.audience);');
        expect(builder).toContain('emailReady: audience.reachableCount,');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('CURRENT WORK · opportunity and campaign are never conflated', () => {
    const emptyDraft = {
        id: 'opp-draft', status: 'new', created_at: d('2027-09-30T21:30:00Z'),
        first_response_at: null, preferred_delivery_date: null, alternate_delivery_date: null, confirmed_delivery_date: null,
        participant_estimate: null, notes: null, lost_at: null, lost_reason: null, campaign_id: null, converted_at: null,
        inquiries: [],
    };

    it('13. an open opportunity is a NEXT FUNDRAISER card — not a campaign, not a history row', () => {
        const dash = buildOrganizationDashboard(world({
            campaigns: CAMPAIGNS.filter((c) => c.id !== D), openOpportunity: emptyDraft,
        }), NOW);
        expect(dash.current.campaigns).toEqual([]);
        expect(dash.current.opportunity).toMatchObject({
            id: 'opp-draft', kind: 'planning', title: 'Planning next fundraiser', chipLabel: 'Planning',
        });
        // Dated in the tenant's timezone: 21:30 UTC on Sep 30 is still Sep 30 in Chicago.
        expect(dash.current.opportunity!.lines).toEqual([
            'No delivery date confirmed yet',
            'Started by you on Sep 30, 2027 · no website inquiry',
        ]);
        expect(dash.history.some((r) => r.id === 'opp-draft')).toBe(false);
        expect(dash.kpis.campaignsRun).toBe(3);
    });

    it('14. a running campaign is a CURRENT FUNDRAISER card with live figures and its real stage', () => {
        const dash = buildOrganizationDashboard(world(), NOW);
        expect(dash.current.campaigns).toHaveLength(1);
        expect(dash.current.campaigns[0]).toMatchObject({
            id: D,
            stageKey: 'awaiting_setup',
            stageLabel: 'Awaiting Coordinator Setup',
            dateLine: 'Delivery Apr 15, 2027 · Orders close Apr 1, 2027',
            figuresLine: '$100 sales so far · 1 order',
        });
        expect(dash.kpis.campaignsHelper).toBe('1 running now');
    });

    it('15. nothing in progress → no current-work cards at all', () => {
        const dash = buildOrganizationDashboard(world({ campaigns: CAMPAIGNS.filter((c) => c.id !== D) }), NOW);
        expect(dash.current).toEqual({ campaigns: [], opportunity: null, invoiceFollowUps: [] });
    });

    it('16. a public inquiry is an INQUIRY card and is never discardable', () => {
        const dash = buildOrganizationDashboard(world({
            openOpportunity: {
                ...emptyDraft, id: 'opp-inq',
                inquiries: [{ received_at: d('2027-09-28T15:00:00Z'), source_channel: 'tenant_website', contact_name: 'Dana' }],
            },
        }), NOW);
        expect(dash.current.opportunity).toMatchObject({ kind: 'inquiry', title: 'Fundraiser inquiry', chipLabel: 'Inquiry' });
        expect(dash.current.opportunity!.lines[1]).toBe('Inquiry received Sep 28, 2027 from Dana via your website');
        expect(dash.current.opportunity!.discard.eligible).toBe(false);
        expect(dash.current.opportunity!.discard.blockers).toContain('has_inquiry');
    });

    it('16b. a closed campaign with an unpaid invoice becomes a NEXT STEP, worded by describeCampaignInvoice', () => {
        const unpaid = CAMPAIGNS.map((c) => (c.id === A
            ? { ...c, invoices: [{ ...c.invoices[0], status: 'SENT' }] }
            : c));
        const dash = buildOrganizationDashboard(world({ campaigns: unpaid }), NOW);
        expect(dash.current.invoiceFollowUps).toEqual([
            { campaignId: A, campaignName: 'Fall 2026 Fundraiser', label: 'Invoice sent — awaiting payment', tone: 'pending' },
        ]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('DISCARD · the rule', () => {
    const empty: DraftDiscardOpportunity = {
        status: 'new', first_response_at: null, preferred_delivery_date: null, alternate_delivery_date: null,
        confirmed_delivery_date: null, campaign_id: null, converted_at: null, lost_at: null, lost_reason: null,
        notes: null, participant_estimate: null, inquiry_count: 0,
    };

    it('17. an empty tenant-created draft is eligible', () => {
        expect(evaluateDraftDiscard(empty)).toEqual({ eligible: true, blockers: [] });
        expect(evaluateDraftDiscard({ ...empty, notes: '   ' }).eligible).toBe(true);   // whitespace is not content
    });

    it('18. every fact the owner listed blocks it', () => {
        const cases: [Partial<DraftDiscardOpportunity>, string][] = [
            [{ inquiry_count: 1 }, 'has_inquiry'],
            [{ confirmed_delivery_date: '2027-10-14' }, 'has_dates'],
            [{ preferred_delivery_date: '2027-10-14' }, 'has_dates'],
            [{ campaign_id: 'camp-x' }, 'has_campaign'],
            [{ converted_at: '2027-09-01T00:00:00Z' }, 'has_campaign'],
            [{ first_response_at: '2027-09-01T00:00:00Z' }, 'responded'],
            [{ status: 'in_conversation' }, 'not_new'],
            [{ status: 'date_confirmed' }, 'not_new'],
            [{ status: 'lost', lost_at: '2027-09-01T00:00:00Z', lost_reason: 'not_interested' }, 'has_disposition'],
            [{ notes: 'Call back in March' }, 'has_planning_details'],
            [{ participant_estimate: 40 }, 'has_planning_details'],
        ];
        for (const [over, blocker] of cases) {
            const v = evaluateDraftDiscard({ ...empty, ...over });
            expect(v.eligible).toBe(false);
            expect(v.blockers).toContain(blocker);
        }
    });

    it('18b. the delete WHERE re-asserts every fact, scoped by the session tenant', () => {
        expect(draftDiscardWhere('opp-1', BIZ)).toEqual({
            id: 'opp-1', business_id: BIZ, status: 'new',
            first_response_at: null, preferred_delivery_date: null, alternate_delivery_date: null,
            confirmed_delivery_date: null, campaign_id: null, converted_at: null,
            lost_at: null, lost_reason: null, participant_estimate: null,
            OR: [{ notes: null }, { notes: '' }],
            inquiries: { none: {} },
        });
    });
});

describe('DISCARD · the route (POST /api/opportunities/[id]/discard-draft)', () => {
    const OPP = 'opp-empty';
    const stored = (over: any = {}) => ({
        id: OPP, customer_id: ORG, status: 'new', first_response_at: null, preferred_delivery_date: null,
        alternate_delivery_date: null, confirmed_delivery_date: null, campaign_id: null, converted_at: null,
        lost_at: null, lost_reason: null, notes: null, participant_estimate: null, _count: { inquiries: 0 },
        ...over,
    });
    const post = async (body: unknown = { confirm: true }) => {
        const { POST } = await import('@/app/api/opportunities/[id]/discard-draft/route');
        return readJson(await POST(jsonRequest(`http://localhost/api/opportunities/${OPP}/discard-draft`, body), ctx(OPP)));
    };
    const tenantWorld = (row: any, deleteCount = 1) => createPrismaMock({
        results: {
            'fundraiserOpportunity.findFirst': (args: any) => (args?.where?.business_id === BIZ && args?.where?.id === OPP ? row : null),
            'fundraiserOpportunity.deleteMany': { count: deleteCount },
        },
    });
    const noUpdates = () => {
        for (const k of ['fundraiserOpportunity.update', 'fundraiserOpportunity.updateMany', 'fundraiserOpportunity.upsert', 'fundraiserInquiry.updateMany', 'customer.update']) {
            expect(mock.callsTo(k)).toHaveLength(0);
        }
    };

    it('19. anonymous → 401 before any query', async () => {
        const res = await post();
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('20. no explicit confirmation → 400, nothing read or deleted', async () => {
        useSession({ user: { businessId: BIZ } });
        const res = await post({});
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('confirmation_required');
        expect(mock.calls).toHaveLength(0);
    });

    it('21. another tenant’s opportunity → 404, scoped by the SESSION business, nothing deleted', async () => {
        useMock(tenantWorld(stored()));
        useSession({ user: { businessId: OTHER_BIZ } });
        const res = await post();
        expect(res.status).toBe(404);
        expect(mock.firstCall('fundraiserOpportunity.findFirst')!.args.where).toEqual({ id: OPP, business_id: OTHER_BIZ });
        expect(mock.callsTo('fundraiserOpportunity.deleteMany')).toHaveLength(0);
    });

    it('22. a draft with a public inquiry → 409 and it is kept', async () => {
        useMock(tenantWorld(stored({ _count: { inquiries: 1 } })));
        useSession({ user: { businessId: BIZ } });
        const res = await post();
        expect(res.status).toBe(409);
        expect(res.body.blockers).toContain('has_inquiry');
        expect(res.body.error).toMatch(/real inquiry/);
        expect(mock.callsTo('fundraiserOpportunity.deleteMany')).toHaveLength(0);
    });

    it('22b. a confirmed date, a campaign, or recorded history each → 409 and kept', async () => {
        for (const over of [
            { status: 'date_confirmed', confirmed_delivery_date: d('2027-10-14T00:00:00Z') },
            { status: 'converted', campaign_id: 'camp-x', converted_at: d('2027-09-01T00:00:00Z') },
            { status: 'in_conversation', first_response_at: d('2027-09-01T00:00:00Z') },
            { notes: 'Asked for October' },
        ]) {
            useMock(tenantWorld(stored(over)));
            useSession({ user: { businessId: BIZ } });
            const res = await post();
            expect(res.status).toBe(409);
            expect(mock.callsTo('fundraiserOpportunity.deleteMany')).toHaveLength(0);
        }
    });

    it('23. an eligible empty draft is hard-deleted once, through the guarded WHERE — no lost record is written', async () => {
        useMock(tenantWorld(stored()));
        useSession({ user: { businessId: BIZ } });
        const res = await post();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ discarded: true, opportunityId: OPP, organizationId: ORG });
        const del = mock.callsTo('fundraiserOpportunity.deleteMany');
        expect(del).toHaveLength(1);
        expect(del[0].args.where).toEqual(draftDiscardWhere(OPP, BIZ));
        noUpdates();
    });

    it('24. a draft that changed between the read and the delete is left alone → 409', async () => {
        useMock(tenantWorld(stored(), 0));
        useSession({ user: { businessId: BIZ } });
        const res = await post();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('changed');
    });

    it('25. an inquiry racing in is refused by the foreign key, reported as a 409 — never a 500', async () => {
        const m = tenantWorld(stored());
        m.client.fundraiserOpportunity.deleteMany.mockImplementation(async () => { throw Object.assign(new Error('fk'), { code: 'P2003' }); });
        useMock(m);
        useSession({ user: { businessId: BIZ } });
        const res = await post();
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('changed');
    });

    it('26. mark_lost is unchanged — a real prospect is still never deleted', () => {
        const patch = code('app/api/opportunities/[id]/route.ts');
        expect(patch).toContain("data.status = 'lost';");
        expect(read('app/api/opportunities/[id]/route.ts')).toContain('The lead is never deleted.');
        expect(patch).not.toMatch(/\.delete(Many)?\(/);
        // And there is still no generic DELETE handler for opportunities.
        expect(patch).not.toMatch(/export async function DELETE/);
        expect(code('app/api/opportunities/[id]/discard-draft/route.ts')).not.toMatch(/export async function (DELETE|PATCH|PUT|GET)/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('HISTORY · frozen truth first', () => {
    const dash = buildOrganizationDashboard(world(), NOW);

    it('27. a closed campaign’s bundles and physical count come from its FROZEN invoice lines', () => {
        const a = row(dash, A);
        expect(a.bundleSource).toBe('invoice');
        expect(a.physicalBundles).toBe(71);
        // Serves-5 and Serves-2 siblings collapse into one family; most-ordered first.
        expect(a.bundleFamilies).toEqual(['Family Friendly - Fall 2026', 'Keto - Fall 2026']);
        expect(a.metricsLabel).toBe('2 supporters · 71 bundles · $5,755 sales');
        expect(a.shareLabel).toBe('$1,151');
        expect(a.invoiceLabel).toBe('Paid');
        expect(a.dateLabel).toBe('Delivery Oct 14, 2026');
    });

    it('28. renaming, reassigning or deleting today’s bundles cannot rewrite closed history', () => {
        const a = row(dash, A);
        // A's live assignment says "Renamed After Closeout" and its orders say "Family Favorites".
        expect(a.bundleFamilies).not.toContain('Renamed After Closeout');
        expect(a.bundleFamilies).not.toContain('Family Favorites');
        // A closed campaign with no invoice lines reads its orders' own frozen line names, never the catalog.
        const noInvoice = CAMPAIGNS.map((c) => (c.id === A ? { ...c, invoices: [] } : c));
        const fallback = row(buildOrganizationDashboard(world({ campaigns: noInvoice }), NOW), A);
        expect(fallback.bundleSource).toBe('orders');
        expect(fallback.bundleFamilies).toEqual(['Family Favorites', 'Keto']);
        expect(fallback.bundleFamilies).not.toContain('Renamed After Closeout');
    });

    it('29. a running campaign stays clearly live — "so far", no invoice line, its current offer', () => {
        const live = row(dash, D);
        expect(live.isOpen).toBe(true);
        expect(live.metricsLabel).toBe('1 supporter · 1 bundle · $100 sales so far');
        expect(live.invoiceLabel).toBeNull();
        // No active selection yet, so what was actually sold names the bundles.
        expect(live.bundleSource).toBe('orders');
        expect(live.bundleFamilies).toEqual(['Comfort Classics']);
        const selected = CAMPAIGNS.map((c) => (c.id === D
            ? { ...c, bundle_selection_status: 'selected', activeBundles: [
                { name: 'Comfort Classics - Spring 2027', serving_tier: 'serves_5' },
                { name: 'Comfort Classics (Serves 2) - Spring 2027', serving_tier: 'serves_2' },
            ] }
            : c));
        const withOffer = row(buildOrganizationDashboard(world({ campaigns: selected }), NOW), D);
        expect(withOffer.bundleSource).toBe('selection');
        expect(withOffer.bundleFamilies).toEqual(['Comfort Classics - Spring 2027']);
        // A live campaign with nothing sold yet has no orders, not missing data —
        // and while the coordinator has not chosen, the row says exactly that.
        const fresh = row(buildOrganizationDashboard(world({ orders: dashboardOrders(ORDERS.filter((o) => o.campaign !== D)) }), NOW), D);
        expect(fresh.metricsLabel).toBe('No orders yet');
        expect(fresh.bundleNote).toBe('Waiting for the coordinator to choose bundles');
    });

    it('30. relationship intelligence reads the LAST CLOSED fundraiser, not the running one', () => {
        expect(dash.intelligence.lastFundraiser).toMatchObject({
            campaignId: A,
            name: 'Fall 2026 Fundraiser',
            dateLabel: 'Delivery Oct 14, 2026',
            resultLabel: '71 bundles · $5,755',
            bundleFamilies: ['Family Friendly - Fall 2026', 'Keto - Fall 2026'],
            supporterCount: 2,
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('TIMING · inferred from history, never a preference', () => {
    it('31. one dated fundraiser is not a pattern', () => {
        expect(describeTimingPattern([d('2026-10-14T00:00:00Z')], 1).label).toBe('Not enough history (1 fundraiser)');
        expect(describeTimingPattern([d('2026-10-14T00:00:00Z')], 3).label).toBe('Not enough history (1 dated fundraiser)');
    });

    it('32. two or more dates give a pattern only when a month repeats', () => {
        const dash = buildOrganizationDashboard(world(), NOW);
        expect(dash.intelligence.timing).toEqual({ label: 'October (2 of 3 fundraisers)', muted: false, datedCount: 3 });
        expect(describeTimingPattern([d('2026-03-10T00:00:00Z'), d('2025-10-10T00:00:00Z')], 2).label)
            .toBe('No repeating month yet (March and October)');
        expect(describeTimingPattern([
            d('2026-03-10T00:00:00Z'), d('2025-03-10T00:00:00Z'), d('2025-10-10T00:00:00Z'), d('2024-10-10T00:00:00Z'),
        ], 4).label).toBe('March and October (2 each of 4 fundraisers)');
    });

    it('33. nothing calls an inference a preference, and no preferred-season field is invented', () => {
        for (const f of ['lib/organizationDashboard.ts', 'components/crm2/orgDashboard/RelationshipIntelligenceCard.tsx']) {
            expect(code(f)).not.toMatch(/['"`>][^'"`<]*Preferred season/);
        }
        const schema = read('prisma/schema.prisma');
        expect(schema).not.toMatch(/preferred_(season|month)/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('MARKETING · recorded activity only', () => {
    const entries = buildMarketingEntries({
        seasonal: [
            { batchId: 'sb1', offeringName: 'Fall 2027 Lineup', attempts: [
                { status: 'accepted', accepted_at: '2027-09-10T15:00:00Z', failed_at: null, skipped_at: null, created_at: '2027-09-10T14:59:00Z' },
            ] },
            // In an audience, never attempted: not activity.
            { batchId: 'sb2', offeringName: 'Spring 2027 Lineup', attempts: [] },
        ],
        previousSupporters: [
            { batchId: 'pb1', campaignName: 'Spring 2027 Fundraiser', accepted: 18, failed: 2, skipped: 1, queued: 0, lastActivityAt: '2027-03-20T18:00:00Z' },
        ],
        rebookingResponses: [
            { submissionId: 'rs1', offeringName: 'Fall 2027 Lineup', selected: true, respondedAt: d('2027-09-12T02:30:00Z'), revisionNumber: 2 },
        ],
    }, 'America/Chicago');

    it('34. only sends and responses FreezerIQ recorded appear, newest first, dated in the tenant’s timezone', () => {
        expect(entries.map((e) => e.id)).toEqual(['rebooking:rs1', 'seasonal:sb1', 'previous_supporters:pb1']);
        expect(entries[0]).toMatchObject({ stateLabel: 'Responded — interested', dateLabel: 'Sep 11, 2027', detail: 'They updated their response' });
        expect(entries[1]).toMatchObject({ title: 'Seasonal update · Fall 2027 Lineup', stateLabel: 'Sent', dateLabel: 'Sep 10, 2027' });
        expect(entries[2]).toMatchObject({ stateLabel: 'Sent with issues', detail: '18 sent · 2 failed · 1 skipped (opted out)' });
    });

    it('35. no opened, clicked or delivered state is ever produced or rendered', () => {
        for (const e of entries) expect(`${e.stateLabel} ${e.detail ?? ''}`).not.toMatch(/open|click|deliver/i);
        for (const f of ['lib/organizationDashboard.ts', 'components/crm2/orgDashboard/MarketingActivityCard.tsx']) {
            const src = code(f).replace('Opens and clicks are not tracked.', '');
            expect(src).not.toMatch(/['"`>][^'"`<]*\b(Opened|Clicked|Delivered)\b/);
        }
    });

    it('36. test sends are never activity — the loader excludes them at the query', () => {
        const loader = code('lib/organizationDashboardData.ts');
        expect((loader.match(/is_test: false/g) ?? []).length).toBe(2);
    });

    it('36b. an invitation is dated by when it was sent, not by when its row was claimed', async () => {
        const { loadOrganizationDashboardInput } = await import('@/lib/organizationDashboardData');
        const m = createPrismaMock({
            results: {
                'customer.findFirst': { id: ORG, name: 'Maple Grove Youth Group', archived: false },
                'business.findUnique': { timezone: 'America/Chicago' },
                'outreachBatch.findMany': [{ id: 'pb1', campaign_id: A, campaign: { name: 'Fall 2026 Fundraiser' } }],
                'emailDeliveryAttempt.groupBy': [
                    { outreach_batch_id: 'pb1', status: 'accepted', _count: { _all: 2 }, _max: { accepted_at: d('2026-09-18T16:30:00Z'), failed_at: null, skipped_at: null, created_at: d('2026-10-02T00:30:00Z') } },
                    { outreach_batch_id: 'pb1', status: 'failed', _count: { _all: 1 }, _max: { accepted_at: null, failed_at: d('2026-09-18T16:31:00Z'), skipped_at: null, created_at: d('2026-10-02T00:30:00Z') } },
                ],
            },
        });
        const loaded = await loadOrganizationDashboardInput(m.client, { businessId: BIZ, organizationId: ORG, now: NOW });
        expect(loaded.ok).toBe(true);
        const p = (loaded as any).input.marketing.previousSupporters[0];
        expect(p).toMatchObject({ accepted: 2, failed: 1, skipped: 0, queued: 0 });
        expect(new Date(p.lastActivityAt).toISOString()).toBe('2026-09-18T16:31:00.000Z');
        // The groupBy itself is tenant-scoped and excludes test sends.
        expect(m.firstCall('emailDeliveryAttempt.groupBy')!.args.where).toEqual({ business_id: BIZ, outreach_batch_id: { in: ['pb1'] }, is_test: false });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('DASHBOARD ROUTE · GET /api/customers/[id]/fundraiser-dashboard', () => {
    const get = async (id = ORG) => {
        const { GET } = await import('@/app/api/customers/[id]/fundraiser-dashboard/route');
        return readJson(await GET(new Request(`http://localhost/api/customers/${id}/fundraiser-dashboard`), ctx(id)));
    };
    const fullWorld = () => createPrismaMock({
        results: {
            'customer.findFirst': (args: any) => (args?.where?.business_id === BIZ && args?.where?.id === ORG
                ? { id: ORG, name: 'Maple Grove Youth Group', archived: false } : null),
            'business.findUnique': { timezone: 'America/Chicago' },
            'fundraiserCampaign.findMany': (args: any) => {
                if (args?.distinct) return [{ customer_id: ORG }];
                if (args?.select?.invoices) {
                    return Array.from({ length: 7 }, (_, i) => ({
                        id: `c${i}`, name: `Campaign ${i}`, status: 'Closed', closed_at: d('2026-01-01T00:00:00Z'),
                        created_at: d('2025-01-01T00:00:00Z'), start_date: null, end_date: null,
                        delivery_date: d(`20${15 + i}-10-0${1 + (i % 8)}T00:00:00Z`),
                        settlement_total: '250.00', settled_externally: false, bundle_selection_status: 'selected',
                        invoices: [], campaign_bundles: [],
                    }));
                }
                return Array.from({ length: 7 }, (_, i) => ({ id: `c${i}` }));
            },
        },
    });

    it('37. anonymous → 401 before any query', async () => {
        const res = await get();
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('38. a foreign organization → 404, the lookup is scoped by the session business, and nothing else is read', async () => {
        useMock(fullWorld());
        useSession({ user: { businessId: OTHER_BIZ } });
        const res = await get();
        expect(res.status).toBe(404);
        expect(mock.firstCall('customer.findFirst')!.args.where).toEqual({ id: ORG, business_id: OTHER_BIZ });
        expect(mock.callsTo('fundraiserCampaign.findMany')).toHaveLength(0);
        expect(mock.callsTo('order.findMany')).toHaveLength(0);
    });

    it('39. a non-UUID id answers 404 without touching the database', async () => {
        useSession({ user: { businessId: BIZ } });
        const res = await get('not-a-uuid');
        expect(res.status).toBe(404);
        expect(mock.calls).toHaveLength(0);
    });

    it('40. the campaign read has NO take — seven campaigns are seven, and nothing is written', async () => {
        useMock(fullWorld());
        useSession({ user: { businessId: BIZ } });
        const res = await get();
        expect(res.status).toBe(200);
        const campaignRead = mock.callsTo('fundraiserCampaign.findMany').find((c) => c.args?.select?.invoices)!;
        expect(campaignRead.args.where).toEqual({ customer_id: ORG });
        expect(campaignRead.args).not.toHaveProperty('take');
        expect(res.body.kpis.campaignsRun).toBe(7);
        expect(res.body.history).toHaveLength(7);
        expect(res.body.kpis.lifetimeSales).toBe(1750);
        for (const c of mock.calls) expect(['findFirst', 'findMany', 'findUnique', 'groupBy']).toContain(c.method);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('REGRESSION · the page', () => {
    const PAGE = 'app/fundraisers/[id]/page.tsx';
    const page = code(PAGE);
    const raw = read(PAGE);

    it('41. the legacy workflow is no longer rendered on the organization page', () => {
        for (const gone of ['PipelineStepper', 'FundraiserOverview', 'FundraisersTab', 'StatusPipeline', 'FundraiserSetup', 'CampaignCard']) {
            expect(page).not.toContain(gone);
        }
        // Comments may name what was removed; rendered markup may not.
        for (const label of ['Send Intro Email', 'Send Info Packet', 'Send Marketing Packet', 'Create Campaign', 'Preview Flyer', 'Preview Tracker', 'Save Changes', 'Next Steps']) {
            expect(page).not.toContain(label);
        }
        // No direct campaign creation and no campaign PATCH from this page.
        expect(page).not.toMatch(/fetch\(['`]\/api\/campaigns/);
        expect(page).not.toContain("activeTab === '");
    });

    it('42. Start Next Fundraiser still enters the canonical opportunity flow', () => {
        expect(page).toContain("fetch('/api/opportunities'");
        expect(page).toContain("router.push('/fundraisers?tab=leads')");
        expect(page).toContain('evaluateRebookingEligibility(rebookingInput)');
        // Every campaign, from the dashboard read — not the profile's newest five.
        expect(page).toContain('? dashboard.rebooking.campaigns');
        // Reachable on a phone: the same action, pinned to the bottom of the screen.
        expect(page).toMatch(/fixed inset-x-0 bottom-0[^"]*sm:hidden/);
    });

    it('43. Tax, Contact Profile, Customer Notes, QuickBooks and Documents are all still on the page', () => {
        const details = code('components/crm2/orgDashboard/OrganizationDetailsSection.tsx');
        expect(details).toContain('<OrganizationTaxPanel');
        expect(details).toContain('Contact Profile');
        expect(details).toContain('Customer Notes');
        expect(details).toContain('<DocumentsTab customer={customer} />');
        expect(page).toContain('<OrganizationDetailsSection');
        expect(page.split('<QuickBooksCustomerLinkCard customerId={customer.id} />')).toHaveLength(2);
        // Notes still save through the organization save path, with the CURRENT notes in every save.
        expect(page).toContain('const result = await putProfile({ notes: value });');
        expect(page).toMatch(/notes\s*\n\s*\};/);
    });

    it('44. the profile editor calls CustomerStatus what it is — the relationship stage', () => {
        expect(raw).toContain('>Relationship stage</label>');
        expect(raw).not.toMatch(/>Status<\/label>/);
        // Same underlying enum and options — relabelled, not repurposed.
        expect(page).toContain('Object.entries(STATUS_LABELS)');
        // Archive / restore survives, because an archived organization is the one refusal Start Next gives.
        expect(raw).toContain('Restore organization');
        expect(page).toContain('{ archived: !archived }');
    });

    it('45. "View campaign" and "Open fundraiser" open the existing Campaign Context drawer', () => {
        expect(code('components/crm2/orgDashboard/CampaignHistoryList.tsx')).toContain('href={`/fundraisers?campaign=${r.id}`}');
        expect(code('components/crm2/orgDashboard/CurrentWorkSection.tsx')).toContain('href={`/fundraisers?campaign=${c.id}`}');
        const campaigns = code('app/fundraisers/page.tsx');
        expect(campaigns).toContain("const campaignParam = searchParams.get('campaign');");
        expect(campaigns).toContain('setDetailCampaign({ ...target, triage: triageCampaign(target, new Date()) });');
    });

    it('46. the website inquiry flow and coordinator setup are untouched by this phase', () => {
        const pub = code('app/api/public/fundraiser-request/route.ts');
        expect(pub).toContain('fundraiserOpportunity.create');
        expect(pub).toContain('fundraiserInquiry.create');
        // The discard capability lives in its own route; nothing else gained a delete.
        const sources = ['app/api/opportunities/route.ts', 'app/api/opportunities/[id]/route.ts', 'app/api/opportunities/[id]/launch/route.ts'];
        for (const s of sources) expect(code(s)).not.toContain('fundraiserOpportunity.delete');
    });
});
