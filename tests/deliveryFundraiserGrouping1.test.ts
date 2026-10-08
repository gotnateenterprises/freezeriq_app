/**
 * DELIVERY-FUNDRAISER-GROUPING-1 — one fundraiser campaign is ONE delivery stop.
 *
 * Freezer Chef delivers a whole fundraiser to the organization; the coordinator
 * hands the boxes out later with the Pickup Tracker. So the Delivery board shows
 * one stop per FundraiserCampaign, ordinary customers keep one stop per order,
 * and Mark Delivered on a fundraiser stop delivers all of its orders at once —
 * all or nothing — without touching anything about supporter pickup.
 *
 * Numbers in the test names map to the phase's required matrix. Route tests run
 * the REAL handlers (queue, stats, optimize, reorder, campaign-delivered) against
 * tests/helpers/deliveryOrderStore.ts, a stateful store with real rollback, so
 * "nothing was half delivered" is asserted on rows, not on mock call counts.
 * All data is fictional.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createDeliveryOrderStore, type DeliveryOrderStore, type StoreRow } from './helpers/deliveryOrderStore';
import {
    buildDeliveryStops,
    looksLikeStreetAddress,
    navigableStops,
    orderIdsInRouteOrder,
    resolveFundraiserStopAddress,
    FUNDRAISER_ADDRESS_NEEDED_LABEL,
    type DeliveryStop,
} from '@/lib/delivery/deliveryStops';
import { computePackagingNeed } from '@/lib/deliveryPackaging';
import { isPickupDocumentOrder, pickupDocumentOrderWhere } from '@/lib/coordinatorSupporterOrders';
import { supporterPaymentState } from '@/lib/supporterPayment';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__dfgPrisma; } }));
jest.mock('@/auth', () => ({ auth: async () => (global as any).__dfgSession }));

const BIZ = 'biz-dfg';
const OTHER_BIZ = 'biz-dfg-other';
const RELEASED = new Date('2026-10-05T15:00:00Z');

// ── Fixture builders (fictional) ─────────────────────────────────────────────
const org = (name: string, address: string | null = '500 Example Rd, Exampleton IL 61900') => ({
    name, delivery_address: address, contact_name: 'Pat Coordinator', contact_phone: '217-555-0199',
});
const campaign = (id: string, over: Record<string, any> = {}) => ({
    id, name: `${id} Fundraiser`, pickup_location: 'Fellowship Hall', delivery_date: '2026-10-07T00:00:00.000Z',
    delivery_time: '4:00 PM', customer: org('Example County Farm Bureau'), ...over,
});
const item = (id: string, size: 'serves_5' | 'serves_2', qty = 1) => ({
    id, bundle_id: `bundle-${size}`, quantity: qty, variant_size: size, item_name: `Bundle ${size}`,
    bundle: { id: `bundle-${size}`, name: `Comfort Foods (${size === 'serves_5' ? 'Serves 5' : 'Serves 2'})`, contents: [{ quantity: 4, recipe: { container_type: 'tray' } }] },
});
let seq = 0;
function fundraiserOrder(id: string, camp: ReturnType<typeof campaign>, over: Record<string, any> = {}): StoreRow {
    return {
        id, external_id: `EXT-${id}`, business_id: BIZ, source: 'fundraiser', campaign_id: camp.id, campaign: camp,
        status: 'ready_to_ship', canceled_at: null, released_to_delivery_at: RELEASED, delivery_sequence: seq++,
        delivery_date: null, delivery_address: null, customer_name: `Supporter ${id}`, first_name: 'Supporter', last_name: id,
        paid_at: null, customer: { name: `Supporter ${id}`, delivery_address: null },
        items: [item(`${id}-i1`, 'serves_5')], ...over,
    };
}
function customerOrder(id: string, over: Record<string, any> = {}): StoreRow {
    return {
        id, external_id: `EXT-${id}`, business_id: BIZ, source: 'storefront', campaign_id: null, campaign: null,
        status: 'ready_to_ship', canceled_at: null, released_to_delivery_at: RELEASED, delivery_sequence: seq++,
        delivery_date: '2026-10-07T00:00:00.000Z', delivery_address: `${100 + seq} Main St, Paris IL 61944`,
        customer_name: `Customer ${id}`, first_name: 'Customer', last_name: id, paid_at: null,
        customer: { name: `Customer ${id}`, delivery_address: null }, items: [item(`${id}-i1`, 'serves_2')], ...over,
    };
}
/** What the page passes the builder: queue rows + the resolved display name. */
const asQueueRows = (rows: StoreRow[]) => rows.map((r) => ({ ...r, customerName: r.customer_name }));

// ── Route plumbing ───────────────────────────────────────────────────────────
let store: DeliveryOrderStore;
const useStore = (rows: StoreRow[]) => { store = createDeliveryOrderStore(rows); (global as any).__dfgPrisma = store.client; return store; };
const signIn = (businessId: string | null = BIZ) => { (global as any).__dfgSession = businessId ? { user: { businessId, id: 'user-dfg' } } : null; };
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function call(handler: (r: Request) => Promise<Response>, req: Request) {
    const res = await handler(req);
    return { status: res.status, body: await res.json() };
}
const deliver = (campaignId: string, orderIds: string[]) =>
    call(require('@/app/api/delivery/campaign-delivered/route').POST, post('/api/delivery/campaign-delivered', { campaignId, orderIds }));
const queue = async () => (await call(require('@/app/api/delivery/queue/route').GET, new Request('http://localhost/api/delivery/queue'))).body as any[];
const stopsNow = async () => buildDeliveryStops(asQueueRows(await queue() as any));
const statusOf = (id: string) => store.get(id)!.status;

/** Every column of every row except `status` — to prove a delivery wrote nothing else. */
const allButStatus = () => store.rows.map(({ status, ...rest }) => rest);

beforeAll(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); jest.spyOn(console, 'log').mockImplementation(() => {}); });
beforeEach(() => { seq = 0; signIn(); });

// The acceptance shape: Campaign A (20) + Campaign B (8, same org) + 3 customers.
function acceptanceFixture() {
    const A = campaign('camp-A', { pickup_location: 'Fellowship Hall', customer: org('Example County Farm Bureau') });
    const B = campaign('camp-B', { pickup_location: 'Fellowship Hall', customer: org('Example County Farm Bureau') });
    const a = Array.from({ length: 20 }, (_, i) => fundraiserOrder(`A${String(i + 1).padStart(2, '0')}`, A));
    const b = Array.from({ length: 8 }, (_, i) => fundraiserOrder(`B${String(i + 1).padStart(2, '0')}`, B));
    const c = [customerOrder('C1'), customerOrder('C2'), customerOrder('C3')];
    return { A, B, a, b, c, all: [...a, ...b, ...c] };
}

// ═════════════════════════════════════════════════════════════════════════════
describe('GROUPING', () => {
    it('1. twenty fundraiser orders in one campaign are ONE stop holding all twenty', () => {
        const A = campaign('camp-1');
        const rows = Array.from({ length: 20 }, (_, i) => fundraiserOrder(`o${i}`, A));
        const stops = buildDeliveryStops(asQueueRows(rows));
        expect(stops).toHaveLength(1);
        expect(stops[0]).toMatchObject({ kind: 'fundraiser', campaignId: 'camp-1', id: 'campaign:camp-1', orderCount: 20 });
        expect([...stops[0].orderIds].sort()).toEqual(rows.map((r) => r.id).sort());
    });

    it('2. the same organization running two campaigns gets TWO stops — grouping is by campaign, not organization', () => {
        const sameOrg = org('Example County Farm Bureau');
        const A = campaign('camp-A', { customer: sameOrg });
        const B = campaign('camp-B', { customer: sameOrg });
        const stops = buildDeliveryStops(asQueueRows([fundraiserOrder('a1', A), fundraiserOrder('b1', B), fundraiserOrder('a2', A)]));
        expect(stops.map((s) => s.campaignId).sort()).toEqual(['camp-A', 'camp-B']);
        expect(stops.find((s) => s.campaignId === 'camp-A')!.orderIds.sort()).toEqual(['a1', 'a2']);
    });

    it('3. fundraiser orders group; ordinary customers stay one stop each — the acceptance board is 5 stops, not 31', () => {
        const f = acceptanceFixture();
        const stops = buildDeliveryStops(asQueueRows(f.all));
        expect(stops).toHaveLength(5);
        expect(stops.filter((s) => s.kind === 'fundraiser').map((s) => s.orderCount).sort((x, y) => x - y)).toEqual([8, 20]);
        const customers = stops.filter((s) => s.kind === 'customer');
        expect(customers.map((s) => s.id).sort()).toEqual(['C1', 'C2', 'C3']);
        for (const s of customers) expect(s.orderIds).toEqual([s.id]);
    });

    it('4. two different organizations are separate stops', () => {
        const stops = buildDeliveryStops(asQueueRows([
            fundraiserOrder('x1', campaign('camp-X', { customer: org('Org X') })),
            fundraiserOrder('y1', campaign('camp-Y', { customer: org('Org Y') })),
        ]));
        expect(stops.map((s) => s.title).sort()).toEqual(['Org X', 'Org Y']);
    });

    it('5. a canceled fundraiser order never reaches the board (the existing active-Delivery rule)', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A, { canceled_at: new Date() })]);
        const stops = await stopsNow();
        expect(stops).toHaveLength(1);
        expect(stops[0].orderIds).toEqual(['a1']);
    });

    it('6. an already-delivered order is not work: it is not on the stop and is not counted twice', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A, { status: 'delivered' })]);
        const [stop] = await stopsNow();
        expect(stop.orderIds).toEqual(['a1']);
        expect(stop.boxes.total).toBe(1);
    });

    it('a row with only ONE fundraiser signal is never folded into a campaign stop (classification never guesses)', () => {
        const A = campaign('camp-A');
        const odd = fundraiserOrder('odd', A, { source: 'manual' }); // campaign_id but not a fundraiser source
        const stops = buildDeliveryStops(asQueueRows([fundraiserOrder('a1', A), odd]));
        expect(stops).toHaveLength(2);
        expect(stops.find((s) => s.id === 'odd')!.kind).toBe('ambiguous');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('BOX COUNTS', () => {
    function mixedFixture() {
        const A = campaign('camp-A');
        return [
            fundraiserOrder('f1', A, { items: [item('f1-i1', 'serves_5'), item('f1-i2', 'serves_5')] }),        // 2 large
            fundraiserOrder('f2', A, { items: [item('f2-i1', 'serves_2'), item('f2-i2', 'serves_2')] }),        // 1 large (paired)
            fundraiserOrder('f3', A, { items: [item('f3-i1', 'serves_2')] }),                                    // 1 small
            fundraiserOrder('f4', A, { items: [item('f4-i1', 'serves_2', 3)] }),                                 // 1 large + 1 small
            customerOrder('c1', { items: [item('c1-i1', 'serves_5')] }),                                         // 1 large
            customerOrder('c2', { items: [item('c2-i1', 'serves_2')] }),                                         // 1 small
        ];
    }

    it('7. a stop\'s large/small/total cartons are exactly the sum of its orders — and the board total is unchanged', () => {
        const rows = mixedFixture();
        const stops = buildDeliveryStops(asQueueRows(rows));
        const flat = computePackagingNeed(rows as any);
        const sum = (k: 'large' | 'small' | 'total') => stops.reduce((n, s) => n + s.boxes[k], 0);
        expect({ large: sum('large'), small: sum('small'), total: sum('total') })
            .toEqual({ large: flat.largeBoxCount, small: flat.smallBoxCount, total: flat.physicalBoxCount });
        expect(flat).toMatchObject({ largeBoxCount: 5, smallBoxCount: 3, physicalBoxCount: 8 });
        const f = stops.find((s) => s.kind === 'fundraiser')!;
        expect(f.boxes).toEqual({ large: 4, small: 2, total: 6, unpackable: 0 });
        // Boxes, not stops and not orders: 4 orders on the stop, 6 cartons.
        expect(f.orderCount).toBe(4);
        for (const o of f.orders) expect(o.boxes.total).toBeGreaterThan(0);
        expect(f.orders.reduce((n, o) => n + o.boxes.total, 0)).toBe(f.boxes.total);
    });

    it('8. the label reprint batch is EVERY underlying order id — the same labels as before grouping', () => {
        const f = acceptanceFixture();
        const stops = buildDeliveryStops(asQueueRows(f.all));
        const batch = orderIdsInRouteOrder(stops);
        expect(batch).toHaveLength(31);
        expect([...batch].sort()).toEqual(f.all.map((r) => r.id).sort());
        // The page builds its batch from exactly this helper over its stops.
        const page = strip(read('app/delivery/page.tsx'));
        const fn = page.slice(page.indexOf('const reprintBoxLabels'), page.indexOf('const refreshData'));
        expect(fn).toMatch(/orderIdsInRouteOrder\(locations\)/);
    });

    it('9. the sidebar NEED/STOCK figures still come from the order population — grouping cannot reduce them', async () => {
        const rows = mixedFixture();
        useStore(rows);
        const stats = (await call(require('@/app/api/delivery/stats/route').GET, new Request('http://localhost/api/delivery/stats'))).body;
        const stops = await stopsNow();
        expect(stops).toHaveLength(3); // one campaign stop + two customers
        expect(stats.largeBoxCount).toBe(stops.reduce((n, s) => n + s.boxes.large, 0));
        expect(stats.smallBoxCount).toBe(stops.reduce((n, s) => n + s.boxes.small, 0));
        expect(stats.physicalBoxCount).toBe(8);
        expect(stats.totalActiveOrders).toBe(6); // orders, not stops
        // The page's NEED and Print Queue read the stats route, never the stop list.
        const page = read('app/delivery/page.tsx');
        expect(page).toMatch(/needed=\{stats\?\.largeBoxCount \?\? 0\}/);
        expect(page).toMatch(/needed=\{stats\?\.smallBoxCount \?\? 0\}/);
        expect(strip(read('app/api/delivery/stats/route.ts'))).not.toMatch(/deliveryStops|groupOrdersForDelivery/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ADDRESS', () => {
    const order = (camp: any) => ({ ...fundraiserOrder('a1', camp), customerName: 'x' });

    it('10. there is no structured campaign delivery address in the schema, so the organization profile address wins next', () => {
        const model = read('prisma/schema.prisma').match(/model FundraiserCampaign \{[\s\S]*?\n\}/)![0];
        expect(model).not.toMatch(/^\s*delivery_address\s/m);
        const r = resolveFundraiserStopAddress(order(campaign('c', { pickup_location: 'Room 12, 300 Oak St, Paris IL', customer: org('Org', '210 W Washington St, Paris IL') })));
        // Owner priority: organization address before the free-text pickup location.
        expect(r).toEqual({ address: '210 W Washington St, Paris IL', addressSource: 'organization_address', locationNote: 'Room 12, 300 Oak St, Paris IL' });
    });

    it('11. with no organization address, a pickup location that reads like a street address is used — otherwise it is only a note', () => {
        const r1 = resolveFundraiserStopAddress(order(campaign('c', { pickup_location: 'Coles County Farm Bureau, 719 W Lincoln Ave Charleston IL', customer: org('Coles', null) })));
        expect(r1).toEqual({ address: 'Coles County Farm Bureau, 719 W Lincoln Ave Charleston IL', addressSource: 'campaign_pickup_location', locationNote: 'Coles County Farm Bureau, 719 W Lincoln Ave Charleston IL' });
        const r2 = resolveFundraiserStopAddress(order(campaign('c', { pickup_location: 'Farm Bureau Basement', customer: org('Org', null) })));
        expect(r2).toEqual({ address: null, addressSource: null, locationNote: 'Farm Bureau Basement' });
        expect(looksLikeStreetAddress('Edgar County Farm Bureau 210 W Washington St, Paris IL')).toBe(true);
        expect(looksLikeStreetAddress('Farm Bureau Basement')).toBe(false);
        expect(looksLikeStreetAddress('Room 24')).toBe(false);
    });

    it('12. a fundraiser stop NEVER uses a supporter\'s address — not the order\'s, not the supporter customer\'s', () => {
        const A = campaign('camp-A', { customer: org('Org', null), pickup_location: null });
        const rows = [
            fundraiserOrder('a1', A, { delivery_address: '999 Supporter Home Rd', customer: { name: 's', delivery_address: '888 Supporter Lane' } }),
            fundraiserOrder('a2', A, { delivery_address: 'Delivery to Room 24' }),
        ];
        const [stop] = buildDeliveryStops(asQueueRows(rows));
        expect(stop.address).toBeNull();
        expect(JSON.stringify(stop)).not.toMatch(/Supporter Home|Supporter Lane|Room 24/);
        expect(strip(read('lib/delivery/deliveryStops.ts')).match(/function resolveFundraiserStopAddress[\s\S]*?\n\}/)![0])
            .not.toMatch(/order\.delivery_address|order\.customer\b/);
    });

    it('13. no address at all: the stop says so, is never sent to a map, and is still deliverable', () => {
        const A = campaign('camp-A', { customer: org('Org', null), pickup_location: null });
        const [stop] = buildDeliveryStops(asQueueRows([fundraiserOrder('a1', A)]));
        expect(stop).toMatchObject({ address: null, addressSource: null, locationNote: null });
        expect(navigableStops([stop])).toEqual([]);
        expect(FUNDRAISER_ADDRESS_NEEDED_LABEL).toBe('Delivery address needed');
        expect(read('app/delivery/page.tsx')).toMatch(/\{FUNDRAISER_ADDRESS_NEEDED_LABEL\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('ROUTE PLAN', () => {
    it('14. twenty-five supporter orders from one fundraiser are ONE navigation stop', () => {
        const A = campaign('camp-A', { customer: org('Org', '210 W Washington St, Paris IL') });
        const stops = buildDeliveryStops(asQueueRows(Array.from({ length: 25 }, (_, i) => fundraiserOrder(`a${i}`, A))));
        expect(navigableStops(stops).map((s) => s.address)).toEqual(['210 W Washington St, Paris IL']);
    });

    it('15. an ordinary customer is one navigation stop at its own address, exactly as before', () => {
        const [stop] = buildDeliveryStops(asQueueRows([customerOrder('c1', { delivery_address: '42 Elm St, Paris IL' })]));
        expect(stop).toMatchObject({ id: 'c1', kind: 'customer', address: '42 Elm St, Paris IL', addressSource: 'order_address', orderIds: ['c1'], orderCount: 1 });
        // orderCount counts ORDERS, even when one order has several lines.
        const [two] = buildDeliveryStops(asQueueRows([customerOrder('c2', { items: [item('c2-a', 'serves_5'), item('c2-b', 'serves_2')] })]));
        expect(two.orderCount).toBe(1);
    });

    it('16. optimize + reorder work on stops: a stop keeps its orders together, a no-address stop goes last, and the order round-trips', async () => {
        const f = acceptanceFixture();
        const noAddr = campaign('camp-N', { customer: org('No Address Org', null), pickup_location: null });
        const rows = [...f.all, fundraiserOrder('N1', noAddr), fundraiserOrder('N2', noAddr)];
        useStore(rows);
        const stops = await stopsNow();
        expect(stops).toHaveLength(6);

        // The REAL optimize route, with Google's distance matrix stubbed: farther stops sort later.
        const payload = stops.map((l) => ({ id: l.id, address: l.address ?? '' })); // the page's exact mapping
        // ...pinned to the page itself: a stop with no address sends an EMPTY one. Any
        // placeholder text would be geocoded to some arbitrary place by the optimizer.
        const page = strip(read('app/delivery/page.tsx'));
        const arrange = page.slice(page.indexOf('const handleAutoArrange'), page.indexOf('const openFullRoute'));
        expect(arrange).toMatch(/orders: locations\.map\(l => \(\{ id: l\.id, address: l\.address \?\? '' \}\)\)/);
        const navigable = payload.filter((p) => p.address);
        const realFetch = global.fetch;
        process.env.GOOGLE_MAPS_API_KEY = 'test-key';
        (global as any).fetch = jest.fn(async () => ({ json: async () => ({ status: 'OK', rows: [{ elements: navigable.map((_, i) => ({ status: 'OK', distance: { value: 1000 * (navigable.length - i) }, duration: { value: 60 } })) }] }) }));
        try {
            const opt = await call(require('@/app/api/delivery/optimize/route').POST, post('/api/delivery/optimize', { origin: 'Kitchen, 1 Main St', orders: payload }));
            expect(opt.status).toBe(200);
            const ids: string[] = opt.body.optimizedIds;
            expect(ids).toHaveLength(6);
            expect(ids[ids.length - 1]).toBe('campaign:camp-N'); // no address -> appended, never geocoded
            expect(ids.slice(0, 5)).toEqual(navigable.map((p) => p.id).reverse());

            // Save exactly as the page does: per order, each stop's orders contiguous.
            const reordered = ids.map((id) => stops.find((s) => s.id === id)!);
            const r = await call(require('@/app/api/delivery/route/reorder/route').PUT, put('/api/delivery/route/reorder', { orderIds: orderIdsInRouteOrder(reordered) }));
            expect(r.status).toBe(200);
            const after = await stopsNow();
            expect(after.map((s) => s.id)).toEqual(ids);
            for (const s of after) {
                const seqs = s.orderIds.map((id) => store.get(id)!.delivery_sequence).sort((x: number, y: number) => x - y);
                expect(seqs[seqs.length - 1] - seqs[0]).toBe(seqs.length - 1); // contiguous run
            }
        } finally {
            (global as any).fetch = realFetch;
        }
    });

    it('16b. Nav Route leaves out a stop with no address instead of navigating to a placeholder', () => {
        const page = strip(read('app/delivery/page.tsx'));
        const fn = page.slice(page.indexOf('const openFullRoute'), page.indexOf('const handleMarkDelivered'));
        expect(fn).toMatch(/navigableStops\(locations\)/);
        expect(fn).toMatch(/routable\.map\(l => encodeURIComponent\(l\.address!\)\)/);
        expect(fn).not.toMatch(/locations\.map\(l => encodeURIComponent/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('MARK DELIVERED — one action for the whole fundraiser', () => {
    it('17. delivers EVERY eligible order of the campaign in one call, and reports it', async () => {
        const f = acceptanceFixture();
        useStore(f.all);
        const res = await deliver('camp-A', f.a.map((r) => r.id));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ campaignId: 'camp-A', updated: 20, alreadyDelivered: 0, refused: [] });
        for (const r of f.a) expect(statusOf(r.id)).toBe('delivered');
        // The board now shows Campaign B and the three customers.
        expect((await stopsNow()).map((s) => s.id).sort()).toEqual(['C1', 'C2', 'C3', 'campaign:camp-B']);
    });

    it('18. ONLY that campaign: the other campaign of the same organization and every customer are untouched', async () => {
        const f = acceptanceFixture();
        useStore(f.all);
        await deliver('camp-A', f.a.map((r) => r.id));
        for (const r of [...f.b, ...f.c]) expect(statusOf(r.id)).toBe('ready_to_ship');
        // Only `status` was ever written, and only for camp-A rows.
        for (const w of store.writes) {
            expect(Object.keys(w.data)).toEqual(['status']);
            expect(w.where.campaign_id).toBe('camp-A');
        }
    });

    it('19. cross-tenant is impossible: another business\'s campaign is not found, and a foreign id refuses the whole stop', async () => {
        const A = campaign('camp-A');
        const mine = [fundraiserOrder('a1', A), fundraiserOrder('a2', A)];
        const foreign = fundraiserOrder('z1', A, { business_id: OTHER_BIZ });
        useStore([...mine, foreign]);
        const before = structuredClone(store.rows);

        const viaForeignId = await deliver('camp-A', ['a1', 'a2', 'z1']);
        expect(viaForeignId.status).toBe(409);
        expect(viaForeignId.body.refused).toEqual([{ id: 'z1', reason: 'not_found' }]);
        expect(store.rows).toEqual(before);

        signIn(OTHER_BIZ);
        const otherTenant = await deliver('camp-A', ['a1', 'a2']);
        // From the other tenant, my orders do not exist; it can only reach its own row.
        expect(otherTenant.status).toBe(409);
        expect(otherTenant.body.refused.map((r: any) => r.reason)).toEqual(['not_found', 'not_found']);
        expect(store.rows).toEqual(before);

        signIn(null);
        expect((await deliver('camp-A', ['a1'])).status).toBe(401);
        expect(store.rows).toEqual(before);
    });

    it('20. a canceled order is never delivered — shown on a stale screen, it refuses the stop and nothing changes', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A)]);
        store.get('a2')!.canceled_at = new Date(); // canceled after the driver loaded the board
        const res = await deliver('camp-A', ['a1', 'a2']);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'STOP_CHANGED', refused: [{ id: 'a2', reason: 'canceled' }] });
        expect([statusOf('a1'), statusOf('a2')]).toEqual(['ready_to_ship', 'ready_to_ship']);
        // After a refresh the canceled order is gone from the stop and the rest deliver.
        const [stop] = await stopsNow();
        expect(stop.orderIds).toEqual(['a1']);
        expect((await deliver('camp-A', stop.orderIds)).body.updated).toBe(1);
        expect(statusOf('a2')).toBe('ready_to_ship');
    });

    it('21. an order not in Delivery is never delivered, and an order that cannot legally become delivered blocks the stop', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A), fundraiserOrder('held', A, { released_to_delivery_at: null, status: 'fundraiser_hold' })]);
        // Not shown, not in Delivery: silently out of scope, never written.
        expect((await deliver('camp-A', ['a1', 'a2'])).body.updated).toBe(2);
        expect(statusOf('held')).toBe('fundraiser_hold');

        // Shown (stale screen) but not in Delivery: refused.
        useStore([fundraiserOrder('a1', A), fundraiserOrder('held', A, { released_to_delivery_at: null })]);
        const stale = await deliver('camp-A', ['a1', 'held']);
        expect(stale.status).toBe(409);
        expect(stale.body.refused).toEqual([{ id: 'held', reason: 'not_in_delivery' }]);
        expect(statusOf('a1')).toBe('ready_to_ship');

        // In Delivery but at a status the shared matrix will not move to delivered: nothing moves.
        useStore([fundraiserOrder('a1', A), fundraiserOrder('odd', A, { status: 'in_production' })]);
        const blocked = await deliver('camp-A', ['a1', 'odd']);
        expect(blocked.status).toBe(409);
        expect(blocked.body).toMatchObject({ code: 'ORDER_NOT_DELIVERABLE', failures: [{ id: 'odd', status: 'in_production' }] });
        expect([statusOf('a1'), statusOf('odd')]).toEqual(['ready_to_ship', 'in_production']);
    });

    it('22. a concurrent double click delivers each order exactly once, never errors, never half-delivers', async () => {
        const A = campaign('camp-A');
        const rows = Array.from({ length: 12 }, (_, i) => fundraiserOrder(`a${i}`, A, { status: i % 2 ? 'completed' : 'ready_to_ship' }));
        useStore(rows);
        const ids = rows.map((r) => r.id);
        const [r1, r2] = await Promise.all([deliver('camp-A', ids), deliver('camp-A', ids)]);
        for (const r of [r1, r2]) expect([200, 409]).toContain(r.status);
        expect(ids.every((id) => statusOf(id) === 'delivered')).toBe(true);
        const updatedTotal = [r1, r2].reduce((n, r) => n + (r.body.updated ?? 0), 0);
        expect(updatedTotal).toBe(12); // each order counted as newly delivered exactly once
    });

    it('22b. an order canceled while the request is in flight is caught by the locked read — nothing is written', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A), fundraiserOrder('a3', A)]);
        // 1A: the authoritative read now happens INSIDE the transaction, after the
        // campaign lock, so a change that lands before the lock is seen there and refused.
        store.beforeNextTransaction = () => { store.get('a3')!.canceled_at = new Date(); };
        const res = await deliver('camp-A', ['a1', 'a2', 'a3']);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'STOP_CHANGED', refused: [{ id: 'a3', reason: 'canceled' }] });
        expect(['a1', 'a2', 'a3'].map(statusOf)).toEqual(['ready_to_ship', 'ready_to_ship', 'ready_to_ship']);
    });

    it('23. a failure in the middle of the write rolls back every order — the fundraiser is never half delivered', async () => {
        const A = campaign('camp-A');
        const rows = Array.from({ length: 10 }, (_, i) => fundraiserOrder(`a${i}`, A));
        useStore(rows);
        store.failAfterRowUpdates = 6;
        const res = await deliver('camp-A', rows.map((r) => r.id));
        expect(res.status).toBe(500);
        expect(rows.map((r) => statusOf(r.id)).every((s) => s === 'ready_to_ship')).toBe(true);
    });

    it('24. a second call is idempotent: it delivers nothing more and says so', async () => {
        const f = acceptanceFixture();
        useStore(f.all);
        const ids = f.a.map((r) => r.id);
        expect((await deliver('camp-A', ids)).body.updated).toBe(20);
        const writesAfterFirst = store.writes.length;
        const again = await deliver('camp-A', ids);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ updated: 0, alreadyDelivered: 20 });
        expect(store.writes.length).toBe(writesAfterFirst);
    });

    it('a stop that gained an order since it was loaded is refused, so the click delivers exactly what was on screen', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), fundraiserOrder('a2', A), fundraiserOrder('a3', A)]);
        const res = await deliver('camp-A', ['a1', 'a2']);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'STOP_CHANGED', notShownOrderIds: ['a3'] });
        expect(['a1', 'a2', 'a3'].map(statusOf)).toEqual(['ready_to_ship', 'ready_to_ship', 'ready_to_ship']);
    });

    it('rejects malformed input before reading anything', async () => {
        useStore([]);
        for (const body of [{}, { campaignId: 'x' }, { campaignId: 'x', orderIds: [] }, { campaignId: '', orderIds: ['a'] }, { campaignId: 'x', orderIds: [1] }]) {
            const res = await call(require('@/app/api/delivery/campaign-delivered/route').POST, post('/api/delivery/campaign-delivered', body));
            expect(res.status).toBe(400);
        }
        expect((await deliver('camp-none', ['nope'])).status).toBe(404);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// DELIVERY-FUNDRAISER-GROUPING-1A — nothing may join the stop while it is being delivered.
// ═════════════════════════════════════════════════════════════════════════════
describe('1A — CONCURRENT NEW ORDER ENTERS DELIVERY', () => {
    /** Campaign A: orders a01–a20 in Delivery, and a21 packed but not yet sent to Delivery. */
    function twentyPlusOne() {
        const A = campaign('camp-A');
        const rows = Array.from({ length: 20 }, (_, i) => fundraiserOrder(`a${String(i + 1).padStart(2, '0')}`, A));
        rows.push(fundraiserOrder('a21', A, { released_to_delivery_at: null }));
        useStore(rows);
        return rows.map((r) => r.id);
    }
    /** The handoff's own compare-and-set, as a concurrent writer outside our transaction. */
    const releaseA21 = () => store.client.order.updateMany({
        where: { id: 'a21', business_id: BIZ, released_to_delivery_at: null, canceled_at: null, status: 'ready_to_ship' },
        data: { released_to_delivery_at: new Date(), released_to_delivery_by: 'concurrent-handoff' },
    });
    const statusWrites = () => store.writes.filter((w) => w.data.status !== undefined && w.count > 0);

    it('1A-1. order 21 enters Delivery while the click is in flight: NOTHING is delivered, 409 refresh; after refresh all 21 deliver atomically', async () => {
        const ids = twentyPlusOne();
        const [screen] = await stopsNow();
        expect(screen.orderIds).toHaveLength(20); // the driver is looking at 1–20

        // Released after the board loaded and after the click — before the delivery's locked read.
        store.beforeNextTransaction = async () => { expect((await releaseA21()).count).toBe(1); };
        const res = await deliver('camp-A', screen.orderIds);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'STOP_CHANGED', notShownOrderIds: ['a21'] });
        expect(res.body.error).toMatch(/Refresh/);
        expect(ids.map(statusOf).every((s) => s === 'ready_to_ship')).toBe(true); // 1–20 AND 21 untouched
        expect(store.get('a21')!.released_to_delivery_at).not.toBeNull();
        expect(statusWrites()).toEqual([]);

        // Refresh: the stop now holds 21. Retry: all 21, in one transaction.
        const [fresh] = await stopsNow();
        expect(fresh.orderIds).toHaveLength(21);
        const retry = await deliver('camp-A', fresh.orderIds);
        expect(retry).toMatchObject({ status: 200, body: { updated: 21, alreadyDelivered: 0 } });
        expect(ids.map(statusOf).every((s) => s === 'delivered')).toBe(true);
        expect(store.events.filter((e) => e.endsWith(':commit'))).toHaveLength(2); // the refused attempt wrote nothing; the retry is one commit
    });

    it('1A-2. a release attempted while the delivery holds the campaign lock WAITS, and lands after the commit as a new stop', async () => {
        twentyPlusOne();
        const [screen] = await stopsNow();
        let release: Promise<{ count: number }> | null = null;
        // Fired right after the delivery's authoritative read — the exact window the gap lived in.
        store.afterFirstReadInNextTransaction = () => { release = releaseA21(); };
        const res = await deliver('camp-A', screen.orderIds);
        expect(res).toMatchObject({ status: 200, body: { updated: 20 } });
        expect(release).not.toBeNull();
        expect((await release!).count).toBe(1);

        // The release could only commit AFTER the delivery: at the delivery's commit, the
        // campaign's Delivery population was exactly the 20 it delivered.
        const commit = store.events.findIndex((e) => e.endsWith(':commit'));
        const landed = store.events.findIndex((e) => e === 'outside:write:a21');
        expect(commit).toBeGreaterThanOrEqual(0);
        expect(landed).toBeGreaterThan(commit);
        // Order 21 is now its own new stop, needing the operator's attention — not lost, not half-delivered.
        const after = await stopsNow();
        expect(after).toHaveLength(1);
        expect(after[0].orderIds).toEqual(['a21']);
    });

    it('1A-3. a double click: one call delivers, the other waits for it and reports "already delivered" — never 409, never 500', async () => {
        const A = campaign('camp-A');
        const rows = Array.from({ length: 12 }, (_, i) => fundraiserOrder(`a${i}`, A, { status: i % 2 ? 'completed' : 'ready_to_ship' }));
        useStore(rows);
        const ids = rows.map((r) => r.id);
        const results = await Promise.all([deliver('camp-A', ids), deliver('camp-A', ids)]);
        expect(results.map((r) => r.status)).toEqual([200, 200]);
        expect(results.map((r) => [r.body.updated, r.body.alreadyDelivered]).sort()).toEqual([[0, 12], [12, 0]]);
        expect(statusWrites().reduce((n, w) => n + w.count, 0)).toBe(12); // each order written once
    });

    it('1A-4. structure: lock, then the authoritative read, then the writes — all inside ONE transaction; no read outside it', () => {
        const src = strip(read('app/api/delivery/campaign-delivered/route.ts'));
        const body = src.slice(src.indexOf('export async function POST'));
        const tx = body.indexOf('prisma.$transaction(async (tx)');
        expect(tx).toBeGreaterThan(-1);
        const lock = body.indexOf('await lockCampaignOrders(tx, businessId, campaign);');
        const readAt = body.indexOf('const eligible = await readEligible(tx, businessId, campaign);');
        const write = body.indexOf('tx.order.updateMany(');
        expect(tx < lock && lock < readAt && readAt < write).toBe(true);
        expect(body).not.toMatch(/prisma\.order\./); // every order read/write goes through `tx`
        expect(src).toMatch(/SELECT id FROM orders WHERE business_id = \$\{businessId\} AND campaign_id = \$\{campaignId\} ORDER BY id FOR UPDATE/);
        // The handoff is untouched — it simply waits on the row lock it already needs.
        expect(read('app/api/delivery/handoff/route.ts')).not.toMatch(/FOR UPDATE|campaign-delivered|deliveryStops/);
    });

    it('1A-5. a deadlock or lock timeout with another writer is a safe 409, never a 500, and writes nothing', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A)]);
        for (const code of ['P2034', 'P2028']) {
            const real = store.client.$transaction;
            store.client.$transaction = async () => { throw Object.assign(new Error('conflict'), { code }); };
            const res = await deliver('camp-A', ['a1']);
            store.client.$transaction = real;
            expect(res).toMatchObject({ status: 409, body: { code: 'STATUS_CHANGED_CONCURRENTLY' } });
        }
        expect(statusOf('a1')).toBe('ready_to_ship');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DELIVERED ≠ PICKED UP', () => {
    it('25. delivering the fundraiser writes ONLY status — supporter payment marks and every other column are untouched', async () => {
        const A = campaign('camp-A');
        const rows = Array.from({ length: 6 }, (_, i) => fundraiserOrder(`a${i}`, A, { paid_at: i % 2 ? new Date('2026-10-02T12:00:00Z') : null }));
        useStore(rows);
        const before = allButStatus();
        const paymentBefore = store.rows.map((r) => supporterPaymentState(r as any));
        expect((await deliver('camp-A', rows.map((r) => r.id))).body.updated).toBe(6);
        expect(allButStatus()).toEqual(before);
        expect(store.rows.map((r) => supporterPaymentState(r as any))).toEqual(paymentBefore);
        const route = strip(read('app/api/delivery/campaign-delivered/route.ts'));
        expect(route).toMatch(/data: \{ status: deliveredValue \}/);
        expect(route).not.toMatch(/paid_at|picked|released_to_delivery_at:\s*(new Date|null)|invoice|delivery_sequence/);
    });

    it('26. a delivered order stays on the coordinator\'s pickup documents, open or closed', () => {
        const delivered = { status: 'delivered', source: 'fundraiser', canceled_at: null };
        expect(isPickupDocumentOrder(delivered, { closed: true })).toBe(true);
        expect(isPickupDocumentOrder(delivered, { closed: false })).toBe(true);
        // The tracker's own where-clause has no status filter that a delivery could trip.
        expect(JSON.stringify(pickupDocumentOrderWhere('c', { closed: true }))).not.toMatch(/delivered/);
        expect(JSON.stringify(pickupDocumentOrderWhere('c', { closed: false }))).not.toMatch(/delivered/);
        // And the Pickup Tracker surfaces were not touched by this phase.
        for (const f of ['app/coordinator/portal/pickup-tracker/page.tsx', 'app/api/coordinator/pickup-tracker/route.ts', 'app/api/tracker/pickup-sheet/route.ts']) {
            expect(read(f)).not.toMatch(/deliveryStops|campaign-delivered/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('REGRESSION', () => {
    const walk = (dir: string, out: string[] = []) => {
        for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
            const p = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
        }
        return out;
    };

    it('27-28. Production, its board and box labels stay order-level: nothing there consumes the stop builder', () => {
        const files = [...walk('app/production'), ...walk('app/api/production'), ...walk('components/production')];
        expect(files.length).toBeGreaterThan(5);
        for (const f of files) expect({ f, uses: /deliveryStops|campaign-delivered/.test(read(f)) }).toEqual({ f, uses: false });
    });

    it('29. the manifest and packing slips still read the order population, so they list the same underlying orders', () => {
        for (const f of ['app/api/delivery/packing-slips/route.ts', 'app/delivery/print-manifest/page.tsx', 'app/delivery/print-packing-slips/page.tsx']) {
            expect(read(f)).not.toMatch(/deliveryStops|groupOrdersForDelivery/);
        }
        expect(strip(read('app/api/delivery/packing-slips/route.ts'))).toMatch(/activeDeliveryOrderWhere\(/);
    });

    it('30. ordinary deliveries are unchanged: same stops, same order, same address text, same Mark Delivered call', () => {
        const rows = [
            customerOrder('c3', { delivery_sequence: 2 }), customerOrder('c1', { delivery_sequence: 0 }),
            customerOrder('c2', { delivery_sequence: 1, delivery_address: null }), customerOrder('c4', { delivery_sequence: 1 }),
        ];
        // The pre-grouping mapping, verbatim in behaviour.
        const legacy = asQueueRows(rows)
            .map((o: any) => ({ id: o.id, customerName: o.customerName, address: o.delivery_address || 'No Address Provided', sequence: o.delivery_sequence || 0 }))
            .sort((a, b) => a.sequence - b.sequence);
        const stops = buildDeliveryStops(asQueueRows(rows));
        expect(stops.map((s) => ({ id: s.id, customerName: s.title, address: s.address ?? 'No Address Provided', sequence: s.sequence }))).toEqual(legacy);
        const page = strip(read('app/delivery/page.tsx'));
        expect(page).toMatch(/fetch\('\/api\/orders', \{\s*method: 'PATCH'[\s\S]*?status: 'delivered'/);
        expect(page).toMatch(/\{loc\.address \?\? NO_ADDRESS_LABEL\}/);
    });

    it('30b. the fundraiser route refuses an ordinary customer order outright', async () => {
        const A = campaign('camp-A');
        useStore([fundraiserOrder('a1', A), customerOrder('c1')]);
        const res = await deliver('camp-A', ['a1', 'c1']);
        expect(res.status).toBe(409);
        expect(res.body.refused).toEqual([{ id: 'c1', reason: 'not_in_this_fundraiser' }]);
        expect([statusOf('a1'), statusOf('c1')]).toEqual(['ready_to_ship', 'ready_to_ship']);
    });

    it('the queue route adds the campaign + organization it needs, and nothing it does not', async () => {
        const f = acceptanceFixture();
        useStore(f.all);
        const rows = await queue();
        expect(rows).toHaveLength(31);
        const one = rows.find((r) => r.id === 'A01');
        expect(one).toMatchObject({ source: 'fundraiser', campaign_id: 'camp-A' });
        expect(Object.keys(one.campaign).sort()).toEqual(['customer', 'delivery_date', 'delivery_time', 'id', 'name', 'pickup_location']);
        const src = strip(read('app/api/delivery/queue/route.ts'));
        expect(src).toMatch(/select: \{ name: true, delivery_address: true, contact_name: true, contact_phone: true \}/);
        expect(src).toMatch(/activeDeliveryOrderWhere\(businessId, week\)/);
    });
});
