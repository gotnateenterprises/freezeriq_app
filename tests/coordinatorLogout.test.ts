/**
 * FR-COORD-SEC-1D-L — the coordinator logout control.
 *
 * The gap these tests exist to close: the logout backend shipped in
 * FR-COORD-SEC-1B and nothing in the portal ever called it, so a coordinator on
 * a shared or borrowed device could not end their session — it simply lapsed at
 * 24 hours.
 *
 * The security-relevant behaviour is exercised for real: `runCoordinatorLogout`
 * is driven with an injected fetch so the assertions below observe the actual
 * request and the actual branching, not source text. Source assertions are kept
 * for the properties that genuinely are properties of the source — where the
 * control is rendered, and what the code is forbidden to reference.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
    runCoordinatorLogout,
    COORDINATOR_LOGOUT_ENDPOINT,
    COORDINATOR_SIGNED_OUT_PATH,
    COORDINATOR_LOGOUT_ERROR,
} from '@/lib/coordinatorLogout';
import { isSameOriginMutation, requiresSameOriginCheck } from '@/lib/coordinatorSession';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const LOGOUT_LIB = 'lib/coordinatorLogout.ts';
const LOGOUT_BUTTON = 'components/coordinator/LogoutButton.tsx';
const PORTAL = 'app/coordinator/portal/page.tsx';
const ACCESS = 'app/coordinator/access/page.tsx';
const SESSION_ROUTE = 'app/api/coordinator/session/route.ts';

/** Comments describe the old defect on purpose; only code counts. */
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

/** A minimal stand-in for Response; only `ok` is consulted. */
const reply = (ok: boolean) => ({ ok }) as Response;

/** Records every call so the request itself can be asserted on. */
function recordingFetch(result: Response | Error) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const impl = (async (url: any, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (result instanceof Error) throw result;
        return result;
    }) as unknown as typeof fetch;
    return { impl, calls };
}

function harness(result: Response | Error) {
    const { impl, calls } = recordingFetch(result);
    const navigated: string[] = [];
    const errors: string[] = [];
    return {
        calls,
        navigated,
        errors,
        run: () =>
            runCoordinatorLogout({
                fetchImpl: impl,
                navigate: (p) => navigated.push(p),
                onError: (m) => errors.push(m),
            }),
    };
}

// ── The request itself ───────────────────────────────────────────────────────

describe('the logout request', () => {
    it('is a DELETE to the session endpoint', async () => {
        const h = harness(reply(true));
        await h.run();

        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].url).toBe(COORDINATOR_LOGOUT_ENDPOINT);
        expect(h.calls[0].url).toBe('/api/coordinator/session');
        expect(h.calls[0].init?.method).toBe('DELETE');
    });

    it('sends no body at all — the cookie is the whole request', async () => {
        const h = harness(reply(true));
        await h.run();

        expect(h.calls[0].init?.body).toBeUndefined();
    });

    it('is same-origin, so the server-side CSRF check can pass legitimately', async () => {
        const h = harness(reply(true));
        await h.run();

        expect(h.calls[0].init?.credentials).toBe('same-origin');
    });

    it('carries no credential, campaign id, or session value anywhere', async () => {
        const h = harness(reply(true));
        await h.run();

        // `credentials: 'same-origin'` is a fetch mode, not a credential. Drop
        // the known-good option so the sweep below still means something.
        const init: Record<string, unknown> = { ...(h.calls[0].init as object) };
        expect(init.credentials).toBe('same-origin');
        delete init.credentials;

        const whole = JSON.stringify({ url: h.calls[0].url, init });
        for (const forbidden of [
            'portal_token', 'portalToken', 'credential', 'token',
            'campaign_id', 'campaignId', 'session_hash', 'sessionHash', 'secret',
        ]) {
            expect(whole).not.toContain(forbidden);
        }
    });

    it('puts nothing in the URL beyond the fixed endpoint path', async () => {
        const h = harness(reply(true));
        await h.run();

        expect(h.calls[0].url).not.toContain('?');
        expect(h.calls[0].url).not.toContain('#');
    });
});

// ── Success ──────────────────────────────────────────────────────────────────

describe('a successful logout', () => {
    it('navigates to the neutral signed-out destination', async () => {
        const h = harness(reply(true));
        const outcome = await h.run();

        expect(outcome).toBe('success');
        expect(h.navigated).toEqual([COORDINATOR_SIGNED_OUT_PATH]);
        expect(h.errors).toEqual([]);
    });

    it('lands somewhere tokenless that cannot re-authenticate', () => {
        expect(COORDINATOR_SIGNED_OUT_PATH).toBe('/coordinator/access?signedout=1');
        // Not a legacy bearer URL, and no fragment to re-exchange.
        expect(COORDINATOR_SIGNED_OUT_PATH).not.toMatch(/#/);
        expect(COORDINATOR_SIGNED_OUT_PATH).not.toMatch(/\/coordinator\/[A-Za-z0-9_-]{20,}/);
    });
});

// ── Failure: the property that matters most ──────────────────────────────────

describe('a failed logout never claims success', () => {
    it.each([
        ['a rejected request', reply(false)],
        ['a network failure', new Error('offline')],
    ])('%s reports an error and does NOT navigate', async (_label, result) => {
        const h = harness(result as Response | Error);
        const outcome = await h.run();

        expect(outcome).toBe('failed');
        expect(h.navigated).toEqual([]);
        expect(h.errors).toEqual([COORDINATOR_LOGOUT_ERROR]);
    });

    it('uses plain, retryable, non-technical copy', () => {
        expect(COORDINATOR_LOGOUT_ERROR).toBe("We couldn't log you out. Please try again.");
        expect(COORDINATOR_LOGOUT_ERROR).not.toMatch(/50\d|error|exception|fetch|null|undefined/i);
    });

    it('does not leak the failure reason to the coordinator', async () => {
        const h = harness(new Error('ECONNREFUSED 10.0.0.5:5432'));
        await h.run();

        expect(h.errors[0]).not.toContain('ECONNREFUSED');
        expect(h.errors[0]).not.toContain('5432');
    });
});

// ── The control itself ───────────────────────────────────────────────────────

describe('the portal exposes a visible logout control', () => {
    const portal = read(PORTAL);
    const button = read(LOGOUT_BUTTON);

    it('is rendered by the authenticated portal', () => {
        expect(code(portal)).toContain('<LogoutButton />');
        expect(code(portal)).toMatch(/import \{ LogoutButton \} from '@\/components\/coordinator\/LogoutButton'/);
    });

    it('sits in the portal header, not buried in a sub-page or footer', () => {
        // The header is the sticky top bar; the control must appear before <main>.
        const header = portal.indexOf('sticky top-0');
        const main = portal.indexOf('<main');
        const control = portal.indexOf('<LogoutButton />');

        expect(header).toBeGreaterThan(-1);
        expect(control).toBeGreaterThan(header);
        expect(control).toBeLessThan(main);
    });

    it('is labelled in plain words, not an icon alone', () => {
        expect(button).toContain('Log out');
        expect(code(button)).toMatch(/<LogOut[^>]*aria-hidden/);
    });

    it('is a real button, so it is keyboard operable', () => {
        expect(code(button)).toMatch(/<button/);
        expect(code(button)).toMatch(/type="button"/);
    });

    it('meets a normal tap-target size', () => {
        expect(button).toMatch(/min-h-\[44px\]/);
    });

    it('guards double submission with a synchronous latch, not React state', () => {
        const c = code(button);
        // Two clicks in the same tick would both read the pre-render value of
        // `busy` and both get through; a ref updates synchronously.
        expect(c).toMatch(/const inFlight = useRef\(false\)/);
        expect(c).toMatch(/if \(inFlight\.current\) return;/);
        expect(c).toMatch(/inFlight\.current = true;/);
        // State still drives appearance.
        expect(c).toMatch(/disabled=\{busy\}/);
        expect(c).toMatch(/aria-busy=\{busy\}/);
    });

    it('releases the latch only when logout failed, so success cannot be double-fired', () => {
        const c = code(button);
        expect(c).toMatch(/if \(outcome === 'failed'\)/);
        expect(c).toMatch(/inFlight\.current = false;/);
    });
});

// ── Signed-out destination ───────────────────────────────────────────────────

describe('the signed-out screen', () => {
    const access = read(ACCESS);

    it('tells the truth instead of reusing the broken-link message', () => {
        expect(access).toContain('You&apos;ve been logged out');
        expect(access).toContain('Use your coordinator link to open the portal again.');
    });

    it('still shows the broken-link message when there was no logout', () => {
        expect(access).toContain('This coordinator link is no longer valid');
        // The two states are distinct, not the same branch.
        expect(code(access)).toMatch(/phase === 'signedout'/);
        expect(code(access)).toMatch(/phase === 'invalid'/);
    });

    it('never re-authenticates from stored state', () => {
        const c = code(access);
        expect(c).not.toMatch(/localStorage|sessionStorage/);
    });

    it('reaches the signed-out state from the flag, not by accident', () => {
        // Binding the flag to the phase is what makes the screen reachable at
        // all; a hard-coded phase here would strand it as dead markup.
        expect(code(access)).toMatch(
            /setPhase\(\s*signedOut\s*\?\s*'signedout'\s*:\s*'invalid'\s*\)/
        );
    });

    it('consults the flag only after a credential is ruled out', () => {
        const c = code(access);
        const guard = c.indexOf('if (!credential)');
        // The use site, not the constant's declaration.
        const flag = c.indexOf('.has(SIGNED_OUT_PARAM)');
        expect(guard).toBeGreaterThan(-1);
        expect(flag).toBeGreaterThan(guard);
    });
});

// ── Backend contract ─────────────────────────────────────────────────────────

describe('the logout endpoint', () => {
    const route = code(read(SESSION_ROUTE));

    it('still enforces the same-origin check on DELETE', () => {
        const del = route.slice(route.indexOf('export async function DELETE'));
        expect(del).toMatch(/if \(!isSameOriginMutation\(req\)\) return refuse\(\);/);
    });

    it('revokes only the caller session, never the campaign', () => {
        const del = route.slice(route.indexOf('export async function DELETE'));
        expect(del).toContain('revokeCurrentCoordinatorSession()');
        expect(del).not.toContain('revokeAllCoordinatorSessionsForCampaign');
    });

    it('does NOT report success when revocation failed', () => {
        const del = route.slice(route.indexOf('export async function DELETE'));
        const catchBlock = del.slice(del.indexOf('catch'));
        expect(catchBlock).not.toMatch(/ok:\s*true/);
        expect(catchBlock).toMatch(/status:\s*500/);
    });

    it('takes no credential and no campaign id on the logout path', () => {
        const del = route.slice(route.indexOf('export async function DELETE'));
        expect(del).not.toContain('req.json()');
        expect(del).not.toContain('portal_token');
        expect(del).not.toContain('campaign');
    });
});

// ── CSRF, for the logout verb specifically ───────────────────────────────────

describe('the same-origin gate applies to DELETE, not just POST', () => {
    const del = (origin: string | null) =>
        new Request('https://www.freezeriqapp.com/api/coordinator/session', {
            method: 'DELETE',
            ...(origin ? { headers: { origin } } : {}),
        });

    it('treats DELETE as a mutation', () => {
        expect(requiresSameOriginCheck('DELETE')).toBe(true);
    });

    it('accepts the portal\'s own same-origin logout', () => {
        expect(isSameOriginMutation(del('https://www.freezeriqapp.com'))).toBe(true);
    });

    it.each([
        ['a cross-origin page', 'https://evil.example.com'],
        ['a look-alike host', 'https://www.freezeriqapp.com.evil.example'],
        ['a malformed Origin', 'not-a-url'],
        ['a scheme downgrade', 'http://www.freezeriqapp.com'],
    ])('rejects %s', (_label, origin) => {
        expect(isSameOriginMutation(del(origin))).toBe(false);
    });

    it('rejects a DELETE with no Origin at all', () => {
        expect(isSameOriginMutation(del(null))).toBe(false);
    });
});

// ── Exposure sweep ───────────────────────────────────────────────────────────

describe('logout introduces no credential or storage exposure', () => {
    it.each([LOGOUT_LIB, LOGOUT_BUTTON])('%s touches no client storage', (path) => {
        const c = code(read(path));
        expect(c).not.toMatch(/localStorage/);
        expect(c).not.toMatch(/sessionStorage/);
        expect(c).not.toMatch(/document\.cookie/);
    });

    it.each([LOGOUT_LIB, LOGOUT_BUTTON])('%s logs nothing', (path) => {
        expect(code(read(path))).not.toMatch(/console\s*\./);
    });

    it.each([LOGOUT_LIB, LOGOUT_BUTTON])('%s never names a credential', (path) => {
        const c = code(read(path));
        expect(c).not.toMatch(/portal_token|portalToken/);
    });

    it('reads no session value in client code — it cannot, and must not try', () => {
        const c = code(read(LOGOUT_LIB)) + code(read(LOGOUT_BUTTON));
        expect(c).not.toMatch(/__Host-/);
        expect(c).not.toMatch(/freezeriq_coordinator_session/);
    });
});
