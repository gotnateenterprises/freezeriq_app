/**
 * SEC-PUBLIC-ROUTE-1 — repository-wide route classification sweep.
 *
 * The defect this phase repaired was not one bad route; it was a whole class of
 * handler that shipped with no authentication because nothing enumerated them.
 * This test is the mechanism that stops the class from silently returning: it
 * walks every `app/api/**\/route.ts`, splits each file into its individual
 * exported HTTP handlers, and requires each one to demonstrate exactly one
 * recognised security posture.
 *
 * Two design decisions matter, both taken from Part Q of the phase brief:
 *
 * 1. IT CLASSIFIES PER HANDLER, NOT PER FILE. `app/api/marketing/send/route.ts`
 *    is the reason: its POST was correctly gated while its GET was not. A
 *    file-level grep for `auth()` called that file safe. Each handler body is
 *    extracted by brace matching from its own `export` site, so a guard in one
 *    method can never vouch for another.
 *
 * 2. THE PUBLIC SET IS AN EXPLICIT ALLOWLIST, NOT AN INFERENCE. A handler is
 *    only permitted to be unauthenticated if it is named below with a stated
 *    product reason. Adding a new unauthenticated handler therefore fails this
 *    test until someone writes down why it is public — which is the whole point.
 *
 * This is a structural test, not a behavioural one. It proves a guard is present
 * in each handler; `tests/secPublicRoute1.test.ts` proves the guards actually
 * refuse, by executing the real handlers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const ROOT = process.cwd();

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Every TRACKED route.ts under app/api, as repo-relative POSIX paths.
 *
 * Tracked, not on-disk: the working tree carries parked, uncommitted
 * password-reset routes that are absent from Production. Sweeping the filesystem
 * would demand a security classification for code that is not deployed, and
 * would make this test's result depend on someone's local scratch state.
 */
function routeFiles(): string[] {
    const out = execFileSync('git', ['ls-files', 'app/api'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('/route.ts'));
}

/**
 * Extract one handler's body by brace matching from its export site.
 * Returns null when the verb is not exported by this file.
 *
 * Brace matching (rather than "the rest of the file") is what makes this
 * per-handler: a GET declared after a guarded POST gets only its own body.
 *
 * The parameter list must be skipped first by paren matching. Next 15/16
 * handlers are routinely declared as
 *   export async function GET(req: Request, { params }: { params: Promise<...> }) {
 * and the first `{` after the signature is the DESTRUCTURED PARAMETER, not the
 * body. Taking it would hand the classifier a few characters of type annotation
 * and report every such handler as unguarded.
 */
function handlerBody(src: string, verb: string): string | null {
    const patterns = [
        new RegExp(`export\\s+async\\s+function\\s+${verb}\\s*\\(`),
        new RegExp(`export\\s+function\\s+${verb}\\s*\\(`),
        new RegExp(`export\\s+const\\s+${verb}\\s*=`),
    ];

    for (const re of patterns) {
        const m = re.exec(src);
        if (!m) continue;

        // Walk past the balanced parameter list, if the match ended on '('.
        let cursor = m.index + m[0].length;
        if (src[cursor - 1] === '(') {
            let parens = 1;
            while (cursor < src.length && parens > 0) {
                if (src[cursor] === '(') parens++;
                else if (src[cursor] === ')') parens--;
                cursor++;
            }
        }

        const open = src.indexOf('{', cursor);
        if (open === -1) continue;

        let depth = 0;
        for (let i = open; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') {
                depth--;
                if (depth === 0) return src.slice(open, i + 1);
            }
        }
        return src.slice(open); // unbalanced; treat the remainder as the body
    }
    return null;
}

/** Does this handler body carry a real, self-defending guard? */
function guardOf(body: string, fileSrc = body): string | null {
    const has = (re: RegExp) => re.test(body);

    // C — coordinator session. The helper itself returns the 401, so its
    // presence is the guard.
    if (has(/requireCoordinatorSession\s*\(/)) return 'coordinator-session';
    if (has(/isSameOriginMutation\s*\(/)) return 'coordinator-exchange';

    // D — signed/verified service callers.
    if (has(/constructEvent\s*\(/)) return 'webhook-signature';
    if (has(/verifySignature\s*\(/)) return 'webhook-signature';
    if (has(/VERIFY_TOKEN|verify_token/)) return 'webhook-verify-token';

    // B — tenant session. An auth() call alone is NOT enough: /api/training and
    // /api/ai/generate both called auth() and never gated on the result, which
    // is precisely how they shipped unauthenticated. Require the early return
    // (or an UnauthorizedError throw, used by the withErrorHandler routes) too.
    const callsAuth = has(/\bauth\s*\(\s*\)/) || has(/getServerSession\s*\(/);

    // DELEGATED GUARD. app/api/flyer/download/route.ts resolves authorization in a
    // same-file helper that returns null on failure, and the handler gates on that
    // null. The auth primitive is therefore in the helper, not the handler body —
    // but the handler is still self-defending, so it must not be reported unguarded.
    // Recognised only when all three hold: the handler awaits a local helper, gates
    // on its falsy result with a return, and that helper genuinely calls an auth
    // primitive.
    if (!callsAuth) {
        for (const m of body.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
            const [, resultVar, fnName] = m;
            const gatedOnIt = new RegExp(`if\\s*\\(\\s*!\\s*${resultVar}\\b[^)]*\\)\\s*\\{?[\\s\\S]{0,200}?\\breturn\\b`).test(body);
            if (!gatedOnIt) continue;
            const helper = new RegExp(
                `(?:async\\s+function|const)\\s+${fnName}\\b[\\s\\S]{0,2000}?(?:\\bauth\\s*\\(\\s*\\)|resolveCoordinatorSession\\s*\\(|requireCoordinatorSession\\s*\\()`
            );
            if (helper.test(fileSrc)) return 'tenant-session';
        }
        return null;
    }

    // An auth() call alone is NOT a guard, and the gate must be ON THE SESSION.
    // Both halves matter:
    //  - /api/training read the session and never tested it at all;
    //  - /api/ai/generate read the session, ignored it, and DID have an unrelated
    //    `if (!tenantKey && !process.env...) return` — so "some negated early
    //    return exists" would have called that ungated handler safe.
    // So: collect the identifiers actually derived from the session, then require
    // a negated early return on `session` itself or on one of those.
    const derived = new Set<string>(['session']);
    // `const businessId = session?.user?.businessId` and also the cast-heavy form
    // `const businessId = (session?.user as any)?.businessId` — anything assigned
    // from an expression that mentions the session counts as session-derived.
    for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
        if (/\bsession\b/.test(m[2])) derived.add(m[1]);
    }
    for (const m of body.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*session\b/g)) {
        for (const raw of m[1].split(',')) {
            const name = raw.split(':').pop()!.trim().replace(/=.*$/, '').trim();
            if (name) derived.add(name);
        }
    }

    const names = [...derived].map((n) => n.replace(/[$]/g, '\\$')).join('|');
    const gates =
        new RegExp(`if\\s*\\(\\s*!\\s*(?:${names})\\b[^)]*\\)\\s*\\{?[\\s\\S]{0,300}?\\breturn\\b`).test(body) ||
        has(/throw\s+new\s+UnauthorizedError/) ||
        has(/requireSuperAdmin\s*\(|requireAdmin\s*\(/);
    if (gates) return 'tenant-session';

    // Token-as-credential surfaces resolve the bearer and refuse on miss.
    if (has(/openUnsubscribeToken|resolveRebookingAccess/)) return 'opaque-token';

    return null;
}

/**
 * A — INTENTIONALLY PUBLIC, plus the inert stubs.
 *
 * Every entry states why it needs no session. Keyed `VERB path`. This list is
 * the contract: an unauthenticated handler that is not on it fails the sweep.
 */
const PUBLIC_ALLOWLIST: Record<string, string> = {
    // ── Public storefront / supporter commerce. Tenant is resolved server-side
    //    from the URL slug; a client-supplied businessId is never trusted.
    'GET app/api/public/tenant/[slug]/route.ts': 'public storefront catalogue, slug-scoped',
    'GET app/api/public/tenant/[slug]/tiers/route.ts': 'returns a constant empty list',
    'POST app/api/public/order/route.ts': 'public supporter order submission, slug-scoped + idempotency key',
    'POST app/api/public/menu-signup/route.ts': 'storefront email capture, slug-scoped, uniform anti-enumeration response',
    'POST app/api/public/waitlist/route.ts': 'surplus waitlist, slug-scoped',
    'POST app/api/public/fundraiser-request/route.ts': 'public start-a-fundraiser intake, slug-scoped + submissionKey',
    'POST app/api/public/business-lead/route.ts': 'platform lead form on the marketing site',
    'GET app/api/public/customer/loyalty/route.ts': 'DEFERRED — see SEC-CUSTOMER-AUTH-1 in the phase report; needs a customer session, which has no working issuance path today',
    'POST app/api/checkout/session/route.ts': 'storefront checkout, slug-resolved business',
    'POST app/api/checkout/square/pay/route.ts': 'supporter card payment; businessId derived from the order, amount re-checked server-side',
    'GET app/api/checkout/session/success/route.ts': 'post-payment confirmation, verified against the live Stripe session',
    'POST app/api/checkout/validate-delivery/route.ts': 'pre-checkout address check, slug-scoped, read-only',

    // ── Opaque-token bearer surfaces. The token IS the credential.
    'GET app/api/fundraiser/[token]/route.ts': 'public fundraiser scoreboard; supporter names masked server-side',
    'GET app/api/rebook/[token]/route.ts': 'rebooking link state, token-resolved',
    'POST app/api/rebook/[token]/route.ts': 'rebooking submission, token-resolved + idempotency key',
    'POST app/api/rebook/[token]/refresh/route.ts': 'resend-my-link; sets one flag, mints no credential',
    'GET app/api/unsubscribe/[token]/route.ts': 'List-Unsubscribe target; deliberately side-effect-free',
    'POST app/api/unsubscribe/[token]/route.ts': 'signed unsubscribe token; uniform refusal, no existence oracle',

    // ── Credential exchange. These MINT sessions; they cannot require one.
    'GET app/api/auth/[...nextauth]/route.ts': 'NextAuth handler',
    'POST app/api/auth/[...nextauth]/route.ts': 'NextAuth sign-in/callback',
    'POST app/api/coordinator/session/route.ts': 'coordinator credential -> session cookie exchange, same-origin gated',
    'DELETE app/api/coordinator/session/route.ts': 'coordinator logout, same-origin gated',
    'GET app/api/auth/square/callback/route.ts': 'OAuth callback; businessId from an httpOnly state cookie, not the query',
    'GET app/api/auth/stripe/callback/route.ts': 'OAuth callback; signed state verified server-side',
    'GET app/api/auth/meta/callback/route.ts': 'OAuth callback bound to the session business',
    'GET app/api/integrations/auth/qbo/callback/route.ts': 'OAuth callback bound to the session business',
    'POST app/api/customer/auth/logout/route.ts': 'deletes the caller own cookie; can affect nobody else',
    'POST app/api/public/customer/auth/logout/route.ts': 'deletes the caller own cookie; can affect nobody else',

    // ── Redirects to a third-party consent screen. No DB, no data.
    'GET app/api/auth/instagram/route.ts': 'redirect to Instagram consent; callback is authenticated',
    'GET app/api/auth/meta/route.ts': 'redirect to Meta consent; callback is authenticated',
    'GET app/api/auth/qbo/route.ts': 'redirect to Intuit consent; callback is authenticated',
    'GET app/api/integrations/auth/qbo/login/route.ts': 'redirect to Intuit consent; callback is authenticated',

    // ── Meta webhook POSTs. DEFERRED, not accepted as safe: these need HMAC
    //    signature verification, a different mechanism from session auth, and
    //    ARCHITECTURE.md:376-385 makes webhook behaviour an approval-gated area.
    //    See SEC-META-WEBHOOK-1 in the phase report.
    'POST app/api/webhooks/meta/route.ts': 'DEFERRED — see SEC-META-WEBHOOK-1; needs HMAC verification, not a session',
    'POST app/api/integrations/meta/webhook/route.ts': 'DEFERRED — see SEC-META-WEBHOOK-1; duplicate of the above',

    // ── Inert stubs: 501/410/constant responses. No DB, no side effect.
    'POST app/api/admin/subscriptions/tiers/route.ts': 'returns 501; SubscriptionTier does not exist in the schema',
    'POST app/api/commercial/extra-meals/[id]/publish/route.ts': 'returns 501',
    'POST app/api/customer/auth/request-link/route.ts': 'returns 501',
    'GET app/api/customer/auth/verify/route.ts': 'returns 501',
    'POST app/api/customer/box/submit/route.ts': 'returns 501',
    'POST app/api/public/customer/auth/request/route.ts': 'returns 501',
    'GET app/api/public/customer/auth/verify/route.ts': 'returns 501',
    'POST app/api/public/customer/box/submit/route.ts': 'returns 501',
    'POST app/api/public/customer/subscription/route.ts': 'returns 501',
    'GET app/api/settings/qr-codes/route.ts': 'returns 501',
    'POST app/api/settings/qr-codes/route.ts': 'returns 501',
    'DELETE app/api/settings/qr-codes/route.ts': 'returns 501',
    'GET app/api/stripe/callback/route.ts': 'retired stub',
    'POST app/api/integrations/square/route.ts': 'deliberately retired to 410',
    'GET app/api/integrations/square/route.ts': 'deliberately retired to 410',
    'POST app/api/integrations/sync/qbo/route.ts': 'returns 501',
};

interface Handler { key: string; file: string; verb: string; guard: string | null; }

const HANDLERS: Handler[] = (() => {
    const out: Handler[] = [];
    for (const file of routeFiles()) {
        const src = readFileSync(join(ROOT, file), 'utf8');

        // `export const { GET, POST } = handlers` — the NextAuth destructured form.
        const destructured = /export\s+const\s*\{([^}]+)\}\s*=/.exec(src);
        if (destructured) {
            for (const verb of VERBS) {
                if (new RegExp(`\\b${verb}\\b`).test(destructured[1])) {
                    out.push({ key: `${verb} ${file}`, file, verb, guard: null });
                }
            }
            continue;
        }

        for (const verb of VERBS) {
            const body = handlerBody(src, verb);
            if (body === null) continue;
            out.push({ key: `${verb} ${file}`, file, verb, guard: guardOf(body, src) });
        }
    }
    return out;
})();

describe('SEC-PUBLIC-ROUTE-1 — every API handler is classified', () => {
    it('finds a substantial number of handlers (the sweep is actually running)', () => {
        // A guard against the enumeration silently breaking and vacuously passing.
        expect(HANDLERS.length).toBeGreaterThan(250);
    });

    it('every handler is either guarded or on the explicit public allowlist', () => {
        const unaccounted = HANDLERS
            .filter((h) => h.guard === null && !(h.key in PUBLIC_ALLOWLIST))
            .map((h) => h.key)
            .sort();

        expect(unaccounted).toEqual([]);
    });

    it('no allowlist entry is stale (every listed handler still exists)', () => {
        const live = new Set(HANDLERS.map((h) => h.key));
        const stale = Object.keys(PUBLIC_ALLOWLIST).filter((k) => !live.has(k)).sort();
        expect(stale).toEqual([]);
    });

    it('reports the classification tally (Part Y) and it is internally consistent', () => {
        const tally: Record<string, number> = {};
        for (const h of HANDLERS) {
            const bucket = h.guard ?? (h.key in PUBLIC_ALLOWLIST ? 'intentional-public' : 'UNCLASSIFIED');
            tally[bucket] = (tally[bucket] || 0) + 1;
        }
        // eslint-disable-next-line no-console
        console.log('SEC-PUBLIC-ROUTE-1 handler classification:', JSON.stringify({
            total: HANDLERS.length, ...tally,
        }, null, 2));

        expect(tally['UNCLASSIFIED'] ?? 0).toBe(0);
        expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(HANDLERS.length);
    });

    it('every allowlist entry states a reason', () => {
        for (const [key, reason] of Object.entries(PUBLIC_ALLOWLIST)) {
            expect(typeof reason).toBe('string');
            expect(reason.trim().length).toBeGreaterThan(10);
            expect(key).toMatch(/^(GET|POST|PUT|PATCH|DELETE) app\/api\//);
        }
    });
});

describe('SEC-PUBLIC-ROUTE-1 — the specific handlers this phase repaired stay guarded', () => {
    const REPAIRED = [
        'GET app/api/analytics/margins/route.ts',
        'POST app/api/recipes/upload/route.ts',
        'POST app/api/commercial/ingredients/merge/route.ts',
        'PUT app/api/delivery/route/reorder/route.ts',
        'POST app/api/delivery/record-print-job/route.ts',
        'POST app/api/production/deduct/route.ts',
        'POST app/api/production/generate-po/route.ts',
        'POST app/api/production/print/route.ts',
        'POST app/api/production/print-label/route.ts',
        'GET app/api/training/route.ts',
        'GET app/api/marketing/send/route.ts',
        'POST app/api/ai/feedback/route.ts',
        'POST app/api/ai/generate/route.ts',
    ];

    for (const key of REPAIRED) {
        it(`${key} carries a tenant-session guard`, () => {
            const handler = HANDLERS.find((h) => h.key === key);
            expect(handler).toBeDefined();
            expect(handler!.guard).toBe('tenant-session');
        });

        it(`${key} is NOT on the public allowlist`, () => {
            expect(PUBLIC_ALLOWLIST[key]).toBeUndefined();
        });
    }
});

describe('SEC-PUBLIC-ROUTE-1 — per-handler classification really is per handler', () => {
    it('distinguishes the two methods of app/api/marketing/send/route.ts', () => {
        // This file is the reason the sweep is not file-level: before this phase
        // its POST was guarded and its GET was not.
        const get = HANDLERS.find((h) => h.key === 'GET app/api/marketing/send/route.ts');
        const post = HANDLERS.find((h) => h.key === 'POST app/api/marketing/send/route.ts');
        expect(get?.guard).toBe('tenant-session');
        expect(post?.guard).toBe('tenant-session');
    });

    it('an auth() call with no early return does not count as a guard', () => {
        // The exact shape that let /api/training ship unauthenticated: the
        // session was read and then ignored.
        const ungated = `{
            const session = await auth();
            const businessId = session?.user?.businessId;
            return NextResponse.json({ ok: true });
        }`;
        expect(guardOf(ungated)).toBeNull();
    });

    it('an unrelated early return does not launder an ungated session read', () => {
        // The pre-fix shape of /api/ai/generate: auth() was called and ignored,
        // but the handler DID contain a negated early return on something else.
        // A classifier that only asked "is there any `if (!x) return`" would have
        // reported this as guarded.
        const ungatedButHasAnEarlyReturn = `{
            const session = await auth();
            let tenantKey = null;
            if (session?.user?.businessId) { tenantKey = await getKey(session.user.businessId); }
            if (!tenantKey && !process.env.GEMINI_API_KEY) {
                return NextResponse.json({ error: 'missing key' }, { status: 400 });
            }
            return NextResponse.json({ ok: true });
        }`;
        expect(guardOf(ungatedButHasAnEarlyReturn)).toBeNull();
    });

    it('a gate on a value destructured from the session counts', () => {
        // app/api/tenant/branding/route.ts does exactly this.
        const gatedViaDerived = `{
            const session = await auth();
            const userId = session?.user?.id;
            if (!userId) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            return NextResponse.json({ ok: true });
        }`;
        expect(guardOf(gatedViaDerived)).toBe('tenant-session');
    });

    it('a guarded handler body is recognised', () => {
        const gated = `{
            const session = await auth();
            if (!session?.user?.businessId) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            return NextResponse.json({ ok: true });
        }`;
        expect(guardOf(gated)).toBe('tenant-session');
    });
});
