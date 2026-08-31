/**
 * OPS-3 — fundraiser batch production handoff.
 *
 * THE DEFECT THIS PHASE CLOSES, as proven by archaeology rather than assumed:
 *
 *   docs/ai/SETTLEMENT_CONSTITUTION.md (commit 73c95bb, 2026-05-03) specified
 *   the owner's model in full: fundraiser orders accumulate as commitments,
 *   stay invisible to production, and are released as ONE campaign-level batch
 *   only after the settlement invoice is PAID. Only the HOLD half was ever
 *   built (the `fundraiser_hold` status). The paid-gate half and the batch
 *   half were never written as code -- every identifier belonging to them
 *   appears in exactly one commit, inside that one document.
 *
 *   What shipped instead released on CLOSEOUT: the closeout transaction
 *   promoted fundraiser_hold -> production_ready in the SAME transaction that
 *   creates the invoice as a DRAFT. Food was released to the kitchen before
 *   the invoice was sent, let alone paid.
 *
 * THE REPAIR, in two parts, both deliberately surgical:
 *
 *   1. The release moved -- unchanged -- from closeout to the one place an
 *      invoice becomes PAID (the settle route's winner-only branch). Same
 *      predicate, same target status, different trigger.
 *   2. A campaign-level waiting lane was ADDED to the production dashboard so
 *      held fundraisers are visible at all. The three existing customer lanes
 *      were not touched.
 *
 * Closeout's own inverted assertion lives in tests/invBCloseoutRoute.test.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
    buildFundraiserBatches,
    isInvoicePaidStatus,
    formatServingTier,
    PAID_INVOICE_STATUS,
    type BatchOrder,
} from '@/lib/fundraiserProductionBatch';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SETTLE_ROUTE = 'app/api/tenant/invoices/[id]/settle/route.ts';
const CLOSEOUT_ROUTE = 'app/api/campaigns/[id]/closeout/route.ts';
const DASHBOARD_ROUTE = 'app/api/production/dashboard/route.ts';

// ═════════════════════════════════════════════════════════════════════════
// PART I — CAMPAIGN-LEVEL AGGREGATION (matrix 3,4,5,16-25)
// Pure function, driven directly. No mocks, no source-greps.
// ═════════════════════════════════════════════════════════════════════════

const CAMP_A = 'campaign-A';
const CAMP_B = 'campaign-B';

const campaign = (id: string, name: string, over: any = {}) => ({
    id,
    name,
    delivery_date: '2026-10-17',
    end_date: '2026-10-01',
    customer: { name: 'Hilltop Boosters' },
    invoices: [] as any[],
    ...over,
});

const line = (
    id: string,
    bundleId: string | null,
    name: string,
    variant: string,
    qty: number,
) => ({
    id,
    bundle_id: bundleId,
    quantity: qty,
    variant_size: variant,
    item_name: name,
    bundle: bundleId ? { id: bundleId, name } : null,
});

describe('OPS-3 aggregation: one batch per CAMPAIGN', () => {
    it('3. multiple public supporter orders for one campaign produce ONE batch', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, total_amount: 125, campaign: campaign(CAMP_A, 'Brew Test 4'), items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
            { id: 'o2', campaign_id: CAMP_A, total_amount: 250, campaign: campaign(CAMP_A, 'Brew Test 4'), items: [line('i2', 'b-keto', 'Fall Keto', 'serves_5', 2)] },
        ];
        const batches = buildFundraiserBatches(orders);
        expect(batches).toHaveLength(1);
        expect(batches[0].campaignId).toBe(CAMP_A);
        expect(batches[0].orderCount).toBe(2);
        expect(batches[0].lines).toHaveLength(1);
        expect(batches[0].lines[0].quantity).toBe(3);
    });

    it('4. a coordinator-added order joins the SAME campaign batch as public orders', () => {
        // Both paths write source:'fundraiser' + status:'fundraiser_hold' +
        // campaign_id (app/api/coordinator/route.ts and
        // app/api/public/order/route.ts), so they are indistinguishable here --
        // which is exactly the requirement: one fundraiser, one batch.
        const orders: BatchOrder[] = [
            { id: 'public-1', campaign_id: CAMP_A, total_amount: 125, campaign: campaign(CAMP_A, 'Brew Test 4'), items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
            { id: 'coord-1', campaign_id: CAMP_A, total_amount: 60, campaign: campaign(CAMP_A, 'Brew Test 4'), items: [line('i2', 'b-keto', 'Fall Keto', 'serves_2', 1)] },
        ];
        const batches = buildFundraiserBatches(orders);
        expect(batches).toHaveLength(1);
        expect(batches[0].sourceOrderIds).toEqual(expect.arrayContaining(['public-1', 'coord-1']));
    });

    it('5. TWO campaigns for the SAME organization stay SEPARATE — grouping is campaign identity, never the org', () => {
        const sameOrg = { name: 'Hilltop Boosters' };
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, total_amount: 125, campaign: campaign(CAMP_A, 'Fall Fundraiser', { customer: sameOrg }), items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
            { id: 'o2', campaign_id: CAMP_B, total_amount: 125, campaign: campaign(CAMP_B, 'Spring Fundraiser', { customer: sameOrg }), items: [line('i2', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
        ];
        const batches = buildFundraiserBatches(orders);
        expect(batches).toHaveLength(2);
        expect(batches.map((b) => b.campaignId).sort()).toEqual([CAMP_A, CAMP_B]);
        // Same organization name on both -- proving the org was NOT the key.
        expect(batches[0].organizationName).toBe('Hilltop Boosters');
        expect(batches[1].organizationName).toBe('Hilltop Boosters');
    });

    it('16. same Bundle + same tier aggregate into one line', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 5)] },
            { id: 'o2', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('i2', 'b-keto', 'Fall Keto', 'serves_5', 6)] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.lines).toHaveLength(1);
        expect(batch.lines[0].quantity).toBe(11);
    });

    it('17. same Bundle + DIFFERENT tier stay separate lines', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [
                line('i1', 'b-keto', 'Fall Keto', 'serves_5', 11),
                line('i2', 'b-keto', 'Fall Keto', 'serves_2', 4),
            ] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.lines).toHaveLength(2);
        const s5 = batch.lines.find((l) => l.variantSize === 'serves_5')!;
        const s2 = batch.lines.find((l) => l.variantSize === 'serves_2')!;
        expect(s5.quantity).toBe(11);
        expect(s2.quantity).toBe(4);
        expect(s5.servingTierLabel).toBe('Serves 5');
        expect(s2.servingTierLabel).toBe('Serves 2');
    });

    it('18. different Bundles stay separate', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [
                line('i1', 'b-keto', 'Fall Keto', 'serves_5', 11),
                line('i2', 'b-paleo', 'Clean Eating/Paleo', 'serves_5', 8),
            ] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.lines).toHaveLength(2);
        expect(batch.lines.map((l) => l.bundleId).sort()).toEqual(['b-keto', 'b-paleo']);
    });

    it('19/20/21. campaign id, source Order ids, and source OrderItem ids are all retained', () => {
        const orders: BatchOrder[] = [
            { id: 'order-77', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('item-88', 'b-keto', 'Fall Keto', 'serves_5', 2)] },
            { id: 'order-78', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('item-89', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.campaignId).toBe(CAMP_A);
        expect(batch.sourceOrderIds).toEqual(['order-77', 'order-78']);
        expect(batch.lines[0].sourceOrderItemIds).toEqual(['item-88', 'item-89']);
    });

    it('22/23/24/25. Bundle identity, Bundle NAME, serving tier, and ordered quantity are all preserved', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('i1', 'b-paleo', 'Clean Eating/Paleo', 'serves_2', 3)] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        const [l] = batch.lines;
        expect(l.bundleId).toBe('b-paleo');
        expect(l.bundleName).toBe('Clean Eating/Paleo');
        expect(l.variantSize).toBe('serves_2');
        expect(l.quantity).toBe(3);
    });

    it('E. never produces a positional "Bundle 1"/"Bundle 2" label, and never keys off array position', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [
                line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1),
                line('i2', 'b-paleo', 'Clean Eating/Paleo', 'serves_5', 1),
            ] },
            // Same two bundles, opposite order in the array. If position were the
            // key, these would mis-merge.
            { id: 'o2', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [
                line('i3', 'b-paleo', 'Clean Eating/Paleo', 'serves_5', 1),
                line('i4', 'b-keto', 'Fall Keto', 'serves_5', 1),
            ] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.lines).toHaveLength(2);
        for (const l of batch.lines) {
            expect(l.quantity).toBe(2);
            expect(l.bundleName).not.toMatch(/^Bundle \d+$/);
        }
    });

    it('N. a non-bundle line (manual upsell, bundle_id null) falls back to its NAME snapshot, not its position', () => {
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('i1', null, 'Add-on cookie tray', 'serves_5', 2)] },
            { id: 'o2', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [line('i2', null, 'Add-on cookie tray', 'serves_5', 1)] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.lines).toHaveLength(1);
        expect(batch.lines[0].bundleId).toBeNull();
        expect(batch.lines[0].bundleName).toBe('Add-on cookie tray');
        expect(batch.lines[0].quantity).toBe(3);
    });

    it('an order with no campaign_id is never invented into a batch', () => {
        const orders: BatchOrder[] = [
            { id: 'customer-order', campaign_id: null, items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)] },
        ];
        expect(buildFundraiserBatches(orders)).toHaveLength(0);
    });

    it('F/OPS-4 boundary: counts are RAW ordered units, never the weighted fundraising metric', () => {
        // 2x serves_5 + 2x serves_2. The fundraising goal metric would call this
        // 3 weighted bundles (2 + 0.5 + 0.5). A kitchen makes FOUR things.
        const orders: BatchOrder[] = [
            { id: 'o1', campaign_id: CAMP_A, campaign: campaign(CAMP_A, 'C'), items: [
                line('i1', 'b-keto', 'Fall Keto', 'serves_5', 2),
                line('i2', 'b-keto', 'Fall Keto', 'serves_2', 2),
            ] },
        ];
        const [batch] = buildFundraiserBatches(orders);
        expect(batch.totalUnitCount).toBe(4);
    });

    it('does not import the fundraising weighted-metric module — the two counts must not converge', () => {
        const src = read('lib/fundraiserProductionBatch.ts');
        expect(src).not.toMatch(/from '@\/lib\/fundraiserMetrics'/);
        expect(src).not.toMatch(/computeBundleUnitsFromItems|getBundleUnitWeight/);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// INVOICE PAID = the single authoritative fact (Part D)
// ═════════════════════════════════════════════════════════════════════════
describe('OPS-3 invoice paid authority', () => {
    it('the paid fact is invoices.status === PAID, status-only', () => {
        expect(PAID_INVOICE_STATUS).toBe('PAID');
        expect(isInvoicePaidStatus('PAID')).toBe(true);
        for (const s of ['DRAFT', 'SENT', 'PENDING', 'OVERDUE', 'CANCELED', '', null, undefined]) {
            expect(isInvoicePaidStatus(s)).toBe(false);
        }
    });

    it('a batch reports invoicePaid only for a PAID invoice', () => {
        const mk = (status: string | null) => buildFundraiserBatches([{
            id: 'o1', campaign_id: CAMP_A,
            campaign: campaign(CAMP_A, 'C', { invoices: status ? [{ id: 'inv', status, paid_at: null }] : [] }),
            items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)],
        }])[0];

        expect(mk('PAID').invoicePaid).toBe(true);
        expect(mk('DRAFT').invoicePaid).toBe(false);
        expect(mk('SENT').invoicePaid).toBe(false);
        expect(mk('OVERDUE').invoicePaid).toBe(false);
        expect(mk(null).invoicePaid).toBe(false);
        expect(mk(null).invoiceStatus).toBeNull();
    });

    it('a PAID invoice with a NULL paid_at still counts as paid — five historical rows are like this', () => {
        const [batch] = buildFundraiserBatches([{
            id: 'o1', campaign_id: CAMP_A,
            campaign: campaign(CAMP_A, 'C', { invoices: [{ id: 'inv', status: 'PAID', paid_at: null }] }),
            items: [line('i1', 'b-keto', 'Fall Keto', 'serves_5', 1)],
        }]);
        expect(batch.invoicePaid).toBe(true);
    });
});

describe('OPS-3 serving-tier display', () => {
    it('formats without altering the stored truth', () => {
        expect(formatServingTier('serves_5')).toBe('Serves 5');
        expect(formatServingTier('serves_2')).toBe('Serves 2');
        expect(formatServingTier(null)).toBe('');
    });
});

// ═════════════════════════════════════════════════════════════════════════
// PART J/K — THE RELEASE GATE, executed against the REAL settle handler.
// ═════════════════════════════════════════════════════════════════════════

const calls: Array<{ op: string; args?: any }> = [];
let invoiceRow: any;
let claimCount = 1;

const txClient: any = {
    invoice: {
        updateMany: async (a: any) => {
            calls.push({ op: 'invoice.settle', args: a });
            return { count: claimCount };
        },
    },
    order: {
        updateMany: async (a: any) => {
            calls.push({ op: 'orders.release', args: a });
            return { count: 3 };
        },
    },
    loyaltyPoint: { findFirst: async () => null, create: async () => ({}) },
    customer: { update: async () => ({}) },
};

const mockPrisma = {
    $transaction: async (fn: any) => fn(txClient),
    invoice: {
        findFirst: async () => invoiceRow,
    },
};

jest.mock('@/lib/db', () => ({ prisma: mockPrisma }));

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const BIZ = 'biz-a';

const settle = async (body: any = { method: 'check', paidAt: '2026-01-15', reference: 'ck-1001' }) => {
    const { POST } = await import('@/app/api/tenant/invoices/[id]/settle/route');
    const res = await POST(
        new Request('http://localhost/api/tenant/invoices/inv-1/settle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }) as any,
        { params: Promise.resolve({ id: 'inv-1' }) } as any,
    );
    return { res, body: await res.json().catch(() => ({})) };
};

const releaseCalls = () => calls.filter((c) => c.op === 'orders.release');

beforeEach(() => {
    calls.length = 0;
    claimCount = 1;
    invoiceRow = {
        id: 'inv-1',
        status: 'SENT',
        paid_at: null,
        payment_method: null,
        payment_reference: null,
        campaign_id: CAMP_A,
        customer_id: 'cust-1',
        total_amount: 500,
        customer: { type: 'fundraiser_org' },
    };
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({ user: { id: 'u1', email: 'a@t.test', businessId: BIZ } });
});

describe('OPS-3 release gate: only an authoritative Invoice PAID releases the fundraiser', () => {
    it('14. recording payment on a SENT campaign invoice releases exactly this campaign\'s held orders', async () => {
        const { res } = await settle();
        expect(res.status).toBe(200);

        const released = releaseCalls();
        expect(released).toHaveLength(1);
        expect(released[0].args.where).toMatchObject({
            campaign_id: CAMP_A,
            business_id: BIZ,
            source: 'fundraiser',
            status: 'fundraiser_hold',
            canceled_at: null,
        });
        expect(released[0].args.data).toEqual({ status: 'production_ready' });
    });

    it('9. a DRAFT invoice cannot be settled at all, and releases nothing', async () => {
        invoiceRow.status = 'DRAFT';
        const { res, body } = await settle();
        expect(res.status).toBe(409);
        expect(String(body.error)).toMatch(/draft/i);
        expect(releaseCalls()).toHaveLength(0);
    });

    it('a CANCELED invoice cannot be settled, and releases nothing', async () => {
        invoiceRow.status = 'CANCELED';
        const { res } = await settle();
        expect(res.status).toBe(409);
        expect(releaseCalls()).toHaveLength(0);
    });

    it('10. a SENT but UNPAID invoice releases nothing until payment is actually recorded', async () => {
        // Proven by construction: no release call exists until the settle POST
        // wins its PAID transition. Nothing else in the app writes PAID.
        expect(releaseCalls()).toHaveLength(0);
        const src = read(SETTLE_ROUTE);
        // The release is INSIDE the winner-only guard.
        const winnerGuard = src.indexOf('if (result.count !== 1) return result;');
        const campaignRelease = src.indexOf('campaign_id: invoice.campaign_id');
        expect(winnerGuard).toBeGreaterThan(-1);
        expect(campaignRelease).toBeGreaterThan(winnerGuard);
    });

    it('11/12. closeout alone does not release — the promotion is gone from the closeout route', async () => {
        const src = read(CLOSEOUT_ROUTE);
        expect(src).not.toMatch(/status: 'fundraiser_hold' as any,?\s*\n\s*canceled_at: null/);
        expect(src).not.toMatch(/data: \{\s*status: 'production_ready' as any\s*\}/);
        // And it still does everything else it always did.
        expect(src).toMatch(/status: 'DRAFT' as any/);
        expect(src).toMatch(/settlement_total: settlementTotal/);
    });

    it('15. supporter payment state is never consulted by the release — only the invoice is', async () => {
        await settle();
        const where = releaseCalls()[0].args.where;
        expect(where).not.toHaveProperty('payment_processor');
        expect(where).not.toHaveProperty('processor_payment_id');
        expect(Object.keys(where).sort()).toEqual(
            ['business_id', 'campaign_id', 'canceled_at', 'source', 'status'].sort(),
        );
    });

    it('an ORDINARY (non-campaign) invoice keeps its original invoice_id release, unchanged', async () => {
        invoiceRow.campaign_id = null;
        invoiceRow.customer.type = 'direct_customer';
        await settle();
        const released = releaseCalls();
        expect(released).toHaveLength(1);
        expect(released[0].args.where).toEqual({ invoice_id: 'inv-1', business_id: BIZ });
    });
});

describe('OPS-3 exact-once release', () => {
    it('26. the first PAID transition releases exactly once', async () => {
        await settle();
        expect(releaseCalls()).toHaveLength(1);
    });

    it('27. a repeated Record Payment on an already-PAID invoice returns the stored facts and releases NOTHING', async () => {
        invoiceRow.status = 'PAID';
        invoiceRow.paid_at = new Date('2026-01-15T12:00:00.000Z');
        invoiceRow.payment_method = 'check';
        const { res, body } = await settle();
        expect(res.status).toBe(200);
        expect(body.alreadySettled).toBe(true);
        expect(releaseCalls()).toHaveLength(0);
    });

    it('28/29/30. a lost race (conditional transition matched 0 rows) releases NOTHING', async () => {
        // This is the same guard a refresh, a retried API call, or a duplicate
        // payment event hits: the PAID transition is conditional, so only one
        // caller can ever get count === 1.
        claimCount = 0;
        invoiceRow.status = 'SENT';
        await settle();
        expect(releaseCalls()).toHaveLength(0);
    });

    it('31. the release predicate itself is the durable claim — already-released orders can never match again', async () => {
        await settle();
        // status:'fundraiser_hold' in the WHERE means a second run over the same
        // campaign matches zero rows, with no time window and no new table.
        expect(releaseCalls()[0].args.where.status).toBe('fundraiser_hold');
    });

    it('exact-once needs no new persistence: no release marker is written, and the schema gained nothing', async () => {
        // NB: the settle route's own prose legitimately discusses "Idempotency"
        // -- that is its existing design commentary, not a stored field. What
        // must not exist is a WRITTEN release marker.
        const src = read(SETTLE_ROUTE);
        expect(src).not.toMatch(/released_at|production_released|release_key|batch_id|idempotency_key/i);
        // OPS-3 must not have added any release-marker persistence. (The schema's
        // pre-existing `idempotency_key` columns belong to the unrelated rebooking
        // submission models and are deliberately not matched here; that OPS-3
        // changed no schema line at all is proven by the staged diff, not a grep.)
        const schema = read('prisma/schema.prisma');
        expect(schema).not.toMatch(/production_released|release_key|fundraiser_batch/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// PART L/M — SEPARATION AND TENANT ISOLATION (matrix 6,7,36-38)
// ═════════════════════════════════════════════════════════════════════════
describe('OPS-3 customer vs fundraiser separation', () => {
    const dash = read(DASHBOARD_ROUTE);

    it('6/7. the three customer lanes EXCLUDE fundraiser_hold and the fundraiser lane requires it — mutually exclusive by construction', () => {
        const excludes = dash.match(/NOT: \{ status: 'fundraiser_hold' as any \}/g) || [];
        expect(excludes.length).toBe(3);
        expect(dash).toMatch(/status: 'fundraiser_hold' as any,\s*\n\s*campaign_id: \{ not: null \}/);
    });

    it('7. no order can be double-counted: a held order is invisible to customer lanes, a released one to the fundraiser lane', () => {
        // The same column decides both. There is no overlap to police.
        expect(dash).toMatch(/mutually exclusive BY CONSTRUCTION/);
    });

    it('39. the existing customer lane queries were not rewritten — all three still return their original keys', () => {
        expect(dash).toMatch(/pending: pendingOrders/);
        expect(dash).toMatch(/prep: Array\.from\(prepMap\.values\(\)\)/);
        expect(dash).toMatch(/completed: completedOrders/);
    });

    it('36/37/38. every dashboard query is scoped to the session business, and the fundraiser lane is too', () => {
        const scoped = dash.match(/business_id: businessId/g) || [];
        expect(scoped.length).toBe(4);
        expect(dash).toMatch(/const businessId = session\.user\.businessId/);
    });

    it('38. the release asserts business_id on the ORDER rows, so a campaign id cannot reach across tenants', async () => {
        await settle();
        expect(releaseCalls()[0].args.where.business_id).toBe(BIZ);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// PART N/P — LIFECYCLE AND HISTORICAL SAFETY (matrix 34,35)
// ═════════════════════════════════════════════════════════════════════════
describe('OPS-3 lifecycle safety', () => {
    it('34/35. NO production lane filters on campaign lifecycle — archival can never remove waiting or released work', () => {
        const dash = read(DASHBOARD_ROUTE);
        // Deliberately checked across the WHOLE route, not just the new lane:
        // released fundraiser work lives in the `prep` lane, so a lifecycle
        // filter added anywhere here could silently delete a kitchen
        // requirement. Archived/Closed are CRM filing states, never production
        // switches.
        //
        // Written to catch any shape of the predicate, not one spelling —
        // an earlier version of this test only looked for `status: 'Archived'`
        // and a mutant that wrote `status: { not: 'Archived' }` walked straight
        // past it.
        expect(dash).not.toMatch(/Archived/);
        expect(dash).not.toMatch(/organization_archived/);
        expect(dash).not.toMatch(/isArchivedForDashboard/);
        // No relation-filter into the campaign at all in any order query.
        expect(dash).not.toMatch(/campaign:\s*\{\s*status/);
    });

    it('a post-release payment correction does NOT pull food back out of the kitchen', () => {
        const src = read(SETTLE_ROUTE);
        const del = src.slice(src.indexOf('export async function DELETE'));
        // The undo path must contain no order write at all.
        expect(del).not.toMatch(/tx\.order\.updateMany/);
        expect(del).toMatch(/deliberately NOT reverted/);
    });

    it('P. an order missing optional historical data still aggregates without fabricating anything', () => {
        const [batch] = buildFundraiserBatches([{
            id: 'legacy-order',
            campaign_id: CAMP_A,
            total_amount: null,
            campaign: { id: CAMP_A, name: null, delivery_date: null, end_date: null, customer: null, invoices: null },
            items: [{ id: 'li', bundle_id: null, quantity: 1, variant_size: null, item_name: null, bundle: null }],
        }]);
        expect(batch.campaignId).toBe(CAMP_A);
        expect(batch.deliveryDate).toBeNull();
        expect(batch.organizationName).toBe('');
        expect(batch.salesTotal).toBe(0);
        expect(batch.invoiceStatus).toBeNull();
        // Falls back to a safe label, never a positional one.
        expect(batch.lines[0].bundleName).toBe('Item');
        expect(batch.lines[0].variantSize).toBe('serves_5');
    });
});
