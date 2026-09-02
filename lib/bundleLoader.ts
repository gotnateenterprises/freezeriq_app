/**
 * OPS-5C — the Manual Planner's Bundle-load STATE MACHINE.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * WHY THIS EXISTS
 *
 * OPS-5B gated the Bundle fetch behind `if (status !== 'authenticated')
 * return;`, where `status` is NextAuth's client-side useSession() readiness
 * signal. On the deployed preview that gate never resolved: the effect that
 * fires the fetch runs its ONE guaranteed pass per mount (React only re-runs
 * an effect when a dependency changes on a LATER render of that SAME
 * instance), and by the time ProductionCalculator is freshly mounted --
 * conditionally, on a client tab click, not at page load -- there is no
 * further code-level trigger that gives it a second chance if that first
 * read of `status` was not already 'authenticated'.
 *
 * THE ARCHITECTURAL FIX
 *
 * app/api/bundles/route.ts is ALREADY fully self-defending: it calls auth()
 * first, 401s before any query, and derives business_id ONLY from the
 * server session -- never from anything client-supplied
 * (tests/opsManualPlannerBundleFilter1.test.ts covers this, unmodified by
 * this phase). The client does not need to know its own tenant, or even
 * that it is authenticated, before ASKING the server for "my active
 * Bundles" -- the server is the one that decides whether to answer.
 * app/suppliers/page.tsx already proves this pattern works: it fetches on
 * mount with NO auth/session gate of any kind and treats a non-ok response
 * as "nothing to show" rather than hanging. app/customers/page.tsx even
 * contains a SECOND, fully ungated fetch of this exact '/api/bundles'
 * endpoint, working correctly beside its own (separately-purposed,
 * feature-gate) status check.
 *
 * So the fetch now fires unconditionally on mount. This module is the
 * state machine that guarantees it always TERMINATES -- into exactly one of
 * 'ready' or 'error', never left at 'loading' -- regardless of how the
 * response fails (401, 500, malformed JSON, a non-array body, or the fetch
 * itself rejecting). Extracted as a pure function (Part H) rather than left
 * inline, because the previous phase's inline version was proven only by
 * source-text regexes, which cannot demonstrate that every failure path
 * actually reaches a terminal state -- exactly the class of gap this
 * failure was.
 */

export type BundleLoadState = 'loading' | 'ready' | 'error';

export type BundleListResult =
    | { ok: true; bundles: any[] }
    | { ok: false; reason: string };

/**
 * Interprets a settled fetch Response into a terminal outcome. Never
 * throws -- a malformed body (bad JSON, or valid JSON that isn't an array)
 * is reported as `{ ok: false }`, exactly like a non-2xx status, so a
 * caller can never mistake "the server said something we don't understand"
 * for "the tenant genuinely has zero Bundles."
 */
export async function resolveBundleListResponse(res: Response): Promise<BundleListResult> {
    if (!res.ok) {
        return { ok: false, reason: `Bundle load failed: ${res.status}` };
    }
    let data: unknown;
    try {
        data = await res.json();
    } catch {
        return { ok: false, reason: 'Bundle response was not valid JSON' };
    }
    if (!Array.isArray(data)) {
        return { ok: false, reason: 'Unexpected bundle response shape' };
    }
    return { ok: true, bundles: data };
}

/**
 * Runs one Bundle-load attempt to completion. Fires `fetchImpl` immediately
 * -- no auth/session/tenant readiness gate of any kind, by design (see
 * module doc) -- and is guaranteed to call `setBundlesLoadState` with a
 * TERMINAL value ('ready' or 'error') no matter how the fetch settles,
 * unless `isCancelled` reports the caller has already unmounted.
 */
export async function loadBundles(
    fetchImpl: () => Promise<Response>,
    setters: {
        setBundles: (bundles: any[]) => void;
        setBundlesLoadState: (state: BundleLoadState) => void;
    },
    isCancelled: () => boolean = () => false,
): Promise<void> {
    setters.setBundlesLoadState('loading');

    let result: BundleListResult;
    try {
        const res = await fetchImpl();
        result = await resolveBundleListResponse(res);
    } catch (err) {
        result = { ok: false, reason: err instanceof Error ? err.message : 'Network error' };
    }

    if (isCancelled()) return;

    if (result.ok) {
        setters.setBundles(result.bundles);
        setters.setBundlesLoadState('ready');
    } else {
        console.error('Failed to load Bundles:', result.reason);
        setters.setBundlesLoadState('error');
    }
}
