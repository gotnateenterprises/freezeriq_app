/**
 * FR-COORD-123A — the retired Square simulation endpoint, exercised.
 *
 * The source-level assertions in frCoord123TierTriage prove the file contains
 * no database access. These INVOKE the shipped handler with the exact payload
 * shapes that used to create rows, and fail the test outright if Prisma is
 * touched at all — a spy stands in for the client and throws on any property
 * access, so even reaching for `prisma.order` is a failure, not just calling it.
 */
process.env.TZ = 'America/Chicago';

/**
 * Any use of the Prisma client from the route under test is a containment
 * breach. The proxy throws on ANY property read, so `prisma.$transaction`,
 * `prisma.order.create`, or a bare `prisma.bundle` all fail loudly.
 */
const prismaTouches: string[] = [];
jest.mock('@/lib/db', () => ({
    get prisma() {
        return new Proxy({}, {
            get(_t, prop) {
                prismaTouches.push(String(prop));
                throw new Error(`CONTAINMENT BREACH: retired route touched prisma.${String(prop)}`);
            },
        });
    },
}));

import { POST, GET } from '../app/api/integrations/square/route';

/** The payload shape the endpoint used to accept and turn into rows. */
const SIMULATED_ORDER = {
    order_id: 'sq-probe-0001',
    customer_name: 'Probe Customer',
    total_money: { amount: 12500 },
    created_at: '2026-08-27T00:00:00.000Z',
    line_items: [
        { name: 'Fall 2026 - Family Friendly', quantity: '2', catalog_object_id: 'SKU-FAM' },
        { name: 'Fall 2026 - Family Friendly (Serves 2)', quantity: '1', catalog_object_id: 'SKU-S2' },
    ],
};

/** A request whose body would blow up if anything ever tried to read it. */
function reqWith(body: unknown): Request {
    return {
        url: 'https://www.freezeriqapp.com/api/integrations/square',
        method: 'POST',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => {
            throw new Error('CONTAINMENT BREACH: retired route read the request body');
        },
        text: async () => {
            throw new Error('CONTAINMENT BREACH: retired route read the request body');
        },
        __body: body,
    } as unknown as Request;
}

beforeEach(() => { prismaTouches.length = 0; });

describe('FR-COORD-123A · POST cannot create an order', () => {
    it('a full simulated Square order is refused with 410 and writes nothing', async () => {
        const res = await (POST as any)(reqWith(SIMULATED_ORDER));
        expect(res.status).toBe(410);
        expect(prismaTouches).toEqual([]);
        const body = await res.json();
        expect(body).toEqual({ error: 'This endpoint is no longer available.' });
        // No echo of the caller's data, and no hint of the old behaviour.
        const text = JSON.stringify(body);
        expect(text).not.toContain('sq-probe-0001');
        expect(text).not.toContain('Probe Customer');
        expect(text).not.toMatch(/bundle|tenant|business|sku|matched|failed/i);
    });

    it('no session, no write', async () => {
        // There is no session to present; the answer is the same either way.
        const res = await (POST as any)(reqWith(SIMULATED_ORDER));
        expect(res.status).toBe(410);
        expect(prismaTouches).toEqual([]);
    });

    it('an arbitrary SKU or name triggers no lookup', async () => {
        for (const item of [
            { name: 'anything at all', quantity: '1', catalog_object_id: 'SKU-DOES-NOT-EXIST' },
            { name: "'; DROP TABLE orders; --", quantity: '9999' },
            { name: '', quantity: '1' },
        ]) {
            const res = await (POST as any)(reqWith({ ...SIMULATED_ORDER, line_items: [item] }));
            expect(res.status).toBe(410);
        }
        expect(prismaTouches).toEqual([]);
    });

    it('CROSS-TENANT input triggers no lookup and no write', async () => {
        // The original route matched bundles by SKU/name across every business
        // and set no business_id on the order it created. This is that exact
        // attack shape.
        const res = await (POST as any)(reqWith({
            ...SIMULATED_ORDER,
            business_id: 'some-other-tenant',
            line_items: [{ name: 'Another Tenants Bundle', quantity: '1', catalog_object_id: 'OTHER-TENANT-SKU' }],
        }));
        expect(res.status).toBe(410);
        expect(prismaTouches).toEqual([]);
    });

    it('a malformed or empty body is refused identically — no parse, no crash', async () => {
        for (const body of [undefined, null, {}, { line_items: null }, 'not json']) {
            const res = await (POST as any)(reqWith(body));
            expect(res.status).toBe(410);
        }
        expect(prismaTouches).toEqual([]);
    });

    it('repeated calls stay inert — nothing accumulates', async () => {
        for (let i = 0; i < 25; i++) {
            const res = await (POST as any)(reqWith(SIMULATED_ORDER));
            expect(res.status).toBe(410);
        }
        expect(prismaTouches).toEqual([]);
    });

    it('GET is equally closed and equally silent', async () => {
        const res = await (GET as any)(reqWith(undefined));
        expect(res.status).toBe(410);
        expect(prismaTouches).toEqual([]);
        expect(await res.json()).toEqual({ error: 'This endpoint is no longer available.' });
    });

    it('the refusal is not cached by any intermediary', async () => {
        const res = await (POST as any)(reqWith(SIMULATED_ORDER));
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
});
