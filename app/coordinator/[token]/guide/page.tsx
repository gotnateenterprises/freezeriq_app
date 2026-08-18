/**
 * FR-COORD-SEC-1C-R — retired coordinator guide bearer route.
 *
 * `/coordinator/<token>/guide` used to authenticate from the credential in the
 * path, exactly like its sibling `/coordinator/<token>`. The guide now lives
 * inside the session-authenticated portal at `/coordinator/portal/guide`, so
 * this route exists only to give old bookmarks and previously-sent emails the
 * same neutral answer as the retired portal route instead of a bare 404.
 *
 * Like its sibling it deliberately does almost nothing:
 *
 *   - it does NOT read the token from params,
 *   - it does NOT query portal_token,
 *   - it does NOT exchange the value for a session,
 *   - it does NOT redirect based on it.
 *
 * Every visitor sees the same page whether the value is a real credential, a
 * rotated one, or nonsense, so the route cannot be used to test whether a
 * campaign or credential exists.
 *
 * HONEST LIMITATION: this page cannot un-log anything. A browser that requests
 * this URL has already put the value into the access log — that request happened
 * before any of our code ran. This is precisely why FR-COORD-SEC-1D rotates every
 * existing credential rather than relying on this page to contain the exposure.
 *
 * Rendered as a static server component: no client JavaScript reads the URL, so
 * the value is not handed to anything at all.
 */
export const dynamic = 'force-static';

export const metadata = {
    title: 'Coordinator link | FreezerIQ',
    robots: { index: false, follow: false },
};

export default function RetiredCoordinatorGuideLinkPage() {
    return (
        <main className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
            <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200 text-center">
                <h1 className="text-lg font-semibold text-slate-900">
                    This coordinator link is no longer valid
                </h1>
                <p className="mt-3 text-sm text-slate-600">
                    Please ask your FreezerIQ contact for a new link.
                </p>
            </div>
        </main>
    );
}
