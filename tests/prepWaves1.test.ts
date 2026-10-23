/**
 * PREP-WAVES-1 — Start Prep and Mark Packed & Ready act on EXACT fundraiser orders, never on
 * "every order that shares this bundle".
 *
 * AUDIT: PROD-FUNDRAISER-WAVES-AUDIT-1. At the audited Production SHA a Prep card said "Start
 * Prep" and the server advanced every tenant order at that status that contained the bundle: all
 * the fundraisers sharing a meal, plus ordinary orders, as whole orders, with nothing in the app
 * able to move them back. The dashboard had collected the exact order ids behind each number and
 * deleted them before answering.
 *
 * THE RULE THIS SUITE PINS
 *     aggregate totals MAY span campaigns; the scope of a status action MAY NOT.
 *
 * LEVELS
 *   1. lib/prepWaves.ts — the pure model (grouping, breakdown, selection, request, wording).
 *   2. the REAL dashboard route — the read model keeps the aggregate and now keeps its sources.
 *   3. END TO END, in process: the real dashboard route feeds the real PrepList; its clicks go to
 *      the real, UNMODIFIED /api/orders/bulk-status route over one shared in-memory database whose
 *      transactions are all-or-nothing.
 *
 * Every order, supporter and organization below is FICTIONAL (the repository is public).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountComponent, findAll, textOf } from './helpers/hookRuntime';
import { FakeOrderDb } from './helpers/fakeOrderDb';
import {
    buildPrepModel,
    buildPrepStatusRequest,
    describePrepAction,
    describePrepFailure,
    prepConfirmMessage,
    prepLaneOf,
    resolveWaveSelection,
    rowBreakdown,
    rowOrdinaryOrderIds,
    waveLines,
    waveMealLabelItems,
    type PrepRow,
} from '@/lib/prepWaves';
import { PRINT_BATCH_STORAGE_KEY } from '@/lib/printBatchStorage';

jest.mock('react', () => require('./helpers/hookRuntime').createReactMock());
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: (u: string) => mockPush(u), back: () => {} }) }));
jest.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
const mockToast = { success: jest.fn(), error: jest.fn() };
jest.mock('sonner', () => ({ toast: { success: (m: string) => mockToast.success(m), error: (m: string) => mockToast.error(m) } }));
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__prepDb; } }));
jest.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u-1', businessId: 'biz-fixture' } }) }));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PREPLIST = 'components/production/PrepList.tsx';
const PANEL = 'components/production/PrepWavePanel.tsx';
const HELPER = 'lib/prepWaves.ts';
const DASH = 'app/api/production/dashboard/route.ts';
const BULK = 'app/api/orders/bulk-status/route.ts';
const BATCH = 'app/api/orders/batch-update-by-bundle/route.ts';

// ── Fictional fixtures ───────────────────────────────────────────────────────────────────────
const BIZ = 'biz-fixture';
const ORG_A = 'Alpha County Farm Bureau (fixture)';
const ORG_B = 'Bravo County Farm Bureau (fixture)';
const ORG_C = 'Charlie Booster Club (fixture)';
const CAMP_A = 'aaaa1111-0000-4000-8000-000000000001';
const CAMP_B = 'bbbb2222-0000-4000-8000-000000000002';
const CAMP_C = 'cccc3333-0000-4000-8000-000000000003';
const CAMP_B2 = 'dddd4444-0000-4000-8000-000000000004'; // a SECOND campaign owned by Bravo
const PII = ['PII-first-name', 'PII-last-name', 'pii-email@example.test', 'PII-phone-555', 'PII-street-address', 'PII-customer-name', 'PII-participant', 'PII-notes'];

const campaign = (id: string, org: string | null, date: string | null, name?: string) =>
    ({ id, name: name ?? `${org ?? 'Unnamed'} Fundraiser`, delivery_date: date, customer: org === null ? null : { name: org } });
const CA = campaign(CAMP_A, ORG_A, '2026-10-21T00:00:00.000Z');
const CB = campaign(CAMP_B, ORG_B, '2026-10-27T00:00:00.000Z');
const CC = campaign(CAMP_C, ORG_C, '2026-10-27T00:00:00.000Z');
const CB2 = campaign(CAMP_B2, ORG_B, '2026-10-27T00:00:00.000Z', 'Bravo Spring Fundraiser');

const recipe = (id: string, name: string) => ({ id, name, label_text: null });
const bundle = (id: string, name: string, sku: string, contents: [any, number][]) =>
    ({ id, name, sku, contents: contents.map(([r, quantity]) => ({ quantity, recipe: r })) });
const SHARED = recipe('r-shared', 'Garlic Bread');
const FF = bundle('b-ff', 'Family Friendly (Serves 2)', 'FF2', [[recipe('r-ziti', 'Baked Ziti'), 1], [recipe('r-chili', 'Veggie Chili'), 1], [SHARED, 2]]);
const KETO = bundle('b-keto', 'Keto Bundle (Serves 2)', 'K2', [[recipe('r-steak', 'Steak Bites'), 1], [SHARED, 1]]);

let seq = 0;
const line = (b: any, quantity: number, variant = 'serves_2') => { seq += 1; return { id: `oi-${seq}`, bundle_id: b.id, quantity, variant_size: variant, bundle: b }; };
/** An order exactly as the dashboard route reads it (campaign relation joined; PII present on the row and never returned). */
const order = (id: string, camp: any | null, items: any[], over: any = {}) => ({
    id, business_id: BIZ, status: 'production_ready', canceled_at: null, released_to_delivery_at: null,
    source: camp ? 'fundraiser' : 'manual', campaign_id: camp?.id ?? null, campaign: camp,
    created_at: '2026-10-05T15:00:00.000Z',
    first_name: PII[0], last_name: PII[1], email: PII[2], phone: PII[3], delivery_address: PII[4], customer_name: PII[5],
    participant_name: PII[6], notes: PII[7],
    customer: { name: PII[5], type: 'direct_customer', delivery_address: PII[4] },
    items, ...over,
});

/**
 *   A (Oct 21): a1 FF×2 · a2 FF×1 + KETO×1 (a MULTI-BUNDLE order) · a3 FF×3        -> FF 6, KETO 1
 *   B (Oct 27): b1 FF×1 · b2 FF×2                                                   -> FF 3
 *   C (Oct 27): c1 FF×4                                                             -> FF 4
 *   ordinary:   o1 FF×1 · o2 KETO×2 · o3 FF×1 + KETO×1 (an ordinary multi-bundle)   -> FF 2, KETO 3
 *   x1: a CANCELED order that shares FF — invisible to the board, fatal to the bundle-wide route
 *   Kitchen totals: FF = 6+3+4+2 = 15, KETO = 1+3 = 4.
 */
const board = (extra: any[] = []) => {
    seq = 0;
    return [
        order('a1', CA, [line(FF, 2)]), order('a2', CA, [line(FF, 1), line(KETO, 1)]), order('a3', CA, [line(FF, 3)]),
        order('b1', CB, [line(FF, 1)]), order('b2', CB, [line(FF, 2)]),
        order('c1', CC, [line(FF, 4)]),
        order('o1', null, [line(FF, 1)]), order('o2', null, [line(KETO, 2)]), order('o3', null, [line(FF, 1), line(KETO, 1)]),
        order('x1', CA, [line(FF, 9)], { canceled_at: '2026-10-06T00:00:00.000Z' }),
        ...extra,
    ];
};
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const sorted = (xs: Iterable<string>) => [...xs].sort();

// ── Browser globals and the in-process "server" ──────────────────────────────────────────────
const store = new Map<string, string>();
const fetchLog: { url: string; body: any }[] = [];
const confirmLog: string[] = [];
let confirmAnswer = true;
let db: FakeOrderDb;

beforeEach(() => {
    jest.clearAllMocks();
    store.clear(); fetchLog.length = 0; confirmLog.length = 0; confirmAnswer = true; mockPush.mockClear();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } },
    });
    (globalThis as any).confirm = (m: string) => { confirmLog.push(m); return confirmAnswer; };
    // fetch is a thin shim onto the REAL route handlers (shared state in `db`).
    (globalThis as any).fetch = async (url: string, init?: any) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        fetchLog.push({ url, body });
        if (url === '/api/tenant/identity') return { ok: true, status: 200, json: async () => ({ businessId: BIZ }) };
        if (url === '/api/orders/bulk-status') {
            const { POST } = require('@/app/api/orders/bulk-status/route');
            return POST(new Request('http://localhost' + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body }));
        }
        throw new Error(`unexpected fetch ${url}`);
    };
});
const use = (rows: any[]) => { db = new FakeOrderDb(rows); (global as any).__prepDb = db; return db; };
const getDashboard = async () => {
    const { GET } = require('@/app/api/production/dashboard/route');
    const res = await GET();
    expect(res.status).toBe(200);
    return JSON.parse(JSON.stringify(await res.json()));
};

// ── The real PrepList, mounted over the real dashboard response ─────────────────────────────
let refreshRequests = 0;
const open = async () => {
    const dash = await getDashboard();
    const PrepList = require('@/components/production/PrepList').default;
    refreshRequests = 0;
    const m = mountComponent(PrepList, { items: dash.prep, campaigns: dash.prepCampaigns, onRefresh: () => { refreshRequests += 1; } });
    return {
        m, dash,
        /** What the page does after onRefresh: read the board again and hand it down. */
        async reload() { const d = await getDashboard(); m.setProps({ items: d.prep, campaigns: d.prepCampaigns }); return d; },
    };
};
const waveBoxes = (tree: any, label: string, extra = '') =>
    findAll(tree, (el) => el.type === 'button' && el.props.role === 'checkbox' && textOf(el.props.children).includes(label) && textOf(el.props.children).includes(extra));
const wave = (tree: any, label: string, extra = '') => {
    const hits = waveBoxes(tree, label, extra);
    if (hits.length !== 1) throw new Error(`expected one wave "${label}${extra ? ' / ' + extra : ''}", found ${hits.length}`);
    return hits[0];
};
const button = (tree: any, re: RegExp) => {
    const hits = findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
    if (hits.length !== 1) throw new Error(`expected exactly one button matching ${re}, found ${hits.length}: ${hits.map((h) => textOf(h.props.children)).join(' | ')}`);
    return hits[0];
};
const maybeButtons = (tree: any, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
const cardFor = (tree: any, bundleName: string) => findAll(tree, (el) => el.type === 'div' && typeof el.props.className === 'string' && /rounded-3xl/.test(el.props.className) && /p-6/.test(el.props.className) && textOf(el.props.children).includes(bundleName) && !/Kitchen Prep List/.test(textOf(el.props.children)))
    .sort((a, z) => textOf(a.props.children).length - textOf(z.props.children).length)[0];
const bulkCalls = () => fetchLog.filter((f) => f.url === '/api/orders/bulk-status');

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE PURE MODEL
// ═════════════════════════════════════════════════════════════════════════════
const rowsOf = async (rows: any[]) => { use(rows); return getDashboard(); };

describe('1. the model groups by Campaign.id, orders once, and never guesses', () => {
    it('1a. waves are keyed by FundraiserCampaign.id; ordinary orders form no wave', async () => {
        const dash = await rowsOf(board());
        const model = buildPrepModel(dash.prep, dash.prepCampaigns);
        expect(model.ready.waves.map((w) => w.campaignId)).toEqual([CAMP_A, CAMP_B, CAMP_C]);
        expect(model.ready.waves.map((w) => w.orderIds.length)).toEqual([3, 2, 1]);
        expect(sorted(model.ready.otherOrderIds)).toEqual(['o1', 'o2', 'o3']);
        expect(model.inprod.waves).toEqual([]);
    });

    it('1b. two campaigns of ONE organization stay two waves (never grouped by organization)', async () => {
        const dash = await rowsOf(board([order('d1', CB2, [line(FF, 5)])]));
        const waves = buildPrepModel(dash.prep, dash.prepCampaigns).ready.waves;
        const bravo = waves.filter((w) => w.label === ORG_B);
        expect(bravo).toHaveLength(2);
        expect(bravo.map((w) => w.campaignId).sort()).toEqual([CAMP_B, CAMP_B2].sort());
        expect(bravo.map((w) => w.orderIds.length).sort()).toEqual([1, 2]);
        expect(bravo[0].disambiguator).not.toBeNull();            // told apart by a campaign tag
        expect(bravo[0].disambiguator).not.toBe(bravo[1].disambiguator);
    });

    it('1c. same delivery date, different campaigns: still separate waves', async () => {
        const dash = await rowsOf(board());
        const waves = buildPrepModel(dash.prep, dash.prepCampaigns).ready.waves;
        const b = waves.find((w) => w.campaignId === CAMP_B)!; const c = waves.find((w) => w.campaignId === CAMP_C)!;
        expect(b.deliveryDate).toBe('2026-10-27');
        expect(c.deliveryDate).toBe('2026-10-27');
        expect(b.orderIds).not.toEqual(c.orderIds);
    });

    it('1d. delivery dates are read as CALENDAR dates in every timezone (no browser-zone shift)', async () => {
        const dash = await rowsOf(board());
        const savedTZ = process.env.TZ;
        try {
            for (const tz of ['America/Los_Angeles', 'America/Chicago', 'UTC', 'Pacific/Auckland']) {
                process.env.TZ = tz;
                const waves = buildPrepModel(dash.prep, dash.prepCampaigns).ready.waves;
                expect(waves.map((w) => w.deliveryDateLabel)).toEqual(['Oct 21, 2026', 'Oct 27, 2026', 'Oct 27, 2026']);
                expect(waves.map((w) => w.deliveryDate)).toEqual(['2026-10-21', '2026-10-27', '2026-10-27']);
            }
            process.env.TZ = 'America/Los_Angeles';
            expect(new Date('2026-10-21T00:00:00.000Z').getDate()).toBe(20); // the trap is real on this machine
        } finally {
            if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
        }
    });

    it('1e. a MULTI-BUNDLE order is ONE order in its wave, not one per bundle', async () => {
        const dash = await rowsOf(board());
        const model = buildPrepModel(dash.prep, dash.prepCampaigns);
        const a = model.ready.waves.find((w) => w.campaignId === CAMP_A)!;
        // a2 holds FF and KETO, so it appears on two cards — but it is one order, once, in wave A.
        expect(sorted(a.orderIds)).toEqual(['a1', 'a2', 'a3']);
        expect(model.ready.orders.filter((o) => o.id === 'a2')).toHaveLength(1);
        const a2 = model.ready.orders.find((o) => o.id === 'a2')!;
        expect(a2.lines.map((l) => l.bundleName).sort()).toEqual(['Family Friendly (Serves 2)', 'Keto Bundle (Serves 2)']);
        // The wave's lines say what moves: every bundle in every one of its orders.
        const lines = waveLines(model.ready, a);
        expect(lines.map((l) => [l.bundleName, l.units, l.orders])).toEqual([['Family Friendly (Serves 2)', 6, 3], ['Keto Bundle (Serves 2)', 1, 1]]);
    });

    it('1f. one-signal rows are NEVER guessed into a wave', async () => {
        const sourceOnly = order('amb1', null, [line(FF, 1)], { source: 'fundraiser', campaign_id: null, campaign: null });
        const campaignOnly = order('amb2', CA, [line(FF, 1)], { source: 'manual' });
        const dash = await rowsOf(board([sourceOnly, campaignOnly]));
        const model = buildPrepModel(dash.prep, dash.prepCampaigns);
        const a = model.ready.waves.find((w) => w.campaignId === CAMP_A)!;
        expect(a.orderIds).not.toContain('amb2');                   // has A's campaign object and id, but a non-fundraiser source
        expect(model.ready.waves.flatMap((w) => w.orderIds)).not.toContain('amb1');
        expect(model.ready.otherOrderIds).toEqual(expect.arrayContaining(['amb1', 'amb2']));
    });

    it('1g. an order whose rows disagree about its lane is never actionable (fail closed)', () => {
        const rows: PrepRow[] = [
            { bundle_id: 'b1', bundle_name: 'One', total_quantity: 1, status: 'production_ready', sources: [{ order_id: 'weird', source: 'fundraiser', campaign_id: CAMP_A, quantity: 1 }] },
            { bundle_id: 'b2', bundle_name: 'Two', total_quantity: 1, status: 'in_production', sources: [{ order_id: 'weird', source: 'fundraiser', campaign_id: CAMP_A, quantity: 1 }] },
        ];
        const model = buildPrepModel(rows, { [CAMP_A]: CA });
        expect(model.conflicted).toEqual(['weird']);
        expect(model.ready.orders).toEqual([]);
        expect(model.inprod.orders).toEqual([]);
        expect(model.ready.waves).toEqual([]);
    });

    it('1h. lane bucketing is exactly the one PrepList always used', () => {
        expect(prepLaneOf('production_ready')).toBe('ready');
        expect(prepLaneOf('APPROVED')).toBe('ready');
        expect(prepLaneOf('in_production')).toBe('inprod');
        expect(prepLaneOf('IN_PRODUCTION')).toBe('inprod');
        expect(prepLaneOf(undefined)).toBe('ready');
        expect(prepLaneOf('something-else')).toBe('ready');
    });

    it('1i. the model is pure: no data access, no network, no storage, no React', () => {
        const src = strip(read(HELPER));
        expect(src).not.toMatch(/prisma|from ['"]react['"]|fetch\(|localStorage|process\.env|\.update\(|\.create\(|\.upsert\(/);
        expect(src).not.toMatch(/customer_id/);
    });
});

describe('2. selection resolves to exact order ids — and an empty selection is nothing', () => {
    const lane = async (extra: any[] = []) => { const d = await rowsOf(board(extra)); return buildPrepModel(d.prep, d.prepCampaigns).ready; };

    it('2a. selecting one fundraiser carries exactly that fundraiser\'s orders', async () => {
        const l = await lane();
        const wB = l.waves.find((w) => w.campaignId === CAMP_B)!;
        expect(resolveWaveSelection(l, new Set(wB.orderIds)).orderIds).toEqual(['b1', 'b2']);
    });

    it('2b. two intentional fundraisers are the exact union, and the third is untouched', async () => {
        const l = await lane();
        const ids2 = [...l.waves.find((w) => w.campaignId === CAMP_A)!.orderIds, ...l.waves.find((w) => w.campaignId === CAMP_C)!.orderIds];
        const r = resolveWaveSelection(l, new Set(ids2));
        expect(sorted(r.orderIds)).toEqual(['a1', 'a2', 'a3', 'c1']);
        expect(r.waves.map((w) => w.campaignId)).toEqual([CAMP_A, CAMP_C]);
    });

    it('2c. an EMPTY selection resolves to nothing — never to everything', async () => {
        const l = await lane();
        expect(resolveWaveSelection(l, new Set())).toEqual({ orderIds: [], waves: [] });
    });

    it('2d. a stale id (an order that left the lane) is pruned', async () => {
        const l = await lane();
        const r = resolveWaveSelection(l, new Set(['a1', 'gone-order', 'b1']));
        expect(sorted(r.orderIds)).toEqual(['a1', 'b1']);
    });

    it('2e. a hidden id is never actionable: ordinary orders, canceled orders and strangers are ignored', async () => {
        const l = await lane();
        const r = resolveWaveSelection(l, new Set(['o1', 'o2', 'x1', 'a1', 'someone-elses-order']));
        expect(r.orderIds).toEqual(['a1']);                         // x1 is canceled (not on the board); o1/o2 belong to no wave
    });

    it('2f. the request body is order ids and a target status — nothing that could widen the scope', () => {
        const r = buildPrepStatusRequest('start_prep', ['a1', 'a1', 'a2', '', '  ']);
        expect(r).toEqual({ orderIds: ['a1', 'a2'], status: 'in_production' });
        expect(Object.keys(r!)).toEqual(['orderIds', 'status']);
        expect(buildPrepStatusRequest('mark_packed', ['a1'])).toEqual({ orderIds: ['a1'], status: 'ready_to_ship' });
        expect(buildPrepStatusRequest('start_prep', [])).toBeNull();
    });
});

describe('3. the confirmation states the exact scope', () => {
    it('3a. one fundraiser is named in the question, with its date and count', async () => {
        const dash = await rowsOf(board());
        const lane = buildPrepModel(dash.prep, dash.prepCampaigns).ready;
        const msg = prepConfirmMessage(describePrepAction('start_prep', ['a1', 'a2', 'a3'], lane));
        expect(msg).toContain(`Start Prep for 3 ${ORG_A} orders?`);
        expect(msg).toContain(`${ORG_A} (delivery Oct 21, 2026) — 3 orders`);
        expect(msg).toContain('Each order moves as a whole, including every bundle in it.');
        expect(msg).not.toContain(ORG_B);
    });

    it('3b. several fundraisers are each listed, and the counts sum to the request', async () => {
        const dash = await rowsOf(board());
        const lane = buildPrepModel(dash.prep, dash.prepCampaigns).ready;
        const scope = describePrepAction('mark_packed', ['a1', 'b1', 'b2', 'c1'], lane);
        expect(scope.lines.reduce((n, l) => n + l.count, 0)).toBe(scope.total);
        expect(scope.total).toBe(4);
        const msg = prepConfirmMessage(scope);
        expect(msg).toContain('Mark 4 orders Packed & Ready?');
        expect(msg).toContain(`${ORG_A} (delivery Oct 21, 2026) — 1 order`);
        expect(msg).toContain(`${ORG_B} (delivery Oct 27, 2026) — 2 orders`);
        expect(msg).toContain(`${ORG_C} (delivery Oct 27, 2026) — 1 order`);
    });

    it('3c. an ordinary-only action has no fundraiser lines and says it moves whole orders', async () => {
        const dash = await rowsOf(board());
        const lane = buildPrepModel(dash.prep, dash.prepCampaigns).ready;
        const msg = prepConfirmMessage(describePrepAction('start_prep', ['o1', 'o3'], lane));
        expect(msg).toBe('Start Prep for 2 orders?\n\nEach order moves as a whole, including every bundle in it.\nNothing outside these orders is changed.');
    });

    it('3d. a refusal is reported as "nothing changed" and asks for a reload — never a retry', () => {
        for (const [status, code] of [[409, 'STATUS_CHANGED_CONCURRENTLY'], [400, 'ILLEGAL_STATUS_TRANSITION'], [404, 'ORDER_NOT_FOUND'], [400, 'ORDER_CANCELED']] as const) {
            const f = describePrepFailure(status, code);
            expect(f.stale).toBe(true);
            expect(f.message).toContain('nothing was changed');
        }
        expect(describePrepFailure(401).stale).toBe(false);
        expect(describePrepFailure(500).message).toContain('Nothing was changed');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE REAL DASHBOARD ROUTE
// ═════════════════════════════════════════════════════════════════════════════
describe('4. the dashboard keeps the kitchen aggregate AND the exact sources behind it', () => {
    it('4a. the aggregate is unchanged: one row per bundle + status + tier, totals span every campaign', async () => {
        const dash = await rowsOf(board());
        const ff = dash.prep.find((r: any) => r.bundle_id === 'b-ff');
        expect(dash.prep).toHaveLength(2);                                  // FF and KETO — NOT one row per campaign
        expect(ff.total_quantity).toBe(15);                                  // A6 + B3 + C4 + ordinary 2
        expect(ff.order_count).toBe(8);                                      // a1 a2 a3 b1 b2 c1 o1 o3
        expect(dash.prep.find((r: any) => r.bundle_id === 'b-keto').total_quantity).toBe(4);
        expect(Object.keys(ff).sort()).toEqual(['bundle_id', 'bundle_name', 'order_count', 'recipes', 'sku', 'sources', 'status', 'total_quantity', 'variant_size']);
    });

    it('4b. every source is exact: order id, raw signals, quantity and the OrderItem ids — and they add up to the card', async () => {
        const dash = await rowsOf(board());
        for (const row of dash.prep) {
            expect(row.sources.length).toBe(row.order_count);
            expect(row.sources.reduce((n: number, s: any) => n + s.quantity, 0)).toBe(row.total_quantity);
            for (const s of row.sources) expect(Object.keys(s).sort()).toEqual(['campaign_id', 'order_id', 'order_item_ids', 'quantity', 'source']);
        }
        const ff = dash.prep.find((r: any) => r.bundle_id === 'b-ff');
        const a2 = ff.sources.find((s: any) => s.order_id === 'a2');
        expect(a2).toMatchObject({ source: 'fundraiser', campaign_id: CAMP_A, quantity: 1 });
        expect(a2.order_item_ids).toHaveLength(1);
        expect(ff.sources.find((s: any) => s.order_id === 'o1')).toMatchObject({ source: 'manual', campaign_id: null });
    });

    it('4c. two lines of the same bundle and tier on ONE order are one source (quantities add, both item ids kept)', async () => {
        seq = 0;
        const dash = await rowsOf([order('twin', CA, [line(FF, 2), line(FF, 3)])]);
        const row = dash.prep[0];
        expect(row.sources).toHaveLength(1);
        expect(row.sources[0].quantity).toBe(5);
        expect(row.sources[0].order_item_ids).toHaveLength(2);
        expect(row.total_quantity).toBe(5);
    });

    it('4d. campaign label data comes with the rows — id, name, delivery DATE and the owning organization — and nothing else', async () => {
        const dash = await rowsOf(board());
        expect(Object.keys(dash.prepCampaigns).sort()).toEqual([CAMP_A, CAMP_B, CAMP_C].sort());
        for (const c of Object.values<any>(dash.prepCampaigns)) {
            expect(Object.keys(c).sort()).toEqual(['customer', 'delivery_date', 'id', 'name']);
            expect(Object.keys(c.customer)).toEqual(['name']);
        }
        expect(dash.prepCampaigns[CAMP_A]).toMatchObject({ name: `${ORG_A} Fundraiser`, delivery_date: '2026-10-21T00:00:00.000Z', customer: { name: ORG_A } });
    });

    it('4e. no supporter PII reaches the Prep payload: no email, phone, address, name or note', async () => {
        const dash = await rowsOf(board());
        const wire = JSON.stringify({ prep: dash.prep, prepCampaigns: dash.prepCampaigns });
        for (const p of PII) expect(wire).not.toContain(p);
    });

    it('4f. a canceled order never reaches the board, so it can neither be selected nor block a selection', async () => {
        const dash = await rowsOf(board());
        const all = dash.prep.flatMap((r: any) => r.sources.map((s: any) => s.order_id));
        expect(all).not.toContain('x1');
        expect(dash.prep.find((r: any) => r.bundle_id === 'b-ff').total_quantity).toBe(15); // the 9 canceled units are not counted
    });

    it('4g. WHICH orders reach the kitchen is unchanged: the Prep query WHERE, and its explicit campaign select', async () => {
        const seen: any[] = [];
        const rows = new FakeOrderDb(board());
        (global as any).__prepDb = { order: { findMany: async (a: any) => { seen.push(a); return rows.order.findMany(a); } } };
        await getDashboard();
        const prepQuery = seen.find((a) => Array.isArray(a?.where?.status?.in) && a.where.status.in.includes('production_ready'));
        expect(prepQuery.where).toEqual({
            business_id: BIZ, canceled_at: null,
            status: { in: ['production_ready', 'APPROVED', 'in_production', 'IN_PRODUCTION'] },
            NOT: { status: 'fundraiser_hold' },
        });
        expect(prepQuery.include.campaign).toEqual({ select: { id: true, name: true, delivery_date: true, customer: { select: { name: true } } } });
        expect(prepQuery.select).toBeUndefined();
    });

    it('4h. the source text keeps the pinned aggregation key and adds no new query', () => {
        const dash = strip(read(DASH));
        expect(dash).toMatch(/const key = `\$\{bid\}-\$\{status\}-\$\{variantSize \?\? 'unknown'\}`/);
        expect(dash).toMatch(/prep: Array\.from\(prepMap\.values\(\)\)/);
        expect((dash.match(/prisma\.order\.findMany/g) || []).length).toBe(4);
        expect((dash.match(/business_id: businessId/g) || []).length).toBe(4);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. END TO END: real dashboard -> real PrepList -> real bulk-status -> real dashboard
// ═════════════════════════════════════════════════════════════════════════════
const statuses = (d: FakeOrderDb, idList: string[]) => d.statusOf(idList);

describe('5. SCENARIO A — starting one fundraiser moves that fundraiser and no other', () => {
    it('5a. A, B and C share one bundle; ticking A and starting prep moves exactly A', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();

        expect(bulkCalls()).toHaveLength(1);
        expect(bulkCalls()[0].body).toEqual({ orderIds: expect.any(Array), status: 'in_production' });
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3']);
        expect(Object.keys(bulkCalls()[0].body)).toEqual(['orderIds', 'status']);
        expect(statuses(db, ['a1', 'a2', 'a3'])).toEqual({ a1: 'in_production', a2: 'in_production', a3: 'in_production' });
        expect(statuses(db, ['b1', 'b2', 'c1', 'o1', 'o2', 'o3'])).toEqual({ b1: 'production_ready', b2: 'production_ready', c1: 'production_ready', o1: 'production_ready', o2: 'production_ready', o3: 'production_ready' });
        expect(db.writes.map((w) => w.id).sort()).toEqual(['a1', 'a2', 'a3']);
        expect(refreshRequests).toBe(1);
        expect(mockToast.success).toHaveBeenCalledWith('Status Updated');
    });

    it('5b. the confirmation named A and 3 orders before anything was sent', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(confirmLog).toHaveLength(1);
        expect(confirmLog[0]).toContain(`Start Prep for 3 ${ORG_A} orders?`);
        expect(confirmLog[0]).toContain('delivery Oct 21, 2026');
    });

    it('5c. declining the confirmation sends nothing and changes nothing', async () => {
        confirmAnswer = false;
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(bulkCalls()).toHaveLength(0);
        expect(db.writes).toEqual([]);
    });

    it('5d. a fundraiser that is not selected is never sent — even with three sharing the bundle', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_B).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 2 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['b1', 'b2']);          // not a*, not c1, not ordinary
        expect(statuses(db, ['a1', 'c1', 'o1']).a1).toBe('production_ready');
        expect(statuses(db, ['b1', 'b2'])).toEqual({ b1: 'in_production', b2: 'in_production' });
    });
});

describe('5. SCENARIO B — intentionally starting two fundraisers moves exactly those two', () => {
    it('5e. A + C together: the exact union moves and B stays', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        wave(ui.m.tree, ORG_C).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 4 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3', 'c1']);
        expect(statuses(db, ['a1', 'a2', 'a3', 'c1'])).toEqual({ a1: 'in_production', a2: 'in_production', a3: 'in_production', c1: 'in_production' });
        expect(statuses(db, ['b1', 'b2'])).toEqual({ b1: 'production_ready', b2: 'production_ready' });
        expect(confirmLog[0]).toContain(`${ORG_A} (delivery Oct 21, 2026) — 3 orders`);
        expect(confirmLog[0]).toContain(`${ORG_C} (delivery Oct 27, 2026) — 1 order`);
        expect(confirmLog[0]).not.toContain(ORG_B);
    });

    it('5f. "select all for this date" ticks exactly the campaigns delivering that date', async () => {
        use(board());
        const ui = await open();
        button(ui.m.tree, /Select all for this date/).props.onClick(); ui.m.render();   // the only multi-campaign date is Oct 27 (B + C)
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['b1', 'b2', 'c1']);
        expect(statuses(db, ['a1']).a1).toBe('production_ready');
    });
});

describe('5. SCENARIO C — totals refresh from the server after a fundraiser moves lanes', () => {
    it('5g. To Prep and In Prep, their totals and the campaign contributions all follow the server', async () => {
        use(board());
        const ui = await open();
        const ffBefore = ui.dash.prep.find((r: any) => r.bundle_id === 'b-ff' && r.status === 'production_ready');
        expect(ffBefore.total_quantity).toBe(15);

        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        const after = await ui.reload(); ui.m.render();

        const ffReady = after.prep.find((r: any) => r.bundle_id === 'b-ff' && r.status === 'production_ready');
        const ffInProd = after.prep.find((r: any) => r.bundle_id === 'b-ff' && r.status === 'in_production');
        expect(ffReady.total_quantity).toBe(9);                      // 15 - A's 6
        expect(ffInProd.total_quantity).toBe(6);
        expect(ffReady.total_quantity + ffInProd.total_quantity).toBe(15);
        const model = buildPrepModel(after.prep, after.prepCampaigns);
        expect(model.ready.waves.map((w) => w.campaignId)).toEqual([CAMP_B, CAMP_C]);
        expect(model.inprod.waves.map((w) => w.campaignId)).toEqual([CAMP_A]);
        // the cards' campaign contributions always sum to the card's own total
        for (const row of after.prep) {
            expect(rowBreakdown(row, model).reduce((n, p) => n + p.units, 0)).toBe(row.total_quantity);
        }
        // and the screen shows it: A now offers "Mark Packed & Ready", not "Start Prep"
        expect(waveBoxes(ui.m.tree, ORG_A)).toHaveLength(1);
        expect(maybeButtons(ui.m.tree, /^Mark Packed & Ready — choose fundraisers$/)).toHaveLength(1);
        expect(refreshRequests).toBe(1);
    });
});

describe('5. SCENARIO D — marking ONE fundraiser packed puts only that fundraiser in Packed & Ready', () => {
    it('5h. only A reaches the Packed & Ready lane', async () => {
        use(board());
        const ui = await open();
        // start A and B, then mark only A packed
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        wave(ui.m.tree, ORG_B).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 5 selected$/).props.onClick();
        await ui.reload(); ui.m.render();

        const inPrepA = findAll(ui.m.tree, (el) => el.type === 'section' && el.props['aria-label'] === 'Fundraisers in prep')[0];
        const aBox = findAll(inPrepA, (el) => el.type === 'button' && el.props.role === 'checkbox' && textOf(el.props.children).includes(ORG_A))[0];
        aBox.props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Mark Packed & Ready — 3 selected$/).props.onClick();

        const marks = bulkCalls().filter((c) => c.body.status === 'ready_to_ship');
        expect(marks).toHaveLength(1);
        expect(sorted(marks[0].body.orderIds)).toEqual(['a1', 'a2', 'a3']);
        const dash = await getDashboard();
        expect(sorted(dash.completed.map((o: any) => o.id))).toEqual(['a1', 'a2', 'a3']);          // Packed & Ready holds A only
        expect(statuses(db, ['b1', 'b2'])).toEqual({ b1: 'in_production', b2: 'in_production' }); // B is still being prepped
        expect(statuses(db, ['c1']).c1).toBe('production_ready');                                  // C untouched
        expect(confirmLog[confirmLog.length - 1]).toContain(`Mark 3 ${ORG_A} orders Packed & Ready?`);
    });
});

describe('5. SCENARIO E — ordinary orders that share the bundle are left alone, and vice versa', () => {
    it('5i. the card shows combined demand with each contributor; the fundraiser action never carries an ordinary order', async () => {
        use(board());
        const ui = await open();
        const ff = cardFor(ui.m.tree, 'Family Friendly (Serves 2)');
        const chips = textOf(findAll(ff, (el) => el.props && el.props['data-prep-breakdown'] !== undefined)[0].props.children);
        expect(chips).toContain(`${ORG_A} · Oct 21, 2026 · 6`);
        expect(chips).toContain(`${ORG_B} · Oct 27, 2026 · 3`);
        expect(chips).toContain(`${ORG_C} · Oct 27, 2026 · 4`);
        expect(chips).toContain('Other orders · 2');

        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        wave(ui.m.tree, ORG_B).props.onClick(); ui.m.render();
        wave(ui.m.tree, ORG_C).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 6 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1']);
        expect(statuses(db, ['o1', 'o2', 'o3'])).toEqual({ o1: 'production_ready', o2: 'production_ready', o3: 'production_ready' });
    });

    it('5j. the card\'s own button carries only its ORDINARY orders, and says so', async () => {
        use(board());
        const ui = await open();
        const ff = cardFor(ui.m.tree, 'Family Friendly (Serves 2)');
        const btn = findAll(ff, (el) => el.type === 'button' && /Start Prep/.test(textOf(el.props.children)))[0];
        expect(textOf(btn.props.children)).toBe('Start Prep — 2 other orders');          // o1 and o3 — not the fundraisers
        await btn.props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['o1', 'o3']);
        expect(confirmLog[0]).toBe('Start Prep for 2 orders?\n\nEach order moves as a whole, including every bundle in it.\nNothing outside these orders is changed.');
        expect(statuses(db, ['o1', 'o3'])).toEqual({ o1: 'in_production', o3: 'in_production' });
        expect(statuses(db, ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'])).toEqual({ a1: 'production_ready', a2: 'production_ready', a3: 'production_ready', b1: 'production_ready', b2: 'production_ready', c1: 'production_ready' });
    });

    it('5k. a card made only of fundraiser orders offers NO bundle-wide button; it points to the fundraiser list', async () => {
        seq = 0;
        use([order('a1', CA, [line(FF, 2)]), order('b1', CB, [line(FF, 1)])]);
        const ui = await open();
        const ff = cardFor(ui.m.tree, 'Family Friendly (Serves 2)');
        expect(findAll(ff, (el) => el.type === 'button')).toHaveLength(0);
        expect(textOf(ff.props.children)).toContain('Start these from “Fundraisers ready to start”.');
    });

    it('5l. an ordinary-only board looks and acts as before: no panel, no chips, the original buttons', async () => {
        seq = 0;
        use([order('o1', null, [line(FF, 2)]), order('o2', null, [line(KETO, 1)])]);
        const ui = await open();
        const html = renderToStaticMarkup(createElement(require('@/components/production/PrepList').default, { items: ui.dash.prep, campaigns: ui.dash.prepCampaigns, onRefresh: () => {} }));
        expect(html).not.toContain('Fundraisers ready to start');
        expect(html).not.toContain('data-prep-breakdown');
        expect(html).not.toContain('Kitchen totals');
        expect((html.match(/Start Prep/g) || []).length).toBe(2);
        expect(html).not.toContain('other order');
        // The two cards carry the original, unqualified button and each acts on its own orders.
        const starts = maybeButtons(ui.m.tree, /^Start Prep$/);
        expect(starts).toHaveLength(2);
        await starts[0].props.onClick();
        expect(bulkCalls()).toHaveLength(1);
        expect(bulkCalls()[0].body.status).toBe('in_production');
        expect(confirmLog[0]).toBe('Start Prep for 1 order?\n\nEach order moves as a whole, including every bundle in it.\nNothing outside these orders is changed.');
    });
});

describe('5. SCENARIO F — a multi-bundle order is ONE order-level action', () => {
    it('5m. an order with two bundles appears on two cards but moves once, whole, with one id', async () => {
        use(board());
        const ui = await open();
        const ffSources = ui.dash.prep.find((r: any) => r.bundle_id === 'b-ff').sources.map((s: any) => s.order_id);
        const ketoSources = ui.dash.prep.find((r: any) => r.bundle_id === 'b-keto').sources.map((s: any) => s.order_id);
        expect(ffSources).toContain('a2'); expect(ketoSources).toContain('a2');          // on both cards...

        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(bulkCalls()[0].body.orderIds.filter((i: string) => i === 'a2')).toHaveLength(1); // ...but sent once
        const after = await ui.reload();
        // moved WHOLE: no card of To Prep still lists a2, and BOTH of its bundles are now In Prep
        for (const row of after.prep.filter((r: any) => r.status === 'production_ready')) expect(row.sources.map((s: any) => s.order_id)).not.toContain('a2');
        for (const bid of ['b-ff', 'b-keto']) {
            const inProd = after.prep.find((r: any) => r.bundle_id === bid && r.status === 'in_production');
            expect(inProd.sources.map((s: any) => s.order_id)).toContain('a2');
        }
    });

    it('5n. the wave says what will move: every bundle in its orders, so no bundle appears to move alone', async () => {
        use(board());
        const ui = await open();
        const aRow = wave(ui.m.tree, ORG_A);
        const t = textOf(aRow.props.children);
        expect(t).toContain('3 orders · 7 bundles');
        expect(t).toContain('Family Friendly (Serves 2) ×6');
        expect(t).toContain('Keto Bundle (Serves 2) ×1');
        // and the explanation is on screen
        expect(textOf(ui.m.tree)).toContain('Each one moves as whole orders — every bundle in them');
    });

    it('5o. an ordinary multi-bundle order moves whole from either card, and its other card follows after the refresh', async () => {
        use(board());
        const ui = await open();
        const keto = cardFor(ui.m.tree, 'Keto Bundle (Serves 2)');
        await findAll(keto, (el) => el.type === 'button' && /Start Prep/.test(textOf(el.props.children)))[0].props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['o2', 'o3']);                 // never a1/a2/a3
        const after = await ui.reload();
        for (const row of after.prep.filter((r: any) => r.status === 'production_ready')) expect(row.sources.map((s: any) => s.order_id)).not.toContain('o3');
        expect(statuses(db, ['o3']).o3).toBe('in_production');
    });
});

describe('6. nothing is advanced by accident', () => {
    it('6a. no selection in a lane of several fundraisers: the action is disabled, refuses to send, and says so', async () => {
        use(board());
        const ui = await open();
        const act = button(ui.m.tree, /^Start Prep — choose fundraisers$/);
        expect(act.props.disabled).toBe(true);
        await act.props.onClick();                                // even if clicked anyway
        expect(fetchLog).toHaveLength(0);
        expect(confirmLog).toHaveLength(0);
        expect(db.writes).toEqual([]);
        expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('nothing was changed'));
        expect(textOf(ui.m.tree)).toContain('Nothing is selected, so nothing will move.');
    });

    it('6b. a stale order is never widened into a broader query: one request, nothing written, lanes reloaded', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        // while the screen was open, someone moved a2 PAST packed — out of reach of Start Prep
        db.rows.find((r) => r.id === 'a2')!.status = 'ready_to_ship';
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();

        expect(bulkCalls()).toHaveLength(1);                                             // exactly one request; no fallback
        expect(fetchLog.filter((f) => /batch-update-by-bundle/.test(f.url))).toHaveLength(0);
        expect(db.writes).toEqual([]);                                                   // all-or-nothing: a1 and a3 did NOT move either
        expect(statuses(db, ['a1', 'a3'])).toEqual({ a1: 'production_ready', a3: 'production_ready' });
        expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('changed since this screen loaded'));
        expect(refreshRequests).toBe(1);                                                 // reload so the operator sees the truth
    });

    it('6c. an order already started by someone else is harmless: the rest still move and it is left as it is', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        db.rows.find((r) => r.id === 'a2')!.status = 'in_production';
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(statuses(db, ['a1', 'a2', 'a3'])).toEqual({ a1: 'in_production', a2: 'in_production', a3: 'in_production' });
        expect(db.writes.map((w) => w.id).sort()).toEqual(['a1', 'a3']);               // a2 verified, never rewritten
    });

    it('6d. a stale TICK is pruned: an order that left the lane is not sent', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        // a2 leaves To Prep (someone started it) and the screen refreshes
        db.rows.find((r) => r.id === 'a2')!.status = 'in_production';
        await ui.reload(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 2 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['a1', 'a3']);              // a2 is not in the request
    });

    it('6e. a late-arriving order is NOT silently swept in: only the orders the operator saw are sent', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        // another invoice settles: a4 (campaign A) is released into To Prep; the screen reloads
        seq = 100;
        db.rows.push(JSON.parse(JSON.stringify(order('a4', CA, [line(FF, 1)]))));
        await ui.reload(); ui.m.render();
        expect(wave(ui.m.tree, ORG_A).props['aria-checked']).toBe('mixed');             // 3 of 4 ticked — visibly incomplete
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(sorted(bulkCalls()[0].body.orderIds)).toEqual(['a1', 'a2', 'a3']);        // NOT a4
        expect(statuses(db, ['a4']).a4).toBe('production_ready');
    });

    it('6f. a CANCELED order that shares the bundle neither appears nor blocks the selected fundraiser', async () => {
        use(board());
        // CONTROL: the old bundle-wide route trips over x1 (canceled, same bundle, same status) and refuses everything.
        const { POST: oldRoute } = require('@/app/api/orders/batch-update-by-bundle/route');
        const old = await oldRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ bundleId: 'b-ff', currentStatus: 'production_ready', newStatus: 'in_production' }) }));
        expect(old.status).toBe(400);
        expect((await old.json()).code).toBe('ORDER_CANCELED');
        expect(db.writes).toEqual([]);

        // The exact-id flow never selected x1, so it simply works.
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        expect(statuses(db, ['a1', 'a2', 'a3'])).toEqual({ a1: 'in_production', a2: 'in_production', a3: 'in_production' });
        expect(db.rows.find((r) => r.id === 'x1')!.status).toBe('production_ready');     // the canceled order was never touched
    });

    it('6g. the old bundle-wide behaviour is exactly the defect: it moves every campaign sharing the bundle', async () => {
        // Documents WHY the UI no longer uses it: same data, no canceled blocker.
        use(board().filter((o) => o.id !== 'x1'));
        const { POST: oldRoute } = require('@/app/api/orders/batch-update-by-bundle/route');
        const res = await oldRoute(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify({ bundleId: 'b-ff', currentStatus: 'production_ready', newStatus: 'in_production' }) }));
        expect(res.status).toBe(200);
        expect(sorted(db.writes.map((w) => w.id))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'o1', 'o3']);   // EVERY campaign + ordinary
    });

    it('6h. the Prep UI never calls the bundle-wide route, and its request carries only ids and a status', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_C).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 1 selected$/).props.onClick();
        expect(fetchLog.every((f) => !/batch-update-by-bundle/.test(f.url))).toBe(true);
        expect(Object.keys(fetchLog[0].body).sort()).toEqual(['orderIds', 'status']);
        const src = strip(read(PREPLIST));
        expect(src).not.toMatch(/batch-update-by-bundle|currentStatus|bundleId/);
        expect(src).toMatch(/'\/api\/orders\/bulk-status'/);
    });
});

describe('7. same organization, two campaigns', () => {
    it('7a. two Bravo campaigns are two checkboxes, tagged, and ticking one moves only its orders', async () => {
        use(board([order('d1', CB2, [line(FF, 5)])]));
        const ui = await open();
        const bravo = waveBoxes(ui.m.tree, ORG_B);
        expect(bravo).toHaveLength(2);
        const spring = bravo.find((b) => textOf(b.props.children).includes('1 order ·'))!;
        spring.props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 1 selected$/).props.onClick();
        expect(bulkCalls()[0].body.orderIds).toEqual(['d1']);                            // not b1/b2 (same organization, other campaign)
        expect(statuses(db, ['b1', 'b2']).b1).toBe('production_ready');
    });
});

describe('8. meal labels for one fundraiser use that fundraiser\'s own quantities', () => {
    it('8a. counts are physicalMealCount(that fundraiser\'s units, per-bundle quantity), merged by recipe + tier — not the card total', async () => {
        use(board());
        const ui = await open();
        // A AND B are both in prep, so each In Prep card's total spans two fundraisers.
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        wave(ui.m.tree, ORG_B).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 5 selected$/).props.onClick();
        const after = await ui.reload();
        expect(after.prep.find((r: any) => r.bundle_id === 'b-ff' && r.status === 'in_production').total_quantity).toBe(9);   // A 6 + B 3
        const lane = buildPrepModel(after.prep, after.prepCampaigns).inprod;
        const a = lane.waves.find((w) => w.campaignId === CAMP_A)!; const b = lane.waves.find((w) => w.campaignId === CAMP_B)!;
        const by = (items: any[]) => Object.fromEntries(items.map((i) => [i.id, i.copies]));
        // A contributes FF 6 and KETO 1. Garlic Bread is in both bundles at the same tier: 6x2 + 1x1 = 13.
        const itemsA = waveMealLabelItems(after.prep, a, 'inprod');
        expect(by(itemsA)).toEqual({ 'r-ziti': 6, 'r-chili': 6, 'r-shared': 13, 'r-steak': 1 });
        expect(itemsA.every((i) => i.qty === i.copies && i.unit === 'ea' && i.servingTier === 'Serves 2')).toBe(true);
        // B contributes only FF 3 (the card says 9): its labels must not include A's meals.
        expect(by(waveMealLabelItems(after.prep, b, 'inprod'))).toEqual({ 'r-ziti': 3, 'r-chili': 3, 'r-shared': 6 });
    });

    it('8b. the printer button queues that batch (read-only) and goes to the existing print page', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_A).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 3 selected$/).props.onClick();
        await ui.reload(); ui.m.render();
        const before = JSON.stringify(db.rows);
        const printer = findAll(ui.m.tree, (el) => el.type === 'button' && el.props.title === "Meal labels for this fundraiser's orders")[0];
        await printer.props.onClick();
        const batch = JSON.parse(store.get(PRINT_BATCH_STORAGE_KEY) as string);
        expect(batch.name).toBe(`Production: ${ORG_A}`);
        expect(batch.businessId).toBe(BIZ);
        expect(batch.items.map((i: any) => i.id).sort()).toEqual(['r-chili', 'r-shared', 'r-steak', 'r-ziti']);
        expect(mockPush).toHaveBeenCalledWith('/production/print-batch');
        expect(bulkCalls().filter((c) => c.body.orderIds && c.body.status === 'ready_to_ship')).toHaveLength(0);
        expect(JSON.stringify(db.rows)).toBe(before);                                    // printing changed no order
    });

    it('8c. the existing per-card print (the cross-campaign total) is untouched', () => {
        const src = strip(read(PREPLIST));
        expect(src).toMatch(/physicalMealCount\(item\.total_quantity, r\.quantity\)/);
        expect(src).toMatch(/name: `Production: \$\{item\.bundle_name\}`/);
    });
});

describe('9. the Packed & Ready lane, Delivery and the release gate are untouched', () => {
    it('9a. an order marked packed lands in the lane exactly as before (the same query and shape)', async () => {
        use(board());
        const ui = await open();
        wave(ui.m.tree, ORG_C).props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Start Prep — 1 selected$/).props.onClick();
        await ui.reload(); ui.m.render();
        const sec = findAll(ui.m.tree, (el) => el.type === 'section' && el.props['aria-label'] === 'Fundraisers in prep')[0];
        findAll(sec, (el) => el.type === 'button' && el.props.role === 'checkbox')[0].props.onClick(); ui.m.render();
        await button(ui.m.tree, /^Mark Packed & Ready — 1 selected$/).props.onClick();
        const dash = await getDashboard();
        expect(dash.completed.map((o: any) => o.id)).toEqual(['c1']);
        expect(dash.completed[0].campaign).toEqual({ id: CAMP_C, name: `${ORG_C} Fundraiser`, delivery_date: '2026-10-27T00:00:00.000Z', customer: { name: ORG_C } });
    });

    it('9b. no Delivery, release, payment, invoice or schema file changed shape because of this task', () => {
        const handoff = strip(read('app/api/delivery/handoff/route.ts'));
        expect(handoff).not.toMatch(/prepWaves|PrepWavePanel/);
        for (const f of ['app/api/delivery/campaign-delivered/route.ts', 'lib/delivery/deliveryStops.ts', 'lib/invoiceSettlementTransition.ts', 'lib/orderStatus.ts', 'lib/productionIntake.ts', 'app/api/delivery/handoff/route.ts']) {
            expect(strip(read(f))).not.toMatch(/prepWaves|PrepWavePanel|buildPrepStatusRequest/);
        }
        expect(read('prisma/schema.prisma')).not.toMatch(/prep_wave|production_batch|PrepWave/i);
    });

    it('9c. both status routes are exactly as they were: bulk-status is reused unmodified, the bundle-wide route is left in place', () => {
        const bulk = strip(read(BULK));
        expect(bulk).toMatch(/const BATCHABLE_TARGETS = new Set\(\['in_production', 'ready_to_ship'\]\)/);
        expect(bulk).toMatch(/id: \{ in: uniqueIds \}/);
        expect(bulk).toMatch(/prisma\.\$transaction/);
        expect(bulk).not.toMatch(/prepWaves|campaign/i);
        expect(strip(read(BATCH))).toMatch(/items: \{ some: \{ bundle_id: bundleId \} \}/);     // not edited, not removed
    });

    it('9d. the presentational panel performs no I/O and knows nothing about statuses or APIs', () => {
        expect(strip(read(PANEL))).not.toMatch(/fetch\(|localStorage|prisma|useRouter|\/api\/|released_to_delivery|handoff/);
    });
});

describe('10. the unmodified exact-id route behaves as the design relies on', () => {
    const post = async (body: any) => {
        const { POST } = require('@/app/api/orders/bulk-status/route');
        const res = await POST(new Request('http://localhost/api/orders/bulk-status', { method: 'POST', body: JSON.stringify(body) }));
        return { status: res.status, body: await res.json() };
    };

    it('10a. exact ids move exactly those orders, all-or-nothing, and report what changed', async () => {
        use(board());
        const r = await post({ orderIds: ['a1', 'a3'], status: 'in_production' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ count: 2, updated: 2, unchanged: 0 });
        expect(sorted(r.body.orderIds)).toEqual(['a1', 'a3']);
        expect(statuses(db, ['a2', 'b1']).a2).toBe('production_ready');
    });

    it('10b. a foreign / unknown id refuses the whole batch with 404 and writes nothing', async () => {
        use(board());
        const r = await post({ orderIds: ['a1', 'someone-elses-order'], status: 'in_production' });
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('ORDER_NOT_FOUND');
        expect(db.writes).toEqual([]);
    });

    it('10c. an empty or malformed batch is refused, and only the two kitchen targets are accepted', async () => {
        use(board());
        expect((await post({ orderIds: [], status: 'in_production' })).status).toBe(400);
        expect((await post({ orderIds: 'a1', status: 'in_production' })).status).toBe(400);
        expect((await post({ orderIds: ['a1'], status: 'delivered' })).body.code).toBe('TRANSITION_NOT_BATCHABLE');
        expect((await post({ orderIds: ['a1'], status: 'production_ready' })).body.code).toBe('TRANSITION_NOT_BATCHABLE');
        expect(db.writes).toEqual([]);
    });

    it('10d. a canceled order inside the batch refuses the batch — which is why the UI never selects one', async () => {
        use(board());
        const r = await post({ orderIds: ['a1', 'x1'], status: 'in_production' });
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('ORDER_CANCELED');
        expect(db.writes).toEqual([]);
    });

    it('10e. a concurrent change mid-batch rolls EVERYTHING back and is never reported as success', async () => {
        use(board());
        // a3 changes between the preflight read and its write: the compare-and-set misses and the transaction aborts.
        const realUpdate = db.order.updateMany;
        db.order.updateMany = async (args: any) => {
            if (args.where.id === 'a3') db.rows.find((r) => r.id === 'a3')!.status = 'in_production';
            return realUpdate(args);
        };
        const r = await post({ orderIds: ['a1', 'a2', 'a3'], status: 'in_production' });
        // The route answers 409 STATUS_CHANGED_CONCURRENTLY in the production build. Under ts-jest
        // (tsconfig target es5) a subclassed Error loses its prototype, so the route's own
        // `instanceof` check cannot match here and it falls through to its generic 500. Either way the
        // contract this design relies on holds: not a success, and nothing is left half-moved.
        expect([409, 500]).toContain(r.status);
        expect(r.status).not.toBe(200);
        expect(statuses(db, ['a1', 'a2'])).toEqual({ a1: 'production_ready', a2: 'production_ready' }); // rolled back
        expect(db.writes).toEqual([]);
    });
});
