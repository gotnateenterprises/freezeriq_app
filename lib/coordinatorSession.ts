/**
 * FR-COORD-SEC-1B — the coordinator session.
 *
 * WHAT WAS WRONG
 * The coordinator credential travelled in the URL path (`/coordinator/<token>`)
 * and was re-sent on every subsequent request: 12 API calls placed it in the
 * path and 2 more in the query string. Vercel records the concrete request path
 * of every request, so a single coordinator visit wrote the live secret into the
 * production access log more than a dozen times. Hashing the credential at rest
 * would not have helped — the leak is in transport, not storage.
 *
 * WHAT THIS IS
 * The credential now arrives exactly once, in a URL *fragment*, which browsers
 * never put on the wire. The access page reads it in JavaScript and POSTs it in
 * a request body to the exchange endpoint, which trades it for an opaque session
 * cookie. Every later request authenticates with that cookie and carries no
 * credential in any URL.
 *
 * WHY SERVER-STORED
 * Revocation is a hard requirement: rotating a campaign's portal_token, or an
 * explicit logout, must end access immediately. A signed stateless cookie cannot
 * be revoked without a denylist, and a denylist is a session table wearing a
 * disguise — so this is a plain table.
 *
 * WHAT IS STORED
 * Only sha256(secret). The raw cookie value lives in the coordinator's browser
 * and nowhere else, mirroring OutreachRecipient.rebooking_token_hash. A database
 * disclosure therefore cannot be replayed as a live session.
 *
 * Server-only: `node:crypto` keeps this out of any client bundle by construction.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';

/** 32 bytes = 256 bits, the same size as the portal credential it replaces. */
export const COORDINATOR_SESSION_SECRET_BYTES = 32;

/** base64url of 32 bytes is always 43 characters. Exported so tests can assert. */
export const COORDINATOR_SESSION_SECRET_LENGTH = 43;

/**
 * Fixed 24-hour lifetime. Deliberately NOT sliding: a coordinator whose session
 * lapses simply re-opens the link they already have, which costs them one click
 * and costs us none of the complexity of renewal races.
 */
export const COORDINATOR_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Production cookie name. The `__Host-` prefix is enforced by the browser and
 * requires Secure, Path=/ and NO Domain attribute — which is exactly the
 * contract we want, so the prefix turns our intent into something the browser
 * polices rather than something we merely promise.
 *
 * A cookie cannot carry two Path values, so scoping to both `/coordinator` and
 * `/api/coordinator` is impossible; Path=/ is the only correct choice. The
 * cookie may therefore accompany other same-origin requests, and the rule that
 * makes that safe is enforced in code: ONLY the helpers in this module read it,
 * and they resolve authority solely from the session row.
 */
export const COORDINATOR_SESSION_COOKIE = '__Host-freezeriq_coordinator_session';

/**
 * `__Host-` requires Secure, and Secure cookies do not work over plain HTTP, so
 * localhost needs a separate name. This is a development-only relaxation: the
 * production attributes below are never weakened to accommodate it.
 */
export const COORDINATOR_SESSION_COOKIE_DEV = 'freezeriq_coordinator_session_dev';

const isProd = () => process.env.NODE_ENV === 'production';

export function coordinatorSessionCookieName(): string {
    return isProd() ? COORDINATOR_SESSION_COOKIE : COORDINATOR_SESSION_COOKIE_DEV;
}

/** Mint an opaque session secret. Never stored; only its digest is. */
export function mintCoordinatorSessionSecret(): string {
    return randomBytes(COORDINATOR_SESSION_SECRET_BYTES).toString('base64url');
}

/** sha256 hex. The only form of the secret that ever reaches the database. */
export function hashCoordinatorSessionSecret(secret: string): string {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * The lookup below is already an indexed equality probe, so this is belt and
 * braces rather than the primary defence — but a digest comparison is cheap and
 * there is no reason to leak timing on one.
 */
export function digestsMatch(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
}

export type CoordinatorSessionRecord = {
    id: string;
    campaign_id: string;
    expires_at: Date;
    revoked_at: Date | null;
};

/**
 * Exchange a validated campaign for a fresh session.
 *
 * Returns the RAW secret exactly once, to be written straight into the cookie
 * by the caller. It is never returned to the client in a response body and
 * never logged.
 */
export async function createCoordinatorSession(campaignId: string): Promise<{
    secret: string;
    session: CoordinatorSessionRecord;
}> {
    const secret = mintCoordinatorSessionSecret();
    const session = await prisma.coordinatorSession.create({
        data: {
            campaign_id: campaignId,
            session_hash: hashCoordinatorSessionSecret(secret),
            expires_at: new Date(Date.now() + COORDINATOR_SESSION_TTL_MS),
        },
        select: { id: true, campaign_id: true, expires_at: true, revoked_at: true },
    });
    return { secret, session };
}

/**
 * The cookie's scope, defined once.
 *
 * FR-COORD-SEC-1D-L-R: setting and clearing MUST use identical attributes. A
 * browser matches a Set-Cookie to an existing cookie by name/domain/path, and
 * the `__Host-` prefix additionally REQUIRES Secure, Path=/ and no Domain — on
 * the deletion as much as on the original. Sharing one definition is what makes
 * the two impossible to drift apart.
 */
function coordinatorSessionCookieScope() {
    return {
        httpOnly: true,
        secure: isProd(),
        sameSite: 'lax' as const,
        path: '/',
    };
}

/** Write the session cookie. Production attributes are not negotiable. */
export async function setCoordinatorSessionCookie(secret: string): Promise<void> {
    const store = await cookies();
    store.set(coordinatorSessionCookieName(), secret, {
        ...coordinatorSessionCookieScope(),
        maxAge: Math.floor(COORDINATOR_SESSION_TTL_MS / 1000),
    });
}

/**
 * Expire the cookie explicitly.
 *
 * NOT `store.delete()`: Next serialises that as `name=; Path=/; Expires=1970`
 * with NO Secure attribute, and a `__Host-` prefixed cookie without Secure is
 * rejected outright by the browser — so the deletion is discarded and the real
 * cookie survives its full TTL. Proven against the installed runtime and in a
 * browser. Max-Age=0 expires it; the 1970 Expires is the belt-and-braces form
 * for any client that honours only the older attribute.
 */
export async function clearCoordinatorSessionCookie(): Promise<void> {
    const store = await cookies();
    store.set(coordinatorSessionCookieName(), '', {
        ...coordinatorSessionCookieScope(),
        maxAge: 0,
        expires: new Date(0),
    });
}

async function readCoordinatorSessionSecret(): Promise<string | null> {
    const store = await cookies();
    return store.get(coordinatorSessionCookieName())?.value ?? null;
}

/**
 * Resolve the caller's session to a campaign, or null.
 *
 * Fails closed on every path: no cookie, unknown digest, revoked, or expired all
 * return null and are indistinguishable to the caller. Nothing about which of
 * those it was reaches the client.
 */
export async function resolveCoordinatorSession(): Promise<{
    session: CoordinatorSessionRecord;
    campaignId: string;
} | null> {
    const secret = await readCoordinatorSessionSecret();
    if (!secret) return null;

    const session = await prisma.coordinatorSession.findUnique({
        where: { session_hash: hashCoordinatorSessionSecret(secret) },
        select: { id: true, campaign_id: true, expires_at: true, revoked_at: true },
    });
    if (!session) return null;
    if (session.revoked_at) return null;
    if (session.expires_at.getTime() <= Date.now()) return null;

    return { session, campaignId: session.campaign_id };
}

/**
 * The campaign this request is authorised for, or null.
 *
 * This is the ONLY way a coordinator route may learn which campaign it is
 * acting on. A campaign id supplied by the client is never consulted, so a
 * session cannot be pointed at a second campaign by editing a request body.
 */
export async function resolveCoordinatorCampaignId(): Promise<string | null> {
    const resolved = await resolveCoordinatorSession();
    return resolved?.campaignId ?? null;
}

/**
 * Best-effort activity stamp. Deliberately fire-and-forget: a failed write here
 * must never turn a valid coordinator request into an error.
 */
export async function touchCoordinatorSession(sessionId: string): Promise<void> {
    try {
        await prisma.coordinatorSession.update({
            where: { id: sessionId },
            data: { last_used_at: new Date() },
        });
    } catch {
        /* activity tracking is not worth failing a request over */
    }
}

/** Explicit logout. Idempotent. */
export async function revokeCoordinatorSessionBySecret(secret: string): Promise<void> {
    await prisma.coordinatorSession.updateMany({
        where: { session_hash: hashCoordinatorSessionSecret(secret), revoked_at: null },
        data: { revoked_at: new Date() },
    });
}

export async function revokeCurrentCoordinatorSession(): Promise<void> {
    const secret = await readCoordinatorSessionSecret();
    if (secret) await revokeCoordinatorSessionBySecret(secret);
    await clearCoordinatorSessionCookie();
}

/**
 * FR-COORD-SEC-1B PART S — the rotation primitive.
 *
 * Replacing a campaign's portal_token must not leave live sessions behind that
 * were established with the old credential, or rotation would revoke the link
 * while leaving open browsers authorised. This is the primitive FR-COORD-SEC-1D
 * will call; it rotates NOTHING by itself.
 *
 * Returns the number of sessions revoked.
 */
export async function revokeAllCoordinatorSessionsForCampaign(campaignId: string): Promise<number> {
    const { count } = await prisma.coordinatorSession.updateMany({
        where: { campaign_id: campaignId, revoked_at: null },
        data: { revoked_at: new Date() },
    });
    return count;
}

/**
 * Same-origin check for state-changing coordinator requests.
 *
 * Cookie authentication introduces ambient authority that the old bearer-in-URL
 * design did not have: a cross-site form could previously not authenticate at
 * all, and now the browser would attach the cookie for it. SameSite=Lax already
 * withholds the cookie from cross-site POSTs, and this is the second lock.
 *
 * A browser always sends Origin on POST/PUT/PATCH/DELETE, so a missing Origin on
 * a mutation is not a normal browser request and is refused.
 */
export function isSameOriginMutation(req: Request): boolean {
    const origin = req.headers.get('origin');
    if (!origin) return false;
    let candidate: URL;
    try {
        candidate = new URL(origin);
    } catch {
        return false;
    }
    const target = new URL(req.url);
    return candidate.origin === target.origin;
}

/** Methods that carry mutation semantics and therefore require the check above. */
export const COORDINATOR_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requiresSameOriginCheck(method: string): boolean {
    return COORDINATOR_MUTATION_METHODS.has(method.toUpperCase());
}

/**
 * One guard for every coordinator route.
 *
 * Returns the authorised campaign id, or a Response that the route should return
 * unchanged. Every failure — no session, expired, revoked, cross-origin — yields
 * the same generic shape, so the endpoint is not an oracle for any of them.
 */
export async function requireCoordinatorSession(req: Request): Promise<
    { ok: true; campaignId: string; sessionId: string } | { ok: false; response: Response }
> {
    const deny = () =>
        new Response(JSON.stringify({ error: 'Not authorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });

    if (requiresSameOriginCheck(req.method) && !isSameOriginMutation(req)) {
        return { ok: false, response: deny() };
    }

    const resolved = await resolveCoordinatorSession();
    if (!resolved) return { ok: false, response: deny() };

    return { ok: true, campaignId: resolved.campaignId, sessionId: resolved.session.id };
}
