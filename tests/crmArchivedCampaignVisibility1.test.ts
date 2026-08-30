/**
 * CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1 — an archived fundraiser must leave every
 * operational Campaigns-dashboard bucket (Create invoice, Closed — awaiting
 * payment, Needs attention, Worth a look, Active, Leads & upcoming, Recently
 * completed), regardless of invoice/payment state. Archiving is a filing
 * decision, not a financial one; it says nothing about whether money is owed.
 *
 * TWO REAL ARCHIVE SIGNALS EXIST TODAY — both traced by direct reading, not
 * assumption:
 *
 *   1. FundraiserCampaign.status === 'Archived' — already part of the
 *      CLOSED_FAMILY/CLOSED_STATUS_FAMILY vocabulary in THREE places
 *      (lib/growth/nextAction.ts, lib/campaignDisplayStage.ts,
 *      lib/growth/campaignLifecycle.ts), and lib/growth/campaignLifecycle.ts's
 *      own header comment names REAL production campaigns carrying it today:
 *      "Edgar County and Coles County are Archived, carry $2,065 and $1,410 of
 *      real orders, have no invoice, and are not yet marked settled
 *      externally — so they read as awaiting payment" — which is EXACTLY the
 *      defect the owner reported. Nothing invented; this status value already
 *      exists and is already populated on real rows.
 *
 *   2. Customer.archived (Boolean) / archived_at (DateTime?) — the
 *      ORGANIZATION-level archive flag, written correctly by
 *      lib/statusWorkflow.ts's archiveCustomer/unarchiveCustomer/setStatus,
 *      reachable in the UI via the "Archive"/"Reactivate" button in
 *      FundraiserOverview.tsx / CustomerOverview.tsx. That button calls
 *      onUpdateCustomer({archived: !isArchived}), which PUTs to
 *      /api/customers/[id] — but that route's finalUpdateData whitelist
 *      (confirmed by direct reading) never read body.archived at all, so
 *      every click has silently no-op'd at the database layer. Proven, not
 *      guessed: the field exists, the correct write helper already exists
 *      and is unused by this route, the UI's confirm() dialog and button
 *      label are unambiguous, and the DELETE handler's own error messages
 *      ("archiving keeps the campaigns, orders, and contact history") show
 *      the application's own authors intended it to work. Part P's exception
 *      licenses a tiny correction to this proven-broken existing action.
 *
 * A campaign is archived-for-dashboard-purposes when EITHER signal is true —
 * see isArchivedForDashboard. Fixture 6 below only reproduces through the
 * SECOND signal (an organization archived while its last campaign row is
 * still nominally 'Active'), which is why both signals are load-bearing.
 */

const NOW = new Date('2026-08-30T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

// ═════════════════════════════════════════════════════════════════════════════
// PART F — the seven required fixtures, at the real classification boundary.
// ═════════════════════════════════════════════════════════════════════════════
describe('triageCampaign: archive outranks every operational classification', () => {
    const { triageCampaign, isArchivedForDashboard } = require('@/lib/growth/nextAction');

    it('1. CLOSED_NOT_ARCHIVED_NO_INVOICE may still show Create invoice (unchanged)', () => {
        const t = triageCampaign({
            status: 'Closed', closed_at: days(-3),
            invoice_statuses: [], settlement_total: 500, held_order_count: 0,
        }, NOW);
        expect(t.priority).toBe('awaiting_payment');
        expect(t.action?.label).toBe('Create invoice');
    });

    it('2. CLOSED_NOT_ARCHIVED_UNPAID_INVOICE may still show Closed — awaiting payment (unchanged)', () => {
        const t = triageCampaign({
            status: 'Closed', closed_at: days(-3),
            invoice_statuses: ['SENT'], settlement_total: 500,
        }, NOW);
        expect(t.priority).toBe('awaiting_payment');
    });

    it('3. ARCHIVED_NO_INVOICE (Edgar/Coles shape: real sales, no invoice) is excluded entirely', () => {
        const t = triageCampaign({
            status: 'Archived', closed_at: null,
            invoice_statuses: [], settlement_total: null, held_order_count: 5,
        }, NOW);
        expect(t.priority).toBeNull();
        expect(t.action).toBeNull();
    });

    it('4. ARCHIVED_UNPAID_INVOICE is excluded entirely, not filed as awaiting payment', () => {
        const t = triageCampaign({
            status: 'Archived', invoice_statuses: ['SENT'], settlement_total: 500,
        }, NOW);
        expect(t.priority).toBeNull();
    });

    it('5. ARCHIVED_PAID_INVOICE is excluded entirely, not even filed as Recently completed', () => {
        const t = triageCampaign({
            status: 'Archived', invoice_statuses: ['PAID'], settlement_total: 500,
        }, NOW);
        expect(t.priority).toBeNull();
    });

    it('6. ARCHIVED_WITH_STALE_NEEDS_ATTENTION_SIGNAL (org archived, campaign row still Active) is excluded, not Needs attention', () => {
        const t = triageCampaign({
            status: 'Active', organization_archived: true,
            health: 'at_risk',
            health_reasons: [
                { code: 'no_orders_yet', label: 'x', kind: 'heuristic' },
                { code: 'no_coordinator_activity', label: 'x', kind: 'heuristic' },
            ],
        }, NOW);
        expect(t.priority).toBeNull();
    });

    it('7. ACTIVE_NORMAL_CAMPAIGN is completely unaffected', () => {
        const t = triageCampaign({ status: 'Active', health: 'on_pace', organization_archived: false }, NOW);
        expect(t.priority).toBe('on_pace');
        expect(t.action).toBeNull();
    });

    it('isArchivedForDashboard: true for campaign-status archived', () => {
        expect(isArchivedForDashboard({ status: 'Archived' })).toBe(true);
    });

    it('isArchivedForDashboard: true for organization-archived', () => {
        expect(isArchivedForDashboard({ status: 'Active', organization_archived: true })).toBe(true);
    });

    it('isArchivedForDashboard: false otherwise', () => {
        expect(isArchivedForDashboard({ status: 'Active', organization_archived: false })).toBe(false);
        expect(isArchivedForDashboard({ status: 'Closed' })).toBe(false);
    });

    // ── Part M items 8-11: non-archived behavior must be byte-identical ──────
    it('8. non-archived closed/no-invoice behavior unchanged (paid campaign still completes)', () => {
        const t = triageCampaign({ status: 'Closed', closed_at: days(-3), invoice_statuses: ['PAID'], settlement_total: 500 }, NOW);
        expect(t.priority).toBe('completed');
    });

    it('9. non-archived closed/unpaid behavior unchanged', () => {
        const t = triageCampaign({ status: 'Closed', closed_at: days(-3), invoice_statuses: ['OVERDUE'], settlement_total: 500 }, NOW);
        expect(t.priority).toBe('awaiting_payment');
    });

    it('10. paid non-archived closed campaign behavior unchanged', () => {
        const t = triageCampaign({ status: 'Settled', settled_externally: true, invoice_statuses: [], settlement_total: 500 }, NOW);
        expect(t.priority).toBe('completed');
    });

    it('11. an ordinary active campaign with a real warning sign still shows Worth a look', () => {
        const t = triageCampaign({ status: 'Active', health: 'watch', health_reasons: [{ code: 'behind_pace', label: 'x', kind: 'heuristic' }] }, NOW);
        expect(t.priority).toBe('worth_a_look');
    });

    it('a placeholder Lead for an archived organization is excluded, not filed under Leads & upcoming', () => {
        const t = triageCampaign({ status: 'Lead', is_placeholder: true, organization_archived: true }, NOW);
        expect(t.priority).toBeNull();
    });

    it('a placeholder Lead for a normal organization is unaffected', () => {
        const t = triageCampaign({ status: 'Lead', is_placeholder: true, organization_archived: false }, NOW);
        expect(t.priority).toBe('upcoming');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// groupCampaignsByPriority: archived campaigns never become a rendered row,
// in ANY section -- this is the one authoritative choke point every dashboard
// filter pill (all/attention/awaiting/active/lead/closed) ultimately renders
// through, so fixing it here fixes every pill without touching page code.
// ═════════════════════════════════════════════════════════════════════════════
describe('groupCampaignsByPriority: archived campaigns produce no section membership at all', () => {
    const { groupCampaignsByPriority } = require('@/lib/growth/campaignSections');

    it('an archived campaign with a stale at_risk signal is absent from every section', () => {
        const archived = {
            id: 'a1', status: 'Archived', invoice_statuses: [], settlement_total: null, held_order_count: 5,
        };
        const normal = { id: 'n1', status: 'Active', health: 'on_pace', health_reasons: [] };
        const sections = groupCampaignsByPriority([archived, normal], NOW);

        const allIds = sections.flatMap((s: any) => s.campaigns.map((c: any) => c.id));
        expect(allIds).not.toContain('a1');
        expect(allIds).toContain('n1');
    });

    it('a dashboard of only archived campaigns renders zero sections, not an empty "Recently completed"', () => {
        const sections = groupCampaignsByPriority([
            { id: 'a1', status: 'Archived', invoice_statuses: ['PAID'], settlement_total: 500 },
            { id: 'a2', status: 'Active', organization_archived: true, health: 'at_risk', health_reasons: [] },
        ], NOW);
        expect(sections).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// summarizeAttention: the attention-strip counts must agree with the sections
// -- an archived campaign must not inflate "Needs attention" or held-order
// totals even when the archive signal is organization-level (not caught by
// the pre-existing isClosedFamily check alone).
// ═════════════════════════════════════════════════════════════════════════════
describe('summarizeAttention: archived campaigns never inflate the attention strip', () => {
    const { summarizeAttention } = require('@/lib/growth/nextAction');

    it('an org-archived campaign with stale at_risk health and held orders is not counted', () => {
        const s = summarizeAttention([
            {
                id: 'a1', status: 'Active', organization_archived: true,
                health: 'at_risk', health_reasons: [],
                held_order_count: 3, held_order_total: 450,
            },
        ], NOW);
        expect(s).toEqual({ needsAttention: 0, heldOrders: 0, heldValue: 0 });
    });

    it('a genuine (non-archived) at_risk campaign with held orders is still counted (unchanged)', () => {
        const s = summarizeAttention([
            {
                id: 'r1', status: 'Active', health: 'at_risk', health_reasons: [],
                held_order_count: 3, held_order_total: 450,
            },
        ], NOW);
        expect(s).toEqual({ needsAttention: 1, heldOrders: 3, heldValue: 450 });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Route-level mocks for THIS FILE, shared by both describe blocks below.
//
// jest.mock is file-scoped and hoisted, not describe-scoped: two separate
// jest.mock('@/lib/db', ...) calls in one file silently collide -- the
// second overrides the first for the WHOLE file, not just its own describe
// block. So both routes' Prisma surfaces live on one combined `db` here,
// declared once.
// ═════════════════════════════════════════════════════════════════════════════
const TENANT_A = 'biz-aaaa-1111';
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const db: any = {
    business: { findUnique: jest.fn(async () => ({ slug: 'test-biz' })) },
    customer: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(async () => ({})),
    },
    fundraiserCampaign: {
        findMany: jest.fn(),
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
    },
    invoice: { groupBy: jest.fn(async () => []) },
    fundraiserOpportunity: { groupBy: jest.fn(async () => []) },
};
jest.mock('@/lib/db', () => ({ prisma: db }));

// ═════════════════════════════════════════════════════════════════════════════
// /api/campaigns GET now exposes organization_archived (Customer.archived),
// already fetched with no select restriction -- purely additive.
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/campaigns exposes organization_archived on every row', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { businessId: TENANT_A } });
        db.business.findUnique.mockResolvedValue({ slug: 'test-biz' });
        db.invoice.groupBy.mockResolvedValue([]);
        db.fundraiserOpportunity.groupBy.mockResolvedValue([]);
    });

    it('a real campaign row carries the owning organization\'s archived flag', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Edgar County', contact_name: null, archived: true, archived_at: new Date('2026-01-01') }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([{
            id: 'camp-1', name: 'Fall Fundraiser', status: 'Archived', customer_id: 'c1',
            created_at: new Date('2026-01-01T00:00:00.000Z'), start_date: null, end_date: null,
            goal_amount: null, bundle_goal: 20, total_sales: 2065, participant_label: 'Seller',
            group_label: null, is_group_enabled: false, portal_token: 'tok', closed_at: null,
            org_share_percent: 20, tax_status: null, tax_rate_percent: null,
            settlement_total: null, settled_externally: false, invoices: [],
            _count: { coordinator_actions: 0 }, orders: [],
            bundle_selection_status: 'selected', bundle_selection_at: null,
            primary_coordinator: null,
        }]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(body[0].organization_archived).toBe(true);
    });

    it('a normal, non-archived organization\'s campaign carries organization_archived: false', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Org', contact_name: null, archived: false, archived_at: null }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([{
            id: 'camp-1', name: 'Fall Fundraiser', status: 'Active', customer_id: 'c1',
            created_at: new Date('2026-08-13T00:00:00.000Z'), start_date: null, end_date: null,
            goal_amount: null, bundle_goal: 20, total_sales: 0, participant_label: 'Seller',
            group_label: null, is_group_enabled: false, portal_token: 'tok', closed_at: null,
            org_share_percent: 20, tax_status: null, tax_rate_percent: null,
            settlement_total: null, settled_externally: false, invoices: [],
            _count: { coordinator_actions: 0 }, orders: [],
            bundle_selection_status: 'selected', bundle_selection_at: null,
            primary_coordinator: null,
        }]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(body[0].organization_archived).toBe(false);
    });

    it('a placeholder Lead row for an archived organization also carries organization_archived: true', async () => {
        db.customer.findMany.mockResolvedValue([{ id: 'c1', name: 'Archived Org', contact_name: null, archived: true, archived_at: new Date('2026-01-01') }]);
        db.fundraiserCampaign.findMany.mockResolvedValue([]);

        const { GET } = require('@/app/api/campaigns/route');
        const res = await GET(new Request('https://www.freezeriqapp.com/api/campaigns'));
        const body = await res.json();

        expect(body[0].is_placeholder).toBe(true);
        expect(body[0].organization_archived).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PUT /api/customers/[id] — the proven-broken "Archive" persistence, fixed.
// Tenant isolation (Part M item 13) is pre-existing and unmodified here;
// covered by re-asserting the existing ownership check still runs.
// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /api/customers/[id] now actually persists the Archive button\'s intent', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAuth.mockResolvedValue({ user: { businessId: TENANT_A } });
        db.customer.findUnique.mockResolvedValue({ business_id: TENANT_A });
        db.customer.update.mockResolvedValue({});
        db.fundraiserCampaign.findFirst.mockResolvedValue(null);
    });

    const put = async (id: string, body: unknown) => {
        const { PUT } = require('@/app/api/customers/[id]/route');
        const req = new Request(`http://localhost/api/customers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return PUT(req, { params: Promise.resolve({ id }) });
    };

    it('archived: true writes archived + archived_at together, matching lib/statusWorkflow.ts\'s own convention', async () => {
        const res = await put('11111111-1111-1111-1111-111111111111', { name: 'Org', archived: true });
        expect(res.status).toBe(200);
        const data = db.customer.update.mock.calls[0][0].data;
        expect(data.archived).toBe(true);
        expect(data.archived_at).toBeInstanceOf(Date);
    });

    it('archived: false (Reactivate) clears both fields together', async () => {
        const res = await put('11111111-1111-1111-1111-111111111111', { name: 'Org', archived: false });
        expect(res.status).toBe(200);
        const data = db.customer.update.mock.calls[0][0].data;
        expect(data.archived).toBe(false);
        expect(data.archived_at).toBeNull();
    });

    it('a normal profile save that omits archived leaves the field untouched, matching every other field\'s convention', async () => {
        const res = await put('11111111-1111-1111-1111-111111111111', { name: 'Org', notes: 'updated notes' });
        expect(res.status).toBe(200);
        const data = db.customer.update.mock.calls[0][0].data;
        expect('archived' in data).toBe(false);
        expect('archived_at' in data).toBe(false);
    });

    it('does not touch status as a side effect of archiving -- the UI never asked for that', async () => {
        await put('11111111-1111-1111-1111-111111111111', { archived: true });
        const data = db.customer.update.mock.calls[0][0].data;
        expect(data.status).toBeUndefined();
    });

    it('13. tenant isolation is unchanged: a cross-tenant PUT is still refused before any write', async () => {
        db.customer.findUnique.mockResolvedValue({ business_id: 'some-other-tenant' });
        const res = await put('11111111-1111-1111-1111-111111111111', { archived: true });
        expect(res.status).toBe(403);
        expect(db.customer.update).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Part M item 14 -- classification is pure and mutates nothing. Enforced at
// the source level: these are plain functions with no Prisma import at all.
// ═════════════════════════════════════════════════════════════════════════════
describe('classification never mutates invoices, orders, or payments', () => {
    it('lib/growth/nextAction.ts imports no database client', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'growth', 'nextAction.ts'), 'utf8');
        expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/);
    });

    it('lib/growth/campaignSections.ts imports no database client', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'growth', 'campaignSections.ts'), 'utf8');
        expect(src).not.toMatch(/from ['"]@\/lib\/db['"]/);
    });
});
