/**
 * FR-FLOW-1R — coordinator token strength + fundraiser lead visibility.
 *
 * Two gates failed the FR-FLOW-1 adversarial review and are pinned here:
 *
 *  1. portal_token had NO application generator. Every campaign-creation path
 *     omitted the column, so every coordinator credential came from the schema
 *     default @default(cuid()) — a sortable identifier, not a secret.
 *
 *  2. An inquiry from someone who ALREADY existed in the tenant (a storefront
 *     buyer or waitlist signup, both `direct_customer`) was saved and then
 *     filtered out of the Fundraiser CRM, because that list matched on `type`
 *     alone. The lead existed and nobody could see it.
 */

import fs from 'fs';
import path from 'path';
import {
    mintCoordinatorPortalToken,
    looksLikeLegacyCuid,
    COORDINATOR_PORTAL_TOKEN_LENGTH,
} from '@/lib/coordinatorPortalToken';
import {
    FUNDRAISER_INQUIRY_TAG,
    FUNDRAISER_CRM_TYPES,
    belongsInFundraiserCrm,
    fundraiserCrmCustomerFilter,
} from '@/lib/fundraiserLead';
import {
    createPrismaMock,
    jsonRequest,
    readJson,
    type PrismaMock,
} from './helpers/routeHarness';

let mock: PrismaMock = createPrismaMock();
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__frFlow1Prisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__frFlow1Session) }));
jest.mock('@/lib/email', () => ({ sendLeadNotificationEmail: jest.fn(async () => undefined) }));

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';

function useMock(m: PrismaMock) { mock = m; (global as any).__frFlow1Prisma = m.client; }
function useSession(s: any) { (global as any).__frFlow1Session = s; }

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock());
    useSession(null);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('1. the coordinator token generator is a secret, not an identifier', () => {
    it('produces 43 base64url chars — 256 bits of entropy', () => {
        const t = mintCoordinatorPortalToken();
        expect(t).toHaveLength(COORDINATOR_PORTAL_TOKEN_LENGTH);
        expect(COORDINATOR_PORTAL_TOKEN_LENGTH).toBe(43);
    });

    it('is URL-safe — no +, /, = or anything needing escaping', () => {
        for (let i = 0; i < 50; i++) {
            const t = mintCoordinatorPortalToken();
            expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(encodeURIComponent(t)).toBe(t);
        }
    });

    it('never repeats across many mints', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 2000; i++) seen.add(mintCoordinatorPortalToken());
        expect(seen.size).toBe(2000);
    });

    it('does NOT have the legacy CUID v1 shape', () => {
        for (let i = 0; i < 100; i++) {
            expect(looksLikeLegacyCuid(mintCoordinatorPortalToken())).toBe(false);
        }
        // The detector itself is honest about what a real legacy token looks like.
        expect(looksLikeLegacyCuid('cmd3x9k2p0001qw8v7h2n4t6b')).toBe(true);
    });

    it('shares no leading prefix between consecutive mints (unlike cuid)', () => {
        // cuid v1 embeds a millisecond timestamp, so ids minted together share a
        // long prefix. Random tokens must not.
        let worst = 0;
        for (let i = 0; i < 200; i++) {
            const a = mintCoordinatorPortalToken();
            const b = mintCoordinatorPortalToken();
            let n = 0;
            while (n < a.length && a[n] === b[n]) n++;
            worst = Math.max(worst, n);
        }
        expect(worst).toBeLessThan(6);
    });

    it('is not sortable-by-time — mint order does not imply sort order', () => {
        const tokens = Array.from({ length: 200 }, () => mintCoordinatorPortalToken());
        const sorted = [...tokens].sort();
        expect(sorted).not.toEqual(tokens);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('2. every runtime campaign creation mints the token explicitly', () => {
    // Behaviour test: drive the real handler and assert the create data.
    const csv = 'Organization,Campaign,Contact,Email,Phone\nLincoln PTA,Spring,Jo,jo@pta.org,555\n';
    function formRequest(body: string): any {
        const fd = new FormData();
        fd.append('file', new File([body], 'f.csv', { type: 'text/csv' }));
        return new Request('http://localhost/api/fundraisers/upload', { method: 'POST', body: fd });
    }

    it('CSV import supplies a strong portal_token', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        const { POST } = await import('@/app/api/fundraisers/upload/route');
        await POST(formRequest(csv) as any);

        const created = mock.firstCall('fundraiserCampaign.create');
        expect(created).toBeDefined();
        const token = created!.args.data.portal_token;
        expect(typeof token).toBe('string');
        expect(token).toHaveLength(COORDINATOR_PORTAL_TOKEN_LENGTH);
        expect(looksLikeLegacyCuid(token)).toBe(false);
    });

    // Source-level guard for the campaigns route. Its three create sites sit
    // behind branch conditions (bundle pool / not_required / legacy caller) that
    // need substantial fixture setup to reach individually; this asserts the
    // invariant that matters — that no create site can omit the mint — and will
    // fail the moment a fourth create branch is added without one.
    it('every fundraiserCampaign.create in the campaigns route mints a token', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'app', 'api', 'campaigns', 'route.ts'), 'utf8'
        );
        const creates = (src.match(/fundraiserCampaign\.create\(/g) || []).length;
        const mints = (src.match(/portal_token: mintCoordinatorPortalToken\(\)/g) || []).length;
        expect(creates).toBeGreaterThan(0);
        expect(mints).toBe(creates);
    });

    it('the CSV import route has a mint for each of its creates', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'app', 'api', 'fundraisers', 'upload', 'route.ts'), 'utf8'
        );
        const creates = (src.match(/fundraiserCampaign\.create\(/g) || []).length;
        const mints = (src.match(/portal_token: mintCoordinatorPortalToken\(\)/g) || []).length;
        expect(mints).toBe(creates);
    });

    it('no runtime route relies on the weak schema default', () => {
        // Any runtime file that creates a campaign must import the minter.
        for (const rel of [
            ['app', 'api', 'campaigns', 'route.ts'],
            ['app', 'api', 'fundraisers', 'upload', 'route.ts'],
        ]) {
            const src = fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
            if (src.includes('fundraiserCampaign.create(')) {
                expect(src).toContain('mintCoordinatorPortalToken');
            }
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('3. the Fundraiser CRM inclusion rule', () => {
    it('includes fundraiser organizations by type, as it always did', () => {
        for (const type of FUNDRAISER_CRM_TYPES) {
            expect(belongsInFundraiserCrm({ type, tags: [] })).toBe(true);
        }
    });

    it('includes an existing direct_customer that submitted a fundraiser inquiry', () => {
        expect(belongsInFundraiserCrm({
            type: 'direct_customer', tags: [FUNDRAISER_INQUIRY_TAG],
        })).toBe(true);
    });

    it('includes an existing storefront_menu_signup that submitted an inquiry', () => {
        expect(belongsInFundraiserCrm({
            type: 'storefront_menu_signup', tags: [FUNDRAISER_INQUIRY_TAG],
        })).toBe(true);
    });

    it('does NOT include an ordinary retail customer', () => {
        expect(belongsInFundraiserCrm({ type: 'direct_customer', tags: [] })).toBe(false);
    });

    it('does NOT include a surplus-waitlist signup who never asked about a fundraiser', () => {
        expect(belongsInFundraiserCrm({
            type: 'direct_customer', tags: ['surplus_waitlist'],
        })).toBe(false);
    });

    it('does not treat merely having an email as fundraiser intent', () => {
        expect(belongsInFundraiserCrm({ type: 'direct_customer' })).toBe(false);
        expect(belongsInFundraiserCrm({})).toBe(false);
    });

    it('the query fragment matches the pure rule — type OR tag', () => {
        const f: any = fundraiserCrmCustomerFilter();
        expect(f.OR).toHaveLength(2);
        expect(f.OR[0].type.in).toEqual([...FUNDRAISER_CRM_TYPES]);
        expect(f.OR[1].tags.has).toBe(FUNDRAISER_INQUIRY_TAG);
        // Tenant scope is applied by the caller, never inside the fragment.
        expect(JSON.stringify(f)).not.toContain('business_id');
    });
});

describe('4. the CRM query actually uses that rule, tenant-scoped', () => {
    it('campaigns GET filters on type OR tag, within the session tenant', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        useMock(createPrismaMock({ results: { 'business.findUnique': { slug: 'tenant-a' } } }));
        const { GET } = await import('@/app/api/campaigns/route');
        await GET(new Request('http://localhost/api/campaigns') as any);

        const call = mock.firstCall('customer.findMany');
        expect(call).toBeDefined();
        expect(call!.args.where.business_id).toBe(TENANT_A);
        const or = call!.args.where.OR;
        expect(or).toBeDefined();
        expect(or[1].tags.has).toBe(FUNDRAISER_INQUIRY_TAG);
    });

    it('another tenant is never included', async () => {
        useSession({ user: { email: 'a@a.com', businessId: TENANT_A } });
        useMock(createPrismaMock({ results: { 'business.findUnique': { slug: 'tenant-a' } } }));
        const { GET } = await import('@/app/api/campaigns/route');
        await GET(new Request('http://localhost/api/campaigns') as any);
        expect(JSON.stringify(mock.firstCall('customer.findMany')!.args.where)).not.toContain(TENANT_B);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('5. an inquiry from an EXISTING customer becomes visible', () => {
    const VALID = {
        name: 'Jo', email: 'jo@lincolnpta.org', phone: '555-0100',
        orgName: 'Lincoln PTA', deliveryLocation: 'Gym', slug: 'tenant-a',
    };

    const post = async (body: unknown) => {
        const { POST } = await import('@/app/api/public/fundraiser-request/route');
        return readJson(await POST(jsonRequest('http://localhost/api/public/fundraiser-request', body)));
    };

    it('tags an existing direct_customer so the CRM will show them', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT_A },
                'customer.findFirst': {
                    id: 'cust-retail', business_id: TENANT_A,
                    type: 'direct_customer', tags: [], contact_name: 'Jo', contact_phone: '555',
                },
                $queryRaw: [{
                    id: 'cust-retail', business_id: TENANT_A,
                    type: 'direct_customer', tags: [], contact_name: 'Jo', contact_phone: '555',
                }],
                'user.findFirst': { email: 'owner@a.com' },
            },
        }));
        const { status } = await post(VALID);
        expect(status).toBe(200);

        const patch = mock.firstCall('customer.update')!.args.data;
        expect(patch.tags).toContain(FUNDRAISER_INQUIRY_TAG);
        // The row now satisfies the CRM rule.
        expect(belongsInFundraiserCrm({ type: 'direct_customer', tags: patch.tags as string[] })).toBe(true);
    });

    it('does NOT rewrite the existing customer type — that would move them between marketing audiences', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT_A },
                'customer.findFirst': {
                    id: 'cust-retail', business_id: TENANT_A,
                    type: 'direct_customer', tags: [], contact_name: 'Jo', contact_phone: '555',
                },
                $queryRaw: [{
                    id: 'cust-retail', business_id: TENANT_A,
                    type: 'direct_customer', tags: [], contact_name: 'Jo', contact_phone: '555',
                }],
                'user.findFirst': { email: 'owner@a.com' },
            },
        }));
        await post(VALID);
        for (const u of mock.callsTo('customer.update')) {
            expect(u.args.data.type).toBeUndefined();
            expect(u.args.data.status).toBeUndefined();
            expect(u.args.data.source).toBeUndefined();
        }
    });

    it('a brand-new inquiry is visible by BOTH type and tag', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT_A },
                'customer.findFirst': null,
                $queryRaw: [],
                'user.findFirst': { email: 'owner@a.com' },
            },
        }));
        await post(VALID);
        const data = mock.firstCall('customer.create')!.args.data;
        expect(data.type).toBe('fundraiser_org');
        expect(data.tags).toContain(FUNDRAISER_INQUIRY_TAG);
        expect(belongsInFundraiserCrm(data as any)).toBe(true);
    });

    it('still creates no FundraiserCampaign from an inquiry', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT_A },
                'customer.findFirst': { id: 'c1', business_id: TENANT_A, type: 'direct_customer', tags: [] },
                $queryRaw: [{ id: 'c1', business_id: TENANT_A, type: 'direct_customer', tags: [] }],
                'user.findFirst': null,
            },
        }));
        await post(VALID);
        expect(mock.callsTo('fundraiserCampaign.create')).toHaveLength(0);
    });

    it('the same email in another tenant is untouched', async () => {
        useMock(createPrismaMock({
            results: {
                'business.findFirst': { id: TENANT_A },
                // FR-PUBLIC-IDENTITY-1: candidates now arrive through a
                // parameterized query. The foreign-tenant row is only returned
                // if the handler forgets to scope, which is the point of the test.
                $queryRaw: (args: any) =>
                    args?.values?.[0] === TENANT_A ? [] : [{ id: 'foreign', business_id: TENANT_B, tags: [] }],
                'customer.findFirst': null,
                'user.findFirst': null,
            },
        }));
        await post(VALID);
        expect(mock.firstCall('$queryRaw.raw')!.args.values[0]).toBe(TENANT_A);
        for (const u of mock.callsTo('customer.update')) {
            expect(u.args.where.id).not.toBe('foreign');
        }
        expect(mock.firstCall('customer.create')!.args.data.business_id).toBe(TENANT_A);
    });
});
