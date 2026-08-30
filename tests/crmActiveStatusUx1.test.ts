/**
 * CRM-ACTIVE-STATUS-UX-1 — two owner-approved UX changes to the Campaign
 * Priority List (components/crm2/CampaignPriorityList.tsx), reachable from
 * the Campaigns tab of app/fundraisers/page.tsx.
 *
 * CHANGE 1 — SECTION ORDER. The owner's resolution (asked directly, since the
 * Campaigns tab actually has SIX priority sections, not five — "Needs
 * attention" and "Closed — awaiting payment" aren't in the owner's 5-item
 * list at all): those two urgent/money-owed sections stay pinned first,
 * unconditionally; the owner's requested order applies to everything after
 * them. Old: needs_attention, awaiting_payment, worth_a_look, on_pace,
 * upcoming, completed. New: needs_attention, awaiting_payment, on_pace
 * ("Active"), worth_a_look ("Worth a look"), upcoming ("Leads & upcoming"),
 * completed ("Recently completed"). A minimal two-value swap in
 * lib/growth/nextAction.ts's PRIORITY_RANK — membership logic
 * (triageCampaign) is completely untouched.
 *
 * CHANGE 2 — REPLACE "No signal yet". Traced to lib/growth/health.ts's
 * `no_signal` CampaignHealth, rendered by CampaignHealthBadge.tsx. A freshly
 * launched campaign (status Active, bundle_selection_status 'pending', zero
 * orders) computes health='no_signal' for its first
 * HEALTH_THRESHOLDS.bundleSelectionPendingDays (5) days — the exact case the
 * owner saw. Root cause: nothing in the Active row read the ALREADY-EXISTING
 * authoritative setup state (lib/campaignDisplayStage.ts's
 * awaitingCoordinatorSetup, and FundraiserCampaignCoordinator.setup_email_sent_at
 * — a real, durable, provider-confirmed timestamp, not an inference from a
 * button click) at all. The new lib/growth/coordinatorSetupStatus.ts reuses
 * both rather than reinventing either. "Coordinator changes pending" (the
 * preferred state D) is deliberately NOT implemented: there is no
 * distinguishable "reopened" state in the data model — a coordinator
 * reselection re-submits while bundle_selection_status stays 'selected', so
 * there is nothing reliable to derive it from (confirmed by reading
 * app/api/coordinator/bundle-selection/route.ts, not assumed).
 */

const NOW = new Date('2026-08-14T12:00:00.000Z');

// ═════════════════════════════════════════════════════════════════════════════
// CHANGE 1 — section order (Part K items 1-4).
// ═════════════════════════════════════════════════════════════════════════════
describe('section order: Active before Worth a look, urgent sections stay first', () => {
    it('PRIORITY_RANK: needs_attention and awaiting_payment remain first and second', () => {
        const { PRIORITY_RANK } = require('@/lib/growth/nextAction');
        expect(PRIORITY_RANK.needs_attention).toBe(0);
        expect(PRIORITY_RANK.awaiting_payment).toBe(1);
    });

    it('PRIORITY_RANK: on_pace ("Active") now ranks before worth_a_look ("Worth a look")', () => {
        const { PRIORITY_RANK } = require('@/lib/growth/nextAction');
        expect(PRIORITY_RANK.on_pace).toBeLessThan(PRIORITY_RANK.worth_a_look);
    });

    it('PRIORITY_RANK: upcoming ("Leads & upcoming") and completed stay last, in order', () => {
        const { PRIORITY_RANK } = require('@/lib/growth/nextAction');
        expect(PRIORITY_RANK.worth_a_look).toBeLessThan(PRIORITY_RANK.upcoming);
        expect(PRIORITY_RANK.upcoming).toBeLessThan(PRIORITY_RANK.completed);
    });

    it('the real section list, built from real campaigns via groupCampaignsByPriority, reflects the new order', () => {
        const { groupCampaignsByPriority } = require('@/lib/growth/campaignSections');
        const atRisk = { id: 'r', status: 'Active', end_date: '2026-08-24', health: 'at_risk', health_reasons: [{ code: 'no_orders_yet', label: 'x', kind: 'heuristic' }, { code: 'no_coordinator_activity', label: 'x', kind: 'heuristic' }] };
        const owedInvoice = { id: 'o', status: 'Settled', invoice_statuses: ['SENT'], settlement_total: 250, held_order_count: 0 };
        const onPace = { id: 'p', status: 'Active', end_date: '2026-08-24', health: 'on_pace', health_reasons: [] };
        const watch = { id: 'w', status: 'Active', end_date: '2026-08-24', health: 'watch', health_reasons: [{ code: 'behind_pace', label: 'x', kind: 'heuristic' }] };
        const lead = { id: 'l', status: 'Lead', is_placeholder: true };
        const done = { id: 'd', status: 'Settled', invoice_statuses: ['PAID'], settlement_total: 250, held_order_count: 0 };

        const sections = groupCampaignsByPriority([done, lead, watch, onPace, owedInvoice, atRisk], NOW);
        expect(sections.map((s: any) => s.priority)).toEqual([
            'needs_attention', 'awaiting_payment', 'on_pace', 'worth_a_look', 'upcoming', 'completed',
        ]);
        expect(sections.map((s: any) => s.meta.title)).toEqual([
            'Needs attention', 'Closed — awaiting payment', 'Active', 'Worth a look', 'Leads & upcoming', 'Recently completed',
        ]);
    });

    it('membership (triageCampaign) is completely unchanged by the reorder', () => {
        const { triageCampaign } = require('@/lib/growth/nextAction');
        // Same fixtures/expectations as the pre-existing "section membership by
        // lifecycle" suite in tests/growthCampaignSections.test.ts -- this phase
        // must not touch WHICH bucket a campaign lands in, only the order.
        expect(triageCampaign({ status: 'Active', health: 'watch', health_reasons: [] }, NOW).priority).toBe('worth_a_look');
        expect(triageCampaign({ status: 'Active', health: 'on_pace', health_reasons: [] }, NOW).priority).toBe('on_pace');
        expect(triageCampaign({ status: 'Active', health: 'no_signal', health_reasons: [] }, NOW).priority).toBe('on_pace');
        expect(triageCampaign({ status: 'Lead', is_placeholder: true }, NOW).priority).toBe('upcoming');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// CHANGE 2 — the new coordinator-setup status derivation, pure and testable.
// ═════════════════════════════════════════════════════════════════════════════
describe('resolveCoordinatorSetupStatus', () => {
    const { resolveCoordinatorSetupStatus } = require('@/lib/growth/coordinatorSetupStatus');

    it('A: setup pending, invite never sent -> "Coordinator invite not sent"', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'pending',
            coordinator_invite_sent_at: null, health: 'no_signal',
        });
        expect(r).toEqual({ label: 'Coordinator invite not sent', key: 'invite_not_sent' });
    });

    it('B: setup pending, invite sent -> "Waiting on coordinator" + helper text', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'pending',
            coordinator_invite_sent_at: '2026-08-10T00:00:00.000Z', health: 'no_signal',
        });
        expect(r).toEqual({
            label: 'Waiting on coordinator',
            helper: 'Meal selection & setup pending',
            key: 'waiting_on_coordinator',
        });
    });

    it('B still applies even if health somehow computed at_risk/watch for a pending campaign', () => {
        // The coordinator-status message is strictly MORE specific than a generic
        // health signal for exactly this case, and takes precedence -- matching
        // the owner's literal IF/ELSEIF order (coordinator-setup checked first).
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'pending',
            coordinator_invite_sent_at: '2026-08-01T00:00:00.000Z', health: 'at_risk',
        });
        expect(r?.label).toBe('Waiting on coordinator');
    });

    it('C: setup complete (selected), health no_signal, zero orders -> "Open for orders", NOT "No signal yet"', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'selected',
            coordinator_invite_sent_at: '2026-08-01T00:00:00.000Z', health: 'no_signal',
        });
        expect(r).toEqual({ label: 'Open for orders', key: 'open_for_orders' });
    });

    it('C also applies to legacy not_required campaigns (always orderable, no coordinator gate)', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'not_required',
            coordinator_invite_sent_at: null, health: 'no_signal',
        });
        expect(r?.label).toBe('Open for orders');
    });

    it('a genuinely at-risk, fully-set-up campaign is left alone -- returns null so the real health badge still shows', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'selected',
            coordinator_invite_sent_at: '2026-08-01T00:00:00.000Z', health: 'at_risk',
        });
        expect(r).toBeNull();
    });

    it('a worth-a-look, fully-set-up campaign is left alone -- health signal is already specific and useful', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'selected',
            coordinator_invite_sent_at: '2026-08-01T00:00:00.000Z', health: 'watch',
        });
        expect(r).toBeNull();
    });

    it('an on-pace, fully-set-up campaign is left alone -- real progress already speaks for itself', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', bundle_selection_status: 'selected',
            coordinator_invite_sent_at: '2026-08-01T00:00:00.000Z', health: 'on_pace',
        });
        expect(r).toBeNull();
    });

    it('a closed campaign never returns a workflow-status override', () => {
        const r = resolveCoordinatorSetupStatus({
            status: 'Active', closed_at: '2026-08-01T00:00:00.000Z',
            bundle_selection_status: 'pending', coordinator_invite_sent_at: null, health: 'no_signal',
        });
        expect(r).toBeNull();
    });

    it('reuses campaignDisplayStage rather than reimplementing the pending/active gate', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'growth', 'coordinatorSetupStatus.ts'), 'utf8');
        expect(src).toMatch(/import\s*\{[^}]*campaignDisplayStage[^}]*\}\s*from\s*['"]@\/lib\/campaignDisplayStage['"]/);
        // Not a second, competing definition of "pending".
        expect(src).not.toMatch(/status\.toLowerCase\(\)\s*===\s*['"]active['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// The /api/campaigns row now carries the fields the new derivation needs.
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/campaigns exposes bundle_selection_status and coordinator_invite_sent_at', () => {
    const TENANT_A = 'biz-aaaa-1111';

    const mockAuth = jest.fn();
    jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

    const db: any = {
        business: { findUnique: jest.fn(async () => ({ slug: 'test-biz' })) },
        customer: { findMany: jest.fn() },
        fundraiserCampaign: { findMany: jest.fn() },
        invoice: { groupBy: jest.fn(async () => []) },
        fundraiserOpportunity: { groupBy: jest.fn(async () => []) },
    };
    jest.mock('@/lib/db', () => ({ prisma: db }));

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { businessId: TENANT_A } });
        db.business.findUnique.mockResolvedValue({ slug: 'test-biz' });
        db.invoice.groupBy.mockResolvedValue([]);
        db.fundraiserOpportunity.groupBy.mockResolvedValue([]);
    });

    it('a pending campaign with an unsent invite carries both new fields through to the client', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Org', contact_name: null }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([{
            id: 'camp-1', name: 'Fall Fundraiser', status: 'Active', customer_id: 'c1',
            created_at: new Date('2026-08-13T00:00:00.000Z'), start_date: null, end_date: null,
            goal_amount: null, bundle_goal: 20, total_sales: 0, participant_label: 'Seller',
            group_label: null, is_group_enabled: false, portal_token: 'tok', closed_at: null,
            org_share_percent: 20, tax_status: null, tax_rate_percent: null,
            settlement_total: null, settled_externally: false, invoices: [],
            _count: { coordinator_actions: 0 }, orders: [],
            bundle_selection_status: 'pending', bundle_selection_at: null,
            primary_coordinator: { setup_email_sent_at: null, setup_email_claimed_at: null },
        }]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(body).toHaveLength(1);
        expect(body[0].bundle_selection_status).toBe('pending');
        expect(body[0].coordinator_invite_sent_at).toBeNull();
    });

    it('a sent invite is passed through as the real timestamp, not a boolean', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Org', contact_name: null }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([{
            id: 'camp-1', name: 'Fall Fundraiser', status: 'Active', customer_id: 'c1',
            created_at: new Date('2026-08-13T00:00:00.000Z'), start_date: null, end_date: null,
            goal_amount: null, bundle_goal: 20, total_sales: 0, participant_label: 'Seller',
            group_label: null, is_group_enabled: false, portal_token: 'tok', closed_at: null,
            org_share_percent: 20, tax_status: null, tax_rate_percent: null,
            settlement_total: null, settled_externally: false, invoices: [],
            _count: { coordinator_actions: 0 }, orders: [],
            bundle_selection_status: 'pending', bundle_selection_at: null,
            primary_coordinator: { setup_email_sent_at: new Date('2026-08-14T00:00:00.000Z'), setup_email_claimed_at: new Date('2026-08-14T00:00:00.000Z') },
        }]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(body[0].coordinator_invite_sent_at).toBe('2026-08-14T00:00:00.000Z');
    });

    it('a campaign with no primary_coordinator row yet (not launched via FR-FLOW-2B) degrades to null, not a throw', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Org', contact_name: null }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([{
            id: 'camp-1', name: 'Legacy Fundraiser', status: 'Active', customer_id: 'c1',
            created_at: new Date('2026-08-13T00:00:00.000Z'), start_date: null, end_date: null,
            goal_amount: null, bundle_goal: 20, total_sales: 0, participant_label: 'Seller',
            group_label: null, is_group_enabled: false, portal_token: null, closed_at: null,
            org_share_percent: 20, tax_status: null, tax_rate_percent: null,
            settlement_total: null, settled_externally: false, invoices: [],
            _count: { coordinator_actions: 0 }, orders: [],
            bundle_selection_status: 'not_required', bundle_selection_at: null,
            primary_coordinator: null,
        }]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body[0].coordinator_invite_sent_at).toBeNull();
        expect(body[0].bundle_selection_status).toBe('not_required');
    });

    it('the query selects the primary_coordinator relation for the sent timestamp, not a second interpretation', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'app', 'api', 'campaigns', 'route.ts'), 'utf8');
        expect(src).toMatch(/primary_coordinator:\s*\{\s*select:\s*\{[^}]*setup_email_sent_at/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// CampaignHealthBadge/CampaignPriorityList wiring (source-level -- this repo
// has no React render harness; the real derivation logic above is already
// executed directly, not mirrored).
// ═════════════════════════════════════════════════════════════════════════════
describe('the Active row wires the new fields through to the badge', () => {
    const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8');

    it('CampaignHealthBadge imports and calls resolveCoordinatorSetupStatus', () => {
        const src = read('components/crm2/CampaignHealthBadge.tsx');
        expect(src).toMatch(/import\s*\{[^}]*resolveCoordinatorSetupStatus[^}]*\}\s*from\s*['"]@\/lib\/growth\/coordinatorSetupStatus['"]/);
    });

    it('CampaignPriorityList passes bundle_selection_status and coordinator_invite_sent_at to the badge', () => {
        const src = read('components/crm2/CampaignPriorityList.tsx');
        expect(src).toMatch(/<CampaignHealthBadge[\s\S]{0,300}bundleSelectionStatus/);
        expect(src).toMatch(/<CampaignHealthBadge[\s\S]{0,300}coordinatorInviteSentAt/);
    });

    it('PriorityListCampaign carries coordinator_invite_sent_at in its type', () => {
        const src = read('components/crm2/CampaignPriorityList.tsx');
        expect(src).toMatch(/coordinator_invite_sent_at/);
    });
});
