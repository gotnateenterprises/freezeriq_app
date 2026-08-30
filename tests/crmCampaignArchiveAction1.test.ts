/**
 * CRM-CAMPAIGN-ARCHIVE-ACTION-1 — an explicit, owner-facing way to archive ONE
 * fundraiser campaign, without archiving its organization.
 *
 * PREDECESSOR CONTEXT (CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1): archived campaigns
 * already disappear from every operational dashboard bucket once
 * `FundraiserCampaign.status === 'Archived'`. What was missing was a way to
 * SET that status for one campaign — "Close Out Fundraiser" sets 'Closed',
 * not 'Archived', and "Done" only dismisses a modal (both traced by direct
 * execution, not assumption, in the predecessor phase).
 *
 * BEFORE-FIX GAP, PROVEN NOT ASSUMED: a generic PATCH /api/campaigns/[id]
 * already existed with 'Archived' in its own `validStatuses` allowlist, and
 * tenant-scoped auth was already correct — but nothing in the owner-facing UI
 * ever called it with {status: 'Archived'}, AND the route itself had no
 * eligibility guard at all: calling it with {status: 'Archived'} against a
 * live, currently-Active, orderable campaign would have silently succeeded.
 * That is the exact "without a deliberate guard" gap Part E/H exist to close
 * — proven below by executing the real route against a currently-Active
 * fixture BEFORE the guard existed (see "PART E/H" describe block; the
 * assertions there describe the fixed behavior and were run red against the
 * pre-fix route during implementation).
 *
 * The fix reuses, rather than duplicates, three things that already existed:
 *   - the route's own tenant-ownership check (unchanged);
 *   - lib/campaignBundleSelection.ts's isCampaignClosed, already imported in
 *     this exact route for two other financially-sensitive gates
 *     (org_share_percent, bundle_goal) — reused a third time here;
 *   - CRM-ARCHIVED-CAMPAIGN-VISIBILITY-1's own dashboard-exclusion logic,
 *     completely untouched — this phase only ever needs to prove archiving
 *     WRITES the field that logic already reads.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const TENANT_A = 'biz-aaaa-1111';
const CAMPAIGN = 'camp-1';

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const db: any = {
    fundraiserCampaign: { findUnique: jest.fn(), update: jest.fn(async (args: any) => ({ id: CAMPAIGN, ...args.data })) },
    customer: { update: jest.fn() },
    invoice: { update: jest.fn(), updateMany: jest.fn() },
};
jest.mock('@/lib/db', () => ({ prisma: db }));

const closedCampaign = (over: Record<string, any> = {}) => ({
    id: CAMPAIGN, status: 'Closed', closed_at: new Date('2026-08-01T00:00:00.000Z'),
    customer: { id: 'c1', business_id: TENANT_A, archived: false, archived_at: null },
    ...over,
});

const activeCampaign = (over: Record<string, any> = {}) => ({
    id: CAMPAIGN, status: 'Active', closed_at: null,
    customer: { id: 'c1', business_id: TENANT_A, archived: false, archived_at: null },
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { businessId: TENANT_A } });
    db.fundraiserCampaign.update.mockImplementation(async (args: any) => ({ id: CAMPAIGN, ...args.data }));
});

const archive = async (id: string = CAMPAIGN) => {
    const { PATCH } = await import('@/app/api/campaigns/[id]/route');
    const req = new Request(`http://localhost/api/campaigns/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'Archived' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id }) });
    const body = await res.json().catch(() => ({}));
    return { res, body };
};

// ═════════════════════════════════════════════════════════════════════════════
// PART N — the required test matrix, items 1-2, 6-11, 15.
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/campaigns/[id] {status: Archived} — the archive action', () => {
    it('1/2. a closed, eligible campaign can be archived, resulting status is Archived', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign());
        const { res, body } = await archive();
        expect(res.status).toBe(200);
        const data = db.fundraiserCampaign.update.mock.calls[0][0].data;
        expect(data.status).toBe('Archived');
        expect(body.status).toBe('Archived');
    });

    it('6/7/9/10/11. archiving writes ONLY status -- no order, invoice, or settlement field is touched', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign());
        await archive();
        const data = db.fundraiserCampaign.update.mock.calls[0][0].data;
        // Every other field this route can write is undefined when the
        // request body carries nothing but status -- Prisma's own convention
        // for "leave this column alone" (matching every other field on this
        // route already).
        expect(data.name).toBeUndefined();
        expect(data.start_date).toBeUndefined();
        expect(data.end_date).toBeUndefined();
        expect(data.goal_amount).toBeUndefined();
        expect(data.org_share_percent).toBeUndefined();
        expect(data.bundle_goal).toBeUndefined();
        // 10/11: no invoice or settlement write of any kind exists on this route.
        expect(db.invoice.update).not.toHaveBeenCalled();
        expect(db.invoice.updateMany).not.toHaveBeenCalled();
        expect('settled_externally' in data).toBe(false);
        expect('settlement_total' in data).toBe(false);
    });

    it('3. archiving a campaign never touches the organization\'s archived flag', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign());
        await archive();
        expect(db.customer.update).not.toHaveBeenCalled();
    });

    it('8. an unpaid invoice remains unpaid -- archive never writes invoice status', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign({ invoice_statuses: ['SENT'] } as any));
        await archive();
        expect(db.invoice.update).not.toHaveBeenCalled();
        expect(db.invoice.updateMany).not.toHaveBeenCalled();
    });

    it('9b. a legitimately closed campaign with NO invoice at all can still be archived -- an invoice is not required', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign());
        const { res } = await archive();
        expect(res.status).toBe(200);
    });

    it('12. anonymous request is rejected 401, no write attempted', async () => {
        mockAuth.mockResolvedValue(null);
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign());
        const { res } = await archive();
        expect(res.status).toBe(401);
        expect(db.fundraiserCampaign.update).not.toHaveBeenCalled();
    });

    it('13. a foreign-tenant campaign is refused, no write attempted', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign({
            customer: { id: 'c1', business_id: 'some-other-tenant', archived: false, archived_at: null },
        }));
        const { res } = await archive();
        expect(res.status).toBe(403);
        expect(db.fundraiserCampaign.update).not.toHaveBeenCalled();
    });

    it('a nonexistent campaign is refused 404, no write attempted', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(null);
        const { res } = await archive();
        expect(res.status).toBe(404);
        expect(db.fundraiserCampaign.update).not.toHaveBeenCalled();
    });

    it('15. archiving an already-Archived campaign is a clean idempotent no-op success, not an error', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign({ status: 'Archived' }));
        const { res } = await archive();
        expect(res.status).toBe(200);
        const data = db.fundraiserCampaign.update.mock.calls[0][0].data;
        expect(data.status).toBe('Archived');
    });

    it('a Settled campaign (a different closed-family member) is also eligible', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(closedCampaign({ status: 'Settled', closed_at: null }));
        const { res } = await archive();
        expect(res.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART E/H — the eligibility guard: this is the exact gap that existed before
// this phase (the route accepted 'Archived' with no check at all).
// ═════════════════════════════════════════════════════════════════════════════
describe('archive eligibility: only closed-family campaigns may be archived through this action', () => {
    it('14. a currently-Active, orderable campaign CANNOT be casually archived', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(activeCampaign());
        const { res, body } = await archive();
        expect(res.status).toBe(409);
        expect(body.error).toMatch(/closed|completed/i);
        expect(db.fundraiserCampaign.update).not.toHaveBeenCalled();
    });

    it('a Lead (never launched) campaign is also refused', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(activeCampaign({ status: 'Lead' }));
        const { res } = await archive();
        expect(res.status).toBe(409);
        expect(db.fundraiserCampaign.update).not.toHaveBeenCalled();
    });

    it('the ordinary non-archive PATCH path (no status change, or a different status) is completely unaffected by the new guard', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(activeCampaign());
        const { PATCH } = await import('@/app/api/campaigns/[id]/route');
        const req = new Request(`http://localhost/api/campaigns/${CAMPAIGN}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Renamed Fundraiser' }),
        });
        const res = await PATCH(req, { params: Promise.resolve({ id: CAMPAIGN }) });
        expect(res.status).toBe(200);
        expect(db.fundraiserCampaign.update).toHaveBeenCalled();
    });

    it('a closed_at-stamped campaign with a status the guard has never seen before is still eligible (closed_at alone is sufficient, matching isCampaignClosed)', async () => {
        db.fundraiserCampaign.findUnique.mockResolvedValue(activeCampaign({ status: 'Active', closed_at: new Date('2026-08-01') }));
        const { res } = await archive();
        expect(res.status).toBe(200);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART C/K -- reconfirm the existing archive vocabulary and dashboard
// exclusion are reused, not reinvented. This is a thin integration check;
// the exhaustive classification matrix already lives in
// tests/crmArchivedCampaignVisibility1.test.ts and is not duplicated here.
// ═════════════════════════════════════════════════════════════════════════════
describe('4/5. the write this action performs is exactly what the predecessor phase already excludes and preserves', () => {
    it('the resulting row is excluded by the existing archive-precedence classifier', () => {
        const { triageCampaign } = require('@/lib/growth/nextAction');
        const archived = { status: 'Archived', closed_at: '2026-08-01T00:00:00.000Z' };
        expect(triageCampaign(archived, new Date('2026-08-30T00:00:00.000Z')).priority).toBeNull();
    });

    it('CLOSED_STATUSES (the eligibility vocabulary) already includes Archived, so a re-archive is self-consistent', () => {
        const { CLOSED_STATUSES, isCampaignClosed } = require('@/lib/campaignBundleSelection');
        expect(CLOSED_STATUSES).toContain('Archived');
        expect(isCampaignClosed({ status: 'Archived', closed_at: null })).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F/G — the owner-facing menu action and its confirmation copy.
// Source-level, matching this repo's established convention for components
// with no render harness (see tests/crmActiveStatusUx1.test.ts).
// ═════════════════════════════════════════════════════════════════════════════
describe('the owner-facing "Archive fundraiser" action', () => {
    it('CampaignPriorityList offers an Archive fundraiser menu item, distinct from Done/closeout', () => {
        const src = read('components/crm2/CampaignPriorityList.tsx');
        expect(src).toMatch(/label:\s*['"]Archive fundraiser['"]/);
        // Not a repurposing of the existing closeout modal's Done button.
        expect(src).not.toMatch(/label:\s*['"]Done['"]/);
    });

    it('the menu item is gated on the campaign already being closed-family (awaiting_payment or completed), not offered on live rows', () => {
        const src = read('components/crm2/CampaignPriorityList.tsx');
        expect(src).toMatch(/triage\.priority\s*===\s*['"]awaiting_payment['"][\s\S]{0,40}triage\.priority\s*===\s*['"]completed['"]/);
    });

    it('app/fundraisers/page.tsx wires a confirmation before calling the archive endpoint', () => {
        const src = read('app/fundraisers/page.tsx');
        expect(src).toMatch(/confirm\(/);
        expect(src).toMatch(/status:\s*['"]Archived['"]/);
        // Part G's required substance -- history is preserved, nothing is paid.
        expect(src).toMatch(/keeps its campaign, orders, invoice, and history/);
        expect(src).toMatch(/will not mark anything paid/);
    });

    it('the confirmation copy is reachable from a PATCH to /api/campaigns/[id], not a new duplicate endpoint', () => {
        const src = read('app/fundraisers/page.tsx');
        expect(src).toMatch(/fetch\(`\/api\/campaigns\/\$\{[^}]+\}`,\s*\{[\s\S]{0,120}method:\s*['"]PATCH['"]/);
    });
});
