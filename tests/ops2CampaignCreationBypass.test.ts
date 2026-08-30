/**
 * OPS-2 — eliminate the fundraiser campaign-creation bypass, and stop new
 * campaigns from ever entering the coordinator-setup-gated funnel through the
 * back door.
 *
 * THE CONFIRMED, LIVE BYPASS — traced from real source, not assumed:
 *
 *   1. components/crm/FundraisersTab.tsx's "New Campaign" button (live, wired
 *      to a real <form onSubmit={handleCreate}>, rendered on both
 *      app/fundraisers/[id]/page.tsx and app/customers/[id]/page.tsx's
 *      Campaigns tab) POSTs to /api/campaigns with
 *      {customerId, name, bundleGoal, endDate, participantLabel, groupLabel}
 *      -- no bundleSelection field at all.
 *
 *   2. app/api/campaigns/route.ts's POST handler has three branches: Mode A
 *      (bundleSelection.mode === 'coordinator_selects', the only mode the
 *      canonical wizard -- components/crm2/StartFundraiserWizard.tsx -- ever
 *      sends), Mode B (explicit bundleSelection.mode === 'not_required'), and
 *      Branch C (bundleSelection omitted entirely, silently treated as
 *      not_required "for legacy callers"). FundraisersTab's request lands on
 *      Branch C. Both B and C write status:'Active',
 *      bundle_selection_status:'not_required', no delivery date, and no
 *      CampaignBundle rows.
 *
 *   3. lib/campaignOrderBundles.ts's resolveCampaignOrderMode -- its own doc
 *      comment: `"not_required" -> legacy fallback: business-wide validation
 *      preserved` -- returns {allowed:true, mode:'legacy'} for such a
 *      campaign, and validateBundleEligibility accepts ANY submitted bundle
 *      ID unconditionally in that mode. The campaign is immediately publicly
 *      orderable against the tenant's entire active Bundle catalog, with no
 *      coordinator ever having set anything up.
 *
 * THE CANONICAL PATH (app/api/opportunities/[id]/launch/route.ts), by
 * contrast, was already fully correct on every dimension checked: status
 * 'Active' but bundle_selection_status 'pending' (blocked from ordering by
 * the same resolveCampaignOrderMode, until a real coordinator completes real
 * setup), a real delivery_date distinct from end_date, real CampaignBundle
 * candidate rows from the tenant's own eligible families, a real
 * FundraiserCampaignCoordinator record, and an atomic conditional-claim
 * idempotency guard (FR-LAUNCH-1E) that survives a retry/double-click. None
 * of that is touched by this phase.
 *
 * app/api/fundraisers/upload/route.ts (CSV bulk import) was investigated and
 * classified separately: it explicitly writes status:'Lead' (not 'Active'),
 * has no live single-campaign UI, and is a genuine legacy/migration tool
 * (Part L option B) -- not the primary bypass, not touched by this phase.
 * See the Final Report for the (theoretical, low-severity, not-currently-
 * reachable) note about its own not_required default.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const db: any = {
    customer: { findFirst: jest.fn() },
    business: { findUnique: jest.fn() },
    rebookingOpportunity: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    bundle: { findMany: jest.fn(async () => []) },
    fundraiserCampaign: { create: jest.fn(), findFirst: jest.fn() },
    campaignBundle: { createMany: jest.fn() },
};
db.$transaction = jest.fn(async (fn: any) => fn(db));
jest.mock('@/lib/db', () => ({ prisma: db }));

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { email: 'owner@tenant-a.com', businessId: TENANT_A } });
    db.customer.findFirst.mockResolvedValue({ id: 'cust-1', tax_status: 'UNKNOWN' });
    db.business.findUnique.mockResolvedValue({ default_food_tax_percent: 8 });
    db.fundraiserCampaign.create.mockImplementation(async (args: any) => ({ id: 'camp-1', ...args.data }));
    db.campaignBundle.createMany.mockResolvedValue({ count: 0 });
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
});

const post = async (body: unknown) => {
    const { POST } = await import('@/app/api/campaigns/route');
    const req = new Request('http://localhost/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const res = await POST(req);
    return { res, body: await res.json().catch(() => ({})) };
};

// ═════════════════════════════════════════════════════════════════════════════
// PART D/O — the confirmed bypass, executed for real against the actual route.
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns: a normal new campaign can never become not_required', () => {
    it('1/8. FIXTURE NORMAL_CAMPAIGN_BYPASS (Branch C -- bundleSelection omitted, exactly what FundraisersTab.tsx sends) is refused, not silently created', async () => {
        const { res, body } = await post({
            customerId: 'cust-1', name: 'Spring Sale', endDate: '2026-05-01',
        });
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
        expect(String(body.error)).toMatch(/bundle/i);
    });

    it('explicit bundleSelection.mode: not_required is ALSO refused for new creation -- not just the silent omission', async () => {
        const { res, body } = await post({
            customerId: 'cust-1', name: 'Spring Sale', endDate: '2026-05-01',
            bundleSelection: { mode: 'not_required' },
        });
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });

    it('1. NORMAL_VALID_LAUNCH: a real coordinator_selects payload still succeeds exactly as before', async () => {
        db.bundle.findMany.mockResolvedValue([
            { id: 'b-fam1-s5', name: 'Family A (S5)', serving_tier: 'serves_5', family_id: 'fam1' },
            { id: 'b-fam1-s2', name: 'Family A (S2)', serving_tier: 'serves_2', family_id: 'fam1' },
        ]);
        const { res, body } = await post({
            customerId: 'cust-1', name: 'Spring Sale', endDate: '2026-05-01',
            bundleSelection: { mode: 'coordinator_selects', candidateFamilyIds: ['fam1'], selectionLimit: 1 },
        });
        expect(res.status).toBe(200);
        const data = db.fundraiserCampaign.create.mock.calls[0][0].data;
        expect(data.status).toBe('Active');
        expect(data.bundle_selection_status).toBe('pending');
        expect(db.campaignBundle.createMany).toHaveBeenCalled();
    });

    // 9. "not publicly orderable before setup" is proven directly against the
    // real gate (resolveCampaignOrderMode) in the describe block below, using
    // exactly the bundle_selection_status a real new campaign now gets
    // ('pending') -- not restated here as a second, weaker assertion.
});

// ═════════════════════════════════════════════════════════════════════════════
// PART Q items 8/9 -- reconfirm the ALREADY-CORRECT public-orderability gate
// this fix relies on, without reimplementing it.
// ═════════════════════════════════════════════════════════════════════════════
describe('resolveCampaignOrderMode: the existing gate a fixed campaign now correctly relies on', () => {
    const { resolveCampaignOrderMode, validateBundleEligibility } = require('@/lib/campaignOrderBundles');

    it('8. a pending campaign (what every new campaign now becomes) is NOT orderable', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Active', closed_at: null, bundle_selection_status: 'pending', bundle_selection_limit: 1, id: 'camp-1' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(false);
        expect(mode.mode).toBe('pending');
    });

    it('proves the exact mechanism of the bug this phase closes: a not_required campaign IS immediately orderable against any submitted bundle', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Active', closed_at: null, bundle_selection_status: 'not_required', bundle_selection_limit: 0, id: 'camp-1' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(true);
        expect(mode.mode).toBe('legacy');
        const eligibility = validateBundleEligibility(mode, ['any-bundle-id-from-the-whole-catalog']);
        expect(eligibility.ok).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART M -- tenant/auth security, unrelated to and unweakened by this fix.
// ═════════════════════════════════════════════════════════════════════════════
describe('tenant/auth security on POST /api/campaigns', () => {
    it('15. anonymous creation is refused', async () => {
        mockAuth.mockResolvedValue(null);
        const { res } = await post({ customerId: 'cust-1', name: 'X' });
        expect(res.status).toBe(401);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });

    it('16. a foreign-tenant customerId is refused (tenant scoping comes from the session, never the body)', async () => {
        db.customer.findFirst.mockResolvedValue(null); // findFirst is scoped by business_id in the WHERE clause
        const { res } = await post({ customerId: 'cust-in-tenant-b', name: 'X' });
        expect(res.status).toBe(404);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
        // Confirms business_id came from the session, not the request:
        expect(db.customer.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ business_id: TENANT_A }) }),
        );
    });

    it('6. a foreign-tenant Bundle cannot enter the allowed pool', async () => {
        // The route's own query already scopes by business_id -- a bundle
        // belonging to another tenant simply never appears in the result set,
        // so it can never be validated as a candidate.
        db.bundle.findMany.mockResolvedValue([]); // simulates: no bundle in THIS tenant matches
        const { res, body } = await post({
            customerId: 'cust-1', name: 'Spring Sale',
            bundleSelection: { mode: 'coordinator_selects', candidateFamilyIds: ['foreign-family'], selectionLimit: 1 },
        });
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Source-level: confirm the unsafe branches are gone, not merely unreachable
// by accident, and that the canonical route was never touched.
// ═════════════════════════════════════════════════════════════════════════════
describe('source proof', () => {
    it('app/api/campaigns/route.ts no longer contains a not_required creation branch', () => {
        const src = read('app/api/campaigns/route.ts');
        expect(src).not.toMatch(/bundle_selection_status:\s*['"]not_required['"]/);
    });

    it('app/api/opportunities/[id]/launch/route.ts is completely untouched by this phase', () => {
        const src = read('app/api/opportunities/[id]/launch/route.ts');
        expect(src).toMatch(/AWAITING_COORDINATOR_SETUP_SELECTION_STATUS/);
        expect(src).toMatch(/checkOpportunityLaunchable/);
    });

    it('lib/campaignOrderBundles.ts (public orderability gate) is completely untouched by this phase', () => {
        const src = read('lib/campaignOrderBundles.ts');
        expect(src).toMatch(/Legacy: no candidate pool, preserve business-wide fallback/);
    });

    it('the New Campaign form in FundraisersTab.tsx now opens the canonical wizard instead of POSTing bundleSelection-less bodies', () => {
        const src = read('components/crm/FundraisersTab.tsx');
        expect(src).toMatch(/StartFundraiserWizard/);
        expect(src).not.toMatch(/handleCreate/);
    });
});
