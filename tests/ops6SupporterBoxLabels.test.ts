/**
 * OPS-6 — SUPPORTER OUTER-BOX LABELS.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REVISED BY OPS-6A — READ THIS BEFORE CHANGING ANYTHING HERE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * OPS-6 asserted: one purchased bundle instance = one physical box = one
 * label. Owner acceptance superseded that rule. A Serves-5 bundle fills a
 * large carton; a Serves-2 fills half of one, so two Serves-2 bundles from the
 * same order share ONE large box and ONE label listing both.
 *
 * So this file no longer owns box counting — tests/ops6aPhysicalBoxPacking.test.ts
 * does, against lib/physicalBoxPacking.ts. What survives here is everything
 * OPS-6 proved that the owner did NOT change, restated against the LAYER 1
 * (purchase) API it always really belonged to:
 *
 *   - order-time supporter identity, and the mutable CRM record staying out
 *   - the frozen item_name bundle-name snapshot
 *   - the frozen variant_size sold-tier authority
 *   - non-bundle / malformed-quantity eligibility
 *   - the privacy repair (no supporter name or address in a URL)
 *   - tenant isolation on the server route
 *
 * Every assertion below is the OPS-6 assertion or a STRICTER one. Where a
 * count moved from "labels" to "purchased instances", the number is unchanged
 * — only the layer it is asserted against is named correctly now. The single
 * genuine REVERSAL is marked at test 17c: the owner reversed the "Guest"
 * ruling, and the test now proves the opposite of what it used to.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
    buildPurchasedInstances,
    countPurchasedInstances,
    resolveSupporterName,
    resolveBundleName,
    resolveSoldTier,
    isBoxEligibleItem,
    quantityFault,
    type BoxManifestOrder,
} from '@/lib/supporterBoxManifest';
import { buildPhysicalBoxManifest, packOrder } from '@/lib/physicalBoxPacking';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** Strip comments so a doc comment can never satisfy (or fail) an assertion. */
const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MANIFEST = 'lib/supporterBoxManifest.ts';
const PACKING = 'lib/physicalBoxPacking.ts';
const ROUTE = 'app/api/production/box-labels/route.ts';
const PAGE = 'app/production/box-labels/page.tsx';
const QUEUE = 'components/production/DeliveryQueue.tsx';
const STORAGE = 'lib/printBatchStorage.ts';

const JANE = (): BoxManifestOrder => ({
    id: 'ord-jane-1',
    first_name: 'Jane',
    last_name: 'Smith',
    customer_name: 'Jane Smith',
    items: [
        { id: 'oi-1', bundle_id: 'b-comfort-5', quantity: 1, variant_size: 'serves_5', item_name: 'Comfort Foods', bundle: { id: 'b-comfort-5', name: 'Comfort Foods' } },
        { id: 'oi-2', bundle_id: 'b-clean-2', quantity: 2, variant_size: 'serves_2', item_name: 'Clean Eating/Paleo', bundle: { id: 'b-clean-2', name: 'Clean Eating/Paleo' } },
    ],
});

const ITEM = (over: any = {}) => ({
    id: 'oi-x',
    bundle_id: 'b-1',
    quantity: 1,
    variant_size: 'serves_5',
    item_name: 'Bundle One',
    bundle: { id: 'b-1', name: 'Bundle One' },
    ...over,
});

const ORDER = (over: Partial<BoxManifestOrder> = {}): BoxManifestOrder => ({
    id: 'ord-1',
    first_name: 'Jane',
    last_name: 'Smith',
    customer_name: 'Jane Smith',
    items: [ITEM()],
    ...over,
} as BoxManifestOrder);

/** Layer 1 purchases for one order, or throw with the block reason. */
const purchases = (o: BoxManifestOrder) => {
    const r = buildPurchasedInstances(o);
    if (!r.ok) throw new Error(`expected purchases, got block: ${r.reason}`);
    return r.instances;
};

// ═════════════════════════════════════════════════════════════════════════════
// 0. FAILING-FIRST — the gap OPS-6 closed at HEAD 69fabc6.
// ═════════════════════════════════════════════════════════════════════════════
describe('0. failing-first: the outer-box gap OPS-6 closed', () => {
    it('0a. the authorities exist', () => {
        expect(existsSync(join(root, MANIFEST))).toBe(true);
        expect(existsSync(join(root, ROUTE))).toBe(true);
        expect(existsSync(join(root, PAGE))).toBe(true);
        // OPS-6A added the physical packing layer alongside them.
        expect(existsSync(join(root, PACKING))).toBe(true);
    });

    it('0b. the items[0] heuristic is gone — the whole order drives the labels', () => {
        const s = strip(read(QUEUE));
        expect(s).not.toMatch(/order\.items\[0\]/);
        expect(s).not.toMatch(/const item = order\.items/);
    });

    it('0c. the bundle-id-as-recipeId category error is gone', () => {
        expect(strip(read(QUEUE))).not.toMatch(/recipeId:\s*item\.bundle\.id/);
    });

    it('0d. supporter identity is resolved from ORDER-TIME fields', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/first_name/);
        expect(s).toMatch(/last_name/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-5. PURCHASE COUNTING.
//
// SUPERSEDED BY OPS-6A: these were "N bundles -> N labels". The counts are
// UNCHANGED; they are now asserted against the purchase layer they always
// described. Label/box counts live in tests/ops6aPhysicalBoxPacking.test.ts,
// because two Serves-2 bundles now share one label.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-5. purchased bundle counting', () => {
    it('1. one Bundle qty1 -> one purchased instance', () => {
        expect(purchases(ORDER({ items: [ITEM({ quantity: 1 })] }))).toHaveLength(1);
    });

    it('2. one Bundle qty3 -> exactly three purchased instances', () => {
        const p = purchases(ORDER({ items: [ITEM({ quantity: 3 })] }));
        expect(p).toHaveLength(3);
        // Fan-out happens in Layer 1 so Layer 2 can pair two instances of the
        // SAME OrderItem — a qty-2 Serves-2 line is one large box.
        expect(p.map(i => i.instanceIndex)).toEqual([0, 1, 2]);
        expect(new Set(p.map(i => i.orderItemId))).toEqual(new Set(['oi-x']));
    });

    it('3. two Bundle items qty1 each -> exactly two purchased instances', () => {
        const p = purchases(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A' }),
                ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Bundle B' }),
            ],
        }));
        expect(p).toHaveLength(2);
        expect(p.map(i => i.bundleName)).toEqual(['Bundle A', 'Bundle B']);
    });

    it('4. qty2 + qty3 -> exactly five purchased instances', () => {
        const p = purchases(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A', quantity: 2 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Bundle B', quantity: 3 }),
            ],
        }));
        expect(p).toHaveLength(5);
        expect(p.filter(i => i.bundleName === 'Bundle A')).toHaveLength(2);
        expect(p.filter(i => i.bundleName === 'Bundle B')).toHaveLength(3);
    });

    it('5. no extra blank physical page after the final label', () => {
        const s = read(PAGE);
        expect(s).toMatch(/\.print-page\s*\{[^}]*break-after:\s*always/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?page-break-after:\s*auto/);
        const exemption = s.slice(
            s.indexOf('.print-page:last-child'),
            s.indexOf('}', s.indexOf('.print-page:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0|content-visibility/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6-10. SEQUENCE AND ORDER SEPARATION.
//
// SUPERSEDED BY OPS-6A: "Box N of M" now counts PHYSICAL boxes, so the
// numbering assertions moved. What remains — and is now proven MORE strictly,
// because pairing depends on it — is that the purchase SEQUENCE is
// deterministic and that separate Orders are never combined.
// ═════════════════════════════════════════════════════════════════════════════
describe('6-10. deterministic sequence, and orders never merged', () => {
    it('6/7. purchases carry a gapless deterministic sequence', () => {
        expect(purchases(ORDER({ items: [ITEM({ quantity: 1 })] })).map(i => i.sequence)).toEqual([0]);
        expect(purchases(ORDER({ items: [ITEM({ quantity: 3 })] })).map(i => i.sequence)).toEqual([0, 1, 2]);
    });

    it('8. mixed Bundles keep one shared source-Order identity', () => {
        const p = purchases(JANE());
        expect(p).toHaveLength(3);
        expect(p.map(i => ({ bundle: i.bundleName, tier: i.servingTier }))).toEqual([
            { bundle: 'Comfort Foods', tier: 'Serves 5' },
            { bundle: 'Clean Eating/Paleo', tier: 'Serves 2' },
            { bundle: 'Clean Eating/Paleo', tier: 'Serves 2' },
        ]);
        expect(new Set(p.map(i => i.orderId))).toEqual(new Set(['ord-jane-1']));
    });

    it('9. the sequence is deterministic across repeat runs AND shuffled input', () => {
        const a = purchases(JANE());
        expect(purchases(JANE())).toEqual(a);
        const shuffled = JANE();
        shuffled.items = [shuffled.items[1], shuffled.items[0]];
        expect(purchases(shuffled)).toEqual(a);
    });

    it('10. two separate Orders for the SAME supporter name are NOT merged', () => {
        const one: BoxManifestOrder = { ...JANE(), id: 'ord-a', items: [ITEM({ id: 'oi-a', quantity: 1 })] };
        const two: BoxManifestOrder = { ...JANE(), id: 'ord-b', items: [ITEM({ id: 'oi-b', quantity: 2 })] };
        const m = buildPhysicalBoxManifest([one, two]);
        // Each order keeps its OWN box total; nothing is ever combined.
        expect(m.boxes.filter(b => b.orderId === 'ord-a').map(b => `${b.boxNumber}/${b.boxTotal}`)).toEqual(['1/1']);
        expect(m.boxes.filter(b => b.orderId === 'ord-b').map(b => `${b.boxNumber}/${b.boxTotal}`)).toEqual(['1/2', '2/2']);
        expect(m.boxes.every(b => b.contents.every((c: any) => c.orderId === b.orderId))).toBe(true);
    });

    it('10b. identical name, email-shaped and phone-shaped duplicates stay separate', () => {
        const mk = (id: string): BoxManifestOrder => ({
            id, first_name: 'Jane', last_name: 'Smith', customer_name: 'Jane Smith',
            items: [ITEM({ id: `${id}-i`, quantity: 1 })],
        });
        const m = buildPhysicalBoxManifest([mk('ord-1'), mk('ord-2'), mk('ord-3')]);
        expect(m.physicalBoxCount).toBe(3);
        expect(m.boxes.every(b => b.boxTotal === 1)).toBe(true);
        expect(new Set(m.boxes.map(b => b.orderId)).size).toBe(3);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11-15. SERVING TIER — the frozen sold snapshot, never re-derived.
// ═════════════════════════════════════════════════════════════════════════════
describe('11-15. serving tier', () => {
    it('11. sold Serves 2 resolves to "Serves 2"', () => {
        expect(purchases(ORDER({ items: [ITEM({ variant_size: 'serves_2' })] }))[0].servingTier)
            .toBe('Serves 2');
    });

    it('12. sold Serves 5 resolves to "Serves 5"', () => {
        expect(purchases(ORDER({ items: [ITEM({ variant_size: 'serves_5' })] }))[0].servingTier)
            .toBe('Serves 5');
    });

    it('12b. no raw vocabulary ever reaches a label', () => {
        for (const raw of ['serves_2', 'serves_5', 'family', 'small', 'large', '2', '5']) {
            const r = buildPurchasedInstances(ORDER({ items: [ITEM({ variant_size: raw })] }));
            if (r.ok) expect(['Serves 2', 'Serves 5']).toContain(r.instances[0].servingTier);
        }
    });

    it('13. same Bundle identity with mixed sold tiers stays distinct', () => {
        const p = purchases(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-same', item_name: 'Keto', variant_size: 'serves_5', quantity: 2 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-same', item_name: 'Keto', variant_size: 'serves_2', quantity: 3 }),
            ],
        }));
        expect(p).toHaveLength(5);
        expect(p.filter(i => i.servingTier === 'Serves 5')).toHaveLength(2);
        expect(p.filter(i => i.servingTier === 'Serves 2')).toHaveLength(3);
        // Never collapsed by Bundle.id alone.
        expect(new Set(p.map(i => i.servingTier)).size).toBe(2);
    });

    it('14. missing OrderItem.variant_size BLOCKS — never guessed', () => {
        for (const bad of [null, undefined, '', '   ', 'family', 'small', 'large', '2', 'SERVES_5']) {
            const r = buildPurchasedInstances(ORDER({ items: [ITEM({ variant_size: bad as any })] }));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/serving size/i);
        }
    });

    it('15. current Bundle.serving_tier cannot override the frozen sold tier', () => {
        const p = purchases(ORDER({
            items: [ITEM({ variant_size: 'serves_2', bundle: { id: 'b-1', name: 'Bundle One', serving_tier: 'family' } })],
        }));
        expect(p[0].servingTier).toBe('Serves 2');

        // A null snapshot is NOT rescued by a present Bundle tier.
        expect(buildPurchasedInstances(ORDER({
            items: [ITEM({ variant_size: null, bundle: { id: 'b-1', name: 'Bundle One', serving_tier: 'serves_5' } })],
        })).ok).toBe(false);

        // Structural: no layer on this path reads serving_tier at all.
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            expect(strip(read(f))).not.toMatch(/serving_tier/);
        }
    });

    it('15b. resolveSoldTier reads variant_size and nothing else', () => {
        expect(resolveSoldTier(ITEM({ variant_size: 'serves_2' }))).toBe('Serves 2');
        expect(resolveSoldTier(ITEM({ variant_size: 'family' }))).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16-20. SUPPORTER — order-time identity, no PII on the label.
// ═════════════════════════════════════════════════════════════════════════════
describe('16-20. supporter', () => {
    it('16. supporter name resolves onto every purchase', () => {
        expect(purchases(JANE()).every(i => i.supporterName === 'Jane Smith')).toBe(true);
    });

    it('16b. order-time first/last is preferred over the mutable combined scalar', () => {
        expect(resolveSupporterName(ORDER({
            first_name: 'Jane', last_name: 'Smith', customer_name: 'STALE ORG NAME',
        }))).toBe('Jane Smith');
    });

    it('16c. customer_name is the fallback for historical rows with no first/last', () => {
        expect(resolveSupporterName(ORDER({
            first_name: null, last_name: null, customer_name: 'Historical Supporter',
        }))).toBe('Historical Supporter');
    });

    it('16d. one name alone is enough, and is not padded', () => {
        expect(resolveSupporterName(ORDER({ first_name: 'Cher', last_name: null, customer_name: null }))).toBe('Cher');
        expect(resolveSupporterName(ORDER({ first_name: null, last_name: 'Smith', customer_name: null }))).toBe('Smith');
        expect(resolveSupporterName(ORDER({ first_name: '  Jane  ', last_name: '  Smith  ', customer_name: null }))).toBe('Jane Smith');
    });

    it('17. missing supporter name BLOCKS, naming the order', () => {
        const r = buildPurchasedInstances(ORDER({ first_name: null, last_name: null, customer_name: null }));
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.reason).toMatch(/supporter name/i);
            expect(r.reason).toContain('ord-1');
        }
    });

    it('17b. machine placeholders are never printed as a supporter', () => {
        for (const bad of ['', '   ', 'undefined', 'null', 'Unknown', 'UNKNOWN CUSTOMER',
            'Customer', 'N/A', 'na', '-', 'A supporter']) {
            expect(resolveSupporterName(ORDER({
                first_name: null, last_name: null, customer_name: bad,
            }))).toBeNull();
        }
    });

    it('17c. "Guest" BLOCKS — REVERSED BY OPS-6A owner ruling', () => {
        // OPS-6 allowed "Guest", reasoning that a stored value might be an
        // intentional tenant entry. The owner reversed it: the largest field on
        // the box exists to answer "whose box is this?", and "Guest" does not
        // answer it. This test now proves the OPPOSITE of the OPS-6 original,
        // deliberately and on the owner's instruction.
        for (const guest of ['Guest', 'guest', '  GUEST  ']) {
            expect(resolveSupporterName(ORDER({
                first_name: null, last_name: null, customer_name: guest,
            }))).toBeNull();
        }
        const r = packOrder(ORDER({ first_name: null, last_name: null, customer_name: 'Guest' }));
        expect(r.ok).toBe(false);
    });

    it('17d. no name is ever fabricated from an email local-part or an order id', () => {
        expect(buildPurchasedInstances(ORDER({
            id: 'ord-abc123', first_name: null, last_name: null, customer_name: null,
        })).ok).toBe(false);
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/split\(['"]@['"]\)/);
        expect(s).not.toMatch(/participant_name/);
    });

    it('18/19/20. no email, phone or address anywhere on the label path', () => {
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/contact_email|customer_email|\bemail\b/i);
            expect(s).not.toMatch(/contact_phone|customer_phone|\bphone\b/i);
            expect(s).not.toMatch(/delivery_address|street|postal|zip/i);
        }
        // The emitted purchase shape carries no contact data.
        const p = purchases(JANE())[0];
        expect(Object.keys(p).sort()).toEqual([
            'bundleName', 'instanceIndex', 'orderId', 'orderItemId',
            'sequence', 'servingTier', 'supporterName', 'variantSize',
        ]);
        expect(JSON.stringify(p)).not.toMatch(/@|address|phone/i);
    });

    it('20b. the printed DOM renders only the locked facts — no allergens, no ingredients', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/box\.supporterName/);
        expect(printBlock).toMatch(/Box \{box\.boxNumber\} of \{box\.boxTotal\}/);
        expect(printBlock).toMatch(/formatBoxContentLine/);
        // Meal-label content stays on the meal label (contract section 7).
        expect(printBlock).not.toMatch(/allergen/i);
        expect(printBlock).not.toMatch(/ingredient/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21-25. TENANT SECURITY.
// ═════════════════════════════════════════════════════════════════════════════
let mockAuth: () => any;
const findManyCalls: any[] = [];
const orderRows: Record<string, any[]> = { rows: [] };

const prismaDouble: any = {
    order: {
        findMany: (args: any) => {
            findManyCalls.push(args);
            const where = args?.where || {};
            const ids: string[] = where.id?.in || [];
            return Promise.resolve(
                orderRows.rows.filter(o => ids.includes(o.id) && o.business_id === where.business_id),
            );
        },
    },
};

jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: prismaDouble }));

const postBoxLabels = async (body: any) => {
    const { POST } = require('@/app/api/production/box-labels/route');
    return POST(new Request('https://x/api/production/box-labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }));
};

describe('21-25. tenant security', () => {
    beforeEach(() => {
        findManyCalls.length = 0;
        mockAuth = () => ({ user: { businessId: 'biz-a' } });
        orderRows.rows = [
            { ...JANE(), id: 'ord-a', business_id: 'biz-a' },
            { ...JANE(), id: 'ord-b', business_id: 'biz-b' },
        ];
    });

    it('21. Tenant A can print Tenant A order', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a'] });
        expect(res.status).toBe(200);
        const body = await res.json();
        // JANE: 1 x S5 + 2 x S2 -> 3 purchases -> 2 physical boxes.
        expect(body.purchasedBundleCount).toBe(3);
        expect(body.physicalBoxCount).toBe(2);
        expect(body.boxes).toHaveLength(2);
        expect(body.boxes[0].supporterName).toBe('Jane Smith');
        expect(body.unavailableCount).toBe(0);
    });

    it('22. Tenant A CANNOT print Tenant B order', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-b'] });
        const body = await res.json();
        expect(body.boxes).toHaveLength(0);
        expect(body.unavailableCount).toBe(1);
        expect(JSON.stringify(body)).not.toMatch(/Jane|Comfort|Clean Eating/);
    });

    it('23. a tampered Order ID cannot cross a tenant boundary', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a', 'ord-b', 'ord-does-not-exist'] });
        const body = await res.json();
        expect(new Set(body.boxes.map((b: any) => b.orderId))).toEqual(new Set(['ord-a']));
        expect(body.unavailableCount).toBe(2);
        expect(findManyCalls[0].where.business_id).toBe('biz-a');
    });

    it('24. a missing authenticated tenant BLOCKS with 401 before any DB read', async () => {
        for (const session of [null, {}, { user: {} }, { user: { businessId: '' } }]) {
            findManyCalls.length = 0;
            mockAuth = () => session;
            const res = await postBoxLabels({ orderIds: ['ord-a'] });
            expect(res.status).toBe(401);
            expect(findManyCalls).toHaveLength(0);
        }
    });

    it('25. a client-supplied businessId CANNOT override the server tenant', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-b'], businessId: 'biz-b', business_id: 'biz-b' });
        const body = await res.json();
        expect(body.boxes).toHaveLength(0);
        expect(findManyCalls[0].where.business_id).toBe('biz-a');
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/body\??\.businessId|body\??\.business_id/);
        expect(s).toMatch(/session\?\.user as any\)\?\.businessId|session\?\.user\)\?\.businessId/);
    });

    it('25b. the route is self-defending — middleware does not cover /api/', () => {
        const s = strip(read(ROUTE));
        expect(s).toMatch(/await auth\(\)/);
        expect(s).toMatch(/status:\s*401/);
        expect(s.indexOf('401')).toBeLessThan(s.indexOf('prisma.order.findMany'));
    });

    it('25c. canceled orders are excluded, and the batch size is capped', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a'] });
        expect(res.status).toBe(200);
        expect(findManyCalls[0].where.canceled_at).toBeNull();
        expect(strip(read(ROUTE))).toMatch(/MAX_ORDERS_PER_BATCH/);
    });

    it('25d. the localStorage handoff refuses a batch it cannot prove belongs here', () => {
        const store: Record<string, string> = {};
        (global as any).localStorage = {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => { store[k] = v; },
            removeItem: (k: string) => { delete store[k]; },
        };
        const { writeBoxLabelBatch, readBoxLabelBatch, BOX_LABEL_STORAGE_KEY } = require('@/lib/printBatchStorage');

        expect(writeBoxLabelBatch({ orderIds: ['ord-a'], businessId: 'biz-a' }).ok).toBe(true);
        expect(readBoxLabelBatch('biz-a').ok).toBe(true);
        const other = readBoxLabelBatch('biz-b');
        expect(other.ok).toBe(false);
        if (!other.ok) expect(other.reason).toMatch(/different business/i);
        for (const missing of [null, undefined, '']) {
            expect(readBoxLabelBatch(missing as any).ok).toBe(false);
        }
        store[BOX_LABEL_STORAGE_KEY] = JSON.stringify({ orderIds: ['ord-a'] });
        expect(readBoxLabelBatch('biz-a').ok).toBe(false);
        expect((readBoxLabelBatch('biz-b') as any).batch).toBeUndefined();
        delete (global as any).localStorage;
    });

    it('25e. a write with no server-confirmed tenant is refused, not silently stored', () => {
        const store: Record<string, string> = {};
        (global as any).localStorage = {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => { store[k] = v; },
            removeItem: (k: string) => { delete store[k]; },
        };
        const { writeBoxLabelBatch } = require('@/lib/printBatchStorage');
        expect(writeBoxLabelBatch({ orderIds: ['ord-a'], businessId: null }).ok).toBe(false);
        expect(Object.keys(store)).toHaveLength(0);
        delete (global as any).localStorage;
    });

    it('25f. the page proves ownership from the SERVER, never useSession()', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(s).not.toMatch(/useSession/);
        expect(s).not.toMatch(/session\?\.user/);
        const q = strip(read(QUEUE));
        expect(q).toMatch(/await fetchAuthenticatedBusinessId\(\)/);
        expect(q).not.toMatch(/useSession/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 26-30. PRIVACY — nothing identifying in a URL, a query string or a log.
// ═════════════════════════════════════════════════════════════════════════════
describe('26-30. privacy', () => {
    it('26. supporter NAME is absent from every generated URL/query', () => {
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/customer:\s*order\.customer\?\.name/);
        expect(q).not.toMatch(/URLSearchParams/);
        expect(q).not.toMatch(/\/labels\?/);
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });

    it('27. ADDRESS is absent from every generated URL/query', () => {
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/address:\s*order\.customer\?\.delivery_address/);
        // Scoped to the LABEL handler: the Packed & Ready card still displays
        // the delivery address on screen for the operator, which predates
        // OPS-6 and is not the label path.
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/address/i);
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            expect(strip(read(f))).not.toMatch(/delivery_address/);
        }
    });

    it('28/29. EMAIL and PHONE are absent from every generated URL/query', () => {
        const q = strip(read(QUEUE));
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/email/i);
        expect(handler).not.toMatch(/phone/i);
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/email/i);
            expect(s).not.toMatch(/phone/i);
        }
    });

    it('29b. the label page reads NO query parameters at all', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|searchParams|URLSearchParams|window\.location\.search/);
    });

    it('30. no supporter PII is written to a log by the new path', () => {
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            for (const line of s.match(/console\.\w+\([^)]*\)/g) || []) {
                expect(line).not.toMatch(/supporterName|customer_name|first_name|last_name|bundleName/);
                expect(line).not.toMatch(/\$\{|JSON\.stringify|,\s*(body|order|orders|e|err|error)\s*\)/);
            }
        }
        expect(strip(read(ROUTE))).toMatch(/console\.error\('Box label manifest failed'\)/);
    });

    it('30b. only opaque Order IDs are stored in the browser', () => {
        const s = strip(read(STORAGE));
        const block = s.slice(s.indexOf('BOX_LABEL_STORAGE_KEY'));
        expect(block).toMatch(/orderIds/);
        expect(block).not.toMatch(/supporterName|first_name|last_name|customer_name|address|phone|email/i);
        expect(strip(read(QUEUE))).toMatch(/targetOrders\.map\(o => o\.id\)/);
    });

    it('30c. the route never selects supporter contact columns', () => {
        const s = strip(read(ROUTE));
        const select = s.slice(s.indexOf('select:'), s.indexOf('orderBy: { id:'));
        expect(select).toMatch(/first_name/);
        expect(select).toMatch(/customer_name/);
        expect(select).not.toMatch(/phone|delivery_address|participant_name|customer:/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 31-32. ORDER-ITEM ELIGIBILITY.
// ═════════════════════════════════════════════════════════════════════════════
describe('31-32. order item eligibility', () => {
    it('31. a non-Bundle row does NOT create a purchase or a box', () => {
        const p = purchases(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A', quantity: 2 }),
                ITEM({ id: 'oi-2', bundle_id: null, item_name: 'Delivery Fee', bundle: null, quantity: 1 }),
            ],
        }));
        expect(p).toHaveLength(2);
        expect(p.every(i => i.bundleName === 'Bundle A')).toBe(true);
        expect(p.map(i => i.bundleName)).not.toContain('Delivery Fee');
    });

    it('31b. tax and fees cannot be line items at all — they are Order columns', () => {
        const schema = read('prisma/schema.prisma');
        const orderItem = schema.slice(schema.indexOf('model OrderItem'), schema.indexOf('model ProductionRun'));
        expect(orderItem).not.toMatch(/item_type|line_type|\bkind\b/);
        const order = schema.slice(schema.indexOf('model Order {'), schema.indexOf('model OrderItem'));
        expect(order).toMatch(/tax_amount/);
        expect(order).toMatch(/delivery_fee/);
    });

    it('32. only eligible physical Bundle instances become purchases', () => {
        expect(isBoxEligibleItem(ITEM({ bundle_id: 'b-1' }))).toBe(true);
        for (const bad of [null, undefined, '', '   ']) {
            expect(isBoxEligibleItem(ITEM({ bundle_id: bad as any }))).toBe(false);
        }
    });

    it('32b. an order with no eligible bundle BLOCKS rather than silently producing nothing', () => {
        const r = buildPurchasedInstances(ORDER({ items: [ITEM({ bundle_id: null, bundle: null, item_name: 'Fee' })] }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/no purchased bundles/i);
    });

    it('32c. a malformed quantity on a bundle line BLOCKS — it is never skipped', () => {
        for (const bad of [0, -1, 1.5, NaN, Infinity, null, undefined, '3']) {
            const r = buildPurchasedInstances(ORDER({ items: [ITEM({ quantity: bad as any })] }));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/quantity/i);
        }
        expect(quantityFault(ITEM({ quantity: 3 }))).toBeNull();
    });

    it('32d. a missing bundle name BLOCKS rather than printing "Item"', () => {
        const r = buildPurchasedInstances(ORDER({
            items: [ITEM({ item_name: null, bundle: { id: 'b-1', name: null } })],
        }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/no name/i);
        expect(resolveBundleName(ITEM({ item_name: 'Sold As', bundle: { id: 'b', name: 'Renamed Since' } }))).toBe('Sold As');
        expect(resolveBundleName(ITEM({ item_name: null, bundle: { id: 'b', name: 'Live Fallback' } }))).toBe('Live Fallback');
    });

    it('32e. a blocked order contributes ZERO boxes but does not stop the others', () => {
        const good: BoxManifestOrder = { ...JANE(), id: 'ord-good' };
        const bad: BoxManifestOrder = {
            id: 'ord-bad', first_name: null, last_name: null, customer_name: null,
            items: [ITEM({ id: 'oi-bad' })],
        };
        const m = buildPhysicalBoxManifest([good, bad]);
        expect(m.boxes.every(b => b.orderId === 'ord-good')).toBe(true);
        expect(m.blocked).toHaveLength(1);
        expect(m.blocked[0].orderId).toBe('ord-bad');
    });

    it('32f. printing is fail-closed in the PRINTABLE DOM, not only on the button', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/hidden print:block/);
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/blocked\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
        expect(s).toMatch(/if \(blocked\.length > 0\)/);
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 33-40. REGRESSION — the locked authorities OPS-6 must not touch.
// ═════════════════════════════════════════════════════════════════════════════
describe('33-40. regression', () => {
    it('33. the OPS-5 meal-label batch page is unchanged', () => {
        const s = read('app/production/print-batch/page.tsx');
        expect(s).toMatch(/collectBlockedLabels/);
        expect(s).toMatch(/labelAllergenDisplay/);
        expect(strip(s)).not.toMatch(/Box \d+ of|boxNumber|box_number/i);
    });

    it('34. S2 qty3 still means 15 MEAL labels via the meal manifest', () => {
        const { physicalMealCount, isPrintableMealCount } = require('@/lib/mealManifest');
        const perRecipe = physicalMealCount(3, 1);
        expect(perRecipe).toBe(3);
        expect(isPrintableMealCount(perRecipe)).toBe(true);
        expect(perRecipe * 5).toBe(15);
    });

    it('35. the SAME scenario yields 3 purchased bundles — and, per OPS-6A, 2 physical boxes', () => {
        // SUPERSEDED BY OPS-6A: OPS-6 asserted 3 boxes here, because it packed
        // one box per purchased bundle. Three Serves-2 bundles are now 1 paired
        // large box + 1 leftover small box. The 15 MEALS still live inside them,
        // and meal count still never drives box count — which is the original
        // point of this test, unchanged.
        const order = ORDER({
            items: [ITEM({ bundle_id: 'b-1', item_name: 'Clean Eating/Paleo', variant_size: 'serves_2', quantity: 3 })],
        });
        expect(countPurchasedInstances(order)).toBe(3);
        const r = packOrder(order);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.result.physicalBoxCount).toBe(2);
            expect(r.result.physicalBoxCount).not.toBe(15);
        }
    });

    it('35b. no meal/prep/ingredient source can reach the purchase or box count', () => {
        for (const f of [MANIFEST, PACKING]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/prepTasks|assemblyTasks|rawIngredients|BundleContent/);
            expect(s).not.toMatch(/getServingMultiplier|SERVING_MULTIPLIERS/);
            expect(s).not.toMatch(/kitchen_engine|mealManifest|fundraiserMetrics/);
        }
    });

    it('35c. a Serves-2 goal multiplier of 0.5 cannot reduce the physical box count', () => {
        // Three Serves-2 bundles weight 1.5 toward a fundraising goal. They
        // still occupy 2 real cartons.
        const three = packOrder(ORDER({ items: [ITEM({ variant_size: 'serves_2', quantity: 3 })] }));
        expect(three.ok).toBe(true);
        if (three.ok) expect(three.result.physicalBoxCount).toBe(2);
        // Five weight 2.5 and occupy 3.
        const five = packOrder(ORDER({ items: [ITEM({ variant_size: 'serves_2', quantity: 5 })] }));
        expect(five.ok).toBe(true);
        if (five.ok) expect(five.result.physicalBoxCount).toBe(3);
    });

    it('36. ingredient / kitchen math is untouched', () => {
        expect(read('lib/kitchen_engine.ts'))
            .toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE, QUEUE]) {
            expect(strip(read(f))).not.toMatch(/kitchen_engine/);
        }
    });

    it('37. meal allergen behaviour is untouched', () => {
        const { labelAllergenDisplay, resolveLabelAllergens } = require('@/lib/allergens');
        expect(labelAllergenDisplay('None Confirmed')).toBe('');
        expect(labelAllergenDisplay('Dairy, Wheat')).toBe('Dairy, Wheat');
        expect(resolveLabelAllergens(null, 'butter, milk')).toBe('Dairy');
        for (const f of [MANIFEST, PACKING]) {
            expect(strip(read(f))).not.toMatch(/allergen/i);
        }
    });

    it('38. Manual Planner bundle loading is untouched', () => {
        expect(read('lib/bundleLoader.ts').length).toBeGreaterThan(0);
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE]) {
            expect(strip(read(f))).not.toMatch(/bundleLoader/);
        }
    });

    it('39. fundraiser order lineage is untouched', () => {
        const s = read('lib/fundraiserProductionBatch.ts');
        expect(s).toMatch(/export function buildFundraiserBatches/);
        expect(s).toMatch(/sourceOrderIds/);
        expect(strip(s)).not.toMatch(/boxNumber|boxTotal/);
        for (const f of [MANIFEST, PACKING]) {
            expect(strip(read(f))).not.toMatch(/fundraiserProductionBatch/);
        }
    });

    it('40. no Production DB mutation, and no schema change', () => {
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE, QUEUE]) {
            expect(strip(read(f)))
                .not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw/);
        }
        expect(read('prisma/schema.prisma')).not.toMatch(/box_number|box_total|boxNumber/);
    });

    it('40b. the purchase authority is pure — no Prisma, no React, no I/O', () => {
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/from '@\/lib\/db'|from 'react'|PrismaClient|fetch\(/);
        const imports = s.match(/^import .*$/gm) || [];
        expect(imports).toHaveLength(2);
        expect(imports.join('\n')).toMatch(/servingTierLabel.*mealLabel/s);
        expect(imports.join('\n')).toMatch(/purchaserDisplayName.*purchaserName/s);
    });

    it('40c. printing a box label is NOT a lifecycle transition', () => {
        for (const f of [MANIFEST, PACKING, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/status:\s*['"](packed|delivered|ready_to_ship|completed)/i);
            expect(s).not.toMatch(/markPacked|markDelivered|setStatus/);
        }
    });
});
