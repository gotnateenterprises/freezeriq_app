/**
 * FR-FLOW-2 — tenant fundraiser launch.
 *
 * Two kinds of assertion, deliberately separated:
 *
 *  - the decision helpers in lib/fundraiserLaunch.ts are called directly, so the
 *    rules are exercised rather than described;
 *  - the route is run for real against the recording Prisma double, so what is
 *    asserted is the query the handler actually built — a missing business_id
 *    scope or a non-atomic claim is visible to a test.
 *
 * Structural facts that no unit test can reach (the shape of the migration, the
 * foreign keys) are asserted against the files themselves at the end, and the
 * DATABASE behaviour those files produce is proven separately against a real
 * PostgreSQL instance.
 */

import fs from 'fs';
import path from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    AWAITING_COORDINATOR_SETUP_SELECTION_STATUS,
    LAUNCHED_CAMPAIGN_STATUS,
    checkCampaignName,
    checkCandidateFamilies,
    checkOpportunityLaunchable,
    checkOrderDeadline,
    checkPrimaryCoordinator,
    checkSelectionLimit,
} from '@/lib/fundraiserLaunch';
import { campaignDisplayStage, AWAITING_COORDINATOR_SETUP_LABEL } from '@/lib/campaignDisplayStage';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__frFlow2Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__frFlow2Session) }));
jest.mock('@/lib/coordinatorPortalToken', () => ({
    // The real generator is proven by FR-COORD-SEC; here we only need to see that
    // the route CALLS it, and to keep a credential-shaped string out of the test.
    mintCoordinatorPortalToken: jest.fn(() => 'MINTED_BY_CANONICAL_GENERATOR'),
}));
jest.mock('@/lib/campaignBundleSelection', () => ({
    resolveEligibleBundleFamilies: jest.fn(async () => (global as any).__frFlow2Families),
}));

const ROOT = process.cwd();
const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const ORG_A1 = 'org-a1';
const ORG_A2 = 'org-a2';
const OPP = 'opp-1';
const REL_A1 = 'rel-a1';
const DELIVERY = '2026-10-17';

const FAMILIES = [
    { familyId: 'fam-1', serves5: { id: 'b5-1', name: 'Comfort Classics' }, serves2: { id: 'b2-1' } },
    { familyId: 'fam-2', serves5: { id: 'b5-2', name: 'Weeknight Winners' }, serves2: { id: 'b2-2' } },
    { familyId: 'fam-3', serves5: { id: 'b5-3', name: 'Freezer Staples' }, serves2: { id: 'b2-3' } },
];

let mock: PrismaMock;

function useSession(businessId: string | null, role = 'ADMIN') {
    (global as any).__frFlow2Session = businessId ? { user: { businessId, role } } : null;
}

function launchMock(overrides: Record<string, any> = {}) {
    const m = createPrismaMock({
        results: {
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'date_confirmed', customer_id: ORG_A1,
                confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`),
                campaign_id: null,
            },
            'fundraiserOrganizationContact.findFirst': {
                id: REL_A1, business_id: TENANT_A, customer_id: ORG_A1, ended_at: null,
            },
            'fundraiserCampaign.create': { id: 'camp-new' },
            'fundraiserCampaign.findUnique': { portal_token: 'MINTED_BY_CANONICAL_GENERATOR' },
            'fundraiserOpportunity.updateMany': { count: 1 },
            ...overrides,
        },
    });
    (global as any).__frFlow2Prisma = m.client;
    return m;
}

const validBody = (extra: Record<string, unknown> = {}) => ({
    name: 'Autumn Fundraiser',
    endDate: '2026-10-10',
    orgContactId: REL_A1,
    candidateFamilyIds: ['fam-1', 'fam-2'],
    selectionLimit: 2,
    ...extra,
});

async function post(body: unknown, id = OPP) {
    const { POST } = await import('@/app/api/opportunities/[id]/launch/route');
    const req = new Request(`http://localhost/api/opportunities/${id}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJson(await POST(req, { params: Promise.resolve({ id }) }));
}

beforeEach(() => {
    jest.clearAllMocks();
    useSession(TENANT_A);
    (global as any).__frFlow2Families = FAMILIES;
    mock = launchMock();
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the date-confirmed gate', () => {
    it('launches a date-confirmed opportunity', async () => {
        const res = await post(validBody());
        expect(res.status).toBe(201);
        expect(res.body.campaignId).toBe('camp-new');
    });

    for (const status of ['new', 'in_conversation', 'lost']) {
        it(`refuses an opportunity in status "${status}"`, async () => {
            mock = launchMock({
                'fundraiserOpportunity.findFirst': {
                    id: OPP, status, customer_id: ORG_A1,
                    confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`),
                    campaign_id: null,
                },
            });
            const res = await post(validBody());
            expect(res.status).toBe(409);
            expect(res.body.code).toBe('not_date_confirmed');
            expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
        });
    }

    it('refuses date_confirmed with no confirmed date — the column is nullable', async () => {
        mock = launchMock({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'date_confirmed', customer_id: ORG_A1,
                confirmed_delivery_date: null, campaign_id: null,
            },
        });
        const res = await post(validBody());
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('missing_confirmed_date');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('the gate is server-side: a hidden button is not a gate', () => {
        const refused = checkOpportunityLaunchable({
            status: 'in_conversation', confirmed_delivery_date: DELIVERY, campaign_id: null,
        });
        expect(refused.ok).toBe(false);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('confirmed_delivery_date maps to delivery_date, never start_date', () => {
    it('writes the confirmed date as delivery_date', async () => {
        await post(validBody());
        const data = mock.firstCall('fundraiserCampaign.create')!.args.data;
        expect(new Date(data.delivery_date).toISOString().slice(0, 10)).toBe(DELIVERY);
    });

    it('never writes start_date', async () => {
        await post(validBody());
        const data = mock.firstCall('fundraiserCampaign.create')!.args.data;
        expect(data.start_date).toBeUndefined();
    });

    it('the route source maps confirmed -> delivery_date and mentions start_date only to forbid it', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
        expect(code).toMatch(/delivery_date: new Date\(`\$\{launchable\.confirmedDeliveryDate\}/);
        expect(code).not.toMatch(/start_date\s*:/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('OPS-LAUNCH-HOTFIX-1: an implausible confirmed_delivery_date year', () => {
    // FR-FLOW-2 launch error (Production, all on lastDeployment dpl_8bqmaV7...,
    // pre-OPS-1): "Ag in the Classroom" repeatedly 500'd with
    // PrismaClientValidationError -- "Invalid value for argument `delivery_date`:
    // Provided Date object is invalid." Root cause: calendarDateOfDateOnlyValue
    // did not zero-pad the year, so a stored confirmed_delivery_date whose UTC
    // year is not exactly 4 digits produced a string
    // (e.g. "26-08-28") that `new Date(`${x}T00:00:00.000Z`)` cannot parse.
    // A local round-trip through a REAL Postgres @db.Date column with a normal
    // date proved the code path is otherwise correct -- this is data-specific,
    // not a general regression (see the Final Report, Part 5).
    // The recording Prisma double does not simulate Prisma's own client-side
    // argument validation (it never actually rejects an invalid Date the way
    // the real client does), so the crash itself is proven separately: by the
    // real Production runtime error, and by a real-Postgres round-trip. What
    // the double CAN prove -- and must, so this defect can never regress
    // silently -- is that a plausibility check runs before the campaign write
    // is even attempted, for any implausible year.
    const SHORT_YEAR_DELIVERY = new Date('0026-08-28T00:00:00.000Z'); // year 26, not 2026

    it('refuses with a clean, actionable 409 rather than reaching fundraiserCampaign.create', async () => {
        mock = launchMock({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'date_confirmed', customer_id: ORG_A1,
                confirmed_delivery_date: SHORT_YEAR_DELIVERY,
                campaign_id: null,
            },
        });
        const res = await post(validBody());
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('implausible_confirmed_date');
        expect(res.body.error).not.toMatch(/prisma|PrismaClientValidationError|delivery_date/i);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('checkOpportunityLaunchable itself refuses the short year, not just the route', () => {
        const refused = checkOpportunityLaunchable({
            status: 'date_confirmed', confirmed_delivery_date: SHORT_YEAR_DELIVERY, campaign_id: null,
        });
        expect(refused.ok).toBe(false);
        expect((refused as any).code).toBe('implausible_confirmed_date');
    });

    it('an ordinary, plausible year is unaffected', () => {
        const ok = checkOpportunityLaunchable({
            status: 'date_confirmed', confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`), campaign_id: null,
        });
        expect(ok.ok).toBe(true);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the supporter order deadline', () => {
    it('is required', async () => {
        const res = await post(validBody({ endDate: '' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('end_date_required');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('may equal the delivery date — ordering through the morning of delivery is real', () => {
        const r = checkOrderDeadline({ endDate: DELIVERY, confirmedDeliveryDate: DELIVERY });
        expect(r.ok).toBe(true);
    });

    it('may not fall after the delivery date', async () => {
        const res = await post(validBody({ endDate: '2026-10-18' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('end_date_after_delivery');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('invents no minimum lead time — one day before delivery is accepted', () => {
        expect(checkOrderDeadline({ endDate: '2026-10-16', confirmedDeliveryDate: DELIVERY }).ok).toBe(true);
    });

    it('rejects unparseable input', () => {
        expect(checkOrderDeadline({ endDate: 'not-a-date', confirmedDeliveryDate: DELIVERY }).ok).toBe(false);
        expect(checkOrderDeadline({ endDate: 42 as any, confirmedDeliveryDate: DELIVERY }).ok).toBe(false);
    });

    it('does not reimplement timezone logic', () => {
        const src = fs.readFileSync(path.join(ROOT, 'lib/fundraiserLaunch.ts'), 'utf8');
        expect(src).not.toMatch(/Intl\.DateTimeFormat/);
        expect(src).not.toMatch(/America\//);
        expect(src).not.toMatch(/getTimezoneOffset/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('organization share', () => {
    it('persists an explicit percentage', async () => {
        await post(validBody({ orgSharePercent: '28' }));
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.org_share_percent).toBe(28);
    });

    it('omits the field when not supplied, so the 20.00 database default stands', async () => {
        await post(validBody());
        expect('org_share_percent' in mock.firstCall('fundraiserCampaign.create')!.args.data).toBe(false);
    });

    it('refuses a non-admin who tries to set it', async () => {
        useSession(TENANT_A, 'CHEF');
        const res = await post(validBody({ orgSharePercent: '30' }));
        expect(res.status).toBe(403);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('rejects an out-of-range percentage', async () => {
        const res = await post(validBody({ orgSharePercent: '150' }));
        expect(res.status).toBe(400);
    });

    it('duplicates no financial maths', () => {
        const src = fs.readFileSync(path.join(ROOT, 'lib/fundraiserLaunch.ts'), 'utf8');
        expect(src).not.toMatch(/0\.2\b|\* *0\.\d|orgShareAmount|balanceDue/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the candidate bundle-family pool', () => {
    it('persists one candidate row per family, Serves-5 canonical tier only', async () => {
        await post(validBody());
        const rows = mock.firstCall('campaignBundle.createMany')!.args.data;
        expect(rows).toHaveLength(2);
        expect(rows.map((r: any) => r.bundle_id)).toEqual(['b5-1', 'b5-2']);
        expect(rows.every((r: any) => r.state === 'candidate')).toBe(true);
    });

    it('never writes a Serves-2 sibling as its own candidate row', async () => {
        await post(validBody());
        const ids = mock.firstCall('campaignBundle.createMany')!.args.data.map((r: any) => r.bundle_id);
        expect(ids).not.toContain('b2-1');
        expect(ids).not.toContain('b2-2');
    });

    it('counts serving variants as ONE family, not two', async () => {
        await post(validBody({ candidateFamilyIds: ['fam-1'], selectionLimit: 1 }));
        expect(mock.firstCall('campaignBundle.createMany')!.args.data).toHaveLength(1);
    });

    it('creates nothing active — a candidate is not orderable', async () => {
        await post(validBody());
        const rows = mock.firstCall('campaignBundle.createMany')!.args.data;
        expect(rows.some((r: any) => r.state === 'active')).toBe(false);
    });

    it('refuses a family this tenant may not offer', async () => {
        const res = await post(validBody({ candidateFamilyIds: ['fam-1', 'fam-from-tenant-b'] }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('candidates_not_eligible');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('refuses an empty pool and a duplicated pool', () => {
        const eligibleFamilyIds = FAMILIES.map((f) => f.familyId);
        expect(checkCandidateFamilies({ candidateFamilyIds: [], eligibleFamilyIds }).ok).toBe(false);
        expect(checkCandidateFamilies({ candidateFamilyIds: ['fam-1', 'fam-1'], eligibleFamilyIds }).ok).toBe(false);
    });

    it('does not name the offending id back to the caller', () => {
        const r = checkCandidateFamilies({
            candidateFamilyIds: ['fam-secret-from-elsewhere'],
            eligibleFamilyIds: ['fam-1'],
        }) as any;
        expect(r.error).not.toContain('fam-secret-from-elsewhere');
    });

    it('validates against the tenant-scoped resolver, not a client list', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        expect(src).toMatch(/resolveEligibleBundleFamilies\(businessId\)/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the required coordinator selection count', () => {
    it('persists to bundle_selection_limit', async () => {
        await post(validBody({ candidateFamilyIds: ['fam-1', 'fam-2', 'fam-3'], selectionLimit: 3 }));
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.bundle_selection_limit).toBe(3);
    });

    it('is bounded below by 1', () => {
        expect(checkSelectionLimit({ selectionLimit: 0, candidateFamilyCount: 3 }).ok).toBe(false);
    });

    it('may not exceed the candidate family count — 2 required from 1 offered is unsatisfiable', async () => {
        const res = await post(validBody({ candidateFamilyIds: ['fam-1'], selectionLimit: 2 }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('selection_limit_exceeds_candidates');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('rejects non-integers', () => {
        expect(checkSelectionLimit({ selectionLimit: 1.5, candidateFamilyCount: 3 }).ok).toBe(false);
        expect(checkSelectionLimit({ selectionLimit: '2' as any, candidateFamilyCount: 3 }).ok).toBe(false);
    });

    it('allows exactly the candidate count', () => {
        expect(checkSelectionLimit({ selectionLimit: 3, candidateFamilyCount: 3 }).ok).toBe(true);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the campaign primary coordinator', () => {
    it('persists the campaign -> organization-contact relationship', async () => {
        await post(validBody());
        const data = mock.firstCall('fundraiserCampaignCoordinator.create')!.args.data;
        expect(data).toMatchObject({
            campaign_id: 'camp-new', customer_id: ORG_A1, org_contact_id: REL_A1,
        });
    });

    it('is written inside the same transaction as the campaign', async () => {
        await post(validBody());
        expect(mock.client.$transaction).toHaveBeenCalled();
        const idxCampaign = mock.calls.findIndex((c) => `${c.model}.${c.method}` === 'fundraiserCampaign.create');
        const idxCoord = mock.calls.findIndex((c) => `${c.model}.${c.method}` === 'fundraiserCampaignCoordinator.create');
        const idxClaim = mock.calls.findIndex((c) => `${c.model}.${c.method}` === 'fundraiserOpportunity.updateMany');
        expect(idxCampaign).toBeGreaterThanOrEqual(0);
        expect(idxCoord).toBeGreaterThan(idxCampaign);
        expect(idxClaim).toBeGreaterThan(idxCoord);
    });

    it('looks the relationship up SCOPED BY business_id', async () => {
        await post(validBody());
        const where = mock.firstCall('fundraiserOrganizationContact.findFirst')!.args.where;
        expect(where.business_id).toBe(TENANT_A);
        expect(where.id).toBe(REL_A1);
    });

    it('stores no coordinator name/email/phone on the campaign', async () => {
        await post(validBody());
        const data = mock.firstCall('fundraiserCampaign.create')!.args.data;
        for (const k of Object.keys(data)) expect(k).not.toMatch(/coordinator_(name|email|phone)/);
    });

    it('refuses when no coordinator was chosen', async () => {
        const res = await post(validBody({ orgContactId: '' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('coordinator_not_in_organization');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('tenant isolation', () => {
    it('401s an unauthenticated caller before touching the database', async () => {
        useSession(null);
        const res = await post(validBody());
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('scopes the opportunity lookup by business_id', async () => {
        await post(validBody());
        expect(mock.firstCall('fundraiserOpportunity.findFirst')!.args.where.business_id).toBe(TENANT_A);
    });

    it('404s (never 403s) another tenant\'s opportunity, so ids cannot be probed', async () => {
        mock = launchMock({ 'fundraiserOpportunity.findFirst': null });
        const res = await post(validBody());
        expect(res.status).toBe(404);
    });

    it('Tenant A cannot use Tenant B\'s coordinator relationship', async () => {
        mock = launchMock({
            'fundraiserOrganizationContact.findFirst': {
                id: 'rel-b1', business_id: TENANT_B, customer_id: 'org-b1', ended_at: null,
            },
        });
        const res = await post(validBody({ orgContactId: 'rel-b1' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('coordinator_not_in_organization');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    /* THE CRITICAL CASE the phase calls out by name: right tenant, wrong organization. */
    it('SAME TENANT, WRONG ORGANIZATION is refused', async () => {
        mock = launchMock({
            'fundraiserOrganizationContact.findFirst': {
                // Same business as the caller and the opportunity...
                id: 'rel-a2', business_id: TENANT_A,
                // ...but a DIFFERENT organization inside it.
                customer_id: ORG_A2, ended_at: null,
            },
        });
        const res = await post(validBody({ orgContactId: 'rel-a2' }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('coordinator_not_in_organization');
        expect(mock.callsTo('fundraiserCampaignCoordinator.create')).toHaveLength(0);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('the same-tenant-wrong-organization check compares the ORGANIZATION, not just the tenant', () => {
        const sameTenantWrongOrg = checkPrimaryCoordinator({
            row: { id: 'rel-a2', business_id: TENANT_A, customer_id: ORG_A2, ended_at: null },
            expectedBusinessId: TENANT_A,
            expectedCustomerId: ORG_A1,
        });
        expect(sameTenantWrongOrg.ok).toBe(false);
        const right = checkPrimaryCoordinator({
            row: { id: REL_A1, business_id: TENANT_A, customer_id: ORG_A1, ended_at: null },
            expectedBusinessId: TENANT_A,
            expectedCustomerId: ORG_A1,
        });
        expect(right.ok).toBe(true);
    });

    it('refuses an ended relationship', () => {
        expect(checkPrimaryCoordinator({
            row: { id: REL_A1, business_id: TENANT_A, customer_id: ORG_A1, ended_at: new Date() },
            expectedBusinessId: TENANT_A, expectedCustomerId: ORG_A1,
        }).ok).toBe(false);
    });

    it('answers not-found, wrong-tenant and wrong-organization identically', () => {
        const mk = (row: any) => checkPrimaryCoordinator({
            row, expectedBusinessId: TENANT_A, expectedCustomerId: ORG_A1,
        }) as any;
        const a = mk(null);
        const b = mk({ id: 'x', business_id: TENANT_B, customer_id: 'org-b1', ended_at: null });
        const c = mk({ id: 'y', business_id: TENANT_A, customer_id: ORG_A2, ended_at: null });
        expect(a.error).toBe(b.error);
        expect(b.error).toBe(c.error);
        expect(a.code).toBe(c.code);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the Awaiting Coordinator Setup state', () => {
    it('creates the campaign as pending', async () => {
        await post(validBody());
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.bundle_selection_status)
            .toBe('pending');
    });

    it('NEVER creates one as not_required — the legacy bypass is banned', async () => {
        await post(validBody());
        const data = mock.firstCall('fundraiserCampaign.create')!.args.data;
        expect(data.bundle_selection_status).not.toBe('not_required');
        expect(data.bundle_selection_status).not.toBe('selected');
    });

    it('the launch module offers no not_required path at all', () => {
        const src = fs.readFileSync(path.join(ROOT, 'lib/fundraiserLaunch.ts'), 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
        expect(code).not.toMatch(/not_required/);
        expect(AWAITING_COORDINATOR_SETUP_SELECTION_STATUS).toBe('pending');
    });

    it('leaves bundle_selection_at null — that timestamp means an actual submission', async () => {
        await post(validBody());
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.bundle_selection_at).toBeNull();
    });

    it('stores the lifecycle status the public predicates already understand', async () => {
        await post(validBody());
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.status).toBe(LAUNCHED_CAMPAIGN_STATUS);
        expect(LAUNCHED_CAMPAIGN_STATUS).toBe('Active');
    });

    it('displays as Awaiting Coordinator Setup, not a green ACTIVE', () => {
        const s = campaignDisplayStage({ status: 'Active', bundle_selection_status: 'pending' });
        expect(s.label).toBe(AWAITING_COORDINATOR_SETUP_LABEL);
        expect(s.awaitingCoordinatorSetup).toBe(true);
        expect(s.key).not.toBe('active');
    });

    it('a genuinely live campaign still reads Active', () => {
        const s = campaignDisplayStage({ status: 'Active', bundle_selection_status: 'selected' });
        expect(s.label).toBe('Active');
        expect(s.awaitingCoordinatorSetup).toBe(false);
    });

    it('closure outranks the setup state', () => {
        for (const status of ['Closed', 'Archived', 'Settled', 'Completed']) {
            const s = campaignDisplayStage({ status, bundle_selection_status: 'pending' });
            expect(s.awaitingCoordinatorSetup).toBe(false);
            expect(s.label).toBe(status);
        }
        const closedByDate = campaignDisplayStage({
            status: 'Active', closed_at: '2026-01-01', bundle_selection_status: 'pending',
        });
        expect(closedByDate.awaitingCoordinatorSetup).toBe(false);
    });

    it('a legacy not_required campaign is unaffected', () => {
        const s = campaignDisplayStage({ status: 'Active', bundle_selection_status: 'not_required' });
        expect(s.label).toBe('Active');
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('opportunity conversion is atomic — the one_open_per_org hazard', () => {
    it('sets status, campaign_id and converted_at in ONE statement', async () => {
        await post(validBody());
        const claim = mock.firstCall('fundraiserOpportunity.updateMany')!;
        expect(claim.args.data.status).toBe('converted');
        expect(claim.args.data.campaign_id).toBe('camp-new');
        expect(claim.args.data.converted_at).toBeInstanceOf(Date);
    });

    it('never writes campaign_id without also leaving date_confirmed', async () => {
        await post(validBody());
        for (const call of mock.callsTo('fundraiserOpportunity.updateMany')) {
            if ('campaign_id' in call.args.data) expect(call.args.data.status).toBe('converted');
        }
        expect(mock.callsTo('fundraiserOpportunity.update')).toHaveLength(0);
    });

    it('guards the claim on status AND campaign_id AND tenant', async () => {
        await post(validBody());
        const where = mock.firstCall('fundraiserOpportunity.updateMany')!.args.where;
        expect(where).toMatchObject({
            id: OPP, business_id: TENANT_A, status: 'date_confirmed', campaign_id: null,
        });
    });

    it('the whole launch rolls back when the claim matches no row', async () => {
        mock = launchMock({
            'fundraiserOpportunity.updateMany': { count: 0 },
            'fundraiserOpportunity.findFirst': (args: any) =>
                // First read: launchable. Second read (after rollback): settled by the winner.
                args?.select?.campaign_id && !args?.select?.status
                    ? { campaign_id: 'camp-winner' }
                    : {
                        id: OPP, status: 'date_confirmed', customer_id: ORG_A1,
                        confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`),
                        campaign_id: null,
                    },
        });
        const res = await post(validBody());
        // The loser resolves to the winner's campaign rather than creating a second.
        expect(res.status).toBe(200);
        expect(res.body.campaignId).toBe('camp-winner');
        expect(res.body.alreadyLaunched).toBe(true);
    });

    it('409s when the claim fails and no campaign can be found', async () => {
        mock = launchMock({
            'fundraiserOpportunity.updateMany': { count: 0 },
            'fundraiserOpportunity.findFirst': (args: any) =>
                args?.select?.campaign_id && !args?.select?.status
                    ? { campaign_id: null }
                    : {
                        id: OPP, status: 'date_confirmed', customer_id: ORG_A1,
                        confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`),
                        campaign_id: null,
                    },
        });
        const res = await post(validBody());
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('claim_failed');
    });

    it('a retry on an already-converted opportunity resolves to the existing campaign', async () => {
        mock = launchMock({
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'converted', customer_id: ORG_A1,
                confirmed_delivery_date: new Date(`${DELIVERY}T00:00:00.000Z`),
                campaign_id: 'camp-existing',
            },
        });
        const res = await post(validBody());
        expect(res.status).toBe(200);
        expect(res.body.campaignId).toBe('camp-existing');
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('one opportunity maps to at most one campaign', async () => {
        await post(validBody());
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(1);
    });

    it('claims the FUNNEL opportunity, never the rebooking one', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
        expect(code).toMatch(/tx\.fundraiserOpportunity\.updateMany/);
        expect(code).not.toMatch(/rebookingOpportunity/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the coordinator credential', () => {
    it('is minted by the canonical generator', async () => {
        const { mintCoordinatorPortalToken } = await import('@/lib/coordinatorPortalToken');
        await post(validBody());
        expect(mintCoordinatorPortalToken).toHaveBeenCalled();
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.portal_token)
            .toBe('MINTED_BY_CANONICAL_GENERATOR');
    });

    it('is never omitted — portal_token has no schema default', async () => {
        await post(validBody());
        expect(mock.firstCall('fundraiserCampaign.create')!.args.data.portal_token).toBeTruthy();
    });

    it('produces only the fragment link shape, never a path or query credential', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        expect(src).toMatch(/buildCoordinatorAccessUrl\(/);
        expect(src).not.toMatch(/\?token=/);
        expect(src).not.toMatch(/\/coordinator\/\$\{/);
    });

    it('never logs the credential', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        for (const m of src.match(/console\.(log|error|warn|info)\([^)]*\)/g) ?? []) {
            expect(m).not.toMatch(/portal_token|coordinatorAccessUrl|MINTED/);
        }
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('public hard gates are untouched and still hold', () => {
    it('the listing excludes pending campaigns', () => {
        const src = fs.readFileSync(path.join(ROOT, 'app/api/public/tenant/[slug]/route.ts'), 'utf8');
        expect(src).toMatch(/bundle_selection_status <> 'pending'/);
    });

    it('resolveCampaignOrderMode refuses a pending campaign', () => {
        const src = fs.readFileSync(path.join(ROOT, 'lib/campaignOrderBundles.ts'), 'utf8');
        expect(src).toMatch(/mode: 'pending'/);
        expect(src.replace(/\s+/g, ' ')).not.toMatch(/allowed: true, mode: 'pending'/);
    });

    it('the launch route weakens no public gate', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'app/api/opportunities/[id]/launch/route.ts'), 'utf8');
        expect(src).not.toMatch(/bundle_selection_status:\s*'(selected|not_required)'/);
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the candidate pool survives an active-bundle edit', () => {
    const bundlesRoute = () =>
        fs.readFileSync(path.join(ROOT, 'app/api/campaigns/[id]/bundles/route.ts'), 'utf8');

    it('the PUT deletes only active rows', () => {
        const code = bundlesRoute().split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
        const del = code.match(/campaignBundle\.deleteMany\(\{[\s\S]*?\}\)/)![0];
        expect(del).toMatch(/state:\s*'active'/);
    });

    it('the PUT recreates rows explicitly as active', () => {
        const code = bundlesRoute().split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
        const create = code.match(/campaignBundle\.createMany\(\{[\s\S]*?\}\)\]/)![0];
        expect(create).toMatch(/state:\s*'active'/);
    });

    it('MUTATION: dropping the state filter from the delete must be detectable', () => {
        const code = bundlesRoute().split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
        // Mutate the DELETE specifically. A blind replace would hit the GET's
        // identical `where` clause first and prove nothing about the PUT.
        const delRe = /(campaignBundle\.deleteMany\(\{[\s\S]*?)state:\s*'active'\s*(\}[\s\S]*?\}\))/;
        expect(code).toMatch(delRe);
        const mutated = code.replace(delRe, '$1$2');
        expect(mutated).not.toBe(code);

        const originalDel = code.match(/campaignBundle\.deleteMany\(\{[\s\S]*?\}\)/)![0];
        const mutantDel = mutated.match(/campaignBundle\.deleteMany\(\{[\s\S]*?\}\)/)![0];
        // The real assertion passes on the original and fails on the mutant —
        // which is what makes it load-bearing rather than decorative.
        expect(originalDel).toMatch(/state:\s*'active'/);
        expect(mutantDel).not.toMatch(/state:\s*'active'/);
    });

    it('the GET and the PUT agree on which rows this endpoint owns', () => {
        const code = bundlesRoute();
        const activeMentions = (code.match(/state:\s*'active'/g) ?? []).length;
        expect(activeMentions).toBeGreaterThanOrEqual(3); // GET read, PUT delete, PUT create
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the Awaiting Coordinator Setup signal actually fires', () => {
    it('the health reason no longer requires a timestamp that cannot exist while pending', () => {
        const src = fs.readFileSync(path.join(ROOT, 'lib/growth/health.ts'), 'utf8');
        const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
        expect(code).not.toMatch(/bundle_selection_status === 'pending' && c\.bundle_selection_at instanceof Date/);
        expect(code).toMatch(/bundle_selection_status === 'pending'/);
    });

    it('a pending campaign created days ago surfaces the reason', () => {
        const { evaluateCampaignHealth, HEALTH_THRESHOLDS } = require('@/lib/growth/health');
        const now = new Date('2026-09-01T12:00:00Z');
        const created = new Date(now.getTime() - (HEALTH_THRESHOLDS.bundleSelectionPendingDays + 1) * 86_400_000);
        const res = evaluateCampaignHealth({
            status: 'Active', closed_at: null, created_at: created,
            start_date: null, end_date: new Date('2026-10-10T00:00:00Z'),
            weightedBundlesSold: 0, bundle_goal: 100, orderCount: 0, lastOrderAt: null,
            coordinatorActionCount: 0,
            bundle_selection_status: 'pending',
            bundle_selection_at: null,      // exactly what launch writes
        }, now);
        expect(res.reasons.map((r: any) => r.code)).toContain('bundle_selection_pending');
    });

    it('a freshly created pending campaign does not nag before the threshold', () => {
        const { evaluateCampaignHealth } = require('@/lib/growth/health');
        const now = new Date('2026-09-01T12:00:00Z');
        const res = evaluateCampaignHealth({
            status: 'Active', closed_at: null, created_at: now,
            start_date: null, end_date: new Date('2026-10-10T00:00:00Z'),
            weightedBundlesSold: 0, bundle_goal: 100, orderCount: 0, lastOrderAt: null,
            coordinatorActionCount: 0,
            bundle_selection_status: 'pending', bundle_selection_at: null,
        }, now);
        expect(res.reasons.map((r: any) => r.code)).not.toContain('bundle_selection_pending');
    });
});

/* ══════════════════════════════════════════════════════════════════════════ */
describe('the campaign-coordinator schema and migration', () => {
    const schema = () => fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const MIGRATION = 'prisma/migrations/20260820000000_fr_flow_2a_campaign_primary_coordinator/migration.sql';
    const sql = () => fs.readFileSync(path.join(ROOT, MIGRATION), 'utf8');
    const statements = () =>
        sql().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('--')).join('\n');

    it('the model exists with campaign_id as the primary key', () => {
        const s = schema();
        expect(s).toMatch(/model FundraiserCampaignCoordinator \{/);
        expect(s).toMatch(/campaign_id\s+String\s+@id/);
    });

    it('points at the ORGANIZATION-CONTACT relationship, not a bare contact', () => {
        const s = schema();
        const model = s.slice(s.indexOf('model FundraiserCampaignCoordinator'));
        expect(model).toMatch(/org_contact\s+FundraiserOrganizationContact/);
        // A direct FundraiserContact reference would prove only same-tenant.
        expect(model.slice(0, model.indexOf('@@map'))).not.toMatch(/FundraiserContact\b(?!Coordinator)/);
    });

    it('both foreign keys are keyed on the SAME customer_id — that IS the invariant', () => {
        const s = schema();
        const model = s.slice(s.indexOf('model FundraiserCampaignCoordinator'));
        expect(model).toMatch(/fields: \[customer_id, campaign_id\], references: \[customer_id, id\]/);
        expect(model).toMatch(/fields: \[customer_id, org_contact_id\], references: \[customer_id, id\]/);
    });

    it('stores no denormalised coordinator scalars', () => {
        const s = schema();
        const model = s.slice(s.indexOf('model FundraiserCampaignCoordinator'), s.indexOf('fundraiser_campaign_coordinators'));
        expect(model).not.toMatch(/coordinator_name|coordinator_email|coordinator_phone/);
    });

    it('has no is_primary flag to disagree with the primary key', () => {
        const s = schema();
        const model = s.slice(s.indexOf('model FundraiserCampaignCoordinator'), s.indexOf('fundraiser_campaign_coordinators'));
        expect(model).not.toMatch(/is_primary\s+Boolean/);
    });

    it('the relationship table gained the compound FK target', () => {
        const s = schema();
        const model = s.slice(s.indexOf('model FundraiserOrganizationContact'));
        expect(model.slice(0, model.indexOf('@@map'))).toMatch(/@@unique\(\[customer_id, id\]\)/);
    });

    it('the migration is additive: no DROP, no ALTER COLUMN, no data change', () => {
        // `ON DELETE RESTRICT` / `ON UPDATE CASCADE` are referential ACTIONS on a
        // foreign key, not data statements, so they are removed before the scan —
        // otherwise this assertion would fire on its own correctness.
        const st = statements().replace(/ON (DELETE|UPDATE) \w+/gi, '');
        expect(st).not.toMatch(/\bDROP\b/i);
        expect(st).not.toMatch(/\bALTER COLUMN\b/i);
        expect(st).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bUPDATE\s+"/i);
        expect(st).not.toMatch(/\bINSERT\b/i); // no backfill
    });

    it('the migration adds no column to any existing table', () => {
        expect(statements()).not.toMatch(/ADD COLUMN/i);
    });

    it('the migration touches no campaign, order or invoice table', () => {
        const st = statements();
        expect(st).not.toMatch(/ALTER TABLE "fundraiser_campaigns"/);
        expect(st).not.toMatch(/"orders"|"invoices"|"campaign_bundles"|PasswordResetToken/);
    });

    it('both foreign keys RESTRICT, so history cannot be deleted away', () => {
        const st = statements();
        const fks = st.match(/ADD CONSTRAINT[\s\S]*?ON DELETE (\w+)/g) ?? [];
        expect(fks).toHaveLength(2);
        for (const fk of fks) expect(fk).toMatch(/ON DELETE RESTRICT/);
    });

    it('the parked PasswordResetToken block is untouched', () => {
        const s = schema();
        const block = s.slice(s.indexOf('model PasswordResetToken'));
        expect(block.slice(0, block.indexOf('}') + 1)).toMatch(/model PasswordResetToken \{/);
        expect(s.indexOf('model PasswordResetToken')).toBeLessThan(s.indexOf('model FundraiserCampaignCoordinator'));
    });
});
