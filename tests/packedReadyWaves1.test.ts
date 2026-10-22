/**
 * PACKED-READY-WAVES-1 — fundraiser quick-select, selection-honouring Box Labels, a
 * mixed-lane Send to Delivery guard, and the fundraiser organization on lane rows and packing
 * slips.
 *
 * AUDIT: PROD-FUNDRAISER-WAVES-AUDIT-1. At the audited Production SHA, 67 orders from four
 * fundraisers sat in ONE Packed & Ready lane. The lane showed no sign of which fundraiser a row
 * belonged to, "Box Labels — All Orders" ignored any selection, an empty selection meant "send
 * every fundraiser", and a packing slip carried only the supporter's name.
 *
 * WHAT THIS SUITE PROVES
 *   1. Grouping is by FundraiserCampaign.id and nothing else (names and dates are labels).
 *   2. Selecting a fundraiser selects exactly its Order IDs; the union of two is the union;
 *      single-order override works; nothing else moves.
 *   3. The REAL DeliveryQueue, driven through a click-by-click harness, hands exactly the
 *      selected ids to Box Labels, Packing Slips and Send to Delivery — and stores no supporter
 *      or organization text.
 *   4. A MIXED lane with nothing selected cannot print or send "everything".
 *   5. The packing slip names the campaign's owning organization — the label's own authority —
 *      identically in the pre-handoff slip and the Delivery reprint, and never from Order.customer.
 *   6. Ordinary orders are untouched. Printing is read-only.
 *
 * Every order, supporter and organization below is FICTIONAL (the repository is public).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPrismaMock, type PrismaMock } from './helpers/routeHarness';
import {
    describeLane,
    describeSelectionScope,
    formatScopeLine,
    fundraiserOrganizationFor,
    groupFundraiserWaves,
    groupWavesByDate,
    pruneSelection,
    toggleWaves,
    waveSelectionState,
    OTHER_ORDERS_LABEL,
    UNNAMED_FUNDRAISER_LABEL,
} from '@/lib/packedReadyWaves';
import { fundraiserIdentity, fundraiserIdentityText } from '@/lib/fundraiserIdentityLine';
import { BOX_LABEL_STORAGE_KEY, PACKING_SLIP_STORAGE_KEY } from '@/lib/printBatchStorage';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const QUEUE = 'components/production/DeliveryQueue.tsx';
const PANEL = 'components/production/FundraiserQuickSelect.tsx';
const LINE = 'components/production/FundraiserIdentityLine.tsx';
const SLIP_PAGE = 'app/delivery/print-packing-slips/page.tsx';
const CONTENTS = 'lib/packingSlipContents.ts';
const DASH = 'app/api/production/dashboard/route.ts';
const HANDOFF = 'app/api/delivery/handoff/route.ts';
const LABEL_ROUTE = 'app/api/production/box-labels/route.ts';
const PRE_SLIPS = 'app/api/production/packing-slips/route.ts';
const REPRINT_SLIPS = 'app/api/delivery/packing-slips/route.ts';

// ── A hook runtime small enough to drive the real DeliveryQueue without a DOM ──────────────
// (no jsdom / react-test-renderer is installed). While `mockHook` is set, useState/useMemo are
// served from per-mount slots; otherwise (renderToStaticMarkup) the real hooks run untouched.
let mockHook: { states: any[]; i: number } | null = null;
jest.mock('react', () => {
    const actual = jest.requireActual('react');
    return {
        ...actual,
        useState: (init: any) => {
            if (!mockHook) return actual.useState(init);
            const h = mockHook;
            const idx = h.i++;
            if (!(idx in h.states)) h.states[idx] = typeof init === 'function' ? init() : init;
            const set = (v: any) => { h.states[idx] = typeof v === 'function' ? v(h.states[idx]) : v; };
            return [h.states[idx], set];
        },
        useMemo: (fn: any, deps: any) => (mockHook ? fn() : actual.useMemo(fn, deps)),
    };
});

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: (u: string) => mockPush(u), back: () => {} }) }));

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__wavesPrisma; } }));
const useMock = (m: PrismaMock) => { mock = m; (global as any).__wavesPrisma = m.client; };
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

// ── Fictional fixtures ───────────────────────────────────────────────────────────────────────
const BIZ = 'biz-fixture';
const ORG_A = 'Alpha County Farm Bureau (fixture)';
const ORG_B = 'Bravo County Farm Bureau (fixture)';
const CAMP_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CAMP_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CAMP_B2 = 'cccccccc-0000-4000-8000-0000000000b2'; // a SECOND campaign owned by the same organization
const DECOY = 'DECOY ORDER CUSTOMER';

const campaign = (id: string, org: string | null, date: string | null, name = `${org ?? 'Unnamed'} Fundraiser`) => ({
    id, name, delivery_date: date, customer: org === null ? null : { name: org },
});
const CA = campaign(CAMP_A, ORG_A, '2026-10-21T00:00:00.000Z');
const CB = campaign(CAMP_B, ORG_B, '2026-10-27T00:00:00.000Z');
const CB2 = campaign(CAMP_B2, ORG_B, '2026-10-27T00:00:00.000Z', 'Bravo second campaign');

let n = 0;
const lineItem = (variant = 'serves_5') => {
    n += 1;
    return {
        id: `oi-${n}`, bundle_id: 'b-1', quantity: 1, variant_size: variant, item_name: 'Comfort Foods',
        bundle: { id: 'b-1', name: 'Comfort Foods', sku: 'CF', contents: [{ quantity: 2, recipe: { name: 'Lasagna' } }] },
    };
};
/** A fundraiser order. Its OWN Customer relation is a decoy: it must never be the organization shown. */
const fr = (id: string, camp: any, over: any = {}) => ({
    id, business_id: BIZ, status: 'ready_to_ship', released_to_delivery_at: null, canceled_at: null,
    created_at: '2026-10-05T15:00:00.000Z', source: 'fundraiser', campaign_id: camp.id, campaign: camp,
    first_name: `Pat-${id}`, last_name: 'Example', customer_name: `Pat-${id} Example`,
    customer_id: 'cust-decoy', customer: { name: DECOY, type: 'organization', delivery_address: null },
    delivery_date: null, delivery_sequence: 0, items: [lineItem()], ...over,
});
const plain = (id: string, over: any = {}) => ({
    id, business_id: BIZ, status: 'ready_to_ship', released_to_delivery_at: null, canceled_at: null,
    created_at: '2026-10-05T15:00:00.000Z', source: 'manual', campaign_id: null, campaign: null,
    first_name: null, last_name: null, customer_name: 'Ordinary Buyer',
    customer: { name: 'Ordinary Customer Co', type: 'direct_customer', delivery_address: '1 Fixture Way' },
    delivery_date: null, delivery_sequence: 0, items: [lineItem()], ...over,
});

const A = [fr('a1', CA), fr('a2', CA), fr('a3', CA)];
const B = [fr('b1', CB), fr('b2', CB)];
const B2 = [fr('c1', CB2)];
const ORD = [plain('o1'), plain('o2')];
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const sorted = (xs: Iterable<string>) => [...xs].sort();

beforeEach(() => {
    jest.clearAllMocks();
    n = 0;
    mockAuth.mockResolvedValue({ user: { id: 'u-1', businessId: BIZ } });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. GROUPING — FundraiserCampaign.id, nothing else
// ═════════════════════════════════════════════════════════════════════════════
describe('1. fundraiser grouping is keyed by Campaign.id', () => {
    it('1a. one wave per campaign, carrying exactly that campaign\'s order ids in lane order', () => {
        const waves = groupFundraiserWaves([...A, ...B, ...ORD]);
        expect(waves.map((w) => w.campaignId)).toEqual([CAMP_A, CAMP_B]);
        expect(waves[0].orderIds).toEqual(['a1', 'a2', 'a3']);
        expect(waves[1].orderIds).toEqual(['b1', 'b2']);
    });

    it('1b. two campaigns of the SAME organization stay two waves (never grouped by organization)', () => {
        const waves = groupFundraiserWaves([...B, ...B2]);
        expect(waves).toHaveLength(2);
        expect(waves.map((w) => w.campaignId).sort()).toEqual([CAMP_B, CAMP_B2].sort());
        expect(waves[0].label).toBe(ORG_B);
        expect(waves[1].label).toBe(ORG_B);
    });

    it('1c. same organization AND same delivery date: still two waves, told apart by a campaign tag', () => {
        const waves = groupFundraiserWaves([...B, ...B2]);
        expect(waves[0].deliveryDate).toBe(waves[1].deliveryDate);
        expect(waves.every((w) => w.disambiguator !== null)).toBe(true);
        expect(new Set(waves.map((w) => w.disambiguator)).size).toBe(2);
        // The tag is a slice of the REAL key, shown only because the two would read identically.
        for (const w of waves) expect(w.campaignId.startsWith(w.disambiguator as string)).toBe(true);
    });

    it('1c2. the tag is lengthened until it is unique, even when the ids share a long prefix', () => {
        const p = campaign('11111111-2222-4333-8444-555555555501', ORG_A, '2026-10-21T00:00:00.000Z');
        const q = campaign('11111111-2222-4333-8444-555555555502', ORG_A, '2026-10-21T00:00:00.000Z');
        const r = campaign('99999999-2222-4333-8444-555555555503', ORG_A, '2026-10-21T00:00:00.000Z');
        const tags = groupFundraiserWaves([fr('p1', p), fr('q1', q), fr('r1', r)]).map((w) => w.disambiguator);
        expect(tags.every((t) => typeof t === 'string')).toBe(true);
        expect(new Set(tags).size).toBe(3); // three chips that can never look alike
    });

    it('1d. distinct organizations get no tag (it appears only when needed)', () => {
        const waves = groupFundraiserWaves([...A, ...B]);
        expect(waves.every((w) => w.disambiguator === null)).toBe(true);
    });

    it('1e. a name collision between DIFFERENT campaigns never merges them', () => {
        const x = campaign('camp-x', 'Same Name Org', '2026-10-21T00:00:00.000Z');
        const y = campaign('camp-y', 'Same Name Org', '2026-11-04T00:00:00.000Z');
        const waves = groupFundraiserWaves([fr('x1', x), fr('y1', y), fr('x2', x)]);
        expect(waves.map((w) => [w.campaignId, w.orderIds])).toEqual([['camp-x', ['x1', 'x2']], ['camp-y', ['y1']]]);
    });

    it('1f. membership uses the two fundraiser signals only — the joined campaign object cannot create a wave', () => {
        const campaignOnly = { ...plain('anomaly1'), campaign: CA };                    // has a campaign object, no signals
        const sourceOnly = { ...plain('anomaly2'), source: 'fundraiser', campaign_id: null };
        const blankId = { ...fr('anomaly3', CA), campaign_id: '   ' };
        // The classifier's own "ambiguous" shape: a campaign_id on a row whose source is NOT 'fundraiser'.
        const campaignIdOnly = { ...fr('anomaly4', CA), source: 'manual' };
        const waves = groupFundraiserWaves([campaignOnly, sourceOnly, blankId, campaignIdOnly, ...A]);
        expect(waves).toHaveLength(1);
        expect(waves[0].orderIds).toEqual(['a1', 'a2', 'a3']);
        // Such a row is never guessed into a fundraiser: it stays with the other orders and gets no
        // fundraiser line, exactly as lib/orderRecipientName.ts already treats it.
        expect(describeLane([campaignIdOnly, ...A]).otherOrderIds).toEqual(['anomaly4']);
        expect(fundraiserOrganizationFor(campaignIdOnly)).toBeNull();
        expect(html([campaignIdOnly])).not.toContain('data-fundraiser-line');
    });

    it('1g. ordinary orders are never given a fake fundraiser wave', () => {
        expect(groupFundraiserWaves(ORD)).toEqual([]);
        expect(describeLane(ORD)).toEqual({ waves: [], otherOrderIds: ['o1', 'o2'], groupCount: 1, mixed: false });
    });

    it('1h. waves sort by delivery date (earliest first), undated last, then label, then id', () => {
        const late = campaign('camp-late', 'Zulu Org', '2026-11-10T00:00:00.000Z');
        const none = campaign('camp-none', 'Mike Org', null);
        const waves = groupFundraiserWaves([fr('l1', late), fr('n1', none), ...B, ...A]);
        expect(waves.map((w) => w.campaignId)).toEqual([CAMP_A, CAMP_B, 'camp-late', 'camp-none']);
    });

    it('1i. dates are read as CALENDAR dates, never shifted by the viewer\'s timezone', () => {
        const savedTZ = process.env.TZ;
        try {
            for (const tz of ['America/Los_Angeles', 'America/Chicago', 'UTC', 'Pacific/Auckland']) {
                process.env.TZ = tz;
                const waves = groupFundraiserWaves(A);
                expect(waves[0].deliveryDate).toBe('2026-10-21');
                expect(waves[0].deliveryDateLabel).toBe('Oct 21, 2026');
                expect(groupFundraiserWaves([fr('d1', campaign('c', 'Org', '2026-01-01T00:00:00.000Z'))])[0].deliveryDateLabel).toBe('Jan 1, 2026');
                expect(groupFundraiserWaves([fr('d2', campaign('c', 'Org', '2026-12-31T00:00:00.000Z'))])[0].deliveryDateLabel).toBe('Dec 31, 2026');
            }
            // The trap this guards against is REAL on this machine: a stored DATE is midnight UTC,
            // so a local-zone render in the Americas reads the PREVIOUS day.
            process.env.TZ = 'America/Los_Angeles';
            expect(new Date('2026-10-21T00:00:00.000Z').getDate()).toBe(20);
        } finally {
            if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
        }
    });

    it('1j. the delivery date comes from Campaign.delivery_date — never from closeout, invoice or order dates', () => {
        const row: any = fr('t1', { ...CA, delivery_date: '2026-10-21T00:00:00.000Z', end_date: '2026-01-01', closed_at: '2026-02-02', paid_at: '2026-03-03' });
        row.created_at = '2025-05-05T00:00:00.000Z';
        row.delivery_date = '2027-07-07T00:00:00.000Z'; // the ORDER's own date column: also ignored
        expect(groupFundraiserWaves([row])[0].deliveryDate).toBe('2026-10-21');
        const src = strip(read('lib/packedReadyWaves.ts'));
        expect(src).not.toMatch(/end_date|closed_at|paid_at|created_at/);
    });

    it('1k. an undated or unreadable delivery date yields no date and no crash', () => {
        for (const bad of [null, undefined, '', 'not-a-date']) {
            const w = groupFundraiserWaves([fr('u1', campaign('cu', 'Org', bad as any))])[0];
            expect(w.deliveryDate).toBeNull();
            expect(w.deliveryDateLabel).toBeNull();
        }
    });

    it('1l. a campaign with no organization falls back to its own name, then to a neutral label — never blank', () => {
        const byName = campaign('cn', null, '2026-10-21T00:00:00.000Z', 'Spring Drive');
        expect(groupFundraiserWaves([fr('n1', byName)])[0].label).toBe('Spring Drive');
        const bare = campaign('cb', null, '2026-10-21T00:00:00.000Z', '   ');
        expect(groupFundraiserWaves([fr('n2', bare)])[0].label).toBe(UNNAMED_FUNDRAISER_LABEL);
    });

    it('1m. the date headings group waves by delivery date', () => {
        const groups = groupWavesByDate(groupFundraiserWaves([...A, ...B, ...B2]));
        expect(groups.map((g) => [g.dateKey, g.waves.length])).toEqual([['2026-10-21', 1], ['2026-10-27', 2]]);
    });

    it('1n. the grouping module is pure and never treats text as authority', () => {
        const src = strip(read('lib/packedReadyWaves.ts'));
        expect(src).not.toMatch(/prisma|from ['"]react['"]|fetch\(|process\.env|localStorage|\.create\(|\.update\(/);
        // The key is campaign_id; the organization name/customer id are display-only.
        expect(src).toMatch(/byCampaign = new Map<string, FundraiserWave>\(\)/);
        expect(src).not.toMatch(/customer_id/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. SELECTION — a layer over Set<Order.id>
// ═════════════════════════════════════════════════════════════════════════════
describe('2. quick-select edits exactly the right order ids', () => {
    const lane = [...A, ...B, ...B2, ...ORD];
    const waves = groupFundraiserWaves(lane);
    const waveA = waves.find((w) => w.campaignId === CAMP_A)!;
    const waveB = waves.find((w) => w.campaignId === CAMP_B)!;

    it('2a. selecting campaign A selects exactly A\'s ids — not B\'s, not ordinary', () => {
        const next = toggleWaves(new Set(), [waveA]);
        expect(sorted(next)).toEqual(['a1', 'a2', 'a3']);
    });

    it('2b. selecting A then B is the union', () => {
        const next = toggleWaves(toggleWaves(new Set(), [waveA]), [waveB]);
        expect(sorted(next)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
    });

    it('2c. toggling a fully selected campaign removes ONLY its ids and keeps everything else', () => {
        const start = new Set(['a1', 'a2', 'a3', 'b1', 'o1']);
        const next = toggleWaves(start, [waveA]);
        expect(sorted(next)).toEqual(['b1', 'o1']);
        expect(sorted(start)).toEqual(['a1', 'a2', 'a3', 'b1', 'o1']); // input never mutated
    });

    it('2d. a partially selected campaign completes on the next toggle (individual override first, then fill)', () => {
        const partial = new Set(['a1']);
        expect(waveSelectionState([waveA], partial)).toBe('some');
        expect(sorted(toggleWaves(partial, [waveA]))).toEqual(['a1', 'a2', 'a3']);
    });

    it('2e. unticking one order after selecting a campaign removes only that order', () => {
        const all = toggleWaves(new Set(), [waveA]);
        all.delete('a2'); // what the per-order checkbox does
        expect(sorted(all)).toEqual(['a1', 'a3']);
        expect(waveSelectionState([waveA], all)).toBe('some');
    });

    it('2f. the state is none / some / all, and an empty wave list is none', () => {
        expect(waveSelectionState([waveA], new Set())).toBe('none');
        expect(waveSelectionState([waveA], new Set(['a1', 'a2', 'a3']))).toBe('all');
        expect(waveSelectionState([], new Set(['a1']))).toBe('none');
        expect(waveSelectionState([waveA], new Set(['b1']))).toBe('none');
    });

    it('2g. "select all for this date" is the union of exactly that date\'s campaigns', () => {
        const date27 = groupWavesByDate(waves).find((g) => g.dateKey === '2026-10-27')!;
        expect(date27.waves).toHaveLength(2);
        expect(sorted(toggleWaves(new Set(), date27.waves))).toEqual(['b1', 'b2', 'c1']);
        // and it does not reach the Oct 21 campaign
        expect(toggleWaves(new Set(), date27.waves).has('a1')).toBe(false);
    });

    it('2h. a stale id (an order that left the lane) is pruned, never carried forward', () => {
        const pruned = pruneSelection(new Set(['a1', 'ghost-order', 'b1']), lane);
        expect(sorted(pruned)).toEqual(['a1', 'b1']);
    });

    it('2i. ordinary orders stay individually selectable and are untouched by fundraiser toggles', () => {
        const withOrdinary = new Set(['o1']);
        expect(sorted(toggleWaves(withOrdinary, [waveA]))).toEqual(['a1', 'a2', 'a3', 'o1']);
        expect(sorted(toggleWaves(toggleWaves(withOrdinary, [waveA]), [waveA]))).toEqual(['o1']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE REAL LANE, CLICK BY CLICK
// ═════════════════════════════════════════════════════════════════════════════
type Tree = any;
const walk = (node: any, visit: (el: any) => void) => {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return;
    if (Array.isArray(node)) { node.forEach((c) => walk(c, visit)); return; }
    if (typeof node === 'object' && node.props !== undefined) {
        if (typeof node.type === 'function') { walk(node.type(node.props), visit); return; } // hookless presentational components
        visit(node);
        walk(node.props.children, visit);
    }
};
const textOf = (node: any): string => {
    let out = '';
    const go = (x: any) => {
        if (x === null || x === undefined || typeof x === 'boolean') return;
        if (typeof x === 'string' || typeof x === 'number') { out += String(x); return; }
        if (Array.isArray(x)) { x.forEach(go); return; }
        if (typeof x === 'object' && x.props !== undefined) go(typeof x.type === 'function' ? x.type(x.props) : x.props.children);
    };
    go(node);
    return out.replace(/\s+/g, ' ').trim();
};
const findAll = (tree: Tree, pred: (el: any) => boolean): any[] => { const hits: any[] = []; walk(tree, (el) => { if (pred(el)) hits.push(el); }); return hits; };
const button = (tree: Tree, re: RegExp) => {
    const hits = findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
    if (hits.length !== 1) throw new Error(`expected exactly one button matching ${re}, found ${hits.length}`);
    return hits[0];
};
const maybeButton = (tree: Tree, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)))[0];
const chip = (tree: Tree, labelFragment: string) => {
    const hits = findAll(tree, (el) => el.type === 'button' && el.props.role === 'checkbox' && textOf(el.props.children).includes(labelFragment));
    if (hits.length !== 1) throw new Error(`expected one chip for ${labelFragment}, found ${hits.length}`);
    return hits[0];
};
const orderCheckbox = (tree: Tree, orderId: string) => {
    const hits = findAll(tree, (el) => el.type === 'input' && el.props['aria-label'] === `Select order ${orderId.slice(0, 8)}`);
    if (hits.length !== 1) throw new Error(`expected one checkbox for ${orderId}, found ${hits.length}`);
    return hits[0];
};

// Browser globals the handlers touch.
const store = new Map<string, string>();
const fetchLog: { url: string; body: any }[] = [];
const confirmLog: string[] = [];
let confirmAnswer = true;
beforeEach(() => {
    store.clear(); fetchLog.length = 0; confirmLog.length = 0; confirmAnswer = true; mockPush.mockClear();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
    });
    (globalThis as any).confirm = (m: string) => { confirmLog.push(m); return confirmAnswer; };
    (globalThis as any).fetch = async (url: string, init?: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        fetchLog.push({ url, body });
        if (url === '/api/tenant/identity') return { ok: true, status: 200, json: async () => ({ businessId: BIZ }) };
        if (url === '/api/delivery/handoff') return { ok: true, status: 200, json: async () => ({ released: body.orderIds.length, unchanged: 0, shortages: [] }) };
        throw new Error(`unexpected fetch ${url}`);
    };
});

function mount(initial: any[]) {
    const DeliveryQueue = require('@/components/production/DeliveryQueue').default;
    const ctx = { states: [] as any[], i: 0 };
    let props: any = { orders: initial, onRefresh: jest.fn() };
    let tree: Tree;
    const render = () => { ctx.i = 0; mockHook = ctx; try { tree = DeliveryQueue(props); } finally { mockHook = null; } return tree; };
    render();
    return {
        get tree() { return tree; },
        render,
        setOrders(orders: any[]) { props = { ...props, orders }; return render(); },
        props: () => props,
    };
}
const queuedIds = (key: string): string[] => JSON.parse(store.get(key) as string).orderIds;
const handoffCalls = () => fetchLog.filter((f) => f.url === '/api/delivery/handoff');

describe('3. the real Packed & Ready lane, click by click', () => {
    const lane = () => [...A, ...B, ...B2, ...ORD];

    it('3a. clicking a fundraiser selects exactly its orders; Box Labels then queues exactly them', async () => {
        const m = mount(lane());
        expect(textOf(button(m.tree, /Box Labels/).props.children)).toBe('Box Labels — choose orders');
        chip(m.tree, ORG_A).props.onClick(); m.render();

        expect(textOf(button(m.tree, /Box Labels/).props.children)).toBe('Box Labels — 3');
        for (const id of ['a1', 'a2', 'a3']) expect(orderCheckbox(m.tree, id).props.checked).toBe(true);
        for (const id of ['b1', 'b2', 'c1', 'o1', 'o2']) expect(orderCheckbox(m.tree, id).props.checked).toBe(false);

        await button(m.tree, /Box Labels — 3/).props.onClick();
        expect(sorted(queuedIds(BOX_LABEL_STORAGE_KEY))).toEqual(['a1', 'a2', 'a3']);
        expect(mockPush).toHaveBeenCalledWith('/production/box-labels');
    });

    it('3b. Packing Slips uses the same selection and goes to the pre-handoff slip page', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        await button(m.tree, /Packing Slips — 3/).props.onClick();
        expect(sorted(queuedIds(PACKING_SLIP_STORAGE_KEY))).toEqual(['a1', 'a2', 'a3']);
        expect(mockPush).toHaveBeenCalledWith('/delivery/print-packing-slips?source=packed-ready');
    });

    it('3c. selecting two fundraisers intentionally is the union, and only the union is queued', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        // The two Bravo campaigns share a label (one organization, two campaigns) — tell them apart by count.
        const bravo = findAll(m.tree, (el) => el.type === 'button' && el.props.role === 'checkbox' && textOf(el.props.children).includes(ORG_B));
        expect(bravo).toHaveLength(2);
        const withTwoOrders = bravo.find((el) => textOf(el.props.children).includes('2 orders'))!;
        withTwoOrders.props.onClick(); m.render();
        await button(m.tree, /Box Labels — 5/).props.onClick();
        expect(sorted(queuedIds(BOX_LABEL_STORAGE_KEY))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']); // NOT c1 (same org, other campaign)
    });

    it('3d. unticking one order is a finer override that removes only that order', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        orderCheckbox(m.tree, 'a2').props.onChange(); m.render();
        expect(textOf(button(m.tree, /Packing Slips/).props.children)).toBe('Packing Slips — 2');
        expect(chip(m.tree, ORG_A).props['aria-checked']).toBe('mixed');
        await button(m.tree, /Packing Slips — 2/).props.onClick();
        expect(sorted(queuedIds(PACKING_SLIP_STORAGE_KEY))).toEqual(['a1', 'a3']);
    });

    it('3e. Clear selection empties the set, and a mixed lane goes back to requiring a choice', () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        button(m.tree, /Clear selection/).props.onClick(); m.render();
        expect(maybeButton(m.tree, /Clear selection/)).toBeUndefined();
        expect(textOf(button(m.tree, /Box Labels/).props.children)).toBe('Box Labels — choose orders');
        expect(orderCheckbox(m.tree, 'a1').props.checked).toBe(false);
    });

    it('3f. unticking every order of a campaign unticks its chip', () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        for (const id of ['a1', 'a2', 'a3']) { orderCheckbox(m.tree, id).props.onChange(); m.render(); }
        expect(chip(m.tree, ORG_A).props['aria-checked']).toBe('false');
    });

    it('3g. the stored batches hold opaque order ids ONLY — no supporter, organization or fundraiser text', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        await button(m.tree, /Box Labels — 3/).props.onClick();
        await button(m.tree, /Packing Slips — 3/).props.onClick();
        for (const key of [BOX_LABEL_STORAGE_KEY, PACKING_SLIP_STORAGE_KEY]) {
            const raw = store.get(key) as string;
            expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['businessId', 'name', 'orderIds']);
            for (const forbidden of ['Pat-', 'Example', ORG_A, ORG_B, DECOY, 'Fundraiser', 'Farm Bureau']) expect(raw).not.toContain(forbidden);
        }
    });

    it('3h. Send to Delivery sends exactly the selection and the confirmation names the fundraiser and count', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        await button(m.tree, /Send 3 to Delivery/).props.onClick();
        expect(handoffCalls()).toHaveLength(1);
        expect(sorted(handoffCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3']);
        expect(Object.keys(handoffCalls()[0].body)).toEqual(['orderIds']);
        expect(confirmLog).toHaveLength(1);
        expect(confirmLog[0]).toContain(`${ORG_A} (delivery Oct 21, 2026) — 3 orders`);
        expect(confirmLog[0]).toContain('Send 3 orders to Delivery?');
        expect(confirmLog[0]).not.toContain(ORG_B);
    });

    it('3i. a multi-fundraiser send lists EACH fundraiser with its count, and the counts sum to the request', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        const withTwo = findAll(m.tree, (el) => el.type === 'button' && el.props.role === 'checkbox' && textOf(el.props.children).includes('2 orders'))[0];
        withTwo.props.onClick(); m.render();
        orderCheckbox(m.tree, 'o1').props.onChange(); m.render(); // plus one ordinary order
        await button(m.tree, /Send 6 to Delivery/).props.onClick();
        const text = confirmLog[0];
        expect(text).toContain('Send 6 orders to Delivery?');
        expect(text).toContain(`${ORG_A} (delivery Oct 21, 2026) — 3 orders`);
        // Bravo owns TWO campaigns here, so its line carries the campaign tag that tells them apart.
        expect(text).toContain(`${ORG_B} [#bbbbbb] (delivery Oct 27, 2026) — 2 orders`);
        expect(text).not.toContain('[#cccccc]'); // the OTHER Bravo campaign is not part of this send
        expect(text).toContain(`${OTHER_ORDERS_LABEL} — 1 order`);
        expect(sorted(handoffCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'o1']);
    });

    it('3j. declining the confirmation sends nothing', async () => {
        confirmAnswer = false;
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        await button(m.tree, /Send 3 to Delivery/).props.onClick();
        expect(handoffCalls()).toHaveLength(0);
    });

    it('3k. a refresh that drops an order drops it from the selection — a stale id is never sent', async () => {
        const m = mount(lane());
        chip(m.tree, ORG_A).props.onClick(); m.render();
        m.setOrders(lane().filter((o) => o.id !== 'a2')); // a2 left the lane
        expect(textOf(button(m.tree, /Send \d+ to Delivery/).props.children)).toBe('Send 2 to Delivery');
        await button(m.tree, /Send 2 to Delivery/).props.onClick();
        expect(sorted(handoffCalls()[0].body.orderIds)).toEqual(['a1', 'a3']);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE MIXED-LANE GUARD
// ═════════════════════════════════════════════════════════════════════════════
describe('4. a mixed lane cannot print or send "everything"', () => {
    const mixed = () => [...A, ...B, ...B2, ...ORD];

    it('4a. two fundraisers, nothing selected: every batch button is disabled and says to choose', () => {
        const m = mount([...A, ...B]);
        for (const [re, text] of [
            [/Box Labels/, 'Box Labels — choose orders'], [/Packing Slips/, 'Packing Slips — choose orders'],
            [/Send/, 'Send to Delivery — choose orders'],
        ] as const) {
            const b = findAll(m.tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)) && /choose orders/.test(textOf(el.props.children)))[0];
            expect(textOf(b.props.children)).toBe(text);
            expect(b.props.disabled).toBe(true);
        }
        expect(maybeButton(m.tree, /Send All to Delivery/)).toBeUndefined();
        expect(maybeButton(m.tree, /All Orders/)).toBeUndefined();
    });

    it('4b. even if the (disabled) buttons were clicked, nothing is queued and nothing is sent', async () => {
        const m = mount(mixed());
        await button(m.tree, /Box Labels — choose orders/).props.onClick();
        await button(m.tree, /Packing Slips — choose orders/).props.onClick();
        await button(m.tree, /Send to Delivery — choose orders/).props.onClick();
        expect(store.size).toBe(0);                 // no batch written
        expect(handoffCalls()).toHaveLength(0);     // no handoff request
        expect(confirmLog).toHaveLength(0);         // no confirmation even offered
        expect(mockPush).not.toHaveBeenCalled();    // no navigation
    });

    it('4c. the guard is structural: the empty-selection argument in a mixed lane is [] — never the whole lane', () => {
        const q = strip(read(QUEUE));
        expect(q).toMatch(/sendToDelivery\(hasSelection \? selectedOrders : needsExplicitSelection \? \[\] : orders\)/);
        expect(q).toMatch(/queueBoxLabels\(\s*hasSelection \? selectedOrders : needsExplicitSelection \? \[\] : orders,/);
        expect(q).toMatch(/queuePackingSlips\(\s*hasSelection \? selectedOrders : needsExplicitSelection \? \[\] : orders,/);
        expect(q).toMatch(/const needsExplicitSelection = lane\.mixed && !hasSelection/);
    });

    it('4d. a fundraiser beside ordinary orders is ALSO a mixed lane (they would otherwise go together)', () => {
        expect(describeLane([...A, ...ORD]).mixed).toBe(true);
        const m = mount([...A, ...ORD]);
        expect(maybeButton(m.tree, /Send All to Delivery/)).toBeUndefined();
        expect(button(m.tree, /Send to Delivery — choose orders/).props.disabled).toBe(true);
    });

    it('4e. one fundraiser alone is ONE population: today\'s convenient "All" buttons stay', async () => {
        expect(describeLane(A).mixed).toBe(false);
        const m = mount(A);
        expect(textOf(button(m.tree, /Box Labels/).props.children)).toBe('Box Labels — All Orders');
        expect(textOf(button(m.tree, /Packing Slips/).props.children)).toBe('Packing Slips — All Orders');
        expect(button(m.tree, /Send All to Delivery/).props.disabled).toBe(false);
        await button(m.tree, /Box Labels — All Orders/).props.onClick();
        expect(sorted(queuedIds(BOX_LABEL_STORAGE_KEY))).toEqual(['a1', 'a2', 'a3']);
    });

    it('4f. a mixed lane with a deliberate "Select all" is an explicit choice and is allowed', async () => {
        const m = mount([...A, ...B]);
        findAll(m.tree, (el) => el.type === 'input' && el.props.id === 'dq-select-all')[0].props.onChange(); m.render();
        expect(textOf(button(m.tree, /Box Labels/).props.children)).toBe('Box Labels — 5');
        await button(m.tree, /Send 5 to Delivery/).props.onClick();
        expect(sorted(handoffCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2']);
        // and the confirmation tells the operator it is both fundraisers
        expect(confirmLog[0]).toContain(`${ORG_A} (delivery Oct 21, 2026) — 3 orders`);
        expect(confirmLog[0]).toContain(`${ORG_B} (delivery Oct 27, 2026) — 2 orders`);
    });

    it('4g. the per-row buttons still act on exactly one order', async () => {
        const m = mount(mixed());
        const rowSend = findAll(m.tree, (el) => el.type === 'button' && el.props.title === 'Send this order to Delivery');
        expect(rowSend).toHaveLength(mixed().length);
        await rowSend[0].props.onClick();
        expect(handoffCalls()[0].body.orderIds).toEqual(['a1']);
    });

    it('4h. the handoff route and its semantics are not touched by this change', () => {
        const route = strip(read(HANDOFF));
        expect(route).toMatch(/released_to_delivery_at: releasedAt/);
        // The server never learns that a wave existed: it takes opaque ids and re-checks them.
        expect(route).not.toMatch(/packedReadyWaves|FundraiserQuickSelect|fundraiserIdentityLine|groupFundraiserWaves/);
        const q = strip(read(QUEUE));
        expect((q.match(/\/api\/delivery\/handoff/g) || []).length).toBe(1);
        expect(q).toMatch(/body: JSON\.stringify\(\{ orderIds \}\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. WHAT THE LANE SHOWS
// ═════════════════════════════════════════════════════════════════════════════
const html = (orders: any[]) => renderToStaticMarkup(createElement(require('@/components/production/DeliveryQueue').default, { orders, onRefresh: () => {} }));
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plainText = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

describe('5. the lane shows which fundraiser, and when', () => {
    it('5a. each fundraiser is a chip with its organization, its delivery date and its order count, under date headings', () => {
        const out = html([...A, ...B]);
        const t = plainText(out);
        expect(t).toContain('Fundraisers in Packed & Ready');
        expect(t).toContain(`Delivery Oct 21, 2026 ${ORG_A} 3 orders`);
        expect(t).toContain(`Delivery Oct 27, 2026 ${ORG_B} 2 orders`);
        expect(t.indexOf('Oct 21, 2026')).toBeLessThan(t.indexOf('Oct 27, 2026'));
    });

    it('5b. a campaign with no delivery date is labelled honestly, not guessed', () => {
        const t = plainText(html([...A, ...[fr('u1', campaign('cu', 'Undated Org', null))]]));
        expect(t).toContain('No delivery date set');
        expect(t).toContain('Undated Org');
    });

    it('5c. a fundraiser row names its fundraiser under the supporter; an ordinary row names none', () => {
        const out = html([fr('a1', CA), plain('o1')]);
        expect((out.match(/data-fundraiser-line="row"/g) || []).length).toBe(1);
        const row = out.split('Select order')[1]; // the fundraiser's row
        expect(plainText(row)).toContain(`Pat-a1 Example Fundraiser: ${ORG_A}`);
        expect(plainText(out.split('Select order')[2])).not.toContain('Fundraiser:');
    });

    it('5d. the supporter stays the PRIMARY identity: the title is the supporter, the organization is secondary', () => {
        const out = html([fr('a1', CA)]);
        const title = out.match(/<h4 class="font-black text-slate-900 dark:text-white text-lg">([\s\S]*?)<\/h4>/)![1];
        expect(decode(title)).toBe('Pat-a1 Example');
        expect(out.indexOf('Pat-a1 Example')).toBeLessThan(out.indexOf('Fundraiser:'));
    });

    it('5e. the organization comes from the CAMPAIGN\'s owner — never from Order.customer', () => {
        const out = html([...A, ...B]);
        expect(out).not.toContain(DECOY);
        expect(fundraiserOrganizationFor(fr('x', CA))).toBe(ORG_A);
        // Even an Order.customer that LOOKS like an organization is ignored.
        expect(fundraiserOrganizationFor(fr('x', CA, { customer: { name: 'Org-looking Customer', type: 'organization' } }))).toBe(ORG_A);
    });

    it('5f. the row line equals what the outer-box label prints for the same order', async () => {
        useMock(createPrismaMock({ results: { 'order.findMany': (args: any) => [...A, ...B, ...B2].filter((r: any) => args.where.id.in.includes(r.id)) } }));
        const { POST } = await import('@/app/api/production/box-labels/route');
        const res = await POST(new Request('http://x/api/production/box-labels', { method: 'POST', body: JSON.stringify({ orderIds: ids([...A, ...B, ...B2]) }) }) as any);
        const body = await res.json();
        const labelOrg = new Map<string, string>(body.boxes.map((b: any) => [b.orderId, b.organizationName]));
        for (const o of [...A, ...B, ...B2]) expect(fundraiserOrganizationFor(o)).toBe(labelOrg.get(o.id));
    });

    it('5g. an ordinary-only lane shows no fundraiser panel, no fundraiser line and the original buttons', () => {
        const out = html(ORD);
        expect(out).not.toContain('Fundraisers in Packed');
        expect(out).not.toContain('data-fundraiser-line');
        const t = plainText(out);
        expect(t).toContain('Box Labels — All Orders');
        expect(t).toContain('Packing Slips — All Orders');
        expect(t).toContain('Send All to Delivery');
        expect(t).not.toContain('choose orders');
    });

    it('5h. the panel is one control per campaign, accessible as a checkbox, and wraps on narrow screens', () => {
        const out = html([...B, ...B2]);
        expect((out.match(/role="checkbox"/g) || []).length).toBe(2);
        expect(out).toContain('aria-checked="false"');
        const src = strip(read(PANEL));
        expect(src).toMatch(/flex flex-wrap gap-2/);
        expect(src).toMatch(/min-h-11/); // comfortable touch target
        expect(src).toMatch(/break-words/);
    });

    it('5i. the panel performs no I/O and knows nothing about statuses or APIs', () => {
        const src = strip(read(PANEL));
        expect(src).not.toMatch(/fetch\(|localStorage|prisma|router|useRouter|\/api\/|status|released_to_delivery|handoff/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE PACKING SLIP NAMES ITS FUNDRAISER
// ═════════════════════════════════════════════════════════════════════════════
const slipRows = (rows: any[]) => createPrismaMock({ results: {
    'order.findMany': (args: any) => rows.filter((r: any) => {
        const w = args?.where ?? {};
        if (w.id?.in && !w.id.in.includes(r.id)) return false;
        if (w.released_to_delivery_at === null && r.released_to_delivery_at !== null) return false;
        if (w.released_to_delivery_at?.not === null && r.released_to_delivery_at === null) return false;
        if (w.canceled_at === null && r.canceled_at !== null) return false;
        if (w.status?.in && !w.status.in.includes(r.status)) return false;
        if (w.NOT?.status?.in && w.NOT.status.in.includes(r.status)) return false;
        return true;
    }),
} });
const callPre = async (orderIds: string[]) => {
    const { POST } = await import('@/app/api/production/packing-slips/route');
    const res = await POST(new Request('http://x/api/production/packing-slips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderIds }) }) as any);
    return { status: res.status, body: await res.json() };
};
const callReprint = async () => {
    const { GET } = await import('@/app/api/delivery/packing-slips/route');
    const res = await GET(new Request('http://x/api/delivery/packing-slips') as any);
    return { status: res.status, body: await res.json() };
};
const released = (rows: any[]) => rows.map((r) => ({ ...r, released_to_delivery_at: new Date('2026-10-22T12:00:00Z') }));

describe('6. the packing slip carries the campaign\'s owning organization', () => {
    it('6a. a fundraiser slip carries the campaign organization on every one of its boxes', async () => {
        const multi = fr('m1', CA, { items: [lineItem('serves_5'), lineItem('serves_5')] });
        useMock(slipRows([multi]));
        const { body } = await callPre(['m1']);
        expect(body.boxes).toHaveLength(2);
        for (const box of body.boxes) expect(box.organizationName).toBe(ORG_A);
    });

    it('6b. it is the campaign\'s organization, NEVER Order.customer', async () => {
        useMock(slipRows([fr('d1', CA), fr('d2', CB, { customer: { name: ORG_A, type: 'organization' } })]));
        const { body } = await callPre(['d1', 'd2']);
        const byOrder = new Map<string, string>(body.boxes.map((b: any) => [b.orderId, b.organizationName]));
        expect(byOrder.get('d1')).toBe(ORG_A);
        expect(byOrder.get('d2')).toBe(ORG_B); // the decoy Order.customer said ORG_A
        expect(JSON.stringify(body)).not.toContain(DECOY);
    });

    it('6c. an ordinary order\'s slip carries NO organization (null on every box)', async () => {
        useMock(slipRows([plain('p1', { items: [lineItem('serves_5'), lineItem('serves_5')] })]));
        const { body } = await callPre(['p1']);
        expect(body.boxes.length).toBeGreaterThan(0);
        for (const box of body.boxes) expect(box.organizationName).toBeNull();
    });

    it('6d. a mixed batch resolves each order\'s own organization — no bleed between campaigns', async () => {
        useMock(slipRows([fr('x1', CA), fr('x2', CB), plain('x3'), fr('x4', CB2)]));
        const { body } = await callPre(['x1', 'x2', 'x3', 'x4']);
        const byOrder = new Map<string, string | null>(body.boxes.map((b: any) => [b.orderId, b.organizationName]));
        expect(Object.fromEntries(byOrder)).toEqual({ x1: ORG_A, x2: ORG_B, x3: null, x4: ORG_B });
    });

    it('6e. the pre-handoff slip and the Delivery reprint are the SAME document for the same orders', async () => {
        const rows = [fr('r1', CA, { delivery_sequence: 2 }), fr('r2', CB, { delivery_sequence: 1 }), plain('r3', { delivery_sequence: 3 }), fr('r4', CA, { items: [lineItem('serves_2'), lineItem('serves_2'), lineItem('serves_2')], delivery_sequence: 4 })];
        useMock(slipRows(rows));
        const pre = (await callPre(ids(rows))).body;
        useMock(slipRows(released(rows)));
        const reprint = (await callReprint()).body;
        const { requestedCount, unavailableCount, ...preDocument } = pre;
        expect(requestedCount).toBe(4);
        expect(unavailableCount).toBe(0);
        expect(reprint).toEqual(preDocument);
        expect(reprint.boxes.map((b: any) => b.organizationName)).toEqual(preDocument.boxes.map((b: any) => b.organizationName));
        expect(reprint.boxes.some((b: any) => b.organizationName === ORG_A)).toBe(true);
    });

    it('6f. the slip names the same organization the outer-box label prints, for every order', async () => {
        const rows = [fr('l1', CA), fr('l2', CB), fr('l3', CB2), plain('l4')];
        useMock(slipRows(rows));
        const slips = (await callPre(ids(rows))).body;
        const { POST } = await import('@/app/api/production/box-labels/route');
        const res = await POST(new Request('http://x/api/production/box-labels', { method: 'POST', body: JSON.stringify({ orderIds: ids(rows) }) }) as any);
        const labels = await res.json();
        const norm = (boxes: any[]) => boxes.map((b) => [b.orderId, b.boxNumber, b.organizationName]).sort();
        expect(norm(slips.boxes)).toEqual(norm(labels.boxes));
    });

    it('6g. fallbacks mirror the label: organization, then campaign name, then nothing', async () => {
        const byName = campaign('cnm', null, '2026-10-21T00:00:00.000Z', 'Campaign Name Only');
        const nothing = campaign('cno', null, '2026-10-21T00:00:00.000Z', '   ');
        useMock(slipRows([fr('f1', byName), fr('f2', nothing)]));
        const { body } = await callPre(['f1', 'f2']);
        const byOrder = new Map<string, string | null>(body.boxes.map((b: any) => [b.orderId, b.organizationName]));
        expect(byOrder.get('f1')).toBe('Campaign Name Only');
        expect(byOrder.get('f2')).toBeNull();
    });

    it('6h. both routes fetch the organization through the ONE shared select, name only', async () => {
        useMock(slipRows([fr('s1', CA)]));
        await callPre(['s1']);
        const preSelect = mock.firstCall('order.findMany')!.args.select;
        useMock(slipRows([fr('s1', CA)]));
        await callReprint();
        const reprintSelect = mock.firstCall('order.findMany')!.args.select;
        expect(preSelect).toEqual(reprintSelect);
        expect(preSelect.campaign).toEqual({ select: { delivery_date: true, name: true, customer: { select: { name: true } } } });
        expect(Object.keys(preSelect)).not.toContain('customer');
        // The select grew by names only — still no contact data.
        expect(JSON.stringify(preSelect)).not.toMatch(/email|phone|address|contact/i);
    });

    it('6i. the slip assembly uses an explicit mapping (not a blind cast) — the same expression the label route uses', () => {
        const slip = strip(read(CONTENTS));
        const label = strip(read(LABEL_ROUTE));
        expect(slip).toMatch(/campaign_organization_name: o\.campaign\?\.customer\?\.name \?\? null/);
        expect(label).toMatch(/campaign_organization_name: o\.campaign\?\.customer\?\.name \?\? null/);
        expect(slip).not.toMatch(/orders as unknown as BoxManifestOrder\[\]/);
    });

    it('6j. the slip page renders the line under the supporter, from box.organizationName, and shows nothing without one', () => {
        const page = strip(read(SLIP_PAGE));
        const idx = page.indexOf('Prepared For');
        const block = page.slice(idx, idx + 700);
        expect(block).toMatch(/box\.supporterName/);
        expect(block).toMatch(/<FundraiserIdentityLine organizationName=\{box\.organizationName\} variant="slip" \/>/);
        expect(block.indexOf('box.supporterName')).toBeLessThan(block.indexOf('FundraiserIdentityLine'));
        // The page still never reads the mutable Customer chain.
        expect(page).not.toMatch(/order\.customer\?\.|\.customer_name\b|campaign\.customer/);
    });

    it('6k. the printed line wraps instead of cutting a long organization name off', () => {
        const longName = 'The Extraordinarily Long Named County Farm Bureau Foundation For Agricultural Education And Community Outreach Incorporated';
        const out = renderToStaticMarkup(createElement(require('@/components/production/FundraiserIdentityLine').default, { organizationName: longName, variant: 'slip' }));
        expect(decode(out.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()).toBe(`Fundraiser: ${longName}`);
        expect(out).toMatch(/break-words/);
        expect(out).not.toMatch(/truncate|whitespace-nowrap|line-clamp|overflow-hidden/);
        const unbroken = 'X'.repeat(160);
        expect(renderToStaticMarkup(createElement(require('@/components/production/FundraiserIdentityLine').default, { organizationName: unbroken, variant: 'slip' })))
            .toMatch(/overflow-wrap:anywhere/);
    });

    it('6l. no placeholder ever prints: null, undefined, blank and whitespace yield no line at all', () => {
        const Line = require('@/components/production/FundraiserIdentityLine').default;
        for (const v of [null, undefined, '', '   ', '\n\t ']) {
            expect(renderToStaticMarkup(createElement(Line, { organizationName: v as any, variant: 'slip' }))).toBe('');
            expect(renderToStaticMarkup(createElement(Line, { organizationName: v as any, variant: 'row' }))).toBe('');
            expect(fundraiserIdentity(v as any)).toBeNull();
            expect(fundraiserIdentityText(v as any)).toBeNull();
        }
        for (const v of [null, undefined, '', '  ']) {
            expect(renderToStaticMarkup(createElement(Line, { organizationName: v as any, variant: 'slip' }))).not.toMatch(/null|undefined|Fundraiser:/);
        }
        expect(fundraiserIdentityText('  Alpha   County\n Farm Bureau ')).toBe('Fundraiser: Alpha County Farm Bureau');
    });

    it('6m. the supporter name is untouched on the slip (still the primary Prepared For identity)', async () => {
        useMock(slipRows([fr('z1', CA)]));
        const { body } = await callPre(['z1']);
        expect(body.boxes[0].supporterName).toBe('Pat-z1 Example');
        expect(body.boxes[0].supporterName).not.toContain('Farm Bureau');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. NOTHING ELSE MOVED
// ═════════════════════════════════════════════════════════════════════════════
describe('7. printing is read-only; the lane\'s data and every other lane are unchanged', () => {
    it('7a. the Packed & Ready query gained ONLY a read-only, explicit campaign select; its WHERE is unchanged', async () => {
        const seen: any[] = [];
        useMock(createPrismaMock({ results: { 'order.findMany': (args: any) => { seen.push(args); return []; } } }));
        const { GET } = await import('@/app/api/production/dashboard/route');
        await GET();
        const lane = seen.find((a) => a?.where?.released_to_delivery_at === null && Array.isArray(a?.where?.status?.in));
        expect(lane.include.campaign).toEqual({ select: { id: true, name: true, delivery_date: true, customer: { select: { name: true } } } });
        expect(lane.include.customer.select).toEqual({ name: true, type: true, delivery_address: true });
        expect(Object.keys(lane.where).sort()).toEqual(['NOT', 'business_id', 'canceled_at', 'released_to_delivery_at', 'status']);
        // No other lane's query learned about the campaign include.
        for (const a of seen) if (a !== lane) expect(a?.include?.campaign).toBeUndefined();
    });

    it('7b. queuing labels or slips from the UI never calls the handoff route or any API but the tenant identity', async () => {
        const m = mount([...A, ...B]);
        chip(m.tree, ORG_A).props.onClick(); m.render();
        await button(m.tree, /Box Labels — 3/).props.onClick();
        await button(m.tree, /Packing Slips — 3/).props.onClick();
        expect(fetchLog.map((f) => f.url)).toEqual(['/api/tenant/identity', '/api/tenant/identity']);
    });

    it('7c. the print routes still contain no write of any kind', () => {
        for (const f of [LABEL_ROUTE, PRE_SLIPS, REPRINT_SLIPS]) {
            const s = strip(read(f));
            expect(s).not.toMatch(/\.create\(|\.createMany\(|\.update\(|\.updateMany\(|\.upsert\(|\.delete\(|\.deleteMany\(|\$executeRaw|\$transaction/);
        }
        expect(strip(read(CONTENTS))).not.toMatch(/prisma|\.update\(|\.create\(/);
    });

    it('7d. no new API route, batch type or mutation exists for waves', () => {
        const q = strip(read(QUEUE));
        expect(q).not.toMatch(/\/api\/[a-z-/]*wave|campaign-batch|batch-campaign/i);
        for (const f of ['lib/packedReadyWaves.ts', PANEL, LINE, 'lib/fundraiserIdentityLine.ts']) {
            // No data access and no network verb. (`Set.delete` on the in-memory selection is the
            // selection layer doing its job, so it is deliberately not matched.)
            expect(strip(read(f))).not.toMatch(/prisma|fetch\(|XMLHttpRequest|\.update\(|\.updateMany\(|\.create\(|\.createMany\(|\.upsert\(|\.deleteMany\(|\$executeRaw|method:\s*'(POST|PUT|PATCH|DELETE)'/);
        }
    });

    it('7e. the dashboard route still names no wave logic (the grouping is a client selection layer)', () => {
        expect(strip(read(DASH))).not.toMatch(/packedReadyWaves|groupFundraiserWaves|FundraiserWave/);
    });

    it('7f. scope guard: the prep path is exactly as audited (PREP-WAVES-1 is a separate task)', () => {
        const batch = strip(read('app/api/orders/batch-update-by-bundle/route.ts'));
        expect(batch).toMatch(/items: \{ some: \{ bundle_id: bundleId \} \}/);
        const prep = strip(read('components/production/PrepList.tsx'));
        expect(prep).toMatch(/'\/api\/orders\/batch-update-by-bundle'/);
        expect(prep).not.toMatch(/packedReadyWaves|campaign_id|FundraiserWave/);
    });

    it('7g. physical packing, Delivery grouping and the label route are not touched by name', () => {
        for (const f of ['lib/physicalBoxPacking.ts', 'lib/delivery/deliveryStops.ts', 'app/api/delivery/campaign-delivered/route.ts', LABEL_ROUTE]) {
            expect(strip(read(f))).not.toMatch(/packedReadyWaves|fundraiserIdentityLine|FundraiserQuickSelect/);
        }
    });

    it('7h. scope text: the confirmation formatter reports counts that sum to the request', () => {
        const lane = [...A, ...B, ...ORD];
        const target = ['a1', 'a2', 'b1', 'o2'];
        const scope = describeSelectionScope(target, lane);
        expect(scope.total).toBe(4);
        expect(scope.lines.reduce((s, l) => s + l.count, 0)).toBe(4);
        expect(scope.lines.map(formatScopeLine)).toEqual([
            `${ORG_A} (delivery Oct 21, 2026) — 2 orders`,
            `${ORG_B} (delivery Oct 27, 2026) — 1 order`,
            `${OTHER_ORDERS_LABEL} — 1 order`,
        ]);
        // An ordinary-only send has no lines, so its confirmation keeps its original wording.
        expect(describeSelectionScope(['o1', 'o2'], lane).lines).toEqual([]);
    });
});
