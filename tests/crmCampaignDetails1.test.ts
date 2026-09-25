/**
 * CRM-CAMPAIGN-DETAILS-1 — the tenant's own correction path for a live fundraiser's
 * operational details, and the preserve-canonical rule that stops a legacy
 * organization blob from undoing it.
 *
 * THE DEFECT
 * A fundraiser's pickup time was entered as 9:00 AM and needed to be 4:00 PM. The
 * column (`FundraiserCampaign.delivery_time`, FR-FLOW-3) existed and every read
 * surface already preferred it, but `PATCH /api/campaigns/[id]` did not accept it and
 * the only tenant UI — components/crm/FundraiserSetup.tsx — is ORGANISATION-scoped and
 * was deliberately barred from overwriting a coordinator-confirmed time. So the fix
 * took a database edit.
 *
 * THE SECOND HALF, WITHOUT WHICH THE FIRST IS A TRAP
 * `delivery_date`, `end_date` and `pickup_location` were pushed from
 * `Customer.fundraiser_info` to "whichever campaign was created most recently"
 * UNCONDITIONALLY. Audited against Production 2026-09-25: all 7 open campaigns
 * disagreed with their blob on all four fields. So a tenant who corrected a date
 * campaign-side and later saved the organization profile for any unrelated reason
 * would have had the correction reverted from stale JSON. The sync is now
 * fill-only-what-is-missing — the rule FR-FLOW-3 already applied to delivery_time,
 * extended to all four and stated once in lib/campaignOperationalDetails.ts.
 *
 * WHAT MUST NOT CHANGE, and is asserted below: no financial field is reachable, a
 * closed fundraiser is read-only, tenant isolation holds, and the legacy initial fill
 * that the flyer/packet/tracker routes depend on still works.
 */
import fs from 'fs';
import path from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    decideOperationalDetailsChange,
    operationalFillFromOrgProfile,
    checkCoordinatorSetupReadiness,
    hasMeaningfulValue,
    calendarDayToDate,
    CAMPAIGN_OPERATIONAL_FIELDS,
    CAMPAIGN_FORBIDDEN_DETAIL_FIELDS,
} from '../lib/campaignOperationalDetails';
import { resolveBundleGoal, DEFAULT_BUNDLE_GOAL, computeBundleUnitsFromItems } from '../lib/fundraiserMetrics';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__crmDetailsPrisma; },
}));
const authMock = jest.fn(async () => null as any);
jest.mock('@/auth', () => ({ auth: (...a: any[]) => authMock(...(a as [])) }));

const setupEmail = jest.fn(async () => ({ data: { id: 'msg-1' }, error: null }));
jest.mock('@/lib/email', () => ({
    getTenantSender: async () => ({ from: 'tenant@example.invalid', replyTo: null }),
    sendEmail: (...a: any[]) => setupEmail(...(a as [])),
}));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const CAMPAIGN = 'camp-1111';
const ORG = 'org-1111';

const session = (businessId: string | null) =>
    businessId ? { user: { businessId, email: 'owner@tenant.invalid', role: 'OWNER' } } : null;

/** A live fundraiser exactly as the audit found them: pickup time entered wrong. */
const liveCampaign = (over: Record<string, any> = {}) => ({
    id: CAMPAIGN,
    name: 'Shelbyville Band Fundraiser',
    status: 'Active',
    closed_at: null,
    customer_id: ORG,
    delivery_date: new Date('2026-10-15T00:00:00.000Z'),
    delivery_time: '9:00 AM',
    end_date: new Date('2026-10-01T00:00:00.000Z'),
    pickup_location: 'School gym',
    bundle_goal: 20,
    org_share_percent: 20,
    goal_amount: null,
    total_sales: 0,
    settlement_total: null,
    tax_status: 'taxable',
    tax_rate_percent: 6.25,
    customer: { id: ORG, business_id: TENANT_A, name: 'Shelbyville Band', tax_status: 'taxable' },
    ...over,
});

/** Drive the real PATCH /api/campaigns/[id]. */
async function patchCampaign(
    body: Record<string, unknown>,
    opts: { campaign?: any; businessId?: string | null } = {},
) {
    const campaign = opts.campaign ?? liveCampaign();
    const businessId = opts.businessId === undefined ? TENANT_A : opts.businessId;
    const mock = createPrismaMock({
        results: {
            'fundraiserCampaign.findUnique': campaign,
            'business.findUnique': { default_food_tax_percent: 6.25 },
            'order.count': 0,
            'invoice.count': 0,
        },
    });
    (global as any).__crmDetailsPrisma = mock.client;
    authMock.mockResolvedValue(session(businessId) as any);
    const { PATCH } = await import('@/app/api/campaigns/[id]/route');
    const res = await PATCH(
        new Request(`http://localhost/api/campaigns/${CAMPAIGN}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: CAMPAIGN }) } as any,
    );
    return { ...(await readJson(res)), mock };
}

/** The `data` the route actually handed Prisma, or undefined when it never wrote. */
const writtenData = (mock: PrismaMock) =>
    mock.firstCall('fundraiserCampaign.update')?.args?.data as Record<string, any> | undefined;

beforeEach(() => {
    jest.resetModules();
    authMock.mockReset();
    setupEmail.mockClear();
});

// ---------------------------------------------------------------------------
// The rule module
// ---------------------------------------------------------------------------
describe('CRM-CAMPAIGN-DETAILS-1 / the decision', () => {
    const campaign = {
        delivery_date: new Date('2026-10-15T00:00:00.000Z'),
        delivery_time: '9:00 AM',
        end_date: new Date('2026-10-01T00:00:00.000Z'),
        pickup_location: 'School gym',
    };

    test('an empty request is not a change', () => {
        expect(decideOperationalDetailsChange({ requested: {}, campaign, campaignClosed: false }))
            .toEqual({ change: false });
    });

    test('A: the pickup time alone changes, and nothing else is written', () => {
        const d = decideOperationalDetailsChange({
            requested: { delivery_time: '4:00 PM' }, campaign, campaignClosed: false,
        });
        expect(d).toEqual({ change: true, data: { delivery_time: '4:00 PM' } });
        // The date and the deadline are absent from the patch, so Prisma leaves them.
        expect(Object.keys((d as any).data)).toEqual(['delivery_time']);
    });

    test('A: the time is free text, as FR-FLOW-3 designed it', () => {
        for (const t of ['4:00 PM', '3–5 PM', 'TBD', '4:45 p.m.']) {
            const d = decideOperationalDetailsChange({
                requested: { delivery_time: t }, campaign, campaignClosed: false,
            });
            expect((d as any).data.delivery_time).toBe(t);
        }
    });

    test('A: surrounding whitespace is trimmed, and a blank clears the time', () => {
        expect((decideOperationalDetailsChange({
            requested: { delivery_time: '  4:00 PM  ' }, campaign, campaignClosed: false,
        }) as any).data.delivery_time).toBe('4:00 PM');
        expect((decideOperationalDetailsChange({
            requested: { delivery_time: '   ' }, campaign, campaignClosed: false,
        }) as any).data.delivery_time).toBeNull();
    });

    test('B: a date round-trips as the day that was picked, with no shift', () => {
        const d = decideOperationalDetailsChange({
            requested: { delivery_date: '2026-11-03' }, campaign, campaignClosed: false,
        });
        const written = (d as any).data.delivery_date as Date;
        expect(written.toISOString()).toBe('2026-11-03T00:00:00.000Z');
        // Read back the way a @db.Date must be read — UTC getters, never local.
        expect(written.getUTCFullYear()).toBe(2026);
        expect(written.getUTCMonth() + 1).toBe(11);
        expect(written.getUTCDate()).toBe(3);
    });

    test('B: changing the date does not touch the deadline', () => {
        const d = decideOperationalDetailsChange({
            requested: { delivery_date: '2026-11-03' }, campaign, campaignClosed: false,
        });
        expect((d as any).data.end_date).toBeUndefined();
    });

    test('B: a date cannot be cleared — an empty one is refused, not written as null', () => {
        const d = decideOperationalDetailsChange({
            requested: { delivery_date: '' }, campaign, campaignClosed: false,
        });
        expect(d).toMatchObject({ rejected: true, status: 400 });
    });

    test('C: the deadline uses the EXISTING launch rule, not a second opinion', () => {
        // checkOrderDeadline allows equal dates and refuses ordering past delivery.
        expect(decideOperationalDetailsChange({
            requested: { end_date: '2026-10-15' }, campaign, campaignClosed: false,
        })).toMatchObject({ change: true });
        expect(decideOperationalDetailsChange({
            requested: { end_date: '2026-10-16' }, campaign, campaignClosed: false,
        })).toMatchObject({ rejected: true, status: 400 });
    });

    test('C: the deadline is checked against a NEW delivery date supplied in the same edit', () => {
        expect(decideOperationalDetailsChange({
            requested: { delivery_date: '2026-12-01', end_date: '2026-11-20' },
            campaign, campaignClosed: false,
        })).toMatchObject({ change: true });
    });

    test('C: pulling the delivery date in front of the stored deadline is refused, not silently fixed', () => {
        const d = decideOperationalDetailsChange({
            requested: { delivery_date: '2026-09-20' }, campaign, campaignClosed: false,
        });
        expect(d).toMatchObject({ rejected: true, status: 400 });
        expect((d as any).error).toMatch(/on or before the delivery date/i);
    });

    test('D: the location trims, and an empty value clears it', () => {
        expect((decideOperationalDetailsChange({
            requested: { pickup_location: '  Main St lot ' }, campaign, campaignClosed: false,
        }) as any).data.pickup_location).toBe('Main St lot');
        expect((decideOperationalDetailsChange({
            requested: { pickup_location: '' }, campaign, campaignClosed: false,
        }) as any).data.pickup_location).toBeNull();
    });

    test('H: a closed fundraiser refuses every operational edit', () => {
        for (const requested of [
            { delivery_time: '4:00 PM' }, { delivery_date: '2026-11-03' },
            { end_date: '2026-10-02' }, { pickup_location: 'Elsewhere' },
        ]) {
            expect(decideOperationalDetailsChange({ requested, campaign, campaignClosed: true }))
                .toMatchObject({ rejected: true, status: 409 });
        }
    });

    test('I: the decision can only ever produce operational keys', () => {
        const d = decideOperationalDetailsChange({
            requested: {
                delivery_date: '2026-11-03', delivery_time: '4:00 PM',
                end_date: '2026-11-01', pickup_location: 'Main St lot',
                // Everything below is financial and must be ignored outright.
                org_share_percent: 50, goal_amount: 9999, total_sales: 1,
                settlement_total: 1, tax_rate_percent: 99, status: 'Closed',
            } as any,
            campaign, campaignClosed: false,
        });
        const keys = Object.keys((d as any).data);
        expect(keys.sort()).toEqual(['delivery_date', 'delivery_time', 'end_date', 'pickup_location']);
        for (const forbidden of CAMPAIGN_FORBIDDEN_DETAIL_FIELDS) {
            expect(keys).not.toContain(forbidden);
        }
    });

    test('the operational field list and the forbidden list cannot overlap', () => {
        for (const f of CAMPAIGN_OPERATIONAL_FIELDS) {
            expect(CAMPAIGN_FORBIDDEN_DETAIL_FIELDS as readonly string[]).not.toContain(f);
        }
    });

    test('hasMeaningfulValue treats blank and whitespace as unset', () => {
        expect(hasMeaningfulValue(null)).toBe(false);
        expect(hasMeaningfulValue(undefined)).toBe(false);
        expect(hasMeaningfulValue('')).toBe(false);
        expect(hasMeaningfulValue('   ')).toBe(false);
        expect(hasMeaningfulValue('4:00 PM')).toBe(true);
        expect(hasMeaningfulValue(new Date('2026-10-15T00:00:00.000Z'))).toBe(true);
        expect(hasMeaningfulValue(new Date('nope'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
describe('CRM-CAMPAIGN-DETAILS-1 / PATCH /api/campaigns/[id]', () => {
    test('A: 9:00 AM becomes 4:00 PM', async () => {
        const { status, mock } = await patchCampaign({ delivery_time: '4:00 PM' });
        expect(status).toBe(200);
        expect(writtenData(mock)!.delivery_time).toBe('4:00 PM');
    });

    test('A: and the date and deadline are not written at all', async () => {
        const { mock } = await patchCampaign({ delivery_time: '4:00 PM' });
        const data = writtenData(mock)!;
        expect(data.delivery_date).toBeUndefined();
        expect(data.end_date).toBeUndefined();
    });

    test('B: a delivery date is stored as the picked calendar day', async () => {
        const { mock } = await patchCampaign({ delivery_date: '2026-11-03' });
        expect((writtenData(mock)!.delivery_date as Date).toISOString())
            .toBe('2026-11-03T00:00:00.000Z');
    });

    test('C: a new deadline is accepted and stored date-only', async () => {
        const { status, mock } = await patchCampaign({ end_date: '2026-10-10' });
        expect(status).toBe(200);
        expect((writtenData(mock)!.end_date as Date).toISOString()).toBe('2026-10-10T00:00:00.000Z');
    });

    test('C: a deadline after the delivery date is refused with 400 and nothing is written', async () => {
        const { status, body, mock } = await patchCampaign({ end_date: '2026-11-30' });
        expect(status).toBe(400);
        expect(body.error).toMatch(/on or before the delivery date/i);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    test('D: the location is written', async () => {
        const { mock } = await patchCampaign({ pickup_location: 'Main St lot' });
        expect(writtenData(mock)!.pickup_location).toBe('Main St lot');
    });

    test('the goal keeps its own existing path — 20 becomes 35', async () => {
        const { status, mock } = await patchCampaign({ bundleGoal: '35' });
        expect(status).toBe(200);
        expect(writtenData(mock)!.bundle_goal).toBe(35);
    });

    test('G: tenant B cannot edit tenant A\'s campaign, and nothing is written', async () => {
        const { status, mock } = await patchCampaign(
            { delivery_time: '4:00 PM' },
            { businessId: TENANT_B },
        );
        expect(status).toBe(403);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    test('G: an unauthenticated caller is refused before anything is read', async () => {
        const { status, mock } = await patchCampaign(
            { delivery_time: '4:00 PM' },
            { businessId: null },
        );
        expect(status).toBe(401);
        expect(mock.callsTo('fundraiserCampaign.findUnique')).toHaveLength(0);
    });

    test('H: a closed fundraiser refuses the edit with 409 and writes nothing', async () => {
        const { status, body, mock } = await patchCampaign(
            { delivery_time: '4:00 PM' },
            { campaign: liveCampaign({ closed_at: new Date('2026-09-01'), status: 'Closed' }) },
        );
        expect(status).toBe(409);
        expect(body.error).toMatch(/closed out/i);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    test('H: a settled-by-status fundraiser is equally refused', async () => {
        const { status } = await patchCampaign(
            { pickup_location: 'Elsewhere' },
            { campaign: liveCampaign({ status: 'Settled' }) },
        );
        expect(status).toBe(409);
    });

    test('I: no financial field is written, even when the body carries one', async () => {
        const { mock } = await patchCampaign({
            delivery_time: '4:00 PM',
            total_sales: 99999, settlement_total: 99999, closed_at: '2026-01-01',
            tax_rate_percent: 99, tax_status: 'exempt',
        });
        const data = writtenData(mock)!;
        expect(data.total_sales).toBeUndefined();
        expect(data.settlement_total).toBeUndefined();
        expect(data.closed_at).toBeUndefined();
        expect(data.tax_rate_percent).toBeUndefined();
        expect(data.tax_status).toBeUndefined();
        expect(data.org_share_percent).toBeUndefined();
    });

    test('I: no order, invoice or settlement row is touched by a details edit', async () => {
        const { mock } = await patchCampaign({ delivery_time: '4:00 PM', pickup_location: 'Main St lot' });
        for (const key of [
            'order.update', 'order.updateMany', 'orderItem.update', 'orderItem.updateMany',
            'invoice.update', 'invoice.create', 'invoice.updateMany',
        ]) {
            expect(mock.callsTo(key)).toHaveLength(0);
        }
    });

    test('I: the route sends no email as a side effect of a details edit', async () => {
        await patchCampaign({ delivery_time: '4:00 PM' });
        expect(setupEmail).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// E / F — the narrowed organization sync
// ---------------------------------------------------------------------------
describe('CRM-CAMPAIGN-DETAILS-1 / organization profile sync', () => {
    const staleInfo = {
        delivery_date: '2026-08-01',
        delivery_time: '3 PM',
        deadline: '2026-07-20',
        pickup_location: 'Old church hall',
    };

    test('F: a blank campaign is still filled from the organization blob', () => {
        const out = operationalFillFromOrgProfile({
            campaign: { delivery_date: null, delivery_time: null, end_date: null, pickup_location: null },
            info: staleInfo,
        });
        expect((out.delivery_date as Date).toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect((out.end_date as Date).toISOString()).toBe('2026-07-20T00:00:00.000Z');
        expect(out.delivery_time).toBe('3 PM');
        expect(out.pickup_location).toBe('Old church hall');
    });

    test('F: a whitespace-only stored value still counts as missing, so legacy fill works', () => {
        const out = operationalFillFromOrgProfile({
            campaign: { delivery_date: null, delivery_time: '   ', end_date: null, pickup_location: '' },
            info: staleInfo,
        });
        expect(out.delivery_time).toBe('3 PM');
        expect(out.pickup_location).toBe('Old church hall');
    });

    test('E: a campaign that already knows its own answers is left completely alone', () => {
        const out = operationalFillFromOrgProfile({
            campaign: {
                delivery_date: new Date('2026-10-15T00:00:00.000Z'),
                delivery_time: '4:00 PM',
                end_date: new Date('2026-10-01T00:00:00.000Z'),
                pickup_location: 'School gym',
            },
            info: staleInfo,
        });
        expect(out).toEqual({});
    });

    test('E: the four fields are protected independently', () => {
        const out = operationalFillFromOrgProfile({
            campaign: {
                delivery_date: new Date('2026-10-15T00:00:00.000Z'),
                delivery_time: '4:00 PM',
                end_date: null,
                pickup_location: null,
            },
            info: staleInfo,
        });
        expect(out.delivery_date).toBeUndefined();
        expect(out.delivery_time).toBeUndefined();
        expect((out.end_date as Date).toISOString()).toBe('2026-07-20T00:00:00.000Z');
        expect(out.pickup_location).toBe('Old church hall');
    });

    test('E: delivery_time keeps the protection FR-FLOW-3 already gave it', () => {
        const out = operationalFillFromOrgProfile({
            campaign: { delivery_date: null, delivery_time: '4:00 PM', end_date: null, pickup_location: null },
            info: { delivery_time: '9:00 AM' },
        });
        expect(out.delivery_time).toBeUndefined();
    });

    test('E: and it now protects a campaign that never ran the coordinator bundle flow', () => {
        // The old guard keyed on bundle_selection_status === 'selected'. A campaign at
        // 'not_required' was therefore unprotected; it no longer is, because the rule
        // reads the campaign's own value instead.
        const src = R('app/api/customers/[id]/route.ts');
        const block = src.slice(src.indexOf('if (body.fundraiser_info)'), src.indexOf('return NextResponse.json({ success: true'));
        expect(block).toContain('operationalFillFromOrgProfile');
        expect(block).not.toContain("bundle_selection_status === 'selected'");
    });

    test('E: the sync no longer writes the four fields from the raw blob', () => {
        const src = R('app/api/customers/[id]/route.ts');
        const block = src.slice(src.indexOf('if (body.fundraiser_info)'), src.indexOf('return NextResponse.json({ success: true'));
        expect(block).not.toContain('delivery_date: fi.delivery_date');
        expect(block).not.toContain('end_date: fi.deadline');
        expect(block).not.toContain('pickup_location: fi.pickup_location');
        expect(block).not.toContain('delivery_time: fi.delivery_time');
    });

    test('unrelated organization-profile behaviour is untouched', () => {
        const src = R('app/api/customers/[id]/route.ts');
        const block = src.slice(src.indexOf('if (body.fundraiser_info)'), src.indexOf('return NextResponse.json({ success: true'));
        // start_date, checks_payable, labels, copy and the goal still sync as before.
        expect(block).toContain('start_date: fi.start_date');
        expect(block).toContain('checks_payable: fi.checks_payable_to');
        expect(block).toContain('bundle_goal: fi.bundle_goal');
        // And the INV-A closed-campaign boundary above it still stands.
        expect(block).toContain('latestIsClosed');
    });
});

// ---------------------------------------------------------------------------
// Addendum B — the tenant sets date and time before coordinator setup
// ---------------------------------------------------------------------------
describe('CRM-CAMPAIGN-DETAILS-1 / coordinator setup readiness', () => {
    test('a fundraiser with both values is ready', () => {
        expect(checkCoordinatorSetupReadiness({
            delivery_date: new Date('2026-10-15T00:00:00.000Z'), delivery_time: '4:00 PM',
        })).toEqual({ ready: true });
    });

    test('a missing time blocks the invitation and says which field', () => {
        const r = checkCoordinatorSetupReadiness({
            delivery_date: new Date('2026-10-15T00:00:00.000Z'), delivery_time: null,
        });
        expect(r.ready).toBe(false);
        expect((r as any).missing).toEqual(['delivery_time']);
        expect((r as any).error).toMatch(/delivery\/pickup time/i);
    });

    test('a missing date blocks it too', () => {
        const r = checkCoordinatorSetupReadiness({ delivery_date: null, delivery_time: '4:00 PM' });
        expect((r as any).missing).toEqual(['delivery_date']);
    });

    test('both missing is reported as one sentence, not two errors', () => {
        const r = checkCoordinatorSetupReadiness({ delivery_date: null, delivery_time: null });
        expect((r as any).missing).toEqual(['delivery_date', 'delivery_time']);
        expect((r as any).error).toMatch(/date and time/i);
    });

    test('a blank string is not a time', () => {
        expect(checkCoordinatorSetupReadiness({
            delivery_date: new Date('2026-10-15T00:00:00.000Z'), delivery_time: '  ',
        }).ready).toBe(false);
    });

    test('existing launched campaigns are unaffected — the check runs only at send time', () => {
        // No stored state, no migration, no backfill: the gate is a function of the
        // campaign row evaluated inside the invitation route, so nothing re-evaluates a
        // campaign whose invitation already went out.
        const src = R('lib/campaignOperationalDetails.ts');
        expect(src).toContain('DELIBERATELY EVALUATED AT SEND TIME');
        const route = R('app/api/campaigns/[id]/coordinator-email/route.ts');
        expect(route).toContain('PROSPECTIVE BY CONSTRUCTION');
        expect(route).toContain('checkCoordinatorSetupReadiness');
        // It sits with the route's other preconditions, inside resolveInvitation, which
        // both GET (preview) and POST (send) go through.
        const resolve = route.slice(route.indexOf('async function resolveInvitation'), route.indexOf('export async function'));
        expect(resolve).toContain('checkCoordinatorSetupReadiness');
    });

    test('the gate is not a new lifecycle state', () => {
        const src = R('lib/campaignOperationalDetails.ts');
        expect(src).not.toMatch(/prisma\./);
        expect(src).not.toMatch(/setup_ready|readiness_state|campaign\.status\s*=/);
    });
});

// ---------------------------------------------------------------------------
// Propagation + the goal
// ---------------------------------------------------------------------------
describe('CRM-CAMPAIGN-DETAILS-1 / propagation and the goal', () => {
    test('the supporter page prefers the campaign column over the organization blob', () => {
        const src = R('app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx');
        expect(src).toContain('campaign.delivery_time ? String(campaign.delivery_time) : null');
        expect(src).toContain('campaign.pickup_location || fi.pickup_location');
        expect(src).toContain('formatDate(campaign.delivery_date) || formatDate(fi.delivery_date)');
    });

    test('all four fields are in the public payload projection, so the supporter page can see them', () => {
        const src = R('lib/publicFundraiserPayload.ts');
        for (const f of ['delivery_date', 'delivery_time', 'end_date', 'pickup_location']) {
            expect(src).toContain(`'${f}'`);
        }
    });

    test('the coordinator surfaces read the campaign row, with no snapshot of their own', () => {
        const tracker = R('app/coordinator/portal/pickup-tracker/page.tsx');
        expect(tracker).toContain('campaign.delivery_time');
        expect(tracker).toContain('campaign.pickup_location');
        const setup = R('app/api/coordinator/bundle-selection/route.ts');
        expect(setup).toContain('deliveryTime: setup?.delivery_time');
        expect(setup).toContain('pickupLocation: setup?.pickup_location');
        expect(setup).toContain('orderDeadline: dateToIso(setup?.end_date');
    });

    test('the tenant list returns the fields the editor prefills from', () => {
        const src = R('app/api/campaigns/route.ts');
        const select = src.slice(src.indexOf('bundle_goal: true'), src.indexOf('bundle_goal: true') + 600);
        expect(select).toContain('delivery_date: true');
        expect(select).toContain('delivery_time: true');
        expect(select).toContain('pickup_location: true');
    });

    test('no duplicate storage was introduced for any of the four fields', () => {
        const schema = R('prisma/schema.prisma');
        // Scoped to the campaign model: Order.delivery_date is a different fact (when
        // THAT order is delivered), not a second copy of the fundraiser's date.
        const model = schema.slice(
            schema.indexOf('model FundraiserCampaign '),
            schema.indexOf('@@map("fundraiser_campaigns")'),
        );
        for (const f of ['delivery_time', 'delivery_date', 'pickup_location', 'end_date']) {
            const hits = model.split('\n').filter(l => new RegExp(`^\\s+${f}\\s`).test(l));
            expect(hits).toHaveLength(1);
        }
        for (const bad of ['tenant_pickup_time', 'coordinator_pickup_time', 'supporter_pickup_time']) {
            expect(schema).not.toContain(bad);
        }
    });

    test('the goal is the existing weighted bundle target, not a new field', () => {
        expect(DEFAULT_BUNDLE_GOAL).toBe(20);
        expect(resolveBundleGoal(null)).toBe(20);
        expect(resolveBundleGoal(35)).toBe(35);
        expect(resolveBundleGoal(0)).toBe(20);
    });

    test('weighted bundle math is unchanged — serves_5 = 1, serves_2 = 0.5', () => {
        expect(computeBundleUnitsFromItems([
            { quantity: 3, variant_size: 'serves_5' },
            { quantity: 4, variant_size: 'serves_2' },
        ])).toBe(5);
    });

    test('the editor reuses that math rather than restating it', () => {
        const modal = R('components/crm2/EditCampaignDetailsModal.tsx');
        expect(modal).toContain("from '@/lib/fundraiserMetrics'");
        expect(modal).not.toMatch(/0\.5|serves_2|serves_5/);
    });

    test('the editor prefills dates through the off-by-one helper, never through new Date()', () => {
        const modal = R('components/crm2/EditCampaignDetailsModal.tsx');
        expect(modal).toContain('safeCalendarDateForInput');
        expect(modal).not.toMatch(/new Date\(/);
    });

    test('the editor never offers a financial field', () => {
        // Comments discuss why the share and the dollar goal are excluded, so the
        // assertion is on CODE with comments stripped, not on the raw file.
        const code = R('components/crm2/EditCampaignDetailsModal.tsx')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        // 'settlement' is deliberately absent from this list: the closed-campaign panel
        // explains that the invoice and settlement were produced from these values, and
        // that sentence is the point of the panel. What must not exist is a FIELD.
        for (const f of ['org_share_percent', 'orgSharePercent', 'goal_amount', 'tax_rate', 'checks_payable']) {
            expect(code).not.toContain(f);
        }
        // No input is bound to anything but the five operational keys.
        const bound = code.match(/id="cd-[a-z-]+"/g)!.sort();
        expect(bound).toEqual([
            'id="cd-bundle-goal"', 'id="cd-delivery-date"', 'id="cd-delivery-time"',
            'id="cd-end-date"', 'id="cd-pickup-location"',
        ]);
        // And the only keys it can ever POST are the five it owns.
        const body = code.slice(code.indexOf('const body: Record<string, unknown> = {}'), code.indexOf('if (Object.keys(body).length'));
        expect(body.match(/body\.(\w+)/g)!.sort()).toEqual([
            'body.bundleGoal', 'body.delivery_date', 'body.delivery_time',
            'body.end_date', 'body.pickup_location',
        ]);
    });

    test('calendarDayToDate produces the UTC midnight a @db.Date column expects', () => {
        expect(calendarDayToDate('2026-11-03').toISOString()).toBe('2026-11-03T00:00:00.000Z');
    });
});
