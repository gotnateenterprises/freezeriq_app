/**
 * COORD-MANUAL-EMAIL-1B — optional supporter email on coordinator-entered
 * ("+ Add Order") manual orders.
 *
 * THE RULE THIS LOCKS: Order.email, never Customer.contact_email. A manual
 * order's customer_id always points at the campaign's own organization
 * Customer row (shared by every manual order in that campaign), so writing a
 * supporter's address there would overwrite the org's own inbox on every
 * order. See lib/coordinatorSupporterOrders.ts and lib/previousSupporters.ts
 * for the full lineage rule this phase extended.
 *
 * Sections 3 (persistence) and 7 (regression 25-28) execute the REAL POST
 * handler against a recording Prisma double (tests/helpers/routeHarness.ts),
 * mirroring tests/ops1CoordinatorOrderValidity.test.ts's established pattern.
 * Sections 1, 2, 6 are source-level: what they assert is the literal
 * migration/schema/select-allowlist text, which is the actual safety
 * property (an allowlist select cannot leak a field it never named).
 */
import fs from 'fs';
import path from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import {
    supporterEmail,
    supporterGroupKey,
    groupSupporterRows,
    SUPPORTER_ORDER_SELECT,
    type SupporterOrderRow,
} from '@/lib/coordinatorSupporterOrders';
import { normalizeSupporterEmail } from '@/lib/previousSupporters';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Strips block and line comments, so a prose mention of a word (e.g. "no
// phone, no email...") in documentation cannot be confused with that word
// appearing in actual code.
const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema / migration (tests 1-4)
// ═════════════════════════════════════════════════════════════════════════════
describe('1. schema and migration', () => {
    const MIGRATION_DIR = 'prisma/migrations/20260909000000_coord_manual_email_1b_order_email';
    const migrationSql = read(`${MIGRATION_DIR}/migration.sql`);

    it('1. the migration adds exactly one nullable column, no unrelated statements', () => {
        const statements = migrationSql
            .split('\n')
            .filter((l) => !l.trim().startsWith('--') && l.trim().length > 0);
        expect(statements).toHaveLength(1);
        expect(statements[0].trim()).toBe('ALTER TABLE "orders" ADD COLUMN "email" TEXT;');
    });

    it('2. the migration has no default, no index, no unique constraint, no foreign key', () => {
        // Checked against the SQL statements only — the hand-written header
        // comment above them legitimately uses these same words in prose
        // ("no default, no index...") to describe the very property this
        // asserts, which a raw whole-file match would trip on.
        const sqlOnly = migrationSql
            .split('\n')
            .filter((l) => !l.trim().startsWith('--'))
            .join('\n');
        expect(sqlOnly).not.toMatch(/DEFAULT/i);
        expect(sqlOnly).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
        expect(sqlOnly).not.toMatch(/UNIQUE/i);
        expect(sqlOnly).not.toMatch(/FOREIGN KEY|REFERENCES/i);
        expect(sqlOnly).not.toMatch(/NOT NULL/i);
    });

    it('3. schema.prisma declares Order.email as an optional (nullable) scalar, sibling of phone', () => {
        const schema = read('prisma/schema.prisma');
        // Anchor to the Order model block specifically, not any other model.
        const orderModel = schema.slice(schema.indexOf('model Order '), schema.indexOf('model OrderItem'));
        expect(orderModel).toMatch(/phone\s+String\?/);
        expect(orderModel).toMatch(/email\s+String\?/);
    });

    it('4. the new migration sorts after the most recent pre-existing migration (chronological ledger order)', () => {
        const migrationsRoot = path.join(ROOT, 'prisma', 'migrations');
        const dirs = fs.readdirSync(migrationsRoot).filter((d) => /^\d{14}_/.test(d)).sort();
        const idx = dirs.indexOf('20260909000000_coord_manual_email_1b_order_email');
        expect(idx).toBeGreaterThan(-1);
        expect(dirs[idx - 1]).toBe('20260905000000_ops6b_order_delivery_handoff');
        expect(idx).toBe(dirs.length - 1);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Form (tests 5-8) — app/coordinator/portal/page.tsx, source-level.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. manual-order modal form', () => {
    const PORTAL_PAGE = 'app/coordinator/portal/page.tsx';
    const src = read(PORTAL_PAGE);

    it('5. renders an email input bound to formData.email', () => {
        expect(src).toMatch(/type="email"/);
        expect(src).toContain('value={formData.email}');
        expect(src).toContain("setFormData({ ...formData, email: e.target.value })");
    });

    it('6. the email field is optional — no `required` attribute on that input', () => {
        const emailFieldStart = src.indexOf('type="email"');
        expect(emailFieldStart).toBeGreaterThan(-1);
        // Scope the check to the <input ...> tag itself, not the whole file.
        const tagStart = src.lastIndexOf('<input', emailFieldStart);
        const tagEnd = src.indexOf('/>', emailFieldStart);
        const tag = src.slice(tagStart, tagEnd);
        expect(tag).not.toMatch(/\brequired\b/);
        expect(src).toContain('Email (Optional)');
    });

    it('7. formData initial state seeds email as an empty string', () => {
        const stateBlock = src.slice(src.indexOf('useState({'), src.indexOf('});', src.indexOf('useState({')));
        expect(stateBlock).toMatch(/email:\s*''/);
    });

    it('8. the email field is positioned after Phone and before the Note/Address field', () => {
        const phoneIdx = src.indexOf('Phone (Optional)');
        const emailIdx = src.indexOf('Email (Optional)');
        const noteIdx = src.indexOf('Note / Address (Optional)');
        expect(phoneIdx).toBeGreaterThan(-1);
        expect(emailIdx).toBeGreaterThan(phoneIdx);
        expect(noteIdx).toBeGreaterThan(emailIdx);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Persistence (tests 9-14) — the REAL POST handler against a recording
//    Prisma double. Fixture shape mirrors ops1CoordinatorOrderValidity.test.ts.
// ═════════════════════════════════════════════════════════════════════════════
const CAMPAIGN_ID = 'campaign-cme1b-1';
const BUSINESS_ID = 'biz-cme1b-1';
const ORG_CUSTOMER_ID = 'customer-cme1b-org';
const BUNDLE_ID = 'bundle-cme1b-1';

let mock: PrismaMock;

jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__cme1bPrisma; },
}));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) =>
            name === (global as any).__cme1bCookieName && (global as any).__cme1bAuthenticated
                ? { name, value: 'cme1b-test-secret' }
                : undefined,
    }),
}));

const useMock = (m: PrismaMock) => { mock = m; (global as any).__cme1bPrisma = m.client; };
const setAuthenticated = (authenticated: boolean) => {
    (global as any).__cme1bCookieName = coordinatorSessionCookieName();
    (global as any).__cme1bAuthenticated = authenticated;
};

const validSession = {
    id: 'session-cme1b-1',
    campaign_id: CAMPAIGN_ID,
    expires_at: new Date(Date.now() + 3_600_000),
    revoked_at: null,
};

const legacyCampaign = {
    id: CAMPAIGN_ID,
    closed_at: null,
    status: 'Active',
    bundle_selection_status: 'not_required',
    customer_id: ORG_CUSTOMER_ID,
    customer: {
        business_id: BUSINESS_ID,
        business: { plan: 'FREE', id: BUSINESS_ID },
    },
};

const bundleRows = [
    { id: BUNDLE_ID, name: 'Family Feast', price: 89.99, serving_tier: 'serves_5' },
];

function baseResults(overrides: Record<string, any> = {}) {
    return {
        'coordinatorSession.findUnique': validSession,
        'fundraiserCampaign.findFirst': legacyCampaign,
        'bundle.findMany': bundleRows,
        ...overrides,
    };
}

const postRequest = (body: any) =>
    new Request('http://localhost/api/coordinator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify(body),
    }) as any;

const orderBody = (extra: Record<string, any> = {}) => ({
    customerName: 'Fundraiser Coordinator',
    participantName: 'Team Bake Sale',
    items: [{ bundleId: BUNDLE_ID, quantity: 2, serving_tier: 'serves_5' }],
    totalAmount: 179.98,
    deliveryAddress: null,
    phone: null,
    ...extra,
});

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock({ results: baseResults() }));
    setAuthenticated(true);
});

describe('3. server-side persistence', () => {
    it('9. a valid email is persisted onto Order.email', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody({ email: 'mom@example.com' })));
        expect(res.status).toBe(200);
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.email).toBe('mom@example.com');
    });

    it('10. an omitted email persists Order.email as null, not undefined or empty string', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody()));
        expect(res.status).toBe(200);
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.email).toBeNull();
    });

    it('11. a malformed email is dropped to null server-side, never trusted from the client', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody({ email: 'not-an-email' })));
        expect(res.status).toBe(200);
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.email).toBeNull();
    });

    it('12. a validly-shaped but padded/mixed-case email is trimmed and lowercased before persisting', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody({ email: '  Jane.Doe@Example.COM  ' })));
        expect(res.status).toBe(200);
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.email).toBe('jane.doe@example.com');
        expect(create.args.data.email).toBe(normalizeSupporterEmail('  Jane.Doe@Example.COM  '));
    });

    it('13. customer_id on the created order is still the campaign organization, regardless of email', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody({ email: 'someone@example.com' })));
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.customer_id).toBe(ORG_CUSTOMER_ID);
    });

    it('14. no Customer row is ever written as part of a manual order (Customer.contact_email untouched)', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody({ email: 'someone@example.com' })));
        expect(mock.callsTo('customer.update')).toHaveLength(0);
        expect(mock.callsTo('customer.upsert')).toHaveLength(0);
        expect(mock.callsTo('customer.create')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Supporter authority (tests 15-17) — lib/coordinatorSupporterOrders.ts
// ═════════════════════════════════════════════════════════════════════════════
describe('4. supporterEmail() authority', () => {
    const CAMPAIGN_CUSTOMER_ID = 'org-cme1b-authority';
    const INDIVIDUAL_CUSTOMER_ID = 'cust-cme1b-individual';

    it('15. resolves an organization-linked (manual) order\'s own Order.email when present', () => {
        const row: SupporterOrderRow = {
            id: 'o1',
            customer_id: CAMPAIGN_CUSTOMER_ID,
            email: 'supporter@example.com',
            customer: { contact_email: 'coordinator@theorg.org' },
        };
        expect(supporterEmail(row, CAMPAIGN_CUSTOMER_ID)).toBe('supporter@example.com');
    });

    it('16. still returns null for an organization-linked order with no captured email (pre-existing rows)', () => {
        const row: SupporterOrderRow = {
            id: 'o2',
            customer_id: CAMPAIGN_CUSTOMER_ID,
            email: null,
            customer: { contact_email: 'coordinator@theorg.org' },
        };
        expect(supporterEmail(row, CAMPAIGN_CUSTOMER_ID)).toBeNull();
    });

    it('17. an individual (storefront) order still resolves from Customer.contact_email, never Order.email', () => {
        const row: SupporterOrderRow = {
            id: 'o3',
            customer_id: INDIVIDUAL_CUSTOMER_ID,
            // Hypothetical/defensive: even if Order.email were somehow set on a
            // storefront order, identity for this branch must still come from
            // the linked Customer, never the order field.
            email: 'stray-value-must-be-ignored@example.com',
            customer: { contact_email: 'real-supporter@example.com' },
        };
        expect(supporterEmail(row, CAMPAIGN_CUSTOMER_ID)).toBe('real-supporter@example.com');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Tenant isolation (tests 18-19)
// ═════════════════════════════════════════════════════════════════════════════
describe('5. tenant isolation', () => {
    it('18. a manual order\'s group key is always order:<id>, never keyed by email — so identical emails across tenants can never merge', () => {
        const ORG_A = 'org-tenant-a';
        const row: SupporterOrderRow = {
            id: 'order-tenant-a-1',
            customer_id: ORG_A,
            email: 'shared@example.com',
        };
        const key = supporterGroupKey(row, ORG_A);
        expect(key).toBe('order:order-tenant-a-1');
        expect(key).not.toMatch(/email:/);

        // Two different tenants' manual orders sharing the same literal email
        // never collapse into one group — grouping is scoped per-campaign, and
        // even processed together they key off order id, not email.
        const ORG_B = 'org-tenant-b';
        const rowB: SupporterOrderRow = { id: 'order-tenant-b-1', customer_id: ORG_B, email: 'shared@example.com' };
        const groupsA = groupSupporterRows([row], ORG_A);
        const groupsB = groupSupporterRows([rowB], ORG_B);
        expect(groupsA[0].key).not.toBe(groupsB[0].key);
    });

    it('19. the created order\'s business_id/customer_id come from the session-resolved campaign, never from the submitted email or any client-sent tenant field', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody({
            email: 'admin@some-other-tenant.example.com',
            // A spoofed tenant override in the body must have no effect — the
            // session-resolved campaign is the only source of truth. Present
            // to prove this specifically for the email feature's own code
            // path, not just the pre-existing quantity/price validation.
            businessId: 'evil-business-id',
            customer_id: 'evil-customer-id',
        })));
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.business_id).toBe(BUSINESS_ID);
        expect(create.args.data.customer_id).toBe(ORG_CUSTOMER_ID);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Privacy — Order.email must never reach a public, print, label, slip or
//    delivery surface (tests 20-24). Each surface's Prisma select is an
//    explicit allowlist; the safety property IS the absence of the key.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. privacy — Order.email never reaches a fulfillment or public surface', () => {
    it('20. the shared packing-slip select has no email key', () => {
        const src = read('lib/packingSlipContents.ts');
        const block = src.slice(
            src.indexOf('export const PACKING_SLIP_ORDER_SELECT'),
            src.indexOf('\n};', src.indexOf('export const PACKING_SLIP_ORDER_SELECT')),
        );
        expect(block).not.toMatch(/\bemail:/);
    });

    it('21. the box-labels route select has no email key', () => {
        const src = read('app/api/production/box-labels/route.ts');
        const start = src.indexOf('prisma.order.findMany');
        const block = src.slice(start, src.indexOf('orderBy', start) > -1 ? src.indexOf('});', start) : start + 800);
        expect(block).not.toMatch(/\bemail:/);
    });

    it('22. the delivery queue, stats and handoff selects have no email key', () => {
        for (const file of ['app/api/delivery/queue/route.ts', 'app/api/delivery/stats/route.ts', 'app/api/delivery/handoff/route.ts']) {
            const src = read(file);
            const start = src.indexOf('prisma.order.findMany');
            expect(start).toBeGreaterThan(-1);
            const block = src.slice(start, src.indexOf('});', start));
            expect(block).not.toMatch(/\bemail:/);
        }
    });

    it('23. the public order route never reads or writes Order.email — only the supporter\'s own Customer.contact_email', () => {
        const src = read('app/api/public/order/route.ts');
        expect(src).not.toMatch(/order\.email/);
        expect(src).not.toMatch(/\border_email\b/);
        // The route legitimately reads/writes customer.email and contact_email
        // throughout — that is the storefront's own, unrelated identity path.
        expect(src).toMatch(/customer\.email|contact_email/);
    });

    it('24. supporterBoxManifest and physicalBoxPacking never reference email in actual code (comments may discuss its deliberate absence)', () => {
        expect(stripComments(read('lib/supporterBoxManifest.ts'))).not.toMatch(/email/i);
        expect(stripComments(read('lib/physicalBoxPacking.ts'))).not.toMatch(/email/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Regression (tests 25-30)
// ═════════════════════════════════════════════════════════════════════════════
describe('7. regression', () => {
    it('25. an invalid item quantity is still rejected with zero writes, even when a valid email is present', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody({
            email: 'mom@example.com',
            items: [{ bundleId: BUNDLE_ID, quantity: 0 }],
        })));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.code).toBe('INVALID_QUANTITY');
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('26. CB-5 bundle-eligibility rejection is unaffected by the presence of an email', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        const res = await POST(postRequest(orderBody({
            email: 'mom@example.com',
            items: [{ bundleId: 'does-not-exist', quantity: 1 }],
        })));
        expect(res.status).toBe(400);
        expect(mock.callsTo('order.create')).toHaveLength(0);
    });

    it('27. server-derived total_amount authority is unaffected by the presence of an email', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody({ email: 'mom@example.com', totalAmount: 1 })));
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.total_amount).toBeCloseTo(89.99 * 2, 2);
        expect(create.args.data.total_amount).not.toBe(1);
    });

    it('28. phone still persists correctly side-by-side with email', async () => {
        const { POST } = await import('@/app/api/coordinator/route');
        await POST(postRequest(orderBody({ email: 'mom@example.com', phone: '555-0123' })));
        const create = mock.firstCall('order.create')!;
        expect(create.args.data.phone).toBe('555-0123');
        expect(create.args.data.email).toBe('mom@example.com');
    });

    it('29. COORD-PUBLIC-PREVIEW-1\'s "View Supporter Page" wiring (same shareUrl, same label) is untouched by this phase', () => {
        // COORD-POLISH-1 restyled this link (PrimaryMiniLink, not MiniLink) but
        // did not touch its href authority or label — that's what this guards.
        const src = read('components/coordinator/ShareCenter.tsx');
        expect(src).toContain('href={shareUrl} label="View Supporter Page"');
    });

    it('30. SUPPORTER_ORDER_SELECT still excludes delivery_address after gaining the email key', () => {
        expect(SUPPORTER_ORDER_SELECT).not.toHaveProperty('delivery_address');
        expect((SUPPORTER_ORDER_SELECT as any).email).toBe(true);
        expect((SUPPORTER_ORDER_SELECT as any).phone).toBe(true);
    });
});
