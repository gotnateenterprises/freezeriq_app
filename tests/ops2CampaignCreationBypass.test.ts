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
 *
 * OPS-2 COMPLETION CORRECTION -- three gaps the first pass left open, all
 * closed below:
 *
 *   GAP 1 (date authority): the fix above closed the Bundle-pool half of the
 *   contract but never checked the date half. StartFundraiserWizard --
 *   which BOTH surviving callers of this route use, including the
 *   FundraisersTab.tsx path this phase just rewired -- posts to
 *   /api/campaigns with no delivery_date field at all; the route never asked
 *   for one. A campaign could go Active with a real allowed-Bundle pool and
 *   still no confirmed delivery date. The route now requires and validates
 *   one (deliveryDate), reusing lib/fundraiserLaunch.ts's own
 *   checkConfirmedDate/checkOrderDeadline -- the exact functions the
 *   canonical launch route calls -- rather than a second date contract.
 *
 *   GAP 2 (duplicate creation): the opportunityId branch of runCreate has a
 *   real atomic claim (FR-LAUNCH-1E's conditional UPDATE); the direct/no-
 *   opportunity branch -- what a brand-new organization always uses -- had
 *   none. A double-click, a retried request, or two open tabs could create
 *   two campaigns for the same submission. runCreate's direct branch now
 *   takes a Postgres advisory transaction lock keyed to (customer_id, name)
 *   before checking for a campaign already created in the last 30 seconds,
 *   so a concurrent identical submission resolves to what the first one
 *   already created instead of racing it -- no schema change, no new table.
 *
 *   GAP 3 (Lead/import orderability): resolveCampaignOrderMode never checked
 *   campaign.status at all -- only closed_at and bundle_selection_status. A
 *   status:'Lead' row (exactly what fundraisers/upload creates, carrying the
 *   schema's not_required default) fell through to the not_required
 *   "legacy fallback: business-wide validation preserved" branch and was
 *   immediately orderable against the whole catalog if its id were known.
 *   The gate now requires status === 'Active' first, independent of and in
 *   addition to the bundle-selection matrix -- a historical Active
 *   not_required campaign is unaffected; a pre-launch Lead row now fails
 *   closed.
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
    // findFirst here also backs gap 2's recent-duplicate check (inside the
    // transaction) and its catch-handler re-read; defaults to "none found"
    // below so every other test's happy path is unaffected.
    fundraiserCampaign: { create: jest.fn(), findFirst: jest.fn() },
    campaignBundle: { createMany: jest.fn() },
    // OPS-2 (gap 2): the advisory-lock statement. A real no-op against this
    // mock -- what's under test is runCreate's LOGIC given the lock already
    // serialized the race, exactly how FR-LAUNCH-1E's own tests exercise the
    // conditional-UPDATE branch by asserting the code's response to a
    // count:0 claim rather than reproducing a real concurrent transaction.
    $executeRaw: jest.fn(),
};
db.$transaction = jest.fn(async (fn: any) => fn(db));
jest.mock('@/lib/db', () => ({ prisma: db }));

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { email: 'owner@tenant-a.com', businessId: TENANT_A } });
    db.customer.findFirst.mockResolvedValue({ id: 'cust-1', tax_status: 'UNKNOWN' });
    db.business.findUnique.mockResolvedValue({ default_food_tax_percent: 8 });
    db.fundraiserCampaign.create.mockImplementation(async (args: any) => ({ id: 'camp-1', ...args.data }));
    db.fundraiserCampaign.findFirst.mockResolvedValue(null);
    db.campaignBundle.createMany.mockResolvedValue({ count: 0 });
    db.$transaction.mockImplementation(async (fn: any) => fn(db));
    db.$executeRaw.mockResolvedValue(undefined);
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

// OPS-2 (gap 1): a valid coordinator_selects body with BOTH required dates
// present and correctly ordered (deadline on/before delivery). Individual
// tests override just the field(s) under test.
const validCoordinatorSelectsBody = (extra: Record<string, unknown> = {}) => ({
    customerId: 'cust-1', name: 'Spring Sale',
    deliveryDate: '2026-05-10',
    endDate: '2026-05-01',
    bundleSelection: { mode: 'coordinator_selects' as const, candidateFamilyIds: ['fam1'], selectionLimit: 1 },
    ...extra,
});

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

    it('1. NORMAL_VALID_LAUNCH: a real coordinator_selects payload with a confirmed delivery date still succeeds', async () => {
        db.bundle.findMany.mockResolvedValue([
            { id: 'b-fam1-s5', name: 'Family A (S5)', serving_tier: 'serves_5', family_id: 'fam1' },
            { id: 'b-fam1-s2', name: 'Family A (S2)', serving_tier: 'serves_2', family_id: 'fam1' },
        ]);
        const { res, body } = await post(validCoordinatorSelectsBody());
        expect(res.status).toBe(200);
        const data = db.fundraiserCampaign.create.mock.calls[0][0].data;
        expect(data.status).toBe('Active');
        expect(data.bundle_selection_status).toBe('pending');
        // GAP 1: the field this whole correction exists to populate.
        expect(data.delivery_date).toEqual(new Date('2026-05-10T00:00:00.000Z'));
        expect(db.campaignBundle.createMany).toHaveBeenCalled();
    });

    // 9. "not publicly orderable before setup" is proven directly against the
    // real gate (resolveCampaignOrderMode) in the describe block below, using
    // exactly the bundle_selection_status a real new campaign now gets
    // ('pending') -- not restated here as a second, weaker assertion.
});

// ═════════════════════════════════════════════════════════════════════════════
// OPS-2 COMPLETION -- GAP 1: confirmed delivery date is required, distinct
// from and correctly related to the supporter order deadline (endDate).
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns: confirmed delivery-date authority (gap 1)', () => {
    beforeEach(() => {
        db.bundle.findMany.mockResolvedValue([
            { id: 'b-fam1-s5', name: 'Family A (S5)', serving_tier: 'serves_5', family_id: 'fam1' },
            { id: 'b-fam1-s2', name: 'Family A (S2)', serving_tier: 'serves_2', family_id: 'fam1' },
        ]);
    });

    it('a normal creation with NO deliveryDate at all is refused -- the exact gap this correction closes', async () => {
        const { res, body } = await post(validCoordinatorSelectsBody({ deliveryDate: undefined }));
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
        expect(String(body.error)).toMatch(/confirmed delivery date/i);
    });

    it('an unparseable deliveryDate is refused', async () => {
        const { res } = await post(validCoordinatorSelectsBody({ deliveryDate: 'not-a-date' }));
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });

    it('an order deadline (endDate) after the confirmed delivery date is refused', async () => {
        const { res, body } = await post(validCoordinatorSelectsBody({
            deliveryDate: '2026-05-01', endDate: '2026-05-10',
        }));
        expect(res.status).toBe(400);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
        expect(String(body.error)).toMatch(/deliver/i);
    });

    it('endDate remains optional -- unchanged by this correction -- as long as deliveryDate is present', async () => {
        const { res } = await post(validCoordinatorSelectsBody({ endDate: undefined }));
        expect(res.status).toBe(200);
        const data = db.fundraiserCampaign.create.mock.calls[0][0].data;
        expect(data.end_date).toBeUndefined();
        expect(data.delivery_date).toEqual(new Date('2026-05-10T00:00:00.000Z'));
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// OPS-2 COMPLETION -- GAP 2: two repeated/concurrent normal launches for the
// same (customer, name) resolve to ONE FundraiserCampaign.
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns: duplicate-submission protection on the direct creation path (gap 2)', () => {
    beforeEach(() => {
        db.bundle.findMany.mockResolvedValue([
            { id: 'b-fam1-s5', name: 'Family A (S5)', serving_tier: 'serves_5', family_id: 'fam1' },
            { id: 'b-fam1-s2', name: 'Family A (S2)', serving_tier: 'serves_2', family_id: 'fam1' },
        ]);
    });

    it('a resubmitted identical request resolves to the campaign the first request already created, not a second one', async () => {
        // Simulates the state a genuinely concurrent second request would see
        // after waiting on the advisory lock: the first request's campaign
        // already committed. The recent-duplicate check inside the
        // transaction (and, on the thrown-error path, the catch handler's
        // re-read) both go through this same mock.
        db.fundraiserCampaign.findFirst.mockResolvedValue({
            id: 'camp-existing', customer_id: 'cust-1', name: 'Spring Sale',
        });
        const { res, body } = await post(validCoordinatorSelectsBody());
        expect(res.status).toBe(200);
        expect(body.id).toBe('camp-existing');
        expect(body.alreadyConverted).toBe(true);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });

    it('takes the advisory lock scoped to this exact (customer, name) submission before checking for a duplicate', async () => {
        await post(validCoordinatorSelectsBody());
        expect(db.$executeRaw).toHaveBeenCalled();
        // A tagged-template call arrives as (stringsArray, ...interpolatedValues).
        const [strings, ...values] = db.$executeRaw.mock.calls[0];
        expect(strings.join('')).toMatch(/pg_advisory_xact_lock/);
        expect(values).toEqual(['cust-1', 'Spring Sale']);
    });

    it('no recent duplicate found -- the normal, non-racing case -- still creates exactly one campaign', async () => {
        // beforeEach already defaults fundraiserCampaign.findFirst to null.
        const { res } = await post(validCoordinatorSelectsBody());
        expect(res.status).toBe(200);
        expect(db.fundraiserCampaign.create).toHaveBeenCalledTimes(1);
    });

    // ═════════════════════════════════════════════════════════════════════
    // FINAL AUTHORITY PASS -- honest scope of the duplicate guard.
    //
    // The 30-second window (DUPLICATE_SUBMISSION_WINDOW_MS in
    // app/api/campaigns/route.ts) is real, durable, Postgres-serialized
    // protection against T0 (two genuinely concurrent submissions) and T1/T2
    // (an immediate or near-immediate retry) -- proven by the tests above.
    // It is NOT durable request-level idempotency: a retry outside the
    // window is indistinguishable, at the database level, from an
    // intentional new campaign with the same name, because nothing durable
    // identifies "this exact submission attempt" the way FR-LAUNCH-1E's
    // conditional claim identifies a specific opportunity row. There is no
    // pre-existing row to attach that identity to for a brand-new
    // organization with no tracked opportunity, and adding one would require
    // a schema change, which this phase does not make. These two tests make
    // that boundary explicit and regression-tested rather than an
    // undocumented, easy-to-miss gap.
    // ═════════════════════════════════════════════════════════════════════

    it('T3/T4: a retry outside the duplicate-suppression window creates a SECOND campaign -- by design, this is NOT durable idempotency', async () => {
        // fundraiserCampaign.findFirst defaults to null in beforeEach --
        // exactly what the "no recent duplicate" query returns once the
        // first campaign's created_at has aged out of the 30-second window
        // (or, identically to the database, a genuinely fresh request).
        const { res } = await post(validCoordinatorSelectsBody());
        expect(res.status).toBe(200);
        expect(db.fundraiserCampaign.create).toHaveBeenCalledTimes(1);
        // Do not call this idempotent: a second identical POST right now,
        // still simulating "no recent duplicate," would create a second
        // FundraiserCampaign row with the same (customer_id, name). Nothing
        // in this route prevents that once 30 seconds have passed.
    });

    it('T5 (honest limitation): two DIFFERENTLY-INTENDED campaigns for the same org, submitted within the window under the SAME name, are wrongly collapsed into one', async () => {
        // StartFundraiserWizard auto-fills the campaign name as
        // `${orgName} ${year} Fundraiser` (components/crm2/StartFundraiserWizard.tsx)
        // whenever the field is left blank -- so a tenant launching a second,
        // genuinely distinct campaign for the same organization in the same
        // year, without renaming it, reaches this exact collision through
        // the real UI, not merely a contrived test body. The database
        // cannot distinguish that from a resubmitted retry -- both look
        // identical: same customer_id, same name, within the window.
        db.fundraiserCampaign.findFirst.mockResolvedValue({
            id: 'camp-first-intentional-campaign', customer_id: 'cust-1', name: 'Spring Sale',
        });
        const { res, body } = await post(validCoordinatorSelectsBody());
        // The tenant's second, genuinely different campaign silently never
        // gets created -- they are handed back the FIRST one instead, with
        // no error and no indication anything was skipped.
        expect(res.status).toBe(200);
        expect(body.id).toBe('camp-first-intentional-campaign');
        expect(body.alreadyConverted).toBe(true);
        expect(db.fundraiserCampaign.create).not.toHaveBeenCalled();
    });
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

    it('proves the exact mechanism of the bug this phase closes: a not_required campaign IS immediately orderable against any submitted bundle -- but ONLY once it has actually launched (status Active)', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Active', closed_at: null, bundle_selection_status: 'not_required', bundle_selection_limit: 0, id: 'camp-1' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(true);
        expect(mode.mode).toBe('legacy');
        const eligibility = validateBundleEligibility(mode, ['any-bundle-id-from-the-whole-catalog']);
        expect(eligibility.ok).toBe(true);
    });

    // ── GAP 3: a pre-launch Lead/import row must never reach this same
    //    legacy-allow branch merely because its bundle mode happens to be
    //    the schema's not_required default. ─────────────────────────────────
    it('GAP 3: a status:Lead campaign (exactly what fundraisers/upload creates) is NOT orderable even with its exact id, even carrying not_required', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Lead', closed_at: null, bundle_selection_status: 'not_required', bundle_selection_limit: 0, id: 'camp-imported' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(false);
        expect((mode as any).reasonCode).toBe('not_launched');
        const eligibility = validateBundleEligibility(mode, ['any-bundle-id-from-the-whole-catalog']);
        expect(eligibility.ok).toBe(false);
    });

    it('GAP 3 regression: a Closed campaign remains non-orderable independent of the new status check', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Closed', closed_at: new Date('2026-01-01'), bundle_selection_status: 'not_required', bundle_selection_limit: 0, id: 'camp-closed' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(false);
        expect((mode as any).reasonCode).toBe('closed');
    });

    it('GAP 3 regression: an Archived campaign remains non-orderable independent of the new status check', async () => {
        const mode = await resolveCampaignOrderMode(
            { status: 'Archived', closed_at: null, bundle_selection_status: 'not_required', bundle_selection_limit: 0, id: 'camp-archived' },
            TENANT_A,
        );
        expect(mode.allowed).toBe(false);
        expect((mode as any).reasonCode).toBe('closed');
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
        // A valid deliveryDate/endDate here so this request actually reaches
        // the Bundle-family validation under test, rather than being refused
        // one check earlier (gap 1's date requirement) for an unrelated
        // reason that would make this assertion pass without proving anything.
        const { res, body } = await post(validCoordinatorSelectsBody({
            bundleSelection: { mode: 'coordinator_selects', candidateFamilyIds: ['foreign-family'], selectionLimit: 1 },
        }));
        expect(res.status).toBe(400);
        expect(String(body.error)).toMatch(/families/i);
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

    it('lib/campaignOrderBundles.ts (public orderability gate) keeps its legacy fallback comment and now also gates on launch status', () => {
        const src = read('lib/campaignOrderBundles.ts');
        expect(src).toMatch(/Legacy: no candidate pool, preserve business-wide fallback/);
        // GAP 3
        expect(src).toMatch(/campaign\.status !== 'Active'/);
    });

    it('the New Campaign form in FundraisersTab.tsx now opens the canonical wizard instead of POSTing bundleSelection-less bodies', () => {
        const src = read('components/crm/FundraisersTab.tsx');
        expect(src).toMatch(/StartFundraiserWizard/);
        expect(src).not.toMatch(/handleCreate/);
    });

    it('GAP 1: app/api/campaigns/route.ts reuses the launch route\'s own date checks rather than a second copy', () => {
        const src = read('app/api/campaigns/route.ts');
        expect(src).toMatch(/checkConfirmedDate/);
        expect(src).toMatch(/checkOrderDeadline/);
        expect(src).toMatch(/from '@\/lib\/fundraiserLaunch'/);
    });

    it('GAP 2: runCreate\'s direct-creation branch takes an advisory lock before creating', () => {
        const src = read('app/api/campaigns/route.ts');
        expect(src).toMatch(/pg_advisory_xact_lock/);
    });

    it('lib/fundraiserLaunch.ts: checkOpportunityLaunchable now delegates its date check to the shared checkConfirmedDate, not a duplicated copy', () => {
        const src = read('lib/fundraiserLaunch.ts');
        expect(src).toMatch(/export function checkConfirmedDate/);
        expect(src).toMatch(/checkConfirmedDate\(o\.confirmed_delivery_date\)/);
    });
});
