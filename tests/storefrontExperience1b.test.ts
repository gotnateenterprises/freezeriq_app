/**
 * STOREFRONT-CUSTOMER-EXPERIENCE-1B — the tenant chooses which fundraisers the public
 * storefront's "Active Fundraisers" section lists.
 *
 * One boolean, FundraiserCampaign.listed_on_storefront, read by exactly one public query.
 * Everything a fundraiser needs in order to run — its direct link, supporter ordering, the
 * coordinator portal, the scoreboard, closeout and invoices — must behave identically
 * whichever way it is set. Section 2 fails the moment any other file starts reading it;
 * tests/storefrontExperience1bIsolation.test.ts runs those surfaces with it turned off.
 *
 * Real-Postgres evidence, recorded in the phase report rather than re-run here (this suite
 * has no database): the migration's backfill predicate, evaluated read-only against
 * Production before any write, selected exactly the six campaigns the storefront listed that
 * day — none lost, none gained — and two of two on the Preview database.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import {
    STOREFRONT_LISTING_CHIP,
    STOREFRONT_LISTING_HELP,
    STOREFRONT_LISTING_LABEL,
    decideStorefrontListingChange,
    isStorefrontListingRejected,
} from '@/lib/fundraiserStorefrontListing';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TENANT_A = 'biz-sf1b-aaaa';
const TENANT_B = 'biz-sf1b-bbbb';
const TENANT_ROUTE = 'app/api/public/tenant/[slug]/route.ts';
const MIGRATION = 'prisma/migrations/20260930120000_storefront_1b_fundraiser_listed_on_storefront/migration.sql';

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__sf1bPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__sf1bPrisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// The launch route resolves the tenant's eligible families through this module; every other
// export stays real, so the orderability helpers used elsewhere in the app are untouched.
jest.mock('@/lib/campaignBundleSelection', () => ({
    ...jest.requireActual('@/lib/campaignBundleSelection'),
    resolveEligibleBundleFamilies: jest.fn(async () => (global as any).__sf1bFamilies ?? []),
}));

beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { email: 'owner@tenant-a.invalid', businessId: TENANT_A, role: 'ADMIN' } });
});

/** The storefront's fundraiser discovery SQL as written, SQL comments removed, whitespace collapsed. */
function discoverySql(): string {
    const src = read(TENANT_ROUTE);
    const start = src.indexOf('await prisma.$queryRaw`', src.indexOf('Fetch Active Fundraisers'));
    const open = src.indexOf('`', start) + 1;
    const close = src.indexOf('`', open);
    return src.slice(open, close).replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The storefront discovery query — the flag's one public reader.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. the storefront discovery query', () => {
    const sql = discoverySql();

    it('A/B. lists a fundraiser only when the tenant has chosen to list it', () => {
        expect(sql).toContain('AND fc.listed_on_storefront = true');
    });

    it('H. never lists a closed-out campaign, whatever its status says', () => {
        expect(sql).toContain('AND fc.closed_at IS NULL');
    });

    it('I/J. keeps every existing orderability predicate: Active, current in the tenant calendar, not pending', () => {
        expect(sql).toContain("AND fc.status = 'Active'");
        expect(sql).toContain('AND fc.end_date >= (CURRENT_TIMESTAMP AT TIME ZONE ${tenantZone})::date');
        expect(sql).toContain("AND fc.bundle_selection_status <> 'pending'");
    });

    it('L. is tenant-scoped through the organization, with the tenant id bound as a parameter', () => {
        expect(sql).toContain('JOIN customers c ON fc.customer_id = c.id');
        expect(sql).toContain('WHERE c.business_id = ${business.id}');
    });

    it('M. orders by soonest deadline, then name, then id — a total order — with no arbitrary LIMIT', () => {
        expect(sql).toMatch(/ORDER BY fc\.end_date ASC, fc\.name ASC, fc\.id ASC$/);
        expect(sql).not.toMatch(/\bLIMIT\b/i);
    });

    it('sends no payment or financial field to every storefront visitor', () => {
        const selectList = sql.slice(0, sql.indexOf(' FROM '));
        for (const f of ['payment_instructions', 'external_payment_link', 'goal_amount', 'total_sales']) {
            expect(selectList).not.toContain(f);
        }
        for (const f of ['fc.id', 'fc.name', 'fc.about_text', 'c.name as customer_customer_name']) {
            expect(selectList).toContain(f);
        }
    });

    it('the storefront card type no longer declares the fields it never received', () => {
        const client = read('app/shop/[slug]/StorefrontClient.tsx');
        const iface = client.slice(client.indexOf('interface Fundraiser {'), client.indexOf('interface TenantData'));
        for (const f of ['payment_instructions', 'external_payment_link', 'goal_amount', 'total_sales']) {
            expect(iface).not.toContain(f);
        }
    });

    describe('the route that runs it', () => {
        const TENANT = { id: TENANT_A, name: 'SF1B Kitchen', display_name: null, slug: 'sf1b-kitchen', logo_url: null, timezone: 'America/Chicago' };

        const call = async (business: Record<string, unknown>, fundraisers: any[]) => {
            useMock(createPrismaMock({
                results: {
                    'business.findFirst': business,
                    'bundle.findMany': [],
                    $queryRaw: ({ sql: text }: { sql: string }) => (text.includes('FROM fundraiser_campaigns') ? fundraisers : []),
                },
            }));
            const { GET } = await import('@/app/api/public/tenant/[slug]/route');
            return readJson(await GET(new Request(`http://localhost/api/public/tenant/${business.slug}`), {
                params: Promise.resolve({ slug: String(business.slug) }),
            }));
        };

        const row = (id: string, name: string, end: string, org: string) => ({
            id, name, about_text: null, mission_text: null, end_date: new Date(`${end}T00:00:00.000Z`),
            participant_label: 'Seller', customer_customer_name: org,
        });

        it('A/M. returns the listed rows in the order the database gave them, with the organization name', async () => {
            const res = await call(TENANT, [
                row('c-2', 'Clark Co Fundraiser', '2026-10-12', 'Clark Co Farm Bureau'),
                row('c-3', 'Jasper Co Fundraiser', '2026-10-12', 'Jasper Co Farm Bureau'),
                row('c-4', 'Home Schoolers USA Fundraiser', '2026-10-27', 'Home Schoolers USA'),
            ]);
            expect(res.status).toBe(200);
            expect(res.body.fundraisers.map((f: any) => f.id)).toEqual(['c-2', 'c-3', 'c-4']);
            expect(res.body.fundraisers[0].customer).toEqual({ name: 'Clark Co Farm Bureau' });
        });

        it('B. when the tenant lists nothing, the section receives nothing', async () => {
            const res = await call(TENANT, []);
            expect(res.status).toBe(200);
            expect(res.body.fundraisers).toEqual([]);
        });

        it('L. binds exactly this tenant\'s id and zone into the query', async () => {
            await call(TENANT, []);
            const q = mock.callsTo('$queryRaw.raw').find((c) => c.args.sql.includes('FROM fundraiser_campaigns'))!;
            expect(q.args.values).toEqual([TENANT_A, 'America/Chicago']);
        });

        it('an unusable tenant zone still lists nothing, without running the query', async () => {
            const res = await call({ ...TENANT, timezone: 'Not/AZone' }, [row('c-9', 'Never Shown', '2026-10-12', 'Org')]);
            expect(res.body.fundraisers).toEqual([]);
            expect(mock.rawQueries.some((s) => s.includes('FROM fundraiser_campaigns'))).toBe(false);
        });
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Nothing else reads the flag. Adding a reader means changing this list on purpose.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the flag is discovery-only: no other file reads it', () => {
    const SOURCE_ROOTS = ['app', 'lib', 'components'];
    const ROOT_FILES = ['middleware.ts', 'auth.ts', 'auth.config.ts'];
    const FLAG = /listed_on_storefront|listedOnStorefront|fundraiserStorefrontListing|STOREFRONT_LISTING_|Show on customer storefront/;

    const walk = (dir: string): string[] =>
        readdirSync(join(ROOT, dir)).flatMap((name) => {
            const rel = `${dir}/${name}`;
            if (statSync(join(ROOT, rel)).isDirectory()) return walk(rel);
            return /\.(ts|tsx)$/.test(name) ? [rel] : [];
        });

    const sourceFiles = [
        ...SOURCE_ROOTS.flatMap(walk),
        ...ROOT_FILES.filter((f) => existsSync(join(ROOT, f))),
    ];

    const READERS = [
        // The one public reader.
        'app/api/public/tenant/[slug]/route.ts',
        // The tenant's own CRM: list, create, launch, edit.
        'app/api/campaigns/route.ts',
        'app/api/campaigns/[id]/route.ts',
        'app/api/opportunities/[id]/launch/route.ts',
        'components/crm2/CampaignPriorityList.tsx',
        'components/crm2/EditCampaignDetailsModal.tsx',
        'components/crm2/LaunchFundraiserDialog.tsx',
        'components/crm2/StartFundraiserWizard.tsx',
        // The shared decision and copy.
        'lib/fundraiserStorefrontListing.ts',
    ];

    it('the complete set of files that mention the flag is exactly the storefront query and the tenant CRM', () => {
        const readers = sourceFiles.filter((f) => FLAG.test(read(f))).map((f) => f.split(sep).join('/'));
        expect(readers.sort()).toEqual([...READERS].sort());
    });

    // Named so a reviewer can see what the rule protects. The scan above already covers them;
    // this makes each one's absence explicit, and proves the path is real rather than vacuous.
    const PROTECTED: [string, string][] = [
        ['C', 'app/shop/[slug]/fundraiser/[fundraiserId]/page.tsx'],
        ['C', 'app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx'],
        ['C', 'lib/publicFundraiserPayload.ts'],
        ['D', 'app/api/public/order/route.ts'],
        ['D', 'lib/campaignOrderBundles.ts'],
        ['D', 'lib/campaignBundleSelection.ts'],
        ['E', 'app/api/coordinator'],
        ['E', 'app/api/coordinator-actions'],
        ['E', 'app/coordinator'],
        ['E', 'components/coordinator'],
        ['F', 'app/api/fundraiser/[token]/route.ts'],
        ['F', 'app/fundraiser/[token]/page.tsx'],
        ['G', 'app/api/campaigns/[id]/closeout/route.ts'],
        ['G', 'lib/fundraiserCloseoutMath.ts'],
        ['G', 'app/api/tenant/invoices'],
        ['G', 'lib/quickbooks'],
        ['G', 'app/api/integrations/quickbooks'],
        ['G', 'lib/fundraiserTax.ts'],
        ['QR / flyer / packet / promo', 'app/api/qr'],
        ['QR / flyer / packet / promo', 'app/api/flyer'],
        ['QR / flyer / packet / promo', 'app/api/packet'],
        ['QR / flyer / packet / promo', 'app/api/promo-scripts'],
        ['QR / flyer / packet / promo', 'lib/generateFlyer.ts'],
        ['bundle selection', 'app/api/campaigns/[id]/bundles/route.ts'],
        ['production release', 'app/api/production'],
        ['production release', 'lib/kitchen_engine.ts'],
        ['reporting', 'app/api/analytics'],
        ['reporting', 'app/api/dashboard'],
        ['reporting', 'app/api/tracker'],
        ['rebooking', 'app/api/rebooking'],
        ['rebooking', 'app/api/rebook'],
        ['rebooking', 'lib/fundraiserRebooking.ts'],
        ['supporter contact history', 'lib/previousSupporters.ts'],
        ['supporter contact history', 'lib/coordinatorSupporterOrders.ts'],
    ];

    it.each(PROTECTED)('%s: %s never reads the flag', (_test, path) => {
        expect(existsSync(join(ROOT, path))).toBe(true);
        const files = statSync(join(ROOT, path)).isDirectory() ? walk(path) : [path];
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) expect(read(f)).not.toMatch(FLAG);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. PATCH /api/campaigns/[id] — explicit, tenant-scoped, no financial or lifecycle write.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the campaign API writes the flag and nothing else', () => {
    const campaignRow = (over: Record<string, unknown> = {}) => ({
        id: 'camp-1', name: 'Clark Co Fundraiser', status: 'Active', closed_at: null,
        delivery_date: new Date('2026-10-17T00:00:00.000Z'), delivery_time: '4:00 PM',
        end_date: new Date('2026-10-12T00:00:00.000Z'), pickup_location: 'Gym', checks_payable: 'Clark Co FB',
        tax_status: 'TAXABLE', listed_on_storefront: false,
        customer: { business_id: TENANT_A, tax_status: 'TAXABLE' },
        ...over,
    });

    const patch = async (body: unknown, row: Record<string, unknown> = campaignRow()) => {
        useMock(createPrismaMock({ results: { 'fundraiserCampaign.findUnique': row } }));
        const { PATCH } = await import('@/app/api/campaigns/[id]/route');
        return readJson(await PATCH(new Request('http://localhost/api/campaigns/camp-1', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }), { params: Promise.resolve({ id: 'camp-1' }) }));
    };

    /** The keys the update would really write — Prisma skips `undefined`. */
    const written = () => {
        const data = mock.firstCall('fundraiserCampaign.update')!.args.data;
        return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    };

    it('turning it on writes exactly that one column', async () => {
        const res = await patch({ listed_on_storefront: true });
        expect(res.status).toBe(200);
        expect(written()).toEqual({ listed_on_storefront: true });
    });

    it('it touches no financial, tax or lifecycle state, and triggers no activation work', async () => {
        await patch({ listed_on_storefront: true });
        const data = mock.firstCall('fundraiserCampaign.update')!.args.data;
        for (const k of ['status', 'org_share_percent', 'bundle_goal', 'goal_amount', 'total_sales', 'tax_status',
            'tax_rate_percent', 'closed_at', 'closed_by', 'settlement_total', 'settlement_notes', 'settled_externally',
            'end_date', 'delivery_date', 'bundle_selection_status']) {
            expect(data[k]).toBeUndefined();
        }
        expect(mock.callsTo('order.count')).toHaveLength(0);
        expect(mock.callsTo('invoice.count')).toHaveLength(0);
    });

    it('may be changed on a closed campaign — a closed campaign is never listed either way', async () => {
        const res = await patch({ listed_on_storefront: false }, campaignRow({
            status: 'Completed', closed_at: new Date('2026-09-20T15:00:00Z'), listed_on_storefront: true,
        }));
        expect(res.status).toBe(200);
        expect(written()).toEqual({ listed_on_storefront: false });
    });

    it('an omitted flag is left exactly as stored', async () => {
        const res = await patch({ pickup_location: 'Library' });
        expect(res.status).toBe(200);
        expect(written()).not.toHaveProperty('listed_on_storefront');
    });

    it.each([null, 'true', 1, 'yes'])('a non-boolean (%p) is refused and nothing is written', async (value) => {
        const res = await patch({ listed_on_storefront: value });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it("L. another tenant's campaign cannot be changed", async () => {
        const res = await patch({ listed_on_storefront: true }, campaignRow({ customer: { business_id: TENANT_B } }));
        expect(res.status).toBe(403);
        expect(mock.callsTo('fundraiserCampaign.update')).toHaveLength(0);
    });

    it('the decision is one shared rule', () => {
        expect(decideStorefrontListingChange(undefined)).toEqual({ change: false });
        expect(decideStorefrontListingChange(true)).toEqual({ change: true, listed: true });
        expect(decideStorefrontListingChange(false)).toEqual({ change: true, listed: false });
        const refused = decideStorefrontListingChange('false');
        expect(isStorefrontListingRejected(refused)).toBe(true);
    });

    it('the CRM list sends the stored value to the dialog and the indicator', () => {
        const route = strip(read('app/api/campaigns/route.ts'));
        expect(route).toMatch(/listed_on_storefront: true,/);
        expect(route).toMatch(/listed_on_storefront: \(fc as any\)\.listed_on_storefront === true,/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. K. A new campaign is unlisted unless the tenant says otherwise.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. K. new campaigns default to unlisted', () => {
    it('the column defaults to false', () => {
        const model = /model FundraiserCampaign \{[\s\S]*?\n\}/.exec(read('prisma/schema.prisma'))![0];
        expect(model).toMatch(/^\s+listed_on_storefront\s+Boolean\s+@default\(false\)$/m);
    });

    describe('POST /api/campaigns (Start fundraiser)', () => {
        const create = async (extra: Record<string, unknown>) => {
            const m = createPrismaMock({
                results: {
                    'customer.findFirst': { id: 'cust-1', tax_status: 'UNKNOWN' },
                    'business.findUnique': { default_food_tax_percent: 8 },
                    'bundle.findMany': [
                        { id: 'b5-1', name: 'Comfort Classics', serving_tier: 'serves_5', family_id: 'fam-1' },
                        { id: 'b2-1', name: 'Comfort Classics (Serves 2)', serving_tier: 'serves_2', family_id: 'fam-1' },
                    ],
                    'fundraiserCampaign.findFirst': null,
                    'fundraiserCampaign.create': (args: any) => ({ id: 'camp-new', ...args.data }),
                },
            });
            m.client.$executeRaw = jest.fn(async () => 0);
            useMock(m);
            const { POST } = await import('@/app/api/campaigns/route');
            return readJson(await POST(new Request('http://localhost/api/campaigns', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customerId: 'cust-1', name: 'Autumn Fundraiser', deliveryDate: '2027-03-15', endDate: '2027-03-10',
                    bundleSelection: { mode: 'coordinator_selects', candidateFamilyIds: ['fam-1'], selectionLimit: 1 },
                    ...extra,
                }),
            })));
        };

        it('omitted: the database default applies — unlisted', async () => {
            const res = await create({});
            expect(res.status).toBe(200);
            expect(mock.firstCall('fundraiserCampaign.create')!.args.data).not.toHaveProperty('listed_on_storefront');
        });

        it('chosen at creation: written as chosen', async () => {
            await create({ listedOnStorefront: true });
            expect(mock.firstCall('fundraiserCampaign.create')!.args.data.listed_on_storefront).toBe(true);
        });

        it('a non-boolean is refused before anything is created', async () => {
            const res = await create({ listedOnStorefront: 'yes' });
            expect(res.status).toBe(400);
            expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
        });
    });

    describe('POST /api/opportunities/[id]/launch (Launch fundraiser)', () => {
        const launch = async (extra: Record<string, unknown>) => {
            (global as any).__sf1bFamilies = [
                { familyId: 'fam-1', serves5: { id: 'b5-1', name: 'Comfort Classics' }, serves2: { id: 'b2-1' } },
                { familyId: 'fam-2', serves5: { id: 'b5-2', name: 'Weeknight Winners' }, serves2: { id: 'b2-2' } },
            ];
            useMock(createPrismaMock({
                results: {
                    'fundraiserOpportunity.findFirst': {
                        id: 'opp-1', status: 'date_confirmed', customer_id: 'org-1',
                        confirmed_delivery_date: new Date('2026-10-17T00:00:00.000Z'), campaign_id: null,
                        customer: { tax_status: 'UNKNOWN' },
                    },
                    'fundraiserOrganizationContact.findFirst': { id: 'rel-1', business_id: TENANT_A, customer_id: 'org-1', ended_at: null },
                    'business.findUnique': { default_food_tax_percent: 8 },
                    'fundraiserCampaign.create': { id: 'camp-new' },
                    'fundraiserCampaign.findUnique': { portal_token: null },
                    'fundraiserOpportunity.updateMany': { count: 1 },
                },
            }));
            const { POST } = await import('@/app/api/opportunities/[id]/launch/route');
            return readJson(await POST(new Request('http://localhost/api/opportunities/opp-1/launch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Autumn Fundraiser', endDate: '2026-10-10', orgContactId: 'rel-1',
                    candidateFamilyIds: ['fam-1', 'fam-2'], selectionLimit: 2, ...extra,
                }),
            }), { params: Promise.resolve({ id: 'opp-1' }) }));
        };

        it('omitted: the database default applies — unlisted', async () => {
            const res = await launch({});
            expect(res.status).toBe(201);
            expect(mock.firstCall('fundraiserCampaign.create')!.args.data).not.toHaveProperty('listed_on_storefront');
        });

        it('chosen at launch: written as chosen', async () => {
            await launch({ listedOnStorefront: true });
            expect(mock.firstCall('fundraiserCampaign.create')!.args.data.listed_on_storefront).toBe(true);
        });

        it('a non-boolean is refused before anything is created', async () => {
            const res = await launch({ listedOnStorefront: 1 });
            expect(res.status).toBe(400);
            expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
        });
    });

    it('both launch flows start the toggle OFF and send the tenant\'s choice', () => {
        // Raw source: on a CRLF checkout the line-comment stripper eats the newline before a comment line.
        for (const file of ['components/crm2/StartFundraiserWizard.tsx', 'components/crm2/LaunchFundraiserDialog.tsx']) {
            const src = read(file);
            expect(src).toContain('const [listedOnStorefront, setListedOnStorefront] = useState(false);');
            expect(src).toMatch(/\blistedOnStorefront,\r?\n/);
            expect(src).toContain('{STOREFRONT_LISTING_LABEL}');
            expect(src).toContain('{STOREFRONT_LISTING_HELP}');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The tenant UI.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. the tenant controls', () => {
    it('uses the owner-approved wording, stated once', () => {
        expect(STOREFRONT_LISTING_LABEL).toBe('Show on customer storefront');
        expect(STOREFRONT_LISTING_HELP).toBe(
            'Display this fundraiser in the public Active Fundraisers section. Direct fundraiser links continue to work when this is off.');
        expect(STOREFRONT_LISTING_CHIP).toBe('On storefront');
    });

    describe('Edit details', () => {
        const src = strip(read('components/crm2/EditCampaignDetailsModal.tsx'));

        it('shows the stored state and sends the flag only when the tenant changed it', () => {
            expect(src).toContain('const initialListed = campaign.listed_on_storefront === true;');
            expect(src).toContain('const [listed, setListed] = useState(initialListed);');
            expect(src).toContain('if (listed !== initialListed) body.listed_on_storefront = listed;');
        });

        it('renders an accessible toggle with the shared label and help', () => {
            expect(src).toMatch(/<input\s+id="cd-listed-on-storefront"\s+type="checkbox"/);
            expect(src).toContain('aria-describedby="cd-listed-on-storefront-help"');
            expect(src).toContain('{STOREFRONT_LISTING_LABEL}');
            expect(src).toContain('{STOREFRONT_LISTING_HELP}');
        });

        it('a closed campaign shows its stored choice read-only', () => {
            const closedPanel = src.slice(src.indexOf(') : closed ? ('), src.indexOf('<div className="space-y-5">'));
            expect(closedPanel).toContain("<Row label={STOREFRONT_LISTING_LABEL} value={initialListed ? 'On' : 'Off'} />");
            expect(closedPanel).not.toContain('setListed');
        });
    });

    it('the CRM indicator appears only when the public list would really show the fundraiser', () => {
        const src = strip(read('components/crm2/CampaignPriorityList.tsx'));
        expect(src).toContain("const onStorefront = c.listed_on_storefront === true && c.status === 'Active' && !c.closed_at");
        expect(src).toContain("&& c.bundle_selection_status !== 'pending' && !ended;");
        expect(src).toMatch(/\{onStorefront && \([\s\S]*?\{STOREFRONT_LISTING_CHIP\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. N. The migration keeps exactly today's listing.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. N. the migration', () => {
    const sql = read(MIGRATION).replace(/\r\n/g, '\n').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    const unquoted = sql.replace(/"/g, '').replace(/\s+/g, ' ');

    it('adds one NOT NULL column that defaults to false — exactly what the schema declares', () => {
        expect(statements[0]).toBe('ALTER TABLE "fundraiser_campaigns" ADD COLUMN "listed_on_storefront" BOOLEAN NOT NULL DEFAULT false');
    });

    it('its only other statement sets that one column TRUE and writes nothing else', () => {
        expect(statements).toHaveLength(2);
        expect(statements[1]).toMatch(/^UPDATE "fundraiser_campaigns" AS fc\nSET "listed_on_storefront" = true\nFROM "customers" AS c\n/);
        expect(statements[1].match(/\bSET\b/g)).toHaveLength(1);
    });

    it('backfills with the predicate the storefront lists by today, plus closed_at IS NULL', () => {
        const d = discoverySql();
        // Each discovery predicate, and its counterpart in the backfill (tenant zone read per row).
        expect(d).toContain("fc.status = 'Active'");
        expect(unquoted).toContain("AND fc.status = 'Active'");
        expect(d).toContain("fc.bundle_selection_status <> 'pending'");
        expect(unquoted).toContain("AND fc.bundle_selection_status <> 'pending'");
        expect(d).toContain('fc.end_date >= (CURRENT_TIMESTAMP AT TIME ZONE ${tenantZone})::date');
        expect(unquoted).toContain('THEN fc.end_date >= (CURRENT_TIMESTAMP AT TIME ZONE b.timezone)::date');
        expect(d).toContain('fc.closed_at IS NULL');
        expect(unquoted).toContain('AND fc.closed_at IS NULL');
        // Tenant-safe: every campaign is judged by its OWN organization's tenant.
        expect(unquoted).toContain('FROM customers AS c JOIN businesses AS b ON b.id = c.business_id WHERE fc.customer_id = c.id');
    });

    it('never evaluates AT TIME ZONE with a zone Postgres does not know', () => {
        expect(unquoted).toContain('AND CASE WHEN b.timezone IN (SELECT tz.name FROM pg_timezone_names AS tz) THEN');
        expect(unquoted).toMatch(/ELSE false END;\s*$/);
    });

    it('names no id and is destructive nowhere', () => {
        expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|\bDELETE\s+FROM|\bINSERT\s+INTO|\bTRUNCATE\b/i);
    });
});
