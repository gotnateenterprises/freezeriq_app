/**
 * CRM-LEAD-D1 — a fundraiser supporter is a CUSTOMER of the tenant, not a sales lead.
 *
 * THE DEFECT
 * `Customer.status` is `@default(LEAD)` and every creation path in the app hardcodes it anyway, so
 * LEAD means "nobody has touched this record yet", not "this is a sales lead". The Customer CRM read
 * it as the latter: the "Active Leads" tile counted every unarchived `status === 'LEAD'` row and the
 * "New Leads" filter listed them. At audit time that was 34 fundraiser supporters out of 55 LEAD rows
 * — people who bought a bundle to back a campaign and never asked to run one.
 *
 * WHY THIS IS A CLASSIFICATION FIX AND NOT A DATA FIX
 * The status enum is the fundraiser-ORGANISATION pipeline (LEAD -> SEND_INFO "Send Info" -> FLYERS
 * "Send Marketing Tools" -> ACTIVE "In Progress" -> ... -> COMPLETE). It has no value meaning "has
 * purchased": COMPLETE is labelled "Active" but `setStatus`/`progressStatus` ARCHIVE the row when it
 * is reached, and ACTIVE is counted as an in-progress fundraiser. So there is no correct status to
 * move supporters to, and none is written. Their row, order history, `source` and persisted `status`
 * are all left exactly as they are; only the question "is this a sales lead?" moves somewhere better.
 *
 * THE BOUNDARY IS NOT NEW. lib/fundraiserLead.ts already states it for the Fundraiser CRM list and
 * for the lead-alert e-mail: "Having an email, having ordered, or being on the surplus waitlist does
 * NOT qualify — only genuine fundraiser intent does." `isFundraiserSupporter` is the third reader of
 * that same rule, which is why it is defined in that file and not inline at any of the three surfaces.
 *
 * WHAT MUST NOT CHANGE, and is asserted below: supporters stay fully visible in the People lens,
 * genuine /raise-funds leads keep behaving as leads, and no other customer kind is reclassified.
 */
import fs from 'fs';
import path from 'path';
import { createPrismaMock, readJson } from './helpers/routeHarness';
import {
    isFundraiserSupporter,
    qualifiesAsCustomerCrmLead,
    belongsInFundraiserCrm,
    FUNDRAISER_INQUIRY_TAG,
    FUNDRAISER_SUPPORTER_SOURCE,
} from '../lib/fundraiserLead';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__crmLeadD1Prisma; },
}));
const authMock = jest.fn(async () => null as any);
jest.mock('@/auth', () => ({ auth: (...a: any[]) => authMock(...(a as [])) }));
// The dashboard route builds these at module scope of the handler; neither is exercised by the
// Recent Activity label under test, and both would otherwise drag a real production planner in.
jest.mock('@/lib/kitchen_engine', () => ({ KitchenEngine: class { async generateProductionPlan() { return { ingredients: [] }; } } }));
jest.mock('@/lib/prisma_adapter', () => ({ PrismaAdapter: class { } }));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

const session = (businessId: string | null) =>
    businessId
        // The CRM is plan-gated; ENTERPRISE is the ordinary case and is not what these tests probe.
        ? { user: { businessId, email: 'owner@tenant.invalid', plan: 'ENTERPRISE' } }
        : null;

/**
 * The five customer kinds the audit separated, in the RAW shape Prisma returns.
 * `orders` is present because /api/customers selects it and sums it for total_spend.
 */
const KINDS = {
    // A — the supporter. Created by /api/public/order when campaign !== null.
    supporter: {
        id: 'cust-supporter', name: 'Dana Fields', contact_name: null,
        type: 'direct_customer', source: FUNDRAISER_SUPPORTER_SOURCE, status: 'LEAD',
        contact_email: 'dana@example.invalid', archived: false, tags: [], orders: [],
    },
    // B — a genuine /raise-funds enquiry that created its own organisation row.
    inquiryOrg: {
        id: 'cust-inquiry-org', name: 'Clark Co Farm Bureau', contact_name: 'Pat Reed',
        type: 'fundraiser_org', source: 'Fundraiser Inquiry', status: 'LEAD',
        contact_email: 'pat@example.invalid', archived: false, tags: [FUNDRAISER_INQUIRY_TAG], orders: [],
    },
    // B' — the FR-FLOW-1R case: an existing retail person who LATER enquired, so the inquiry
    // enriched their direct_customer row and tagged it rather than creating a new one.
    supporterWhoLaterEnquired: {
        id: 'cust-supporter-enquired', name: 'Jo Mercer', contact_name: null,
        type: 'direct_customer', source: FUNDRAISER_SUPPORTER_SOURCE, status: 'LEAD',
        contact_email: 'jo@example.invalid', archived: false, tags: [FUNDRAISER_INQUIRY_TAG], orders: [],
    },
    // D — an ordinary storefront purchaser.
    storefront: {
        id: 'cust-storefront', name: 'Sam Okafor', contact_name: null,
        type: 'direct_customer', source: 'Storefront', status: 'LEAD',
        contact_email: 'sam@example.invalid', archived: false, tags: [], orders: [],
    },
    // E — imported / waitlist / manual individuals.
    squareCsv: {
        id: 'cust-square', name: 'Lee Park', contact_name: null,
        type: 'direct_customer', source: 'Square CSV', status: 'LEAD',
        contact_email: 'lee@example.invalid', archived: false, tags: [], orders: [],
    },
    waitlist: {
        id: 'cust-waitlist', name: 'Robin Vale', contact_name: null,
        type: 'direct_customer', source: 'Manual', status: 'LEAD',
        contact_email: 'robin@example.invalid', archived: false, tags: ['surplus_waitlist'], orders: [],
    },
    // A manually-created organisation, mid-pipeline.
    manualOrg: {
        id: 'cust-manual-org', name: 'Northside Band', contact_name: 'Alex Kim',
        type: 'organization', source: 'Manual', status: 'FLYERS',
        contact_email: 'alex@example.invalid', archived: false, tags: [], orders: [],
    },
};

/** Run GET /api/customers against a canned customer set. */
async function getCustomers(rows: any[], opts: { type?: string; businessId?: string | null } = {}) {
    const businessId = opts.businessId === undefined ? TENANT_A : opts.businessId;
    const mock = createPrismaMock({
        results: {
            'customer.findMany': rows,
            'order.findMany': [],
        },
    });
    (global as any).__crmLeadD1Prisma = mock.client;
    authMock.mockResolvedValue(session(businessId) as any);
    const { GET } = await import('@/app/api/customers/route');
    const url = `http://localhost/api/customers${opts.type ? `?type=${opts.type}` : ''}`;
    const res = await GET(new Request(url));
    return { ...(await readJson(res)), mock };
}

beforeEach(() => {
    jest.resetModules();
    authMock.mockReset();
});

// ---------------------------------------------------------------------------
// The boundary itself
// ---------------------------------------------------------------------------
describe('CRM-LEAD-D1 / the classification predicate', () => {
    test('A: a fundraiser supporter is a supporter', () => {
        expect(isFundraiserSupporter(KINDS.supporter)).toBe(true);
    });

    test('A: and is therefore NOT a CRM lead, despite status === LEAD', () => {
        expect(KINDS.supporter.status).toBe('LEAD');
        expect(qualifiesAsCustomerCrmLead({ status: 'LEAD', is_fundraiser_supporter: true })).toBe(false);
    });

    test('B: a genuine /raise-funds enquiry is not a supporter and IS a lead', () => {
        expect(isFundraiserSupporter(KINDS.inquiryOrg)).toBe(false);
        expect(belongsInFundraiserCrm(KINDS.inquiryOrg)).toBe(true);
        expect(qualifiesAsCustomerCrmLead({ status: 'LEAD', is_fundraiser_supporter: false })).toBe(true);
    });

    test('B: intent WINS over the supporter source — someone who backed a campaign and then asked to run one is a lead', () => {
        // The inquiry route tags the existing row rather than creating a second one (FR-FLOW-1R), so
        // `source` stays 'Fundraiser'. Expressing the intent half as !belongsInFundraiserCrm is what
        // makes this come out right; a bare `source === 'Fundraiser'` check would misclassify them.
        expect(KINDS.supporterWhoLaterEnquired.source).toBe(FUNDRAISER_SUPPORTER_SOURCE);
        expect(isFundraiserSupporter(KINDS.supporterWhoLaterEnquired)).toBe(false);
        expect(belongsInFundraiserCrm(KINDS.supporterWhoLaterEnquired)).toBe(true);
    });

    test('D/E: no other customer kind is reclassified', () => {
        expect(isFundraiserSupporter(KINDS.storefront)).toBe(false);
        expect(isFundraiserSupporter(KINDS.squareCsv)).toBe(false);
        expect(isFundraiserSupporter(KINDS.waitlist)).toBe(false);
        expect(isFundraiserSupporter(KINDS.manualOrg)).toBe(false);
    });

    test('D/E: and they all still qualify as leads exactly as before', () => {
        for (const kind of [KINDS.storefront, KINDS.squareCsv, KINDS.waitlist]) {
            expect(qualifiesAsCustomerCrmLead({ status: kind.status, is_fundraiser_supporter: false })).toBe(true);
        }
    });

    test('a non-LEAD row is never a lead, supporter or not', () => {
        expect(qualifiesAsCustomerCrmLead({ status: 'FLYERS', is_fundraiser_supporter: false })).toBe(false);
        expect(qualifiesAsCustomerCrmLead({ status: 'COMPLETE', is_fundraiser_supporter: false })).toBe(false);
    });

    test('a row with no flag keeps the previous behaviour', () => {
        // The synthetic customer-less order aggregates carry no classification.
        expect(qualifiesAsCustomerCrmLead({ status: 'LEAD' })).toBe(true);
    });

    test('the predicate reads only type/source/tags — never a name, e-mail or id', () => {
        const src = R('lib/fundraiserLead.ts');
        const after = src.slice(src.indexOf('export function isFundraiserSupporter'));
        // Bound on the next top-level declaration: the parameter type block contains a `\n}` of
        // its own, so slicing at the first one would cut the function in half.
        const fn = after.slice(0, after.indexOf('\n/**'));
        expect(fn).toContain('direct_customer');
        expect(fn).toContain('FUNDRAISER_SUPPORTER_SOURCE');
        expect(fn).toContain('belongsInFundraiserCrm');
        expect(fn).not.toMatch(/name|email|campaign_id|includes\(['"]/);
    });
});

// ---------------------------------------------------------------------------
// C — People visibility, and the flag the CRM surfaces consume
// ---------------------------------------------------------------------------
describe('CRM-LEAD-D1 / GET /api/customers', () => {
    test('C: a supporter is still returned in the People lens', async () => {
        const { status, body } = await getCustomers([KINDS.supporter]);
        expect(status).toBe(200);
        const row = body.customers.find((c: any) => c.id === 'cust-supporter');
        expect(row).toBeDefined();
        expect(row.type).toBe('Individual');
    });

    test('C: with their order history, source and status all intact', async () => {
        const { body } = await getCustomers([
            { ...KINDS.supporter, orders: [{ created_at: new Date('2026-09-01'), total_amount: 60, status: 'fundraiser_hold' }] },
        ]);
        const row = body.customers.find((c: any) => c.id === 'cust-supporter');
        expect(row.status).toBe('LEAD');                 // persisted status untouched
        expect(row.source).toBe(FUNDRAISER_SUPPORTER_SOURCE);
        expect(row.order_count).toBe(1);
        expect(row.total_spend).toBe('$60.00');
    });

    test('A: the route flags them as a supporter', async () => {
        const { body } = await getCustomers([KINDS.supporter]);
        expect(body.customers.find((c: any) => c.id === 'cust-supporter').is_fundraiser_supporter).toBe(true);
    });

    test('D/E: every other People row is flagged false', async () => {
        const { body } = await getCustomers([KINDS.storefront, KINDS.squareCsv, KINDS.waitlist]);
        expect(body.customers).toHaveLength(3);
        for (const row of body.customers) expect(row.is_fundraiser_supporter).toBe(false);
    });

    test('B: organisations are flagged false and still appear in the Organizations lens', async () => {
        const { body } = await getCustomers([KINDS.inquiryOrg, KINDS.manualOrg], { type: 'organization' });
        expect(body.customers).toHaveLength(2);
        for (const row of body.customers) expect(row.is_fundraiser_supporter).toBe(false);
    });

    test('the two lenses stay disjoint — a supporter never leaks into Organizations', async () => {
        const all = [KINDS.supporter, KINDS.inquiryOrg, KINDS.manualOrg, KINDS.storefront];
        const people = await getCustomers(all);
        const orgs = await getCustomers(all, { type: 'organization' });
        const peopleIds = people.body.customers.map((c: any) => c.id);
        const orgIds = orgs.body.customers.map((c: any) => c.id);
        expect(peopleIds).toContain('cust-supporter');
        expect(orgIds).not.toContain('cust-supporter');
        expect(peopleIds.filter((id: string) => orgIds.includes(id))).toHaveLength(0);
    });

    test('E: the query is tenant-scoped', async () => {
        const { mock } = await getCustomers([KINDS.supporter]);
        const call = mock.firstCall('customer.findMany');
        expect(call!.args.where.business_id).toBe(TENANT_A);
        expect(mock.firstCall('order.findMany')!.args.where.business_id).toBe(TENANT_A);
    });

    test('E: another tenant gets its own scope, never a shared one', async () => {
        const { mock } = await getCustomers([], { businessId: TENANT_B });
        expect(mock.firstCall('customer.findMany')!.args.where.business_id).toBe(TENANT_B);
    });

    test('E: an unauthenticated caller is refused before any query runs', async () => {
        const { status, mock } = await getCustomers([KINDS.supporter], { businessId: null });
        expect(status).toBe(401);
        expect(mock.callsTo('customer.findMany')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// FIX 1 + FIX 2 — the two CRM surfaces share one rule
// ---------------------------------------------------------------------------
describe('CRM-LEAD-D1 / the Customer CRM surfaces', () => {
    const page = () => R('app/customers/page.tsx');

    test('FIX 1: the Active Leads tile counts through the shared rule, not a bare status check', () => {
        const src = page();
        const line = src.split('\n').find(l => l.includes('leads:'))!;
        expect(line).toContain('qualifiesAsCustomerCrmLead');
        expect(line).not.toMatch(/status === 'LEAD'/);
        expect(line).toContain('!c.archived');   // archived rows still excluded, as before
    });

    test('FIX 2: the New Leads filter uses the same rule', () => {
        const src = page();
        // 'IN_PROGRESS_VIEW' first appears in the useState union far above, so bound the slice on
        // the comment that introduces the next branch instead.
        const block = src.slice(src.indexOf('// Status Match'), src.indexOf('// Special case for'));
        expect(block).toContain("activeStatus === 'LEAD'");
        expect(block).toContain('qualifiesAsCustomerCrmLead');
    });

    test('both surfaces import the rule from the one file that owns it', () => {
        expect(page()).toMatch(/import \{[^}]*qualifiesAsCustomerCrmLead[^}]*\} from '@\/lib\/fundraiserLead'/);
    });

    test('the page never re-derives the classification itself', () => {
        // The raw `type` is gone by the time the page sees a row ('direct_customer' survives only
        // in a comment explaining the API), so any local attempt to recognise a supporter would
        // silently be wrong. The page must consume the server's answer, not rebuild it.
        const src = page();
        expect(src).not.toContain('isFundraiserSupporter');
        const logic = src.slice(src.indexOf('const lensFiltered'), src.indexOf('return ('));
        expect(logic).not.toContain('direct_customer');
        expect(logic).not.toContain("source === 'Fundraiser'");
        expect(logic).not.toContain( 'fundraiser_inquiry');
    });

    test('C: the People lens itself is untouched — supporters are excluded from LEAD, not from People', () => {
        const src = page();
        const lens = src.slice(src.indexOf('const lensFiltered'), src.indexOf('const filtered'));
        expect(lens).toContain("c.type === 'Individual'");
        expect(lens).not.toContain('is_fundraiser_supporter');
        expect(lens).not.toContain('qualifiesAsCustomerCrmLead');
    });

    test('D: the other tabs and status filters are untouched', () => {
        const src = page();
        const filtered = src.slice(src.indexOf('const filtered'), src.indexOf('// Metrics Calculation'));
        expect(filtered).toContain("c.status !== 'COMPLETE'");          // Completed tab
        expect(filtered).toContain("c.tags?.includes('surplus_waitlist')"); // Waitlist tab
        expect(filtered).toContain("matchesStatus = c.status === 'ACTIVE'"); // In Progress view
        // Only the LEAD branch consults the new rule.
        expect(filtered.match(/qualifiesAsCustomerCrmLead/g)).toHaveLength(1);
    });

    test('no persisted status is written by any of this', () => {
        const src = page();
        expect(src).not.toMatch(/status:\s*'(COMPLETE|INACTIVE|ACTIVE)'/);
    });
});

// ---------------------------------------------------------------------------
// FIX 3 — the dashboard Recent Activity label
// ---------------------------------------------------------------------------
describe('CRM-LEAD-D1 / dashboard Recent Activity', () => {
    /** Run GET /api/dashboard with one order in the Recent Activity feed. */
    async function activityFor(customer: any) {
        const mock = createPrismaMock({
            results: {
                // The dashboard gates on the BUSINESS plan read from the database, not on the
                // session; anything below ULTIMATE returns a restricted payload with an empty
                // recentActivity and never reaches the label under test.
                'business.findUnique': { plan: 'ULTIMATE', google_calendar_url: null },
                // Several order.findMany calls exist; only the Recent Activity one takes 5 rows
                // with the customer included.
                'order.findMany': (args: any) =>
                    args?.take === 5 && args?.include?.customer
                        ? [{
                            id: 'order-1', external_id: 'ext-1', total_amount: 60,
                            created_at: new Date('2026-09-20'), status: 'production_ready',
                            source: 'storefront', customer_name: null, customer,
                        }]
                        : [],
            },
        });
        (global as any).__crmLeadD1Prisma = mock.client;
        authMock.mockResolvedValue(session(TENANT_A) as any);
        const { GET } = await import('@/app/api/dashboard/route');
        const { status, body } = await readJson(await GET());
        expect(status).toBe(200);
        const act = (body.recentActivity || body.activity || []).find((a: any) => a.type === 'order');
        return act;
    }

    test('A: a supporter order is NOT labelled "Lead"', async () => {
        const act = await activityFor(KINDS.supporter);
        expect(act).toBeDefined();
        expect(act.status).not.toBe('Lead');
        expect(act.status).toBe('Fundraiser Supporter');
    });

    test('B: a genuine fundraiser lead still gets its pipeline label', async () => {
        const act = await activityFor(KINDS.inquiryOrg);
        expect(act.status).toBe('Lead');
    });

    test('B: and a mid-pipeline organisation keeps its own stage label', async () => {
        const act = await activityFor(KINDS.manualOrg);
        expect(act.status).toBe('Send Marketing Tools');
    });

    test('D: an ordinary storefront customer at LEAD is unaffected', async () => {
        const act = await activityFor(KINDS.storefront);
        expect(act.status).toBe('Lead');
    });

    test('an order with no customer keeps its existing fallback', async () => {
        const act = await activityFor(null);
        expect(act.status).toBe('In Progress');   // status === 'production_ready'
    });

    test('the label is chosen, never written back to the customer', async () => {
        const src = R('app/api/dashboard/route.ts');
        expect(src).toContain('Fundraiser Supporter');
        expect(src).not.toMatch(/customer\.update/);
    });
});
