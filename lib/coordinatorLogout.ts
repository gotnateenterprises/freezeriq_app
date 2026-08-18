/**
 * FR-COORD-SEC-1D-L — coordinator logout, as testable logic.
 *
 * The behaviour that matters for security lives here rather than inside the
 * React component: what gets sent, what is deliberately NOT sent, and — most
 * importantly — that a failed logout is never reported as a success. Keeping it
 * free of React and Next imports means it can be exercised for real in tests
 * instead of asserted against source text.
 *
 * The session is an HttpOnly cookie. Client code cannot read it, so there is
 * nothing to pass: the request body is empty by design and the server resolves
 * which session to revoke from the cookie the browser attaches.
 */

/** The one endpoint. Same path as the exchange; DELETE is the logout verb. */
export const COORDINATOR_LOGOUT_ENDPOINT = '/api/coordinator/session';

/** Where a signed-out coordinator lands. Neutral, tokenless, no credential. */
export const COORDINATOR_SIGNED_OUT_PATH = '/coordinator/access?signedout=1';

/** Shown when logout did not demonstrably succeed. Never technical. */
export const COORDINATOR_LOGOUT_ERROR = "We couldn't log you out. Please try again.";

export type CoordinatorLogoutOutcome = 'success' | 'failed';

export interface CoordinatorLogoutDeps {
    /** Injected so tests drive the real branching rather than a mocked global. */
    fetchImpl: typeof fetch;
    /** Called only on a proven-successful logout. */
    navigate: (path: string) => void;
    /** Called with user-facing copy when logout did not succeed. */
    onError: (message: string) => void;
}

/**
 * Perform the logout request and decide what the coordinator is told.
 *
 * Returns 'success' ONLY when the server confirmed revocation. Any non-OK
 * response or network failure returns 'failed' without navigating, because
 * telling someone on a shared device that they are signed out when they are
 * not is the worst outcome this control can produce.
 */
export async function runCoordinatorLogout(
    deps: CoordinatorLogoutDeps
): Promise<CoordinatorLogoutOutcome> {
    const { fetchImpl, navigate, onError } = deps;

    try {
        const res = await fetchImpl(COORDINATOR_LOGOUT_ENDPOINT, {
            method: 'DELETE',
            // The cookie is the entire request. `same-origin` is already the
            // default; stated explicitly because logout depends on it, and the
            // server refuses cross-origin mutations outright.
            credentials: 'same-origin',
        });

        if (!res || !res.ok) {
            onError(COORDINATOR_LOGOUT_ERROR);
            return 'failed';
        }

        navigate(COORDINATOR_SIGNED_OUT_PATH);
        return 'success';
    } catch {
        onError(COORDINATOR_LOGOUT_ERROR);
        return 'failed';
    }
}
