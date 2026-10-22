/**
 * PROD-PACKED-READY-NAME-1 — a fundraiser order in Packed & Ready is titled by its
 * SUPPORTER, never by the organization.
 *
 * THE OBSERVED DEFECT
 * Rows for "Edgar County Farm Bureau" appeared in Production -> Packed & Ready where
 * the individual's name belongs, while the box labels printed from the same orders
 * were correct. READ-ONLY Production calibration (25 Packed & Ready orders, all
 * fundraiser) proved the cause: the lane titled each row `customer.name ||
 * customer_name`, and the 15 coordinator "+ Add Order" orders link `customer_id` to
 * the campaign's ORGANIZATION (first/last unset, supporter only in customer_name),
 * while the 10 public supporter orders link their own Customer. The label resolver
 * reads order-time identity only, so it was right for both.
 *
 * WHAT THIS SUITE PROVES
 *   - the lane and the label name the same person, through the REAL dashboard
 *     route, the REAL DeliveryQueue component and the REAL box-labels route;
 *   - the organization never replaces a person (even when both are populated, and
 *     even when nothing else is known);
 *   - ordinary orders are titled exactly as before;
 *   - nothing but the title text changed: counts, bundles, selection, Send to
 *     Delivery, the Production query and every label file are untouched.
 *
 * Every order below is FICTIONAL.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    resolveOrderRecipientName,
    UNKNOWN_SUPPORTER_LABEL,
    UNKNOWN_CUSTOMER_LABEL,
} from '@/lib/orderRecipientName';
import { resolveSupporterName } from '@/lib/supporterBoxManifest';
import { summarizeItemPacking } from '@/lib/physicalBoxPacking';
import { toDbOrderStatusReadCandidates } from '@/lib/orderStatus';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const QUEUE = 'components/production/DeliveryQueue.tsx';
const HELPER = 'lib/orderRecipientName.ts';
const DASH = 'app/api/production/dashboard/route.ts';
const LABEL_ROUTE = 'app/api/production/box-labels/route.ts';
const LABEL_PAGE = 'app/production/box-labels/page.tsx';
const MANIFEST = 'lib/supporterBoxManifest.ts';
const PACKING = 'lib/physicalBoxPacking.ts';
const HANDOFF = 'app/api/delivery/handoff/route.ts';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, back: () => {} }) }));

let mockAuth: () => any;
const dashboardCalls: any[] = [];
const mockStore: { rows: any[] } = { rows: [] };

/** Apply Prisma's top-level `select` the way Prisma does: a select returns ONLY the listed scalars. */
const shape = (row: any, args: any) => {
    if (!args?.select) return row; // `include` ships every scalar plus the named relations
    const out: any = {};
    for (const [k, v] of Object.entries(args.select)) if (v) out[k] = row[k];
    return out;
};

const mockPrisma: any = {
    order: {
        findMany: (args: any) => {
            const where = args?.where || {};
            dashboardCalls.push(args);
            const live = mockStore.rows.filter((o) => o.business_id === where.business_id && o.canceled_at === null);
            // Production's Packed & Ready lane: released_to_delivery_at NULL + ready_to_ship/completed.
            if (where.released_to_delivery_at === null && Array.isArray(where.status?.in)) {
                return Promise.resolve(live
                    .filter((o) => where.status.in.includes(o.status) && o.released_to_delivery_at === null)
                    .map((o) => shape(o, args)));
            }
            // The box-label route: tenant-scoped, by id.
            if (where.id?.in) {
                return Promise.resolve(live.filter((o) => where.id.in.includes(o.id)).map((o) => shape(o, args)));
            }
            return Promise.resolve([]); // New Orders / To Prep / Fundraisers Waiting: not under test here
        },
    },
};
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));
jest.mock('@/lib/db', () => ({ prisma: mockPrisma }));

// ── Fictional orders, in the three REAL shapes ─────────────────────────────────
const BIZ = 'biz-fixture';
const ORG_ID = 'cust-org-edgar';
const ORG_NAME = 'Edgar County Farm Bureau Test Fixture';
const CAMPAIGN = 'camp-edgar-test';

let n = 0;
const item = (sku: string, quantity = 1, variant = 'serves_2') => {
    n += 1;
    return {
        id: `oi-${n}`, order_id: 'x', bundle_id: `b-${sku}`, quantity, variant_size: variant, item_name: `Bundle ${sku}`,
        unit_price: '65.00', is_subscription: false, bundle: { id: `b-${sku}`, name: `Bundle ${sku}`, sku },
    };
};
const base = (id: string, over: any = {}) => ({
    id, business_id: BIZ, external_id: `ext-${id}`, status: 'ready_to_ship', released_to_delivery_at: null, canceled_at: null,
    created_at: '2026-10-05T15:00:00.000Z', delivery_address: null, participant_name: null,
    source: 'fundraiser', campaign_id: CAMPAIGN,
    campaign: { name: 'Fall Fundraiser (fictional)', customer: { name: ORG_NAME } },
    items: [item('MEAL-A')],
    ...over,
});
/** public supporter order: own Customer, first/last written (ord_… path). */
const online = (id: string, first: string, last: string, over: any = {}) => base(id, {
    customer_id: `cust-${id}`, first_name: first, last_name: last, customer_name: `${first} ${last}`,
    customer: { name: `${first} ${last}`, type: 'direct_customer', delivery_address: null }, ...over,
});
/** coordinator "+ Add Order": customer_id = the ORGANIZATION; only customer_name carries the person. */
const manual = (id: string, person: string | null, over: any = {}) => base(id, {
    customer_id: ORG_ID, first_name: null, last_name: null, customer_name: person,
    customer: { name: ORG_NAME, type: 'organization', delivery_address: null }, ...over,
});
/** ordinary direct customer order (no campaign, not source fundraiser). */
const ordinary = (id: string, over: any = {}) => base(id, {
    source: 'manual', campaign_id: null, campaign: null, first_name: null, last_name: null,
    customer_id: `cust-${id}`, customer_name: 'Order-time Name', customer: { name: 'CRM Customer', type: 'direct_customer', delivery_address: null },
    ...over,
});

// ── real route + real component ────────────────────────────────────────────────
const getDashboard = async () => {
    const { GET } = require('@/app/api/production/dashboard/route');
    const res = await GET();
    expect(res.status).toBe(200);
    return res.json();
};
const postLabels = async (orderIds: string[]) => {
    const { POST } = require('@/app/api/production/box-labels/route');
    const res = await POST(new Request('https://x/api/production/box-labels', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderIds }),
    }));
    expect(res.status).toBe(200);
    return res.json();
};
const renderLane = (orders: any[]): string => {
    const DeliveryQueue = require('@/components/production/DeliveryQueue').default;
    return renderToStaticMarkup(createElement(DeliveryQueue, { orders, onRefresh: () => {} }));
};
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** The title (<h4>) of every row, in order. */
const titles = (html: string): string[] =>
    Array.from(html.matchAll(/<h4 class="font-black text-slate-900 dark:text-white text-lg">([\s\S]*?)<\/h4>/g)).map((m) => decode(m[1]));
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const withoutTitles = (html: string) =>
    html.replace(/(<h4 class="font-black text-slate-900 dark:text-white text-lg">)[\s\S]*?(<\/h4>)/g, '$1$2');

beforeEach(() => {
    dashboardCalls.length = 0;
    mockAuth = () => ({ user: { businessId: BIZ } });
    n = 0;
});

// ═════════════════════════════════════════════════════════════════════════════
// 1-4. THE FIX, THROUGH THE REAL ROUTE AND THE REAL COMPONENT.
// ═════════════════════════════════════════════════════════════════════════════
describe('1-4. Packed & Ready titles a fundraiser order by its supporter', () => {
    it('1. an online fundraiser supporter order shows the individual', async () => {
        mockStore.rows = [online('ord-online-1', 'Dana', 'Placeholder')];
        const lane = await getDashboard();
        expect(titles(renderLane(lane.completed))).toEqual(['Dana Placeholder']);
    });

    it('2. a manually entered fundraiser order shows the individual, not the organization', async () => {
        mockStore.rows = [manual('ord-manual-1', 'Sloan Example')];
        const lane = await getDashboard();
        // The Customer relation on this row IS the organization — the premise of the defect.
        expect(lane.completed[0].customer.name).toBe(ORG_NAME);
        expect(titles(renderLane(lane.completed))).toEqual(['Sloan Example']);
    });

    it('3. the organization never replaces a supporter — across a mixed lane', async () => {
        mockStore.rows = [
            manual('ord-m1', 'Avery Testwell'), online('ord-o1', 'Jordan', 'Sample'), manual('ord-m2', 'Wren Fictional'),
            online('ord-o2', 'Harper', 'Demoson'), manual('ord-m3', 'Dakota Mockford'),
        ];
        const lane = await getDashboard();
        const t = titles(renderLane(lane.completed));
        expect(t.sort()).toEqual(['Avery Testwell', 'Dakota Mockford', 'Harper Demoson', 'Jordan Sample', 'Wren Fictional']);
        expect(t.some((x) => x.includes('Farm Bureau'))).toBe(false);
        // REVISED BY PACKED-READY-WAVES-1. This used to assert the organization appears
        // NOWHERE in the lane. The defect was the organization standing in for a PERSON, and
        // that is still pinned above (no title contains it). The lane now also states which
        // fundraiser a row belongs to, as secondary context under the supporter — so the
        // claim is scoped: outside the explicit "Fundraiser:" row line and the fundraiser
        // quick-select panel (which labels each fundraiser by its organization) the
        // organization still appears nowhere, and no row's title is the organization.
        const html = renderLane(lane.completed);
        const outsideFundraiserContext = html
            .replace(/<div[^>]*data-fundraiser-line="row"[^>]*>[\s\S]*?<\/div>/g, '')
            .replace(/<section aria-label="Fundraisers in Packed &amp; Ready"[\s\S]*?<\/section>/g, '');
        expect(text(outsideFundraiserContext)).not.toContain(ORG_NAME);
        expect(text(html)).toContain(`Fundraiser: ${ORG_NAME}`);
        // ...and a row line sits under EACH of the five supporters, never in place of one.
        expect((html.match(/data-fundraiser-line="row"/g) || []).length).toBe(5);
    });

    it('4. supporter AND organization both populated — the supporter wins as the primary name', () => {
        const o: any = manual('ord-both', 'Marley Trialson');
        expect(o.customer.name).toBe(ORG_NAME);          // organization is populated...
        expect(o.customer_name).toBe('Marley Trialson');    // ...and so is the supporter
        expect(resolveOrderRecipientName(o)).toBe('Marley Trialson');
        // Order-time first/last outrank the scalar when both exist.
        expect(resolveOrderRecipientName({ ...o, first_name: 'Marlene', last_name: 'Trialson' })).toBe('Marlene Trialson');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. LANE == LABEL.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. the lane and the box label name the same person', () => {
    it('5. for every fundraiser order, lane title === label supporterName (real routes, same rows)', async () => {
        mockStore.rows = [
            manual('ord-1', 'Dana Placeholder'), manual('ord-2', 'Sloan Example'), online('ord-3', 'Morgan', 'Notreal'),
            online('ord-4', 'Vesper', 'Specimen', { customer: { name: 'Vesper Specimen (renamed in CRM)', type: 'direct_customer', delivery_address: null } }),
            manual('ord-5', "Jules O'Standin"),
            // historical: predates first/last, still a per-supporter Customer
            base('ord-6', { customer_id: 'cust-old', first_name: null, last_name: null, customer_name: 'Sasha Proto', customer: { name: 'Sasha Proto', type: 'direct_customer', delivery_address: null } }),
        ];
        const lane = await getDashboard();
        const laneTitles = titles(renderLane(lane.completed));
        const labels = await postLabels(lane.completed.map((o: any) => o.id));
        expect(labels.blocked).toEqual([]);
        const labelNameByOrder = new Map<string, string>(labels.boxes.map((b: any) => [b.orderId, b.supporterName]));
        lane.completed.forEach((o: any, i: number) => {
            expect(laneTitles[i]).toBe(labelNameByOrder.get(o.id));
            expect(laneTitles[i]).toBe(resolveSupporterName(o)); // and it is the label resolver's own answer
        });
        // Every label still carries the organization ABOVE the person — the lane does not.
        for (const b of labels.boxes) expect(b.organizationName).toBe(ORG_NAME);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. ORDINARY ORDERS ARE UNCHANGED.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. ordinary orders are titled exactly as before', () => {
    const OLD = (o: any) => o.customer?.name || o.customer_name || 'Unknown Customer'; // the pre-fix expression, verbatim

    it('6a. the CRM customer name still wins, then customer_name, then "Unknown Customer"', () => {
        expect(resolveOrderRecipientName(ordinary('o1'))).toBe('CRM Customer');
        expect(resolveOrderRecipientName(ordinary('o2', { customer: null }))).toBe('Order-time Name');
        expect(resolveOrderRecipientName(ordinary('o3', { customer: null, customer_name: null }))).toBe(UNKNOWN_CUSTOMER_LABEL);
        expect(resolveOrderRecipientName(ordinary('o4', { customer: { name: '', type: 'x' }, customer_name: '' }))).toBe('Unknown Customer');
    });

    it('6b. byte-for-byte the old expression across ordinary shapes', () => {
        const shapes: any[] = [
            ordinary('a'), ordinary('b', { customer: null }), ordinary('c', { customer: null, customer_name: null }),
            ordinary('d', { source: 'storefront' }), ordinary('e', { source: 'qbo' }), ordinary('f', { source: 'manual', customer_name: 'X' }),
            // Not provably fundraiser: ONE signal only -> existing behaviour, NOT the fundraiser rule.
            base('g', { source: 'fundraiser', campaign_id: null, customer: { name: 'Org-like Customer', type: 'organization' }, customer_name: 'Someone' }),
            base('h', { source: 'manual', campaign_id: 'camp-x', customer: { name: 'Org-like Customer', type: 'organization' }, customer_name: 'Someone' }),
            base('i', { source: 'fundraiser', campaign_id: '   ', customer: { name: 'Org-like Customer', type: 'organization' }, customer_name: 'Someone' }),
        ];
        for (const s of shapes) expect(resolveOrderRecipientName(s)).toBe(OLD(s));
    });

    it('6c. through the real lane: an ordinary order beside fundraiser orders keeps its customer title', async () => {
        mockStore.rows = [ordinary('ord-ord'), manual('ord-man', 'Blair Madeup'), online('ord-onl', 'Lane', 'Imagine')];
        const lane = await getDashboard();
        expect(titles(renderLane(lane.completed))).toEqual(['CRM Customer', 'Blair Madeup', 'Lane Imagine']);
    });

    it('6d. fundraiser-specific logic cannot leak: the helper only reads names, and only asks the one canonical question', () => {
        const src = strip(read(HELPER));
        expect(src).toMatch(/isFundraiserFulfillmentOrder\(order\)/);
        expect(src).not.toMatch(/organization|campaign\.customer|customer\.type|\.type\b/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7-8. NO PROVABLE NAME; HISTORICAL ROWS.
// ═════════════════════════════════════════════════════════════════════════════
describe('7-8. missing names and historical orders', () => {
    it('7. a fundraiser order with no provable supporter name shows a neutral fallback, never the organization', () => {
        for (const o of [
            manual('m', null), manual('m2', ''), manual('m3', '   '),
            manual('m4', 'Guest'), manual('m5', 'Unknown'), manual('m6', 'Unknown Customer'), manual('m7', 'N/A'),
            online('o', '', '', { customer_name: null }),
        ] as any[]) {
            const r = resolveOrderRecipientName(o);
            expect(r).toBe(UNKNOWN_SUPPORTER_LABEL);
            expect(r).not.toContain('Farm Bureau');
            expect(r).not.toBe(o.customer?.name);
        }
        expect(UNKNOWN_SUPPORTER_LABEL).toBe('Unknown Supporter');
    });

    it('7b. the same order is BLOCKED on the label, and the lane stays neutral (consistent, not contradictory)', async () => {
        mockStore.rows = [manual('ord-nameless', null)];
        const lane = await getDashboard();
        expect(titles(renderLane(lane.completed))).toEqual(['Unknown Supporter']);
        const labels = await postLabels(['ord-nameless']);
        expect(labels.boxes).toEqual([]);
        expect(labels.blocked).toHaveLength(1);
    });

    it('8. a historical fundraiser order (no first/last) follows the same rule', async () => {
        mockStore.rows = [
            base('ord-hist-1', { customer_id: ORG_ID, first_name: null, last_name: null, customer_name: 'Kit Fakeman', customer: { name: ORG_NAME, type: 'organization', delivery_address: null }, created_at: '2025-03-02T10:00:00.000Z' }),
            base('ord-hist-2', { customer_id: 'cust-hist2', first_name: null, last_name: null, customer_name: 'Finley Stand-In', customer: { name: 'Finley Stand-In', type: 'direct_customer', delivery_address: null }, created_at: '2025-03-03T10:00:00.000Z' }),
        ];
        const lane = await getDashboard();
        expect(titles(renderLane(lane.completed))).toEqual(['Kit Fakeman', 'Finley Stand-In']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9-13. NOTHING BUT THE TITLE CHANGED.
// ═════════════════════════════════════════════════════════════════════════════
describe('9-13. nothing but the title changed', () => {
    const lane = async () => {
        mockStore.rows = [
            manual('ord-a', 'Shiloh Pretend', { items: [item('SKU-1', 3, 'serves_2'), item('SKU-2', 1, 'serves_5')] }),
            online('ord-b', 'Lark', 'Faux', { items: [item('SKU-3', 2, 'serves_2')] }),
            ordinary('ord-c', { items: [item('SKU-4', 1, 'serves_5')] }),
        ];
        return (await getDashboard()).completed as any[];
    };

    it('9/10/11. box counts, order count and bundle chips are exactly what the packing authority and the rows say', async () => {
        const orders = await lane();
        const html = renderLane(orders);
        const packing = summarizeItemPacking(orders as any);
        expect(text(html)).toContain(
            `${orders.length} orders · ${packing.purchasedBundleCount} bundles · ${packing.physicalBoxCount} physical boxes (${packing.largeBoxCount} large · ${packing.smallBoxCount} small)`,
        );
        expect(orders).toHaveLength(3);
        expect(titles(html)).toHaveLength(3);
        for (const sku of ['3x SKU-1', '1x SKU-2', '2x SKU-3', '1x SKU-4']) expect(html).toContain(sku);
    });

    it('9/10/11b. changing every NAME changes only the titles — the rest of the lane is byte-identical', async () => {
        const orders = await lane();
        const scrambled = orders.map((o: any, i: number) => ({
            ...o, first_name: o.first_name ? `F${i}` : null, last_name: o.last_name ? `L${i}` : null,
            customer_name: o.customer_name ? `Name ${i}` : null, customer: o.customer ? { ...o.customer, name: `Customer ${i}` } : null,
        }));
        expect(withoutTitles(renderLane(scrambled))).toBe(withoutTitles(renderLane(orders)));
        expect(titles(renderLane(scrambled))).not.toEqual(titles(renderLane(orders)));
    });

    it('12. Send to Delivery eligibility is unchanged — the lane query and the handoff are untouched', async () => {
        mockStore.rows = [manual('ord-a', 'Jules Mock')];
        await getDashboard();
        const completedQuery = dashboardCalls.find((a) => a?.where?.released_to_delivery_at === null);
        expect(completedQuery.where).toEqual({
            business_id: BIZ,
            canceled_at: null,
            released_to_delivery_at: null,
            status: { in: [...new Set([...toDbOrderStatusReadCandidates('completed'), ...toDbOrderStatusReadCandidates('ready_to_ship')])] },
            NOT: { status: 'fundraiser_hold' },
        });
        // Still an include (every Order scalar rides along) + the customer relation ordinary orders need.
        expect(completedQuery.select).toBeUndefined();
        expect(completedQuery.include.customer.select).toEqual({ name: true, type: true, delivery_address: true });
        expect(completedQuery.include.items).toBeDefined();
        // The handoff route is the sole writer and does not know this rule exists.
        const handoff = strip(read(HANDOFF));
        expect(handoff).not.toMatch(/orderRecipientName/);
        expect(handoff).toMatch(/released_to_delivery_at: releasedAt/);
        // The lane still sends order ids and nothing else.
        const q = strip(read(QUEUE));
        expect(q).toMatch(/fetch\('\/api\/delivery\/handoff'/);
        expect(q).toMatch(/body: JSON\.stringify\(\{ orderIds \}\)/);
        // REVISED BY PACKED-READY-WAVES-1. The button used to pass `selected ? picked : orders`,
        // i.e. an empty selection meant "send everything", which with several fundraisers in
        // the lane is every fundraiser at once. It now passes the pruned selection, and an
        // empty selection in a MIXED lane passes nothing (the button is also disabled); in a
        // single-population lane an empty selection is still "all", as before. What is
        // unchanged and still pinned: the route, the body (order ids only), and that the
        // server — not this UI — remains the only writer.
        expect(q).toMatch(/sendToDelivery\(hasSelection \? selectedOrders : needsExplicitSelection \? \[\] : orders\)/);
        expect(q).toMatch(/const selectedOrders = orders\.filter\(o => visibleSelected\.has\(o\.id\)\)/);
    });

    it('13. labels are unchanged — same output, and no label file knows the new rule', async () => {
        mockStore.rows = [manual('ord-a', 'Marin Samplesmith'), online('ord-b', 'Kendall', 'Dummer')];
        const labels = await postLabels(['ord-a', 'ord-b']);
        expect(labels.boxes.map((b: any) => [b.supporterName, b.organizationName, b.boxNumber, b.boxTotal, b.boxType]))
            .toEqual([['Marin Samplesmith', ORG_NAME, 1, 1, 'small'], ['Kendall Dummer', ORG_NAME, 1, 1, 'small']]);
        expect([labels.physicalBoxCount, labels.largeBoxCount, labels.smallBoxCount, labels.purchasedBundleCount]).toEqual([2, 0, 2, 2]);
        for (const f of [LABEL_ROUTE, LABEL_PAGE, MANIFEST, PACKING, 'lib/labelPresets.ts', 'lib/labelSheetLayout.ts', 'lib/labelTypography.ts', 'lib/purchaserName.ts']) {
            expect(strip(read(f))).not.toMatch(/orderRecipientName|resolveOrderRecipientName/);
        }
        // The label's resolver is exactly the one the lane calls — unmodified.
        expect(strip(read(MANIFEST))).toMatch(/export function resolveSupporterName\(order: BoxManifestOrder\): string \| null \{/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// STRUCTURE.
// ═════════════════════════════════════════════════════════════════════════════
describe('structure', () => {
    it('the rule is pure and display-only, and DeliveryQueue is its only consumer', () => {
        const src = strip(read(HELPER));
        expect(src).not.toMatch(/prisma|from ['"]react['"]|fetch\(|process\.env|\.create\(|\.update\(|\.upsert\(/);
        const importers: string[] = [];
        const walk = (dir: string) => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, e.name);
                if (e.isDirectory()) { if (!['node_modules', '.next', '.git', 'tests'].includes(e.name)) walk(full); }
                else if (/\.(ts|tsx)$/.test(e.name) && /from\s*['"][^'"]*\borderRecipientName['"]/.test(readFileSync(full, 'utf8'))) {
                    importers.push(full.slice(ROOT.length + 1).replace(/\\/g, '/'));
                }
            }
        };
        for (const r of ['app', 'components', 'lib']) walk(join(ROOT, r));
        expect(importers).toEqual([QUEUE]);
    });

    it('the lane no longer decides the title from the Customer relation', () => {
        const q = strip(read(QUEUE));
        expect(q).toMatch(/\{resolveOrderRecipientName\(order\)\}/);
        expect(q).not.toMatch(/order\.customer\?\.name \|\| order\.customer_name \|\| 'Unknown Customer'/);
    });

    it('no schema change and no new query: the helper reads Order scalars the dashboard already returns', () => {
        expect(read('prisma/schema.prisma')).not.toMatch(/recipient_name|supporter_display/i);
        const dash = strip(read(DASH));
        expect(dash).not.toMatch(/orderRecipientName|recipient/i);
    });
});
