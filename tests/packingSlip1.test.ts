/**
 * PACKING-SLIP-1 — PHYSICAL-BOX CORRECTNESS + SUPPORTER IDENTITY + TENANT SAFETY.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §7/§11.
 *
 * Folds in and supersedes tests/packingSlip1FailingFirstProbe.test.ts, whose
 * scenarios (A-E below) proved against real HEAD c8ba5d4 that the pre-fix
 * page's one-slip-per-purchased-bundle fanout disagreed with the canonical
 * physical-box authority. That probe is deleted; its scenarios live on here,
 * now asserting the FIXED route+page agree with lib/physicalBoxPacking.ts by
 * construction (this suite calls the real route handler, not a re-implemented
 * arithmetic copy).
 *
 * Ten sections, matching the mission's required matrix:
 *   IDENTITY (6) · PHYSICAL GRAIN (6) · BOX NUMBERING (4) · CONTENTS (6) ·
 *   TIER (3) · ELIGIBILITY (2) · BRANDING (5) · PRINT (4) · SECURITY (5) ·
 *   REGRESSION (6)  =  47
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import {
    buildMealsByOrderItemId,
    buildSlipBundleSections,
    resolveSlipDeliveryDate,
    orderBoxesByDeliverySequence,
} from '@/lib/packingSlipContents';
import { buildPhysicalBoxManifest, type PhysicalBox } from '@/lib/physicalBoxPacking';
import type { BoxManifestOrder } from '@/lib/supporterBoxManifest';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = 'app/api/delivery/packing-slips/route.ts';
const PAGE = 'app/delivery/print-packing-slips/page.tsx';
const CONTENTS = 'lib/packingSlipContents.ts';

// ═════════════════════════════════════════════════════════════════════════════
// Fixtures
// ═════════════════════════════════════════════════════════════════════════════

const ITEM = (over: any = {}) => ({
    id: 'oi-x', bundle_id: 'b-1', quantity: 1, variant_size: 'serves_2',
    item_name: 'Comfort Foods', bundle: { id: 'b-1', name: 'Comfort Foods', contents: [] }, ...over,
});
const ORDER = (id: string, items: any[], over: any = {}) => ({
    id, first_name: 'Wyatt', last_name: 'Williamson', customer_name: 'Wyatt Williamson',
    delivery_date: null, delivery_sequence: null, campaign: null, items, ...over,
});
const canonicalBoxes = (orders: BoxManifestOrder[]): PhysicalBox[] => buildPhysicalBoxManifest(orders).boxes;

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__packingSlip1Prisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__packingSlip1Prisma = m.client; };

const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

const callRoute = async (qs?: string) => {
    const { GET } = await import('@/app/api/delivery/packing-slips/route');
    const url = qs ? `http://localhost/api/delivery/packing-slips?${qs}` : 'http://localhost/api/delivery/packing-slips';
    const res = await GET(new Request(url) as any);
    return { status: res.status, body: await res.json() };
};

const asAuthed = (businessId = 'biz-a') => mockAuth.mockResolvedValue({ user: { id: 'user-1', businessId } });

beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
});

// ═════════════════════════════════════════════════════════════════════════════
// IDENTITY (6)
// ═════════════════════════════════════════════════════════════════════════════
describe('IDENTITY', () => {
    it('I1. box.supporterName is the frozen Order.first_name/last_name combination', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [ORDER('ord-1', [ITEM()], { first_name: 'Jane', last_name: 'Smith', customer_name: 'Some School PTA' })],
        } }));
        const { body } = await callRoute();
        expect(body.boxes[0].supporterName).toBe('Jane Smith');
        expect(body.boxes[0].supporterName).not.toBe('Some School PTA');
    });

    it('I2. historical rows with no first/last fall back to customer_name', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [ORDER('ord-1', [ITEM()], { first_name: null, last_name: null, customer_name: 'Legacy Row Name' })],
        } }));
        const { body } = await callRoute();
        expect(body.boxes[0].supporterName).toBe('Legacy Row Name');
    });

    it('I3. a placeholder name ("Guest") blocks the order rather than printing it', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': [ORDER('ord-1', [ITEM()], { first_name: null, last_name: null, customer_name: 'Guest' })],
        } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(0);
        expect(body.blocked).toHaveLength(1);
        expect(body.blocked[0].orderId).toBe('ord-1');
    });

    it('I4. the route never selects a Customer relation at all', () => {
        // `customer_name` (the frozen Order SCALAR, part of BoxManifestOrder's
        // own precedence — see lib/supporterBoxManifest.ts) is correct and
        // expected here. What must never appear is the mutable Customer
        // RELATION (`customer: { ... }`), which is the mutable-org-name defect
        // this phase fixes.
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/customer:\s*\{/);
        expect(s).toMatch(/\bcustomer_name\b/);
    });

    it('I5. the page no longer reads the mutable Customer identity chain', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/order\.customer\?\.contact_name/);
        expect(s).not.toMatch(/order\.customer\?\.name/);
        expect(s).not.toMatch(/\.customer_name\b/);
    });

    it('I6. the page renders box.supporterName as "Prepared For"', () => {
        const s = strip(read(PAGE));
        const idx = s.indexOf('Prepared For');
        const nearby = s.slice(idx, idx + 300);
        expect(nearby).toMatch(/box\.supporterName/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PHYSICAL GRAIN (6)
// ═════════════════════════════════════════════════════════════════════════════
describe('PHYSICAL GRAIN', () => {
    it('G-A. 1 x S5 -> 1 box', async () => {
        const order = ORDER('ord-1', [ITEM({ variant_size: 'serves_5' })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(1);
        expect(body.physicalBoxCount).toBe(canonicalBoxes([order as any]).length);
    });

    it('G-B. 2 identical S2 -> 1 box (never 2)', async () => {
        const order = ORDER('ord-1', [ITEM({ quantity: 2 })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(1);
    });

    it('G-C. 1 S2 Comfort + 1 S2 Keto -> 1 box listing BOTH', async () => {
        const order = ORDER('ord-1', [
            ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Comfort Foods', bundle: { id: 'b-a', name: 'Comfort Foods', contents: [] } }),
            ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Keto', bundle: { id: 'b-b', name: 'Keto', contents: [] } }),
        ]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(1);
        const sections = buildSlipBundleSections(body.boxes[0], body.mealsByOrderItemId);
        expect(sections.map((s: any) => s.bundleName).sort()).toEqual(['Comfort Foods', 'Keto']);
    });

    it('G-D. 3 x S2 -> 2 boxes (2 + 1 leftover)', async () => {
        const order = ORDER('ord-1', [ITEM({ quantity: 3 })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(2);
    });

    it('G-E. 1 S5 + 2 S2 -> 2 boxes', async () => {
        const order = ORDER('ord-1', [
            ITEM({ id: 'oi-1', variant_size: 'serves_5' }),
            ITEM({ id: 'oi-2', quantity: 2 }),
        ]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(2);
    });

    it('G-F. two SEPARATE orders each with 1 S2 are NEVER paired into one box', async () => {
        const orders = [ORDER('ord-1', [ITEM({ id: 'oi-1' })]), ORDER('ord-2', [ITEM({ id: 'oi-2' })])];
        useMock(createPrismaMock({ results: { 'order.findMany': orders } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(2);
        expect(new Set(body.boxes.map((b: any) => b.orderId)).size).toBe(2);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// BOX NUMBERING (4)
// ═════════════════════════════════════════════════════════════════════════════
describe('BOX NUMBERING', () => {
    it('N1. a single-box order is Box 1 of 1', async () => {
        const order = ORDER('ord-1', [ITEM({ variant_size: 'serves_5' })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes[0].boxNumber).toBe(1);
        expect(body.boxes[0].boxTotal).toBe(1);
    });

    it('N2. a 3-box order numbers sequentially 1..3 with no gaps', async () => {
        const order = ORDER('ord-1', [
            ITEM({ id: 'oi-1', variant_size: 'serves_5' }),
            ITEM({ id: 'oi-2', quantity: 3 }),
        ]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        const own = body.boxes.filter((b: any) => b.orderId === 'ord-1').sort((a: any, z: any) => a.boxNumber - z.boxNumber);
        expect(own.map((b: any) => b.boxNumber)).toEqual([1, 2, 3]);
        expect(own.every((b: any) => b.boxTotal === 3)).toBe(true);
    });

    it('N3. Box N/M is PER-ORDER — a second order restarts at 1, never a running total', async () => {
        const orders = [
            ORDER('ord-1', [ITEM({ id: 'oi-1', variant_size: 'serves_5' })]),
            ORDER('ord-2', [ITEM({ id: 'oi-2', variant_size: 'serves_5' })]),
        ];
        useMock(createPrismaMock({ results: { 'order.findMany': orders } }));
        const { body } = await callRoute();
        const box1 = body.boxes.find((b: any) => b.orderId === 'ord-1');
        const box2 = body.boxes.find((b: any) => b.orderId === 'ord-2');
        expect(box1.boxNumber).toBe(1);
        expect(box2.boxNumber).toBe(1);
    });

    it('N4. the page computes no box count of its own — Box N/M comes only from box.boxNumber/boxTotal', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/box\.boxNumber\}\s*of\s*\{box\.boxTotal\}/);
        expect(s).not.toMatch(/boxIdx\s*\+\s*1/);
        expect(s).not.toMatch(/itemIdx/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// CONTENTS (6)
// ═════════════════════════════════════════════════════════════════════════════
describe('CONTENTS', () => {
    const box = (contents: any[]): PhysicalBox => ({
        orderId: 'ord-1', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'Jane', contents,
    });
    const instance = (over: any = {}) => ({
        orderId: 'ord-1', orderItemId: 'oi-1', instanceIndex: 0, supporterName: 'Jane',
        bundleName: 'Comfort Foods', servingTier: 'Serves 2', variantSize: 'serves_2', sequence: 0, ...over,
    });

    it('C1. a single-bundle box yields one section carrying that bundle\'s meals', () => {
        const meals = { 'oi-1': [{ recipeName: 'Lasagna', quantity: 2 }] };
        const sections = buildSlipBundleSections(box([instance()]), meals);
        expect(sections).toHaveLength(1);
        expect(sections[0].meals).toEqual([{ recipeName: 'Lasagna', quantity: 2 }]);
    });

    it('C2. two DIFFERENT bundles in one box yield TWO sections, each with its own distinct meals', () => {
        const meals = {
            'oi-1': [{ recipeName: 'Lasagna', quantity: 1 }],
            'oi-2': [{ recipeName: 'Keto Bowl', quantity: 1 }],
        };
        const b = box([
            instance({ orderItemId: 'oi-1', bundleName: 'Comfort Foods' }),
            instance({ orderItemId: 'oi-2', bundleName: 'Keto', instanceIndex: 0, sequence: 1 }),
        ]);
        const sections = buildSlipBundleSections(b, meals);
        expect(sections).toHaveLength(2);
        expect(sections.find((s) => s.bundleName === 'Comfort Foods')?.meals).toEqual([{ recipeName: 'Lasagna', quantity: 1 }]);
        expect(sections.find((s) => s.bundleName === 'Keto')?.meals).toEqual([{ recipeName: 'Keto Bowl', quantity: 1 }]);
    });

    it('C3. two IDENTICAL purchases merge into ONE section with count 2, meals not duplicated', () => {
        const meals = { 'oi-1': [{ recipeName: 'Lasagna', quantity: 1 }] };
        const b = box([instance({ orderItemId: 'oi-1' }), instance({ orderItemId: 'oi-1', instanceIndex: 1, sequence: 1 })]);
        const sections = buildSlipBundleSections(b, meals);
        expect(sections).toHaveLength(1);
        expect(sections[0].count).toBe(2);
        expect(sections[0].meals).toHaveLength(1);
    });

    it('C4. buildMealsByOrderItemId skips non-bundle lines without error', () => {
        const map = buildMealsByOrderItemId([{ items: [{ id: 'oi-1', bundle_id: null }] }] as any);
        expect(map['oi-1']).toBeUndefined();
    });

    it('C5. a bundle with no recorded contents yields an empty meal list (page shows "Contents not listed")', () => {
        const sections = buildSlipBundleSections(box([instance()]), {});
        expect(sections[0].meals).toEqual([]);
        const s = strip(read(PAGE));
        expect(s).toMatch(/Contents not listed/);
    });

    it('C6. every bundle physically in the box appears as a section — none dropped', () => {
        const meals = {};
        const b = box([
            instance({ orderItemId: 'oi-1', bundleName: 'A' }),
            instance({ orderItemId: 'oi-2', bundleName: 'B', sequence: 1 }),
            instance({ orderItemId: 'oi-3', bundleName: 'C', sequence: 2 }),
        ]);
        expect(buildSlipBundleSections(b, meals)).toHaveLength(3);
    });

    it('C7. end-to-end: the ROUTE\'s mealsByOrderItemId reflects the live Bundle.contents it fetched', async () => {
        const order = ORDER('ord-1', [ITEM({
            id: 'oi-1',
            bundle: { id: 'b-1', name: 'Comfort Foods', contents: [{ quantity: 2, recipe: { name: 'Lasagna' } }] },
        })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.mealsByOrderItemId['oi-1']).toEqual([{ recipeName: 'Lasagna', quantity: 2 }]);
        // And the select actually asks Prisma for it — a select-shape
        // regression (dropping bundle.contents) would leave this undefined
        // even though the mock happily returns whatever fixture we gave it.
        const select = mock.firstCall('order.findMany')?.args?.select?.items?.select?.bundle?.select;
        expect(select?.contents).toBeTruthy();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// TIER (3)
// ═════════════════════════════════════════════════════════════════════════════
describe('TIER', () => {
    it('T1. servingTier on a section is the frozen sold tier, not Bundle.serving_tier', async () => {
        const order = ORDER('ord-1', [ITEM({ variant_size: 'serves_5', bundle: { id: 'b-1', name: 'Comfort Foods', serving_tier: 'family', contents: [] } })]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        const sections = buildSlipBundleSections(body.boxes[0], body.mealsByOrderItemId);
        expect(sections[0].servingTier).toBe('Serves 5');
    });

    it('T2. same bundle name at two different tiers never merges into one section, and each keeps its OWN meals (no cross-contamination)', () => {
        const b: PhysicalBox = {
            orderId: 'ord-1', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'Jane',
            contents: [
                { orderId: 'ord-1', orderItemId: 'oi-1', instanceIndex: 0, supporterName: 'Jane', bundleName: 'Comfort Foods', servingTier: 'Serves 2', variantSize: 'serves_2', sequence: 0 },
                { orderId: 'ord-1', orderItemId: 'oi-2', instanceIndex: 0, supporterName: 'Jane', bundleName: 'Comfort Foods', servingTier: 'Serves 5', variantSize: 'serves_5', sequence: 1 },
            ],
        };
        // Two distinct Bundle rows that happen to share a display name — a
        // plausible real case (a bundle renamed/relaunched under the same
        // title at a different tier) — must not have their meals swapped.
        const meals = {
            'oi-1': [{ recipeName: 'Small-Tray Special', quantity: 1 }],
            'oi-2': [{ recipeName: 'Family-Tray Special', quantity: 1 }],
        };
        const sections = buildSlipBundleSections(b, meals);
        expect(sections).toHaveLength(2);
        expect(sections.find((s) => s.servingTier === 'Serves 2')?.meals).toEqual([{ recipeName: 'Small-Tray Special', quantity: 1 }]);
        expect(sections.find((s) => s.servingTier === 'Serves 5')?.meals).toEqual([{ recipeName: 'Family-Tray Special', quantity: 1 }]);
    });

    it('T3. neither the page nor packingSlipContents.ts reads Bundle.serving_tier', () => {
        for (const f of [PAGE, CONTENTS]) {
            expect(strip(read(f))).not.toMatch(/serving_tier/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// ELIGIBILITY (2)
// ═════════════════════════════════════════════════════════════════════════════
describe('ELIGIBILITY', () => {
    it('E1. a non-bundle line (bundle_id null) never produces a box', async () => {
        const order = ORDER('ord-1', [
            ITEM({ id: 'oi-1' }),
            { id: 'oi-2', bundle_id: null, quantity: 1, variant_size: null, item_name: 'Delivery Fee', bundle: null },
        ]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.purchasedBundleCount).toBe(1);
        expect(body.boxes).toHaveLength(1);
        expect(body.boxes[0].contents).toHaveLength(1);
    });

    it('E2. an order with ONLY non-bundle items is blocked with a "nothing to pack" reason', async () => {
        const order = ORDER('ord-1', [{ id: 'oi-1', bundle_id: null, quantity: 1, variant_size: null, item_name: 'Fee', bundle: null }]);
        useMock(createPrismaMock({ results: { 'order.findMany': [order] } }));
        const { body } = await callRoute();
        expect(body.boxes).toHaveLength(0);
        expect(body.blocked[0].reason).toMatch(/nothing to pack/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// BRANDING (5)
// ═════════════════════════════════════════════════════════════════════════════
describe('BRANDING', () => {
    it('B1. no literal "Freezer Chef" business-name default exists on the page', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/'Freezer Chef'/);
        expect(s).not.toMatch(/"Freezer Chef"/);
    });

    it('B2. logo pending falls back to name via the canonical chooseBrandHeader/isLogoSettling', () => {
        const { chooseBrandHeader, isLogoSettling } = require('@/lib/tenantLogo');
        expect(chooseBrandHeader('https://cdn/logo.png', 'Acme Meals', 'pending')).toBe('name');
        expect(isLogoSettling('https://cdn/logo.png', 'pending')).toBe(true);
        const s = strip(read(PAGE));
        expect(s).toMatch(/chooseBrandHeader/);
        expect(s).toMatch(/isLogoSettling/);
    });

    it('B3. a brand-new tenant with no TenantBranding row never sees "Freezer Chef" anywhere on this page', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/Freezer Chef/);
        expect(s).toMatch(/businessName:\s*typeof data\.business_name === 'string'/);
    });

    it('B4. an unconfigured sign-off is omitted entirely, not "The Freezer Chef Team"', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/The Freezer Chef Team/);
        expect(s).toMatch(/\{signOff && /);
    });

    it('B5. an unconfigured review QR never falls back to a hardcoded facebook.com/FreezerChef URL', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/facebook\.com\/FreezerChef/i);
        expect(s).toMatch(/\{reviewQrUrl && /);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PRINT (4)
// ═════════════════════════════════════════════════════════════════════════════
describe('PRINT', () => {
    it('P1. full US Letter format is preserved', () => {
        const s = read(PAGE);
        expect(s).toMatch(/size:\s*8\.5in 11in/);
        expect(s).toMatch(/w-\[8\.5in\]\s*h-\[11in\]/);
    });

    it('P2. no trailing blank print page', () => {
        const s = read(PAGE);
        expect(s).toMatch(/\.page-break\s*\{\s*page-break-after:\s*always;\s*\}/);
        expect(s).toMatch(/\.page-break:last-child\s*\{\s*page-break-after:\s*auto;\s*\}/);
    });

    it('P3. OL600 sticker geometry is not applied to packing slips', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/labelSheetLayout|OL600_SHEET|paginateLabelSheets/);
    });

    it('P4. one print page per PHYSICAL BOX — driven by boxes.map, not a per-bundle fanout', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/boxes\.map\(\(box\)/);
        expect(s).not.toMatch(/order\.items\.flatMap/);
        expect(s).not.toMatch(/for \(let i = 0; i < item\.quantity/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SECURITY (5)
// ═════════════════════════════════════════════════════════════════════════════
describe('SECURITY', () => {
    it('S1. a missing session returns 401 before any Prisma call', async () => {
        useMock(createPrismaMock({ results: {} }));
        mockAuth.mockResolvedValue(null);
        const { status } = await callRoute();
        expect(status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });

    it('S2. business_id scope is IN the order.findMany WHERE clause', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        asAuthed('biz-a');
        await callRoute();
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
    });

    it('S3. canceled_at: null is applied', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callRoute();
        expect(mock.firstCall('order.findMany')?.args?.where?.canceled_at).toBeNull();
    });

    it('S4. a client-supplied businessId in the query string cannot select another tenant\'s orders', async () => {
        useMock(createPrismaMock({ results: {
            'order.findMany': (args: any) => (args?.where?.business_id === 'biz-a' ? [] : [ORDER('leak', [ITEM()])]),
        } }));
        asAuthed('biz-a');
        const { body } = await callRoute('businessId=biz-b');
        expect(mock.firstCall('order.findMany')?.args?.where?.business_id).toBe('biz-a');
        expect(body.boxes.find((b: any) => b.orderId === 'leak')).toBeUndefined();
    });

    it('S5. the select is narrow — no phone, email, delivery_address, participant_name or Customer relation', () => {
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/\bphone\b/i);
        expect(s).not.toMatch(/\bemail\b/i);
        expect(s).not.toMatch(/delivery_address/);
        expect(s).not.toMatch(/participant_name/);
        expect(s).not.toMatch(/customer:\s*\{/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// REGRESSION (6)
// ═════════════════════════════════════════════════════════════════════════════
describe('REGRESSION', () => {
    it('R1. delivery-date precedence is Campaign > Order > null, unchanged', () => {
        expect(resolveSlipDeliveryDate({ campaign: { delivery_date: '2026-01-01' }, delivery_date: '2026-02-02' })).toBe('2026-01-01');
        expect(resolveSlipDeliveryDate({ campaign: null, delivery_date: '2026-02-02' })).toBe('2026-02-02');
        expect(resolveSlipDeliveryDate({ campaign: null, delivery_date: null })).toBeNull();
        expect(resolveSlipDeliveryDate(null)).toBeNull();
    });

    it('R2. delivery_week_start reproduces the /api/orders week-window + escape-hatch semantics', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callRoute('delivery_week_start=2026-09-07');
        const where = mock.firstCall('order.findMany')?.args?.where;
        expect(Array.isArray(where.OR)).toBe(true);
        expect(where.OR[0].delivery_date.gte.toISOString().slice(0, 10)).toBe('2026-09-07');
        expect(where.OR[1].delivery_date).toBeNull();
    });

    it('R3. the status candidate list covers every fulfillable status, canonical and legacy alike', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': [] } }));
        await callRoute();
        const statuses: string[] = mock.firstCall('order.findMany')?.args?.where?.status?.in || [];
        expect(statuses).toEqual(expect.arrayContaining([
            'pending', 'PENDING',
            'production_ready', 'APPROVED',
            'in_production', 'IN_PRODUCTION',
            'ready_to_ship',
            'completed', 'COMPLETED',
        ]));
    });

    it('R4. the Quick Tips panel content is unchanged', () => {
        const s = read(PAGE);
        expect(s).toMatch(/Wipe down any condensation on bag\./);
        expect(s).toMatch(/Proper thawing can take up to 36 hours\./);
        expect(s).toMatch(/"Serves 2" trays: replace lid with foil\./);
    });

    it('R5. a blocked order does not stop other orders\' slips from printing', async () => {
        const orders = [
            ORDER('ord-good', [ITEM({ id: 'oi-1' })]),
            ORDER('ord-bad', [ITEM({ id: 'oi-2' })], { first_name: null, last_name: null, customer_name: 'Guest' }),
        ];
        useMock(createPrismaMock({ results: { 'order.findMany': orders } }));
        const { body } = await callRoute();
        expect(body.boxes.some((b: any) => b.orderId === 'ord-good')).toBe(true);
        expect(body.blocked.some((b: any) => b.orderId === 'ord-bad')).toBe(true);
    });

    it('R6. delivery_sequence print ordering is preserved, missing/zero treated as 999 (faithful || 999)', () => {
        const boxes: PhysicalBox[] = [
            { orderId: 'ord-late', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'Z', contents: [] },
            { orderId: 'ord-early', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'A', contents: [] },
            { orderId: 'ord-zero', boxType: 'large', boxNumber: 1, boxTotal: 1, supporterName: 'M', contents: [] },
        ];
        const sorted = orderBoxesByDeliverySequence(boxes, { 'ord-late': 5, 'ord-early': 1, 'ord-zero': 0 });
        // ord-zero's `0` is treated as missing (999), matching the pre-fix
        // page's own `(delivery_sequence || 999)` — so it sorts LAST, not first.
        expect(sorted.map((b) => b.orderId)).toEqual(['ord-early', 'ord-late', 'ord-zero']);
    });

    it('R7. the Print button is never disabled by blocked orders — partial-print policy is structural, not incidental', () => {
        const s = strip(read(PAGE));
        const btnStart = s.indexOf('onClick={handlePrint}');
        const btnDisabled = s.slice(btnStart, s.indexOf('>', btnStart));
        expect(btnDisabled).toMatch(/disabled=\{boxes\.length === 0/);
        expect(btnDisabled).not.toMatch(/blocked/);
        // handlePrint itself never early-returns on blocked.length.
        const fnStart = s.indexOf('const handlePrint = async');
        const fnBody = s.slice(fnStart, s.indexOf('};', fnStart));
        expect(fnBody).not.toMatch(/blocked/);
    });
});
