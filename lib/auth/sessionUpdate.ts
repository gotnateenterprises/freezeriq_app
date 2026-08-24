/**
 * SEC-TENANT-1 — the one place a client-supplied session update may touch the token.
 *
 * WHY THIS MODULE EXISTS
 *
 * Auth.js v5 passes the browser's `useSession().update(x)` payload straight into
 * the jwt callback. From the installed library,
 * node_modules/@auth/core/lib/actions/session.js:28 —
 *
 *     const token = await callbacks.jwt({
 *         ...(isUpdate && { trigger: "update" }),
 *         session: newSession,          // <- verbatim client input
 *
 * So the `session` argument of a jwt callback is a REQUEST BODY. It is not
 * server state, it has not been validated, and any authenticated user can put
 * anything in it. The previous implementation assigned `token.businessId` from
 * it directly, which let any tenant user re-scope their own session — and with
 * it all ~141 route handlers that derive `where: { business_id }` from
 * `session.user.businessId` — onto another tenant.
 *
 * THE TWO QUESTIONS, ANSWERED SEPARATELY
 *
 *   "May this caller view another tenant?"  -> token.isSuperAdmin, trusted server
 *                                              state written at sign-in from the
 *                                              database and never writable here.
 *   "Which tenant, with which attributes?"  -> a signed grant from
 *                                              POST /api/admin/switch-tenant, which
 *                                              proved super-admin AND loaded the
 *                                              business row before signing.
 *
 * Both must hold. The privilege check is deliberately independent of the grant,
 * so obtaining a grant can never substitute for being a super admin.
 *
 * This is a single choke point rather than per-endpoint checks: the endpoints
 * were never individually wrong. They all scope correctly. They shared one
 * premise — that `session.user.businessId` is trustworthy — and that premise is
 * what is repaired here.
 *
 * RESIDUAL RISK, recorded rather than hidden: `isSuperAdmin` lives in a JWE
 * cookie whose expiry is refreshed on every session call
 * (@auth/core/lib/actions/session.js:46), so demoting a super admin in the
 * database does not take effect until they go idle past the 30-day default
 * maxAge. That staleness is a pre-existing property of every claim in this
 * session strategy (role, plan, businessId all share it), it predates this fix,
 * and this fix strictly narrows what a stale claim can do. Closing it needs a
 * per-request database check, which is a separate architectural decision.
 */

import { verifyViewAsGrant } from './viewAsGrant';

/** Business names and plans ride in a cookie; keep them bounded. */
const MAX_DISPLAY_LEN = 200;

function clamp(v: unknown): string {
    return typeof v === 'string' ? v.slice(0, MAX_DISPLAY_LEN) : '';
}

/**
 * Apply a client-supplied session update to the token, in place.
 *
 * Returns the same token object. A payload that is malformed, unsigned, or that
 * asks for something the caller may not have is a no-op — never a widening of
 * scope, never a partial application.
 */
export async function applySessionUpdate(
    token: any,
    update: unknown,
    secret: string | undefined,
): Promise<any> {
    if (!token) return token;
    if (!update || typeof update !== 'object' || Array.isArray(update)) return token;

    const u = update as Record<string, unknown>;

    // PRIVILEGE. Decided by trusted token state alone. Nothing in `u` can grant
    // it — including a field named to look as though it does.
    if (token.isSuperAdmin !== true) return token;

    // Remember the real identity before the first hop, so exiting and
    // re-logging-in both return home.
    //
    // The marker is an explicit boolean rather than "is baseBusinessId set?".
    // Inferring it from truthiness has two failure modes, both found by the
    // adversarial pass: a super admin with NO home business would never latch
    // (baseBusinessId stays undefined), so the SECOND hop would capture the
    // FIRST hop's view-as target as their base and exiting would strand them in
    // someone else's tenant; and any token carrying a base id but not the other
    // base fields would restore an undefined name and plan on exit.
    // Capturing all of it once, under one flag, removes both.
    if (token.baseCaptured !== true) {
        token.baseBusinessId = token.businessId;
        token.baseBusinessName = token.businessName;
        token.basePlan = token.plan;
        token.baseSubscriptionStatus = token.subscriptionStatus;
        token.baseCaptured = true;
    }

    // Leaving needs no target and therefore no grant.
    if (u.exitViewAs === true) {
        token.businessId = token.baseBusinessId;
        token.businessName = token.baseBusinessName;
        token.plan = token.basePlan;
        token.subscriptionStatus = token.baseSubscriptionStatus;
        delete token.viewAsBusinessId;
        return token;
    }

    // TARGET. Only a server-signed grant may move the effective tenant. A bare
    // `businessId` — the original exploit string — and a bare `viewAsBusinessId`
    // are both inert here, for everyone, forever.
    if (!secret) return token;
    const grant = await verifyViewAsGrant(u.viewAsGrant, secret);
    if (!grant) return token;

    // The grant is bound to the admin it was issued to, so it cannot be relayed
    // into a different super admin's session.
    if (!token.sub || grant.sub !== token.sub) return token;

    // Applied together, from one server-side lookup, so the claims cannot
    // disagree with each other.
    token.viewAsBusinessId = grant.bid;
    token.businessId = grant.bid;
    token.businessName = clamp(grant.name);
    token.plan = clamp(grant.plan);
    token.subscriptionStatus = clamp(grant.status);

    return token;
}

/** Reset all tenant authority from the database user at sign-in. */
export function applySignIn(token: any, user: any): any {
    token.role = user.role;
    token.permissions = user.permissions;
    token.businessId = user.businessId;
    token.plan = user.plan;
    token.subscriptionStatus = user.subscriptionStatus;
    token.isSuperAdmin = user.isSuperAdmin;
    token.businessLogo = user.businessLogo;
    token.businessName = user.businessName;

    // A fresh sign-in is always the real identity. Any view-as context from a
    // previous token is discarded rather than inherited.
    delete token.viewAsBusinessId;
    delete token.baseCaptured;
    delete token.baseBusinessId;
    delete token.baseBusinessName;
    delete token.basePlan;
    delete token.baseSubscriptionStatus;
    delete token.baseBusinessLogo;

    return token;
}
