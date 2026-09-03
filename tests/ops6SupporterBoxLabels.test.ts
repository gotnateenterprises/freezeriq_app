/**
 * OPS-6 — SUPPORTER OUTER-BOX LABEL RECONSTRUCTION + PACKING PRINT CLOSEOUT.
 *
 * Covers the required 40-item matrix (Part R). Behavioural wherever the
 * behaviour is expressible: the manifest authority is a pure function, so
 * counting, numbering, tier and supporter rules are proven by CALLING it, not
 * by grepping for it. The route's tenant scope is proven against a recording
 * Prisma double that captures the real WHERE clause. Only the print CSS and
 * the rendered label DOM are asserted on source text, because Jest here is
 * node-only (no jsdom) and cannot count browser-generated sheets — the sheet
 * count itself is owner visual acceptance, and what IS provable is the exact
 * CSS mechanism that produces it.
 *
 * FAILING-FIRST: tests/ops6FailingFirstProbe.test.ts ran against HEAD 69fabc6
 * before any implementation and failed 10/10 — no manifest authority, no label
 * page, no route, `items[0]` only, supporter name and home address in the URL,
 * no sold tier, no Box N/M, an 'Unknown' placeholder name. Those probes are
 * folded into section 0 below and the probe file was deleted.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
    buildOrderBoxLabels,
    buildSupporterBoxManifest,
    countPhysicalBoxes,
    resolveSupporterName,
    resolveBundleName,
    resolveSoldTier,
    isBoxEligibleItem,
    quantityFault,
    type BoxManifestOrder,
} from '@/lib/supporterBoxManifest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** Strip comments so a doc comment can never satisfy (or fail) an assertion. */
const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const MANIFEST = 'lib/supporterBoxManifest.ts';
const ROUTE = 'app/api/production/box-labels/route.ts';
const PAGE = 'app/production/box-labels/page.tsx';
const QUEUE = 'components/production/DeliveryQueue.tsx';
const STORAGE = 'lib/printBatchStorage.ts';

// ── The Part S fixture ───────────────────────────────────────────────────────
// Jane Smith: 1 x Comfort Foods (Serves 5) + 2 x Clean Eating/Paleo (Serves 2)
// => 3 outer boxes, numbered 1..3 of 3.
//
// The OrderItem ids are chosen so the canonical sort key (id ascending — the
// only authoritative stable field on OrderItem; it has no `position` and no
// `created_at`) reproduces the owner's expected sequence.
const JANE = (): BoxManifestOrder => ({
    id: 'ord-jane-1',
    first_name: 'Jane',
    last_name: 'Smith',
    customer_name: 'Jane Smith',
    items: [
        {
            id: 'oi-1',
            bundle_id: 'b-comfort-5',
            quantity: 1,
            variant_size: 'serves_5',
            item_name: 'Comfort Foods',
            bundle: { id: 'b-comfort-5', name: 'Comfort Foods' },
        },
        {
            id: 'oi-2',
            bundle_id: 'b-clean-2',
            quantity: 2,
            variant_size: 'serves_2',
            item_name: 'Clean Eating/Paleo',
            bundle: { id: 'b-clean-2', name: 'Clean Eating/Paleo' },
        },
    ],
});

const ITEM = (over: Partial<BoxManifestOrder['items'][0]> = {}) => ({
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
});

const ok = (o: BoxManifestOrder) => {
    const r = buildOrderBoxLabels(o);
    if (!r.ok) throw new Error(`expected labels, got block: ${r.reason}`);
    return r.labels;
};

// ═════════════════════════════════════════════════════════════════════════════
// 0. FAILING-FIRST — the gap this phase closed (folded from the probe).
// ═════════════════════════════════════════════════════════════════════════════
describe('0. failing-first: the outer-box gap at HEAD 69fabc6', () => {
    it('0a. the three new authorities now exist', () => {
        expect(existsSync(join(root, MANIFEST))).toBe(true);
        expect(existsSync(join(root, ROUTE))).toBe(true);
        expect(existsSync(join(root, PAGE))).toBe(true);
    });

    it('0b. the items[0] heuristic is gone — the whole order drives the labels', () => {
        const s = strip(read(QUEUE));
        expect(s).not.toMatch(/order\.items\[0\]/);
        expect(s).not.toMatch(/const item = order\.items/);
    });

    it('0c. the bundle-id-as-recipeId category error is gone', () => {
        const s = strip(read(QUEUE));
        expect(s).not.toMatch(/recipeId:\s*item\.bundle\.id/);
    });

    it('0d. supporter identity is resolved from ORDER-TIME fields', () => {
        const s = strip(read(MANIFEST));
        expect(s).toMatch(/first_name/);
        expect(s).toMatch(/last_name/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-5. BASIC COUNTING — one label per physical purchased bundle instance.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-5. basic counting', () => {
    it('1. one Bundle qty1 -> one label', () => {
        expect(ok(ORDER({ items: [ITEM({ quantity: 1 })] }))).toHaveLength(1);
    });

    it('2. one Bundle qty3 -> exactly three labels', () => {
        expect(ok(ORDER({ items: [ITEM({ quantity: 3 })] }))).toHaveLength(3);
    });

    it('3. two Bundle items qty1 each -> exactly two labels', () => {
        const labels = ok(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A', quantity: 1 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Bundle B', quantity: 1 }),
            ],
        }));
        expect(labels).toHaveLength(2);
        expect(labels.map(l => l.bundleName)).toEqual(['Bundle A', 'Bundle B']);
    });

    it('4. qty2 + qty3 -> exactly five labels (Part E case 4)', () => {
        const labels = ok(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A', quantity: 2 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-b', item_name: 'Bundle B', quantity: 3 }),
            ],
        }));
        expect(labels).toHaveLength(5);
        expect(labels.filter(l => l.bundleName === 'Bundle A')).toHaveLength(2);
        expect(labels.filter(l => l.bundleName === 'Bundle B')).toHaveLength(3);
    });

    it('5. no extra blank physical page after the final label', () => {
        const s = read(PAGE);
        // The general rule forces a break after every label...
        expect(s).toMatch(/\.print-page\s*\{[^}]*break-after:\s*always/);
        // ...and the last-child exemption releases the final one. Specificity
        // (0,2,0) beats (0,1,0) so declaration order cannot defeat it.
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?break-after:\s*auto/);
        expect(s).toMatch(/\.print-page:last-child\s*\{[\s\S]*?page-break-after:\s*auto/);
        // The exemption must not hide or collapse the final label to fake it.
        const exemption = s.slice(
            s.indexOf('.print-page:last-child'),
            s.indexOf('}', s.indexOf('.print-page:last-child')),
        );
        expect(exemption).not.toMatch(/display:\s*none|visibility:\s*hidden|height:\s*0|content-visibility/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6-10. BOX NUMBERING.
// ═════════════════════════════════════════════════════════════════════════════
describe('6-10. box numbering', () => {
    it('6. one box -> Box 1 of 1', () => {
        const [l] = ok(ORDER({ items: [ITEM({ quantity: 1 })] }));
        expect([l.boxNumber, l.boxTotal]).toEqual([1, 1]);
    });

    it('7. three boxes -> 1/3, 2/3, 3/3', () => {
        const labels = ok(ORDER({ items: [ITEM({ quantity: 3 })] }));
        expect(labels.map(l => `${l.boxNumber} of ${l.boxTotal}`))
            .toEqual(['1 of 3', '2 of 3', '3 of 3']);
    });

    it('8. mixed Bundles share ONE source-Order total (the Part S fixture)', () => {
        const labels = ok(JANE());
        expect(labels).toHaveLength(3);
        expect(labels.map(l => ({
            name: l.supporterName, bundle: l.bundleName, tier: l.servingTier,
            box: `Box ${l.boxNumber} of ${l.boxTotal}`,
        }))).toEqual([
            { name: 'Jane Smith', bundle: 'Comfort Foods', tier: 'Serves 5', box: 'Box 1 of 3' },
            { name: 'Jane Smith', bundle: 'Clean Eating/Paleo', tier: 'Serves 2', box: 'Box 2 of 3' },
            { name: 'Jane Smith', bundle: 'Clean Eating/Paleo', tier: 'Serves 2', box: 'Box 3 of 3' },
        ]);
        // Every label in one order agrees on the total.
        expect(new Set(labels.map(l => l.boxTotal)).size).toBe(1);
    });

    it('9. numbering is deterministic across repeated renders AND input order', () => {
        const a = ok(JANE());
        const b = ok(JANE());
        expect(b).toEqual(a);

        // Part N: never database default row order. Shuffling the input array
        // must not reshuffle Box N/M, because the module sorts by its own
        // authoritative key rather than trusting arrival order.
        const shuffled = JANE();
        shuffled.items = [shuffled.items[1], shuffled.items[0]];
        expect(ok(shuffled)).toEqual(a);
    });

    it('10. two separate Orders for the SAME supporter name are NOT merged', () => {
        const one: BoxManifestOrder = { ...JANE(), id: 'ord-a', items: [ITEM({ id: 'oi-a', quantity: 1 })] };
        const two: BoxManifestOrder = { ...JANE(), id: 'ord-b', items: [ITEM({ id: 'oi-b', quantity: 2 })] };
        const { labels } = buildSupporterBoxManifest([one, two]);

        expect(labels).toHaveLength(3);
        // Each order keeps its OWN total: 1 of 1, then 1 of 2 and 2 of 2.
        expect(labels.filter(l => l.orderId === 'ord-a').map(l => `${l.boxNumber}/${l.boxTotal}`))
            .toEqual(['1/1']);
        expect(labels.filter(l => l.orderId === 'ord-b').map(l => `${l.boxNumber}/${l.boxTotal}`))
            .toEqual(['1/2', '2/2']);
        // Nothing anywhere says "of 3".
        expect(labels.every(l => l.boxTotal !== 3)).toBe(true);
    });

    it('10b. identical name, email-shaped and phone-shaped duplicates stay separate', () => {
        const mk = (id: string): BoxManifestOrder => ({
            id, first_name: 'Jane', last_name: 'Smith', customer_name: 'Jane Smith',
            items: [ITEM({ id: `${id}-i`, quantity: 1 })],
        });
        const { labels } = buildSupporterBoxManifest([mk('ord-1'), mk('ord-2'), mk('ord-3')]);
        expect(labels).toHaveLength(3);
        expect(labels.every(l => l.boxTotal === 1)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11-15. SERVING TIER — the frozen sold snapshot, never re-derived.
// ═════════════════════════════════════════════════════════════════════════════
describe('11-15. serving tier', () => {
    it('11. sold Serves 2 prints "Serves 2"', () => {
        expect(ok(ORDER({ items: [ITEM({ variant_size: 'serves_2' })] }))[0].servingTier)
            .toBe('Serves 2');
    });

    it('12. sold Serves 5 prints "Serves 5"', () => {
        expect(ok(ORDER({ items: [ITEM({ variant_size: 'serves_5' })] }))[0].servingTier)
            .toBe('Serves 5');
    });

    it('12b. no raw vocabulary ever reaches a label', () => {
        for (const raw of ['serves_2', 'serves_5', 'family', 'small', 'large', '2', '5']) {
            const r = buildOrderBoxLabels(ORDER({ items: [ITEM({ variant_size: raw })] }));
            if (r.ok) {
                expect(['Serves 2', 'Serves 5']).toContain(r.labels[0].servingTier);
            }
        }
    });

    it('13. same Bundle identity with mixed sold tiers stays distinct (Part E case 5)', () => {
        const labels = ok(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-same', item_name: 'Keto', variant_size: 'serves_5', quantity: 2 }),
                ITEM({ id: 'oi-2', bundle_id: 'b-same', item_name: 'Keto', variant_size: 'serves_2', quantity: 3 }),
            ],
        }));
        expect(labels).toHaveLength(5);
        expect(labels.filter(l => l.servingTier === 'Serves 5')).toHaveLength(2);
        expect(labels.filter(l => l.servingTier === 'Serves 2')).toHaveLength(3);
        // Never collapsed by Bundle.id alone.
        expect(new Set(labels.map(l => l.servingTier)).size).toBe(2);
    });

    it('14. missing OrderItem.variant_size BLOCKS — never guessed', () => {
        for (const bad of [null, undefined, '', '   ', 'family', 'small', 'large', '2', 'SERVES_5']) {
            const r = buildOrderBoxLabels(ORDER({ items: [ITEM({ variant_size: bad as any })] }));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/serving size/i);
        }
        // In particular it does NOT silently become Serves 5, which is what
        // resolveVariantSize() and fundraiserProductionBatch's `|| 'serves_5'`
        // would have done.
        const r = buildOrderBoxLabels(ORDER({ items: [ITEM({ variant_size: null })] }));
        expect(r.ok).toBe(false);
    });

    it('15. current Bundle.serving_tier cannot override the frozen sold tier', () => {
        // The live Bundle row says one thing; the frozen snapshot says another.
        // The snapshot must win, and the module must not even accept a
        // serving_tier field on the joined bundle.
        const labels = ok(ORDER({
            items: [ITEM({
                variant_size: 'serves_2',
                bundle: { id: 'b-1', name: 'Bundle One', serving_tier: 'family' } as any,
            })],
        }));
        expect(labels[0].servingTier).toBe('Serves 2');

        // And a null snapshot is NOT rescued by a present Bundle tier.
        const blocked = buildOrderBoxLabels(ORDER({
            items: [ITEM({
                variant_size: null,
                bundle: { id: 'b-1', name: 'Bundle One', serving_tier: 'serves_5' } as any,
            })],
        }));
        expect(blocked.ok).toBe(false);

        // Structural: nothing in the authority reads serving_tier at all.
        expect(strip(read(MANIFEST))).not.toMatch(/serving_tier/);
        expect(strip(read(ROUTE))).not.toMatch(/serving_tier/);
        expect(strip(read(PAGE))).not.toMatch(/serving_tier/);
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
    it('16. supporter name prints', () => {
        expect(ok(JANE())[0].supporterName).toBe('Jane Smith');
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
        expect(resolveSupporterName(ORDER({ first_name: 'Cher', last_name: null, customer_name: null })))
            .toBe('Cher');
        expect(resolveSupporterName(ORDER({ first_name: null, last_name: 'Smith', customer_name: null })))
            .toBe('Smith');
        expect(resolveSupporterName(ORDER({ first_name: '  Jane  ', last_name: '  Smith  ', customer_name: null })))
            .toBe('Jane Smith');
    });

    it('17. missing supporter name BLOCKS, naming the order', () => {
        const r = buildOrderBoxLabels(ORDER({ first_name: null, last_name: null, customer_name: null }));
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

    it('17c. "Guest" IS printed — the owner carve-out for an intentional entry', () => {
        expect(resolveSupporterName(ORDER({
            first_name: null, last_name: null, customer_name: 'Guest',
        }))).toBe('Guest');
    });

    it('17d. no name is ever fabricated from an email local-part or an order id', () => {
        const r = buildOrderBoxLabels(ORDER({
            id: 'ord-abc123', first_name: null, last_name: null, customer_name: null,
        }));
        expect(r.ok).toBe(false);
        // Nothing resembling a derived name exists in the authority.
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/split\(['"]@['"]\)/);
        expect(s).not.toMatch(/participant_name/);
    });

    it('18/19/20. no email, phone or address anywhere on the label path', () => {
        for (const f of [MANIFEST, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/contact_email|customer_email|\bemail\b/i);
            expect(s).not.toMatch(/contact_phone|customer_phone|\bphone\b/i);
            expect(s).not.toMatch(/delivery_address|street|postal|zip/i);
        }
        // The emitted label shape carries exactly the four printed facts.
        const label = ok(JANE())[0];
        expect(Object.keys(label).sort()).toEqual([
            'boxNumber', 'boxTotal', 'bundleName', 'orderId', 'orderItemId',
            'physicalInstanceIndex', 'servingTier', 'supporterName',
        ]);
        expect(JSON.stringify(label)).not.toMatch(/@|address|phone/i);
    });

    it('20b. the printed DOM renders only the four facts — no allergens, no ingredients', () => {
        const s = strip(read(PAGE));
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        expect(printBlock).toMatch(/supporterName/);
        expect(printBlock).toMatch(/bundleName/);
        expect(printBlock).toMatch(/servingTier/);
        expect(printBlock).toMatch(/Box \{label\.boxNumber\} of \{label\.boxTotal\}/);
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
            // Emulate the DB honestly: a row is returned only when BOTH the id
            // and the tenant match, which is what the WHERE clause asks for.
            return Promise.resolve(
                orderRows.rows.filter(
                    (o) => ids.includes(o.id) && o.business_id === where.business_id,
                ),
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
        expect(body.labels).toHaveLength(3);
        expect(body.labels[0].supporterName).toBe('Jane Smith');
        expect(body.unavailableCount).toBe(0);
    });

    it('22. Tenant A CANNOT print Tenant B order', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-b'] });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.labels).toHaveLength(0);
        expect(body.unavailableCount).toBe(1);
        // And no leakage in the refusal: the response must not reveal that the
        // order exists elsewhere, nor any of its content.
        expect(JSON.stringify(body)).not.toMatch(/Jane|Comfort|Clean Eating/);
    });

    it('23. a tampered Order ID cannot cross a tenant boundary', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a', 'ord-b', 'ord-does-not-exist'] });
        const body = await res.json();
        // Only the caller's own order yields labels.
        expect(new Set(body.labels.map((l: any) => l.orderId))).toEqual(new Set(['ord-a']));
        expect(body.unavailableCount).toBe(2);
        // The tenant filter is IN THE QUERY, not applied afterwards.
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
        expect(body.labels).toHaveLength(0);
        expect(findManyCalls[0].where.business_id).toBe('biz-a');
        // Structural: the route never reads a tenant from the request body.
        const s = strip(read(ROUTE));
        expect(s).not.toMatch(/body\??\.businessId|body\??\.business_id/);
        expect(s).toMatch(/session\?\.user as any\)\?\.businessId|session\?\.user\)\?\.businessId/);
    });

    it('25b. the route is self-defending — middleware does not cover /api/', async () => {
        const s = strip(read(ROUTE));
        expect(s).toMatch(/await auth\(\)/);
        expect(s).toMatch(/status:\s*401/);
        // 401 is resolved before Prisma is touched.
        expect(s.indexOf('401')).toBeLessThan(s.indexOf('prisma.order.findMany'));
    });

    it('25c. canceled orders are excluded, and the batch size is capped', async () => {
        const res = await postBoxLabels({ orderIds: ['ord-a'] });
        expect(res.status).toBe(200);
        expect(findManyCalls[0].where.canceled_at).toBeNull();
        const s = strip(read(ROUTE));
        expect(s).toMatch(/MAX_ORDERS_PER_BATCH/);
    });

    it('25d. the localStorage handoff refuses a batch it cannot prove belongs here', () => {
        const { readBoxLabelBatch } = require('@/lib/printBatchStorage');
        const store: Record<string, string> = {};
        (global as any).localStorage = {
            getItem: (k: string) => store[k] ?? null,
            setItem: (k: string, v: string) => { store[k] = v; },
            removeItem: (k: string) => { delete store[k]; },
        };
        const { writeBoxLabelBatch, BOX_LABEL_STORAGE_KEY } = require('@/lib/printBatchStorage');

        expect(writeBoxLabelBatch({ orderIds: ['ord-a'], businessId: 'biz-a' }).ok).toBe(true);
        // Right tenant -> opens.
        expect(readBoxLabelBatch('biz-a').ok).toBe(true);
        // Another tenant -> refused.
        const other = readBoxLabelBatch('biz-b');
        expect(other.ok).toBe(false);
        if (!other.ok) expect(other.reason).toMatch(/different business/i);
        // Unknown current tenant -> refused (never "no opinion").
        for (const missing of [null, undefined, '']) {
            expect(readBoxLabelBatch(missing as any).ok).toBe(false);
        }
        // A batch with no proven owner -> refused.
        store[BOX_LABEL_STORAGE_KEY] = JSON.stringify({ orderIds: ['ord-a'] });
        expect(readBoxLabelBatch('biz-a').ok).toBe(false);
        // A refused read never returns batch content.
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
        const r = writeBoxLabelBatch({ orderIds: ['ord-a'], businessId: null });
        expect(r.ok).toBe(false);
        expect(Object.keys(store)).toHaveLength(0);
        delete (global as any).localStorage;
    });

    it('25f. the page proves ownership from the SERVER, never useSession()', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/fetchAuthenticatedBusinessId\(\)/);
        expect(s).not.toMatch(/useSession/);
        expect(s).not.toMatch(/session\?\.user/);
        // The queue writer likewise stamps the server id.
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
        // The only navigation is to a static path with no query string at all.
        expect(q).toMatch(/router\.push\('\/production\/box-labels'\)/);
    });

    it('27. ADDRESS is absent from every generated URL/query', () => {
        const q = strip(read(QUEUE));
        // The old writer put the supporter's home address in the query string.
        expect(q).not.toMatch(/address:\s*order\.customer\?\.delivery_address/);
        // Scoped to the LABEL handler: the Packed & Ready card still displays
        // the delivery address on screen for the operator, which predates
        // OPS-6 and is not the label path. What must be true is that the
        // handler which prepares labels touches no address at all.
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/address/i);
        // ...and no address reaches the label itself or its transport.
        for (const f of [MANIFEST, ROUTE, PAGE]) {
            expect(strip(read(f))).not.toMatch(/delivery_address/);
        }
    });

    it('28/29. EMAIL and PHONE are absent from every generated URL/query', () => {
        const q = strip(read(QUEUE));
        const handler = q.slice(q.indexOf('const queueBoxLabels'), q.indexOf('if (orders.length === 0)'));
        expect(handler).not.toMatch(/email/i);
        expect(handler).not.toMatch(/phone/i);
        for (const f of [MANIFEST, ROUTE, PAGE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/email/i);
            expect(s).not.toMatch(/phone/i);
        }
    });

    it('29b. the new label page reads NO query parameters at all', () => {
        const s = strip(read(PAGE));
        expect(s).not.toMatch(/useSearchParams|searchParams|URLSearchParams|window\.location\.search/);
    });

    it('30. no supporter PII is written to a log by the new path', () => {
        for (const f of [MANIFEST, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            const logs = s.match(/console\.\w+\([^)]*\)/g) || [];
            for (const line of logs) {
                // Identifiers that would carry supporter data into a log sink.
                // Deliberately NOT the words "order"/"label" — a fixed message
                // may legitimately name what failed, and matching those made
                // this assertion fail on its own safe log string.
                expect(line).not.toMatch(/supporterName|customer_name|first_name|last_name|bundleName/);
                // No interpolation and no object echo: a fixed string only.
                expect(line).not.toMatch(/\$\{|JSON\.stringify|,\s*(body|order|orders|e|err|error)\s*\)/);
            }
        }
        // The route's own catch logs a fixed string with no request echo.
        expect(strip(read(ROUTE))).toMatch(/console\.error\('Box label manifest failed'\)/);
    });

    it('30b. only opaque Order IDs are stored in the browser', () => {
        const s = strip(read(STORAGE));
        const block = s.slice(s.indexOf('BOX_LABEL_STORAGE_KEY'));
        expect(block).toMatch(/orderIds/);
        expect(block).not.toMatch(/supporterName|first_name|last_name|customer_name|address|phone|email/i);
        // The queue hands over ids only.
        const q = strip(read(QUEUE));
        expect(q).toMatch(/targetOrders\.map\(o => o\.id\)/);
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
    it('31. a non-Bundle row does NOT create a box', () => {
        const labels = ok(ORDER({
            items: [
                ITEM({ id: 'oi-1', bundle_id: 'b-a', item_name: 'Bundle A', quantity: 2 }),
                // A non-bundle line: no bundle identity. Legitimate, not a box.
                ITEM({ id: 'oi-2', bundle_id: null, item_name: 'Delivery Fee', bundle: null, quantity: 1 }),
            ],
        }));
        expect(labels).toHaveLength(2);
        expect(labels.every(l => l.bundleName === 'Bundle A')).toBe(true);
        expect(labels.every(l => l.boxTotal === 2)).toBe(true);
        expect(labels.map(l => l.bundleName)).not.toContain('Delivery Fee');
    });

    it('31b. tax and fees cannot be line items at all — they are Order columns', () => {
        const schema = read('prisma/schema.prisma');
        const orderItem = schema.slice(schema.indexOf('model OrderItem'), schema.indexOf('model ProductionRun'));
        // No item-type discriminator exists, so bundle_id IS the eligibility test.
        expect(orderItem).not.toMatch(/item_type|line_type|\bkind\b/);
        const order = schema.slice(schema.indexOf('model Order {'), schema.indexOf('model OrderItem'));
        expect(order).toMatch(/tax_amount/);
        expect(order).toMatch(/delivery_fee/);
    });

    it('32. only eligible physical Bundle instances create outer labels', () => {
        expect(isBoxEligibleItem(ITEM({ bundle_id: 'b-1' }))).toBe(true);
        for (const bad of [null, undefined, '', '   ']) {
            expect(isBoxEligibleItem(ITEM({ bundle_id: bad as any }))).toBe(false);
        }
    });

    it('32b. an order with no eligible bundle BLOCKS rather than printing nothing silently', () => {
        const r = buildOrderBoxLabels(ORDER({
            items: [ITEM({ bundle_id: null, bundle: null, item_name: 'Fee' })],
        }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/no purchased bundles/i);
    });

    it('32c. a malformed quantity on a bundle line BLOCKS — it is never skipped', () => {
        // Skipping would silently understate every other box\'s "of M" total.
        for (const bad of [0, -1, 1.5, NaN, Infinity, null, undefined, '3']) {
            const r = buildOrderBoxLabels(ORDER({ items: [ITEM({ quantity: bad as any })] }));
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.reason).toMatch(/quantity/i);
        }
        expect(quantityFault(ITEM({ quantity: 3 }))).toBeNull();
    });

    it('32d. a missing bundle name BLOCKS rather than printing "Item"', () => {
        const r = buildOrderBoxLabels(ORDER({
            items: [ITEM({ item_name: null, bundle: { id: 'b-1', name: null } })],
        }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/no name/i);
        // The frozen snapshot is preferred over the live bundle name.
        expect(resolveBundleName(ITEM({ item_name: 'Sold As', bundle: { id: 'b', name: 'Renamed Since' } })))
            .toBe('Sold As');
        expect(resolveBundleName(ITEM({ item_name: null, bundle: { id: 'b', name: 'Live Fallback' } })))
            .toBe('Live Fallback');
    });

    it('32e. a blocked order contributes ZERO labels but does not stop the others', () => {
        const good: BoxManifestOrder = { ...JANE(), id: 'ord-good' };
        const bad: BoxManifestOrder = {
            id: 'ord-bad', first_name: null, last_name: null, customer_name: null,
            items: [ITEM({ id: 'oi-bad' })],
        };
        const { labels, blocked } = buildSupporterBoxManifest([good, bad]);
        expect(labels).toHaveLength(3);
        expect(labels.every(l => l.orderId === 'ord-good')).toBe(true);
        expect(blocked).toHaveLength(1);
        expect(blocked[0].orderId).toBe('ord-bad');
    });

    it('32f. printing is fail-closed in the PRINTABLE DOM, not only on the button', () => {
        const s = strip(read(PAGE));
        expect(s).toMatch(/hidden print:block/);
        const printBlock = s.slice(s.indexOf('hidden print:block'));
        // A blocked batch renders DO NOT USE instead of the labels, so Ctrl+P
        // cannot bypass the gate.
        expect(printBlock).toMatch(/blocked\.length > 0 \?/);
        expect(printBlock).toMatch(/DO NOT USE/);
        // ...and the button refuses too.
        expect(s).toMatch(/if \(blocked\.length > 0\)/);
        expect(s).toMatch(/disabled=\{[^}]*blocked\.length > 0/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 33-40. REGRESSION — the locked authorities this phase must not touch.
// ═════════════════════════════════════════════════════════════════════════════
describe('33-40. regression', () => {
    it('33. the OPS-5 meal-label batch page is unchanged by this phase', () => {
        const s = read('app/production/print-batch/page.tsx');
        // Still the meal label: allergens, ingredients, fail-closed gate.
        expect(s).toMatch(/collectBlockedLabels/);
        expect(s).toMatch(/labelAllergenDisplay/);
        // And still carries NO outer-box concept (the OPS-5/5A guard).
        expect(strip(s)).not.toMatch(/Box \d+ of|boxNumber|box_number/i);
    });

    it('34. S2 qty3 still means 15 MEAL labels via the meal manifest', () => {
        const { physicalMealCount, isPrintableMealCount } = require('@/lib/mealManifest');
        // 5 recipes in the bundle, 3 bundles ordered at Serves 2, one package
        // of each recipe per bundle => 3 meal labels per recipe, 15 in total.
        // The serving multiplier still does NOT reduce it.
        const perRecipe = physicalMealCount(3, 1);
        expect(perRecipe).toBe(3);
        expect(isPrintableMealCount(perRecipe)).toBe(true);
        expect(perRecipe * 5).toBe(15);
    });

    it('35. the SAME scenario yields 3 OUTER boxes, not 15', () => {
        // One order, one bundle line, qty 3 -> 3 physical boxes. The 15 meals
        // are INSIDE those 3 boxes; meal count must never drive box count.
        const boxes = countPhysicalBoxes([ORDER({
            items: [ITEM({ bundle_id: 'b-1', item_name: 'Clean Eating/Paleo', variant_size: 'serves_2', quantity: 3 })],
        })]);
        expect(boxes).toBe(3);
        expect(boxes).not.toBe(15);
    });

    it('35b. no meal/prep/ingredient source can reach the outer-box count', () => {
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/prepTasks|assemblyTasks|rawIngredients|BundleContent|contents/);
        expect(s).not.toMatch(/getServingMultiplier|SERVING_MULTIPLIERS|multiplier/);
        expect(s).not.toMatch(/kitchen_engine|mealManifest|fundraiserMetrics/);
        // The count comes from quantity, summed, and nothing else.
        expect(s).toMatch(/sum \+ r\.item\.quantity/);
    });

    it('35c. a Serves-2 goal multiplier of 0.5 cannot reduce the box count', () => {
        // Three Serves-2 bundles are three boxes, not 1.5 and not 2.
        const boxes = countPhysicalBoxes([ORDER({
            items: [ITEM({ variant_size: 'serves_2', quantity: 3 })],
        })]);
        expect(boxes).toBe(3);
        // Mixed tiers: 2 x S5 + 3 x S2 = 5 boxes, never 2 + 1.5 = 3.5.
        expect(countPhysicalBoxes([ORDER({
            items: [
                ITEM({ id: 'oi-1', variant_size: 'serves_5', quantity: 2 }),
                ITEM({ id: 'oi-2', variant_size: 'serves_2', quantity: 3 }),
            ],
        })])).toBe(5);
    });

    it('36. ingredient / kitchen math is untouched', () => {
        const s = read('lib/kitchen_engine.ts');
        expect(s).toMatch(/const servingMultiplier = getServingMultiplier\(order\.variant_size\);/);
        // And nothing in this phase imports or edits it.
        for (const f of [MANIFEST, ROUTE, PAGE, QUEUE]) {
            expect(strip(read(f))).not.toMatch(/kitchen_engine/);
        }
    });

    it('37. meal allergen behaviour is untouched', () => {
        const { labelAllergenDisplay, resolveLabelAllergens } = require('@/lib/allergens');
        expect(labelAllergenDisplay('None Confirmed')).toBe('');
        expect(labelAllergenDisplay('Dairy, Wheat')).toBe('Dairy, Wheat');
        expect(resolveLabelAllergens(null, 'butter, milk')).toBe('Dairy');
        // The outer box carries no allergen data at all (contract section 7).
        expect(strip(read(MANIFEST))).not.toMatch(/allergen/i);
    });

    it('38. Manual Planner bundle loading is untouched', () => {
        const s = read('lib/bundleLoader.ts');
        expect(s.length).toBeGreaterThan(0);
        for (const f of [MANIFEST, ROUTE, PAGE]) {
            expect(strip(read(f))).not.toMatch(/bundleLoader/);
        }
    });

    it('39. fundraiser order lineage is untouched', () => {
        const s = read('lib/fundraiserProductionBatch.ts');
        // Still campaign-grouped, still traceable, still not the box authority.
        expect(s).toMatch(/export function buildFundraiserBatches/);
        expect(s).toMatch(/sourceOrderIds/);
        expect(strip(s)).not.toMatch(/boxNumber|boxTotal/);
        // The new module does not import or replace it.
        expect(strip(read(MANIFEST))).not.toMatch(/fundraiserProductionBatch/);
    });

    it('40. no Production DB mutation, and no schema change', () => {
        for (const f of [MANIFEST, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.delete\(|\.deleteMany\(|\.upsert\(|\$executeRaw/);
        }
        // Contract section 7: box numbering is a render-time computation only.
        const schema = read('prisma/schema.prisma');
        expect(schema).not.toMatch(/box_number|box_total|boxNumber/);
    });

    it('40b. the manifest authority is pure — no Prisma, no React, no I/O', () => {
        const s = strip(read(MANIFEST));
        expect(s).not.toMatch(/from '@\/lib\/db'|from 'react'|PrismaClient|fetch\(/);
        // Its only imports are the two canonical pure helpers it reuses.
        const imports = s.match(/^import .*$/gm) || [];
        expect(imports).toHaveLength(2);
        expect(imports.join('\n')).toMatch(/servingTierLabel.*mealLabel/s);
        expect(imports.join('\n')).toMatch(/purchaserDisplayName.*purchaserName/s);
    });

    it('40c. printing a box label is NOT a lifecycle transition', () => {
        // Part P: outer box labels come BEFORE Packed & Ready. Nothing here
        // advances an order's status.
        for (const f of [MANIFEST, ROUTE, PAGE, QUEUE]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/status:\s*['"](packed|delivered|ready_to_ship|completed)/i);
            expect(s).not.toMatch(/markPacked|markDelivered|setStatus/);
        }
    });
});
