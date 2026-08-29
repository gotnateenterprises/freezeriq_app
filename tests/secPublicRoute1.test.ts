/**
 * SEC-PUBLIC-ROUTE-1 — handler-boundary security tests.
 *
 * CONSTITUTION-LOCK-1 found API route handlers that were anonymously reachable
 * in Production. `middleware.ts:63` excludes `api/` from its matcher, so the
 * `authorized()` callback never runs for an API route — every protected handler
 * is self-defending, and one without an in-handler guard has no authentication
 * at all.
 *
 * These assertions execute the REAL exported handler against a recording Prisma
 * double and a controllable session, following the precedent this repo already
 * set for auth-boundary claims:
 *
 *   tests/outreachConsent1.test.ts:646-652 — "Source assertions cannot tell
 *   'returns refuse()' from 'returns ok' — the mutation battery proved exactly
 *   that. So the handlers are imported and run against a fake prisma…"
 *
 * Two properties are asserted per repaired handler, and the second is the one
 * that matters: not merely that an anonymous caller gets 401, but that it
 * reaches NO database call at all. A guard placed after the query would satisfy
 * the status assertion and still leak.
 *
 * The routes must be lazy-loaded (`await import`) INSIDE each test, after the
 * jest.mock calls above have been installed. A static import would evaluate
 * lib/db.ts and construct a real PrismaClient before the mock exists.
 */

import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';

// ── Module doubles. Declared before any route module is loaded. ──────────────
jest.mock('@/lib/db', () => ({
    get prisma() { return (global as any).__secPrisma; },
}));
jest.mock('@/auth', () => ({
    auth: jest.fn(async () => (global as any).__secSession),
}));
jest.mock('@/lib/cost_engine', () => ({
    calculateRecipeCost: jest.fn(async () => ({ costPerUnit: 1, total: 1 })),
}));
jest.mock('@/lib/label_printer', () => ({
    getLabelPrinter: jest.fn(() => ({
        printLabel: jest.fn(async () => ({ success: true, message: 'ok' })),
    })),
}));
jest.mock('@/lib/unit_converter', () => ({
    convertUnit: jest.fn((qty: number) => qty),
}));
jest.mock('@/lib/ai/gemini', () => ({
    getGeminiApiKey: jest.fn(async () => 'tenant-key'),
}));
jest.mock('@/lib/ai/recipe_generator', () => ({
    ViralChef: jest.fn().mockImplementation(() => ({
        generateRecipe: jest.fn(async () => ({ name: 'Generated' })),
    })),
}));
jest.mock('@/lib/marketing_client', () => ({
    marketingClient: { getCampaigns: jest.fn(async () => [{ id: 'c1', subject: 'secret' }]) },
}));

const mockEmailSend = jest.fn(async () => ({ id: 'email-1' }));
jest.mock('resend', () => ({
    Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockEmailSend } })),
}));
jest.mock('@/lib/email', () => ({
    getTenantSender: jest.fn(async () => ({ from: 'Tenant <t@example.com>' })),
}));

let mock: PrismaMock;
const useMock = (m: PrismaMock) => { mock = m; (global as any).__secPrisma = m.client; };
const useSession = (s: any) => { (global as any).__secSession = s; };

const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const sessionFor = (businessId: string) => ({ user: { id: 'u1', businessId } });

beforeEach(() => {
    jest.clearAllMocks();
    useMock(createPrismaMock());
    useSession(null); // anonymous is the DEFAULT for every test
    process.env.RESEND_API_KEY = 'test-key';
});

// Every repaired handler, so the anonymous-refusal assertions can be table-driven.
// `invoke` receives the loaded module and returns the handler's Response.
const REPAIRED: { name: string; path: string; invoke: (mod: any) => Promise<Response> }[] = [
    {
        name: 'GET /api/analytics/margins',
        path: '@/app/api/analytics/margins/route',
        invoke: (m) => m.GET(),
    },
    {
        name: 'POST /api/recipes/upload',
        path: '@/app/api/recipes/upload/route',
        invoke: (m) => {
            const fd = new FormData();
            fd.append('file', new File(['{}'], 'backup.json', { type: 'application/json' }));
            return m.POST({ formData: async () => fd } as any);
        },
    },
    {
        name: 'POST /api/commercial/ingredients/merge',
        path: '@/app/api/commercial/ingredients/merge/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { sourceId: 'i-1', targetId: 'i-2' })),
    },
    {
        name: 'PUT /api/delivery/route/reorder',
        path: '@/app/api/delivery/route/reorder/route',
        invoke: (m) => m.PUT(new Request('http://localhost/x', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: ['o-1', 'o-2'] }),
        }) as any),
    },
    {
        name: 'POST /api/delivery/record-print-job',
        path: '@/app/api/delivery/record-print-job/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { largeBoxes: 60, smallBoxes: 0, sheetsUsed: 3 })),
    },
    {
        name: 'POST /api/production/deduct',
        path: '@/app/api/production/deduct/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { ingredients: [{ name: 'Ground Beef', qty: 5, unit: 'lb' }] })),
    },
    {
        name: 'POST /api/production/generate-po',
        path: '@/app/api/production/generate-po/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', {
            supplier: 'ACME', email: 'attacker@example.com',
            items: [{ id: 'x', name: 'Beef', toBuy: 2, unit: 'lb' }],
        })),
    },
    {
        name: 'POST /api/production/print',
        path: '@/app/api/production/print/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { items: [{ recipeName: 'X' }] })),
    },
    {
        name: 'POST /api/production/print-label',
        path: '@/app/api/production/print-label/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { job: { recipeName: 'X' } })),
    },
    {
        name: 'GET /api/training',
        path: '@/app/api/training/route',
        invoke: (m) => m.GET(new Request('http://localhost/api/training') as any),
    },
    {
        name: 'GET /api/marketing/send',
        path: '@/app/api/marketing/send/route',
        invoke: (m) => m.GET(),
    },
    {
        name: 'POST /api/ai/feedback',
        path: '@/app/api/ai/feedback/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { recipe: { name: 'X' }, rating: 5 })),
    },
    {
        name: 'POST /api/ai/generate',
        path: '@/app/api/ai/generate/route',
        invoke: (m) => m.POST(jsonRequest('http://localhost/x', { vibe: 'spicy' })),
    },
];

// ═════════════════════════════════════════════════════════════════════════════
// 1. Anonymous refusal — required test case 1, across every repaired handler.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. every repaired handler refuses an anonymous caller', () => {
    for (const route of REPAIRED) {
        it(`${route.name} returns 401 with no session`, async () => {
            useSession(null);
            const mod = await import(route.path);
            const res = await route.invoke(mod);
            expect(res.status).toBe(401);
        });

        it(`${route.name} reaches no database call at all when anonymous`, async () => {
            useSession(null);
            const mod = await import(route.path);
            await route.invoke(mod);
            expect(mock.calls).toHaveLength(0);
        });
    }

    // A session that authenticated but carries no tenant is not a tenant caller.
    it('a session with no businessId is refused just like an anonymous one', async () => {
        useSession({ user: { id: 'u1', email: 'x@y.com' } });
        const { GET } = await import('@/app/api/analytics/margins/route');
        const res = await GET();
        expect(res.status).toBe(401);
        expect(mock.calls).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Same-tenant success + tenant scoping — required cases 2 and 8.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. analytics/margins returns only the caller own bundles', () => {
    it('an authenticated caller succeeds', async () => {
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/analytics/margins/route');
        const res = await GET();
        expect(res.status).toBe(200);
    });

    it('scopes the bundle query to the session business', async () => {
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/analytics/margins/route');
        await GET();
        const call = mock.firstCall('bundle.findMany');
        expect(call).toBeDefined();
        expect(call!.args.where).toMatchObject({ is_active: true, business_id: TENANT_A });
    });

    it('never issues a bundle query without a business_id predicate', async () => {
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/analytics/margins/route');
        await GET();
        for (const call of mock.callsTo('bundle.findMany')) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Foreign-tenant resource ids — required cases 3 and 9.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. ingredient merge cannot cross tenants', () => {
    it('scopes both ingredient lookups to the session business', async () => {
        useSession(sessionFor(TENANT_A));
        const { POST } = await import('@/app/api/commercial/ingredients/merge/route');
        await POST(jsonRequest('http://localhost/x', { sourceId: 'src-1', targetId: 'tgt-1' }));

        const lookups = mock.callsTo('ingredient.findFirst');
        expect(lookups).toHaveLength(2);
        for (const call of lookups) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });

    it('a foreign ingredient id is refused and nothing is deleted', async () => {
        // The scoped lookup finds nothing, because the row belongs to TENANT_B.
        useMock(createPrismaMock({
            results: {
                'ingredient.findFirst': (args: any) =>
                    args.where.business_id === TENANT_B ? { id: args.where.id } : null,
            },
        }));
        useSession(sessionFor(TENANT_A));

        const { POST } = await import('@/app/api/commercial/ingredients/merge/route');
        const res = await POST(jsonRequest('http://localhost/x', { sourceId: 'victim-ingredient', targetId: 'mine' }));

        expect(res.status).toBe(500); // existing "Ingredient not found" throw path
        expect(mock.callsTo('ingredient.delete')).toHaveLength(0);
        expect(mock.callsTo('recipeItem.updateMany')).toHaveLength(0);
    });

    it('same-tenant merge still deletes the source and repoints its recipe lines', async () => {
        useMock(createPrismaMock({
            results: {
                'ingredient.findFirst': (args: any) =>
                    args.where.business_id === TENANT_A ? { id: args.where.id } : null,
            },
        }));
        useSession(sessionFor(TENANT_A));

        const { POST } = await import('@/app/api/commercial/ingredients/merge/route');
        const res = await POST(jsonRequest('http://localhost/x', { sourceId: 'src-1', targetId: 'tgt-1' }));

        expect(res.status).toBe(200);
        expect(mock.firstCall('ingredient.delete')!.args.where.id).toBe('src-1');
        expect(mock.firstCall('recipeItem.updateMany')!.args.data.child_ingredient_id).toBe('tgt-1');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Destructive writes only touch same-tenant rows — cases 6, 10, 11, 12.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. destructive writes are tenant-bounded', () => {
    it('delivery reorder scopes every order write to the session business', async () => {
        useSession(sessionFor(TENANT_A));
        const { PUT } = await import('@/app/api/delivery/route/reorder/route');
        await PUT(new Request('http://localhost/x', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: ['o-1', 'o-2', 'o-3'] }),
        }) as any);

        const writes = mock.callsTo('order.updateMany');
        expect(writes).toHaveLength(3);
        for (const call of writes) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });

    it('delivery reorder uses updateMany, so a foreign id is a silent no-op rather than an existence oracle', async () => {
        useSession(sessionFor(TENANT_A));
        const { PUT } = await import('@/app/api/delivery/route/reorder/route');
        await PUT(new Request('http://localhost/x', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: ['foreign-order'] }),
        }) as any);

        // update() throws on a missing row; updateMany() does not. The absence of
        // any order.update call is what removes the 200-vs-500 oracle.
        expect(mock.callsTo('order.update')).toHaveLength(0);
        expect(mock.callsTo('order.updateMany')).toHaveLength(1);
    });

    it('packaging decrement is scoped to the session business', async () => {
        useMock(createPrismaMock({
            results: { 'packagingItem.findFirst': (args: any) => ({ id: 'pk-1', name: 'Tape', ...args.where }) },
        }));
        useSession(sessionFor(TENANT_A));

        const { POST } = await import('@/app/api/delivery/record-print-job/route');
        await POST(jsonRequest('http://localhost/x', { largeBoxes: 60, smallBoxes: 0, sheetsUsed: 3 }));

        const lookups = mock.callsTo('packagingItem.findFirst');
        expect(lookups.length).toBeGreaterThan(0);
        for (const call of lookups) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });

    it('production deduct scopes both the id lookup and the name fallback', async () => {
        useSession(sessionFor(TENANT_A));
        const { POST } = await import('@/app/api/production/deduct/route');
        await POST(jsonRequest('http://localhost/x', {
            ingredients: [
                { id: 'ing-1', qty: 1, unit: 'lb' },
                { name: 'Ground Beef', qty: 1, unit: 'lb' },
            ],
        }));

        const lookups = mock.callsTo('ingredient.findFirst');
        expect(lookups).toHaveLength(2);
        for (const call of lookups) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
        // findUnique cannot carry a business_id predicate — it must not be used here.
        expect(mock.callsTo('ingredient.findUnique')).toHaveLength(0);
    });

    it('production deduct will not write stock for a foreign ingredient', async () => {
        useMock(createPrismaMock({ results: { 'ingredient.findFirst': null } }));
        useSession(sessionFor(TENANT_A));

        const { POST } = await import('@/app/api/production/deduct/route');
        const res = await POST(jsonRequest('http://localhost/x', {
            ingredients: [{ id: 'victim-ingredient', qty: 9999, unit: 'lb' }],
        }));

        expect(res.status).toBe(200);
        const { body } = await readJson(res);
        expect(body.results[0].status).toBe('not_found');
        expect(mock.callsTo('ingredient.update')).toHaveLength(0);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Client-supplied tenant identity cannot override the session — cases 4, 5, 7.
// ═════════════════════════════════════════════════════════════════════════════
describe('5. a body- or query-supplied business_id cannot override the session tenant', () => {
    it('recipes/upload stamps the SESSION business on created rows, not the file body', async () => {
        useSession(sessionFor(TENANT_A));
        const backup = {
            data: {
                categories: [{ id: 'cat-1', name: 'Mains' }],
                suppliers: [{ id: 'sup-1', name: 'ACME', business_id: TENANT_B }],
                ingredients: [{ id: 'ing-1', name: 'Beef', cost_per_unit: 1, unit: 'lb', business_id: TENANT_B }],
                packaging_items: [{ id: 'pk-1', name: 'Tray', business_id: TENANT_B }],
                recipes: [],
            },
        };
        const fd = new FormData();
        fd.append('file', new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        const res = await POST({ formData: async () => fd } as any);
        expect(res.status).toBe(200);

        for (const key of ['category.upsert', 'supplier.upsert', 'ingredient.upsert', 'packagingItem.upsert']) {
            const call = mock.firstCall(key);
            expect(call).toBeDefined();
            expect(call!.args.create.business_id).toBe(TENANT_A);
            expect(call!.args.create.business_id).not.toBe(TENANT_B);
        }
    });

    it('recipes/upload rejects the WHOLE file when it references a foreign record, before any write', async () => {
        useMock(createPrismaMock({
            results: {
                // The pre-flight sees the referenced recipe exists and belongs elsewhere.
                'recipe.findMany': [{ id: 'victim-recipe', business_id: TENANT_B }],
            },
        }));
        useSession(sessionFor(TENANT_A));

        const backup = { data: { recipes: [{ id: 'victim-recipe', name: 'Their Meal', child_items: [] }] } };
        const fd = new FormData();
        fd.append('file', new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        const res = await POST({ formData: async () => fd } as any);
        const { status, body } = await readJson(res);

        expect(status).toBe(403);
        expect(body.code).toBe('FOREIGN_RECORDS_IN_BACKUP');
        // The load-bearing assertion: nothing was destroyed before the rejection.
        expect(mock.callsTo('recipeItem.deleteMany')).toHaveLength(0);
        expect(mock.callsTo('recipe.upsert')).toHaveLength(0);
    });

    it('recipes/upload CSV path looks recipes up within the tenant only', async () => {
        useSession(sessionFor(TENANT_A));
        const csv = 'recipe,type,qty,unit,ingredient,iqty,iunit\nTheir Meal,menu_item,5,servings,Beef,2,lb\n';
        const fd = new FormData();
        fd.append('file', new File([csv], 'import.csv', { type: 'text/csv' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        await POST({ formData: async () => fd } as any);

        const lookups = mock.callsTo('recipe.findFirst');
        expect(lookups.length).toBeGreaterThan(0);
        for (const call of lookups) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
        for (const call of mock.callsTo('ingredient.findFirst')) {
            expect(call.args.where.business_id).toBe(TENANT_A);
        }
    });

    it('recipes/upload CSV path stamps business_id on newly created rows', async () => {
        useSession(sessionFor(TENANT_A));
        const csv = 'recipe,type,qty,unit,ingredient,iqty,iunit\nNew Meal,menu_item,5,servings,Beef,2,lb\n';
        const fd = new FormData();
        fd.append('file', new File([csv], 'import.csv', { type: 'text/csv' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        await POST({ formData: async () => fd } as any);

        expect(mock.firstCall('recipe.create')!.args.data.business_id).toBe(TENANT_A);
        expect(mock.firstCall('ingredient.create')!.args.data.business_id).toBe(TENANT_A);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Cross-tenant RecipeItem deletion — required case 7.
// ═════════════════════════════════════════════════════════════════════════════
describe('6. recipe ingredient lines of another tenant cannot be deleted', () => {
    it('a foreign recipe id in a JSON backup deletes no RecipeItem rows', async () => {
        useMock(createPrismaMock({
            results: { 'recipe.findMany': [{ id: 'victim-recipe', business_id: TENANT_B }] },
        }));
        useSession(sessionFor(TENANT_A));

        const backup = {
            data: {
                recipes: [
                    { id: 'victim-recipe', name: 'Theirs', child_items: [] },
                    { id: 'mine', name: 'Mine', child_items: [] },
                ],
            },
        };
        const fd = new FormData();
        fd.append('file', new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        const res = await POST({ formData: async () => fd } as any);

        expect(res.status).toBe(403);
        // Whole-file rejection: even the caller's OWN recipe is untouched, because
        // the two-pass loop has no transaction and partial rejection is unsafe.
        expect(mock.callsTo('recipeItem.deleteMany')).toHaveLength(0);
    });

    it('an orphan row with business_id null is treated as foreign, not adoptable', async () => {
        useMock(createPrismaMock({
            results: { 'recipe.findMany': [{ id: 'orphan', business_id: null }] },
        }));
        useSession(sessionFor(TENANT_A));

        const backup = { data: { recipes: [{ id: 'orphan', name: 'Legacy', child_items: [] }] } };
        const fd = new FormData();
        fd.append('file', new File([JSON.stringify(backup)], 'b.json', { type: 'application/json' }));

        const { POST } = await import('@/app/api/recipes/upload/route');
        const res = await POST({ formData: async () => fd } as any);
        expect(res.status).toBe(403);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. generate-PO is not an anonymous mail relay — required case 13.
// ═════════════════════════════════════════════════════════════════════════════
describe('7. generate-PO cannot act as an anonymous email relay', () => {
    it('sends no email at all when anonymous', async () => {
        useSession(null);
        const { POST } = await import('@/app/api/production/generate-po/route');
        const res = await POST(jsonRequest('http://localhost/x', {
            supplier: 'ACME', email: 'attacker@example.com',
            items: [{ id: 'x', name: 'Beef', toBuy: 2, unit: 'lb' }],
        }));

        expect(res.status).toBe(401);
        expect(mockEmailSend).not.toHaveBeenCalled();
    });

    it('an authenticated caller sends from the tenant sender, never the platform fallback', async () => {
        useSession(sessionFor(TENANT_A));
        const { POST } = await import('@/app/api/production/generate-po/route');
        const res = await POST(jsonRequest('http://localhost/x', {
            supplier: 'ACME', email: 'buyer@example.com',
            items: [{ id: 'x', name: 'Beef', toBuy: 2, unit: 'lb' }],
        }));

        expect(res.status).toBe(200);
        expect(mockEmailSend).toHaveBeenCalledTimes(1);
        const sent = mockEmailSend.mock.calls[0][0] as any;
        expect(sent.from).toBe('Tenant <t@example.com>');
        expect(sent.from).not.toContain('orders@freezeriq.com');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Physical printer routes — no anonymous handle on hardware.
// ═════════════════════════════════════════════════════════════════════════════
describe('8. label printer routes require a session', () => {
    it('print-label never reaches the printer when anonymous', async () => {
        useSession(null);
        const { getLabelPrinter } = await import('@/lib/label_printer');
        const { POST } = await import('@/app/api/production/print-label/route');
        const res = await POST(jsonRequest('http://localhost/x', { job: { recipeName: 'X' } }));

        expect(res.status).toBe(401);
        expect(getLabelPrinter).not.toHaveBeenCalled();
    });

    it('print never reaches the printer when anonymous', async () => {
        useSession(null);
        const { getLabelPrinter } = await import('@/lib/label_printer');
        const { POST } = await import('@/app/api/production/print/route');
        const res = await POST(jsonRequest('http://localhost/x', { items: [{ recipeName: 'X' }] }));

        expect(res.status).toBe(401);
        expect(getLabelPrinter).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. training GET — the undefined-business_id collapse.
// ═════════════════════════════════════════════════════════════════════════════
describe('9. training resources are not readable anonymously', () => {
    it('never issues a query whose OR contains an undefined business_id', async () => {
        // Prisma STRIPS undefined from a where clause, so `{ business_id: undefined }`
        // collapsed to `{}` and matched every tenant's rows. The guard prevents the
        // query from being built at all.
        useSession(null);
        const { GET } = await import('@/app/api/training/route');
        await GET(new Request('http://localhost/api/training') as any);
        expect(mock.callsTo('trainingResource.findMany')).toHaveLength(0);
    });

    it('an authenticated caller queries with a concrete business_id', async () => {
        useSession(sessionFor(TENANT_A));
        const { GET } = await import('@/app/api/training/route');
        await GET(new Request('http://localhost/api/training') as any);

        const call = mock.firstCall('trainingResource.findMany');
        expect(call).toBeDefined();
        const or = call!.args.where.OR;
        expect(or).toEqual([{ business_id: null }, { business_id: TENANT_A }]);
        for (const clause of or) {
            expect(clause.business_id).not.toBeUndefined();
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Intentional public routes stay public — required case 14.
// ═════════════════════════════════════════════════════════════════════════════
describe('10. intentionally public routes were not made authenticated', () => {
    it('the public fundraiser scoreboard is still reachable without a session', async () => {
        useMock(createPrismaMock({
            results: {
                'fundraiserCampaign.findUnique': {
                    id: 'camp-1', name: 'Camp', public_token: 'tok', total_sales: 0,
                    bundle_goal: 10, orders: [], customer: { name: 'Org' },
                },
            },
        }));
        useSession(null);
        const { GET } = await import('@/app/api/fundraiser/[token]/route');
        const res = await GET(
            new Request('http://localhost/api/fundraiser/tok') as any,
            { params: Promise.resolve({ token: 'tok' }) } as any,
        );
        expect(res.status).not.toBe(401);
    });

    it('the public storefront read is still reachable without a session', async () => {
        useSession(null);
        const { GET } = await import('@/app/api/public/tenant/[slug]/route');
        const res = await GET(
            new Request('http://localhost/api/public/tenant/acme') as any,
            { params: Promise.resolve({ slug: 'acme' }) } as any,
        );
        expect(res.status).not.toBe(401);
    });
});
