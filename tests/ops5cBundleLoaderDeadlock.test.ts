/**
 * OPS-5C — Manual Planner Bundle loader client-auth deadlock closeout.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * OWNER-OBSERVED DEFECT, freshly traced (not assumed) at e18f4d4: on the
 * exact READY OPS-5B preview, Production -> Manual Planner rendered "Loading
 * Bundles..." forever. Independent Vercel runtime-log inspection (this
 * phase's own diagnostic pass, corroborating the owner's account) found
 * /production, /api/production/dashboard and /api/tenant/branding all
 * succeeding, but ZERO requests -- ever, on this deployment or the one
 * before it -- to /api/bundles, and ZERO to /api/auth/session.
 *
 * ROOT CAUSE, freshly proven (not assumed) from next-auth's own installed
 * source (node_modules/next-auth/react.js) and from ProductionCalculator.tsx
 * itself: SessionProvider, given app/layout.tsx's server-resolved session
 * prop, DELIBERATELY skips its own /api/auth/session fetch on mount -- so
 * that absence is expected next-auth behavior, not evidence of a hang.
 * OPS-5B's `if (status !== 'authenticated') return;` guard sits inside a
 * useEffect with dependency array [status]; React only re-runs that effect
 * when a LATER render of this exact component instance produces a changed
 * `status`. Because ProductionCalculator mounts fresh only when the user
 * clicks the "Manual Planner" tab (app/production/page.tsx's activeTab
 * ternary, not at page load), that first render sees whatever `status` the
 * already-running SessionProvider happens to hold at that arbitrary moment.
 * If it is not already 'authenticated', the guard returns once and nothing
 * in the file ever gives the effect a second chance -- exactly the observed
 * "Loading Bundles..." forever, zero fetch.
 *
 * THE FIX. app/api/bundles/route.ts is already fully self-defending (proven
 * fresh in this phase, and unmodified -- see the reused
 * tests/opsManualPlannerBundleFilter1.test.ts suite): it authenticates via
 * auth() first, 401s before any query, and derives business_id ONLY from
 * the server session, never from anything client-supplied. The client does
 * not need to know it is authenticated before ASKING; the server decides
 * whether to answer. app/suppliers/page.tsx already proves this pattern
 * (unconditional fetch, `if (res.ok)`), and app/customers/page.tsx contains
 * a second, fully ungated fetch of this EXACT '/api/bundles' endpoint,
 * working correctly. So the client-side auth-readiness gate is removed
 * entirely -- not narrowed, not replaced with a different gate.
 *
 * lib/bundleLoader.ts extracts the load STATE MACHINE as pure, directly
 * testable functions (Part H: do not accept only source-text assertions for
 * a claim about behavior). resolveBundleListResponse() and loadBundles()
 * are exercised here with mock Response-like objects and mock setters --
 * genuine behavioral proof, not regex matching against comments.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveBundleListResponse, loadBundles, type BundleLoadState } from '@/lib/bundleLoader';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const FILE = 'components/production/ProductionCalculator.tsx';

function bundleEffectBlock(src: string): string {
    const fetchIdx = src.indexOf('loadBundles(');
    if (fetchIdx === -1) throw new Error('loadBundles(...) call not found in source');
    const effectStart = src.lastIndexOf('useEffect(() => {', fetchIdx);
    const depsStart = src.indexOf('}, [', fetchIdx);
    if (effectStart === -1 || depsStart === -1) throw new Error('Could not isolate the Bundle-load effect');
    const depsEnd = src.indexOf('])', depsStart);
    if (depsEnd === -1) throw new Error('Could not find the end of the dependency array');
    return src.slice(effectStart, depsEnd + 2); // include through the closing "])" so the deps array is inspectable
}

// ═════════════════════════════════════════════════════════════════════════════
// PART B / H — root-cause pin, failing-first against e18f4d4 (the deployed
// defect): the effect must not depend on ANY client auth-readiness signal.
// ═════════════════════════════════════════════════════════════════════════════
describe('the Bundle-load effect has no client auth-readiness gate at all', () => {
    it('DEFECT: does not gate on NextAuth status', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).not.toMatch(/status\s*!==\s*['"]authenticated['"]/);
    });

    it('DEFECT: does not gate on businessId', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).not.toMatch(/if\s*\(\s*!businessId\s*\)\s*return;/);
    });

    it('DEFECT: fires exactly once, unconditionally, on mount -- empty dependency array', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block.trim().endsWith('}, [])')).toBe(true);
    });

    it('useSession is no longer destructured for status -- nothing in this file needs it', () => {
        const src = strip(read(FILE));
        expect(src).not.toMatch(/const\s*\{\s*data:\s*session,\s*status\s*\}\s*=\s*useSession\(\)/);
        expect(src).not.toMatch(/\bstatus\b\s*!==\s*['"]authenticated['"]/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART C — server route re-proof (fresh, not assumed). Route file untouched.
// ═════════════════════════════════════════════════════════════════════════════
describe('app/api/bundles/route.ts remains fully self-defending (unmodified by this phase)', () => {
    it('auth() is called and checked before any Prisma query', () => {
        const src = strip(read('app/api/bundles/route.ts'));
        const getFn = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'));
        const authIdx = getFn.indexOf('await auth()');
        const queryIdx = getFn.indexOf('prisma.bundle.findMany');
        expect(authIdx).toBeGreaterThan(-1);
        expect(queryIdx).toBeGreaterThan(authIdx);
    });

    it('business_id is derived only from the server session, never from a client value', () => {
        const src = strip(read('app/api/bundles/route.ts'));
        expect(src).toMatch(/business_id:\s*session\.user\.businessId/);
        expect(src).not.toMatch(/business_id:\s*(data|body|searchParams)\./);
    });

    it('activeOnly still filters is_active', () => {
        const src = strip(read('app/api/bundles/route.ts'));
        expect(src).toMatch(/\.\.\.\(activeOnly \? \{ is_active: true \} : \{\}\)/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D/H — behavioral proof of the loader state machine itself, no jsdom
// required. This is the genuine (not source-text) proof for matrix items
// 7-12: every settlement path terminates, none can leave 'loading' forever.
// ═════════════════════════════════════════════════════════════════════════════
function mockResponse(overrides: Partial<{ ok: boolean; status: number; json: () => Promise<unknown> }>): Response {
    return {
        ok: overrides.ok ?? true,
        status: overrides.status ?? 200,
        json: overrides.json ?? (async () => []),
    } as unknown as Response;
}

describe('resolveBundleListResponse -- genuine behavioral proof, no source-text guessing', () => {
    it('7: a 401 response resolves to a failure, not an empty success', async () => {
        const result = await resolveBundleListResponse(mockResponse({ ok: false, status: 401 }));
        expect(result.ok).toBe(false);
    });

    it('7: a 403 response resolves to a failure', async () => {
        const result = await resolveBundleListResponse(mockResponse({ ok: false, status: 403 }));
        expect(result.ok).toBe(false);
    });

    it('8: a 500 response resolves to a failure, never to bundles: []', async () => {
        const result = await resolveBundleListResponse(mockResponse({ ok: false, status: 500 }));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(/500/);
    });

    it('9: a 200 with malformed (unparseable) JSON resolves to a failure', async () => {
        const result = await resolveBundleListResponse(
            mockResponse({ ok: true, json: async () => { throw new SyntaxError('Unexpected token'); } }),
        );
        expect(result.ok).toBe(false);
    });

    it('9: a 200 with valid JSON that is NOT an array resolves to a failure (shape guard)', async () => {
        const result = await resolveBundleListResponse(mockResponse({ ok: true, json: async () => ({ error: 'nope' }) }));
        expect(result.ok).toBe(false);
    });

    it('10: a 200 with an empty array resolves to a genuine success with zero bundles', async () => {
        const result = await resolveBundleListResponse(mockResponse({ ok: true, json: async () => [] }));
        expect(result).toEqual({ ok: true, bundles: [] });
    });

    it('11: a 200 with a populated array resolves to success carrying those bundles', async () => {
        const rows = [{ id: 'b1', name: 'Bundle One', sku: 'B1' }, { id: 'b2', name: 'Bundle Two', sku: 'B2' }];
        const result = await resolveBundleListResponse(mockResponse({ ok: true, json: async () => rows }));
        expect(result).toEqual({ ok: true, bundles: rows });
    });
});

describe('loadBundles -- the full orchestration always terminates (matrix item 12)', () => {
    function harness() {
        const states: BundleLoadState[] = [];
        const bundlesSeen: any[][] = [];
        const setters = {
            setBundles: (b: any[]) => bundlesSeen.push(b),
            setBundlesLoadState: (s: BundleLoadState) => states.push(s),
        };
        return { states, bundlesSeen, setters };
    }

    it('12: a 401 always ends at "error", never left at "loading"', async () => {
        const { states, setters } = harness();
        await loadBundles(async () => mockResponse({ ok: false, status: 401 }), setters);
        expect(states[0]).toBe('loading');
        expect(states[states.length - 1]).toBe('error');
    });

    it('12: a 500 always ends at "error"', async () => {
        const { states, setters } = harness();
        await loadBundles(async () => mockResponse({ ok: false, status: 500 }), setters);
        expect(states[states.length - 1]).toBe('error');
    });

    it('12: a rejected fetch (network failure) always ends at "error", never "loading"', async () => {
        const { states, setters } = harness();
        await loadBundles(async () => { throw new TypeError('Failed to fetch'); }, setters);
        expect(states[states.length - 1]).toBe('error');
    });

    it('12: malformed JSON always ends at "error"', async () => {
        const { states, setters } = harness();
        await loadBundles(
            async () => mockResponse({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }),
            setters,
        );
        expect(states[states.length - 1]).toBe('error');
    });

    it('a genuine empty tenant always ends at "ready" with zero bundles -- distinct from "error"', async () => {
        const { states, bundlesSeen, setters } = harness();
        await loadBundles(async () => mockResponse({ ok: true, json: async () => [] }), setters);
        expect(states[states.length - 1]).toBe('ready');
        expect(bundlesSeen[bundlesSeen.length - 1]).toEqual([]);
    });

    it('a successful populated response always ends at "ready" and renders the real bundles', async () => {
        const rows = [{ id: 'b1', name: 'Active Bundle', sku: 'AB-1' }];
        const { states, bundlesSeen, setters } = harness();
        await loadBundles(async () => mockResponse({ ok: true, json: async () => rows }), setters);
        expect(states[states.length - 1]).toBe('ready');
        expect(bundlesSeen[bundlesSeen.length - 1]).toEqual(rows);
    });

    it('cancellation (unmount mid-flight) suppresses the terminal setState entirely -- no stale update', async () => {
        const { states, setters } = harness();
        await loadBundles(async () => mockResponse({ ok: true, json: async () => [] }), setters, () => true);
        // 'loading' is set synchronously before the fetch is even awaited, but the
        // terminal ready/error state must never land after cancellation.
        expect(states).toEqual(['loading']);
    });

    it('EXHAUSTIVE: across every failure mode, the state machine never stops at "loading"', async () => {
        const scenarios: Array<() => Promise<Response>> = [
            async () => mockResponse({ ok: false, status: 401 }),
            async () => mockResponse({ ok: false, status: 403 }),
            async () => mockResponse({ ok: false, status: 500 }),
            async () => mockResponse({ ok: true, json: async () => { throw new Error('bad json'); } }),
            async () => mockResponse({ ok: true, json: async () => ({ not: 'an array' }) }),
            async () => { throw new Error('offline'); },
        ];
        for (const fetchImpl of scenarios) {
            const { states, setters } = harness();
            await loadBundles(fetchImpl, setters);
            expect(states[states.length - 1]).not.toBe('loading');
            expect(states[states.length - 1]).toBe('error');
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART D — the component wires loadBundles correctly (thin wiring pin, the
// heavy behavioral lifting is already done above without jsdom).
// ═════════════════════════════════════════════════════════════════════════════
describe('ProductionCalculator wires the extracted loader correctly', () => {
    it('imports loadBundles from the shared authority rather than re-implementing it', () => {
        const src = strip(read(FILE));
        expect(src).toMatch(/import\s*\{[^}]*loadBundles[^}]*\}\s*from\s*['"]@\/lib\/bundleLoader['"]/);
    });

    it('the effect passes setBundles and setBundlesLoadState through to loadBundles', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/setBundles/);
        expect(block).toMatch(/setBundlesLoadState/);
        expect(block).toMatch(/loadBundles\(/);
    });

    it('a cancellation flag is still threaded through, so an unmount mid-flight cannot update stale state', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/cancelled/);
    });

    it('the dropdown still renders three distinct, truthful loading/error/empty states (OPS-5B preserved)', () => {
        const src = strip(read(FILE));
        const selectRegion = src.slice(src.indexOf('<select'), src.indexOf('{bundles.map(b =>'));
        expect(selectRegion).toMatch(/Loading Bundles/);
        expect(selectRegion).toMatch(/Unable to load Bundles/);
        expect(selectRegion).toMatch(/No active Bundles/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Item 16 — no client business ID used as authorization anywhere in the loader.
// ═════════════════════════════════════════════════════════════════════════════
describe('no client business ID is used as authorization for the Bundle fetch', () => {
    it('the fetch URL carries no tenant identifier of any kind', () => {
        const src = strip(read(FILE));
        const block = bundleEffectBlock(src);
        expect(block).toMatch(/fetch\(['"`]\/api\/bundles\?activeOnly=true['"`]\)/);
        expect(block).not.toMatch(/business_id|businessId/);
    });

    it('lib/bundleLoader.ts never references businessId, session, or a tenant identifier', () => {
        const src = strip(read('lib/bundleLoader.ts'));
        expect(src).not.toMatch(/businessId|business_id/);
    });

    it('no literal tenant/business name is hardcoded anywhere in the loader', () => {
        const src = read(FILE) + read('lib/bundleLoader.ts');
        expect(src).not.toMatch(/my\s*freezer\s*chef/i);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Regression: selected Bundle -> Calculate Plan path (OPS-5B M7, re-pinned).
// ═════════════════════════════════════════════════════════════════════════════
describe('regression: the selected-Bundle -> Calculate Plan path is unaffected', () => {
    it('calculatePlan and updateOrder are unchanged', () => {
        const src = strip(read(FILE));
        const calcFn = src.slice(src.indexOf('const calculatePlan'), src.indexOf('const getSupplierSearchUrl'));
        expect(calcFn).toMatch(/orders\.filter\(o\s*=>\s*o\.bundle_id\s*&&\s*o\.quantity\s*>\s*0\)/);
        expect(calcFn).toMatch(/variant_size\s*!=\s*null/);
        expect(calcFn).toMatch(/JSON\.stringify\(\{\s*syncedOrders,\s*manualOrders\s*\}\)/);

        const updateFn = src.slice(src.indexOf('const updateOrder'), src.indexOf('const addRow'));
        expect(updateFn).toMatch(/field === 'bundle_id'/);
        expect(updateFn).toMatch(/variant_size:\s*undefined/);
    });

    it('the localStorage-restore effect is still separate and still businessId-scoped (unrelated, untouched)', () => {
        const src = strip(read(FILE));
        const queueIdx = src.indexOf('_productionQueue');
        const restoreEffectStart = src.lastIndexOf('useEffect(() => {', queueIdx);
        const guardRegion = src.slice(restoreEffectStart, queueIdx);
        expect(guardRegion).toMatch(/if\s*\(\s*!businessId\s*\)\s*return;/);
    });
});
