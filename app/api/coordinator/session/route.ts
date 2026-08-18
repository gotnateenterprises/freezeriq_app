/**
 * FR-COORD-SEC-1B — coordinator session exchange.
 *
 * POST   trades a coordinator credential for an opaque session cookie.
 * DELETE revokes the current session (explicit logout).
 *
 * The credential is accepted ONLY in the request body. It is never read from
 * the path, the query string, or a header, because all three are recorded by
 * Vercel's request logging and that is the exact defect this phase closes.
 *
 * The credential is never logged, never echoed, and never returned — not even
 * in an error. The response says whether the exchange worked and nothing else.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
    createCoordinatorSession,
    setCoordinatorSessionCookie,
    revokeCurrentCoordinatorSession,
    isSameOriginMutation,
} from '@/lib/coordinatorSession';

/**
 * One response for every failure: unknown credential, malformed body, wrong
 * shape, campaign that does not exist. A coordinator cannot tell them apart, so
 * the endpoint cannot be used to probe which credentials or campaigns are real.
 */
function refuse() {
    return NextResponse.json(
        { ok: false, error: 'This coordinator link is no longer valid.' },
        { status: 401 }
    );
}

export async function POST(req: Request) {
    try {
        // Cookie-authenticated state change: same-origin only. The exchange
        // itself does not yet have a session, but it MINTS one, so a cross-site
        // page must not be able to drive it.
        if (!isSameOriginMutation(req)) return refuse();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return refuse();
        }

        const credential =
            body && typeof body === 'object' && typeof (body as any).credential === 'string'
                ? (body as any).credential.trim()
                : '';

        // Cheap structural gate before touching the database. A real credential
        // is 43 base64url characters; anything else cannot match one and is not
        // worth a query.
        if (!credential || credential.length < 20 || credential.length > 200) return refuse();

        // Exact equality on a UNIQUE column. No pattern matching, no ILIKE, no
        // prefix search — the FR-PUBLIC-IDENTITY lesson applies here too.
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { portal_token: credential },
            select: { id: true },
        });
        if (!campaign) return refuse();

        const { secret } = await createCoordinatorSession(campaign.id);
        await setCoordinatorSessionCookie(secret);

        // Deliberately minimal: no campaign id, no name, no credential. The
        // portal fetches what it needs through the session.
        return NextResponse.json({ ok: true });
    } catch {
        // Never surface the underlying error — it could distinguish "no such
        // credential" from "database unavailable".
        return refuse();
    }
}

/**
 * Explicit logout: revoke server-side, then clear the cookie.
 *
 * Idempotent by design. No cookie, an expired session, and an already-revoked
 * session all succeed, so this can never be used to probe whether a session
 * existed.
 *
 * FR-COORD-SEC-1D-L: only a genuine infrastructure failure reaches the catch,
 * and it must NOT report success — the session would still be live while the
 * coordinator believed they had signed out. The cookie is deliberately left in
 * place on that path so a retry can still identify which session to revoke.
 */
export async function DELETE(req: Request) {
    try {
        if (!isSameOriginMutation(req)) return refuse();
        await revokeCurrentCoordinatorSession();
        return NextResponse.json({ ok: true });
    } catch {
        return NextResponse.json(
            { ok: false, error: 'We could not log you out. Please try again.' },
            { status: 500 }
        );
    }
}
