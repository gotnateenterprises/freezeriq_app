/**
 * INV-A — the fundraiser organization share, per campaign.
 *
 * WHAT THIS NUMBER IS
 * ───────────────────
 * The percentage of GROSS fundraiser sales the organization keeps. Stored on
 * the campaign as a PERCENT (25.00), never as a fraction (0.25). Percent is
 * deliberate: `Invoice.fundraiser_profit_percent` is already a percent, so the
 * closeout-time freeze-copy is a straight assignment with no unit conversion —
 * and a silent fraction/percent mix-up is a 100x money error.
 *
 * `ESTIMATED_FUNDRAISER_ORG_SHARE` in lib/fundraiserMetrics.ts is NOT replaced
 * by this module. It remains the display estimate for campaigns whose own rate
 * has not been read (and its own docstring already names itself as the thing
 * that must become configurable). This module is the per-campaign truth; INV-B
 * is what teaches the earnings surfaces to prefer it.
 *
 * The invoice math this feeds, in one line:
 *   balance due tenant = gross − (gross × pct / 100)
 * where gross is the campaign's FROZEN `settlement_total`, never `total_sales`.
 */

/** Backward-compatibility default. Every campaign that predates INV-A is 20.00. */
export const DEFAULT_ORG_SHARE_PERCENT = 20;

/**
 * Owner ruling (INV-A): the organization share is a FINANCIAL CONTRACT TERM —
 * it decides how much of gross fundraiser sales belongs to the organization — so
 * only an ADMIN or a super-admin may explicitly set or change it. CHEF and
 * DRIVER may not.
 *
 * SCOPE: this gates an EXPLICIT override only. A caller that simply omits the
 * field still creates or edits a campaign under that route's existing
 * permissions and gets the 20.00 database default. Creating a fundraiser was
 * never ADMIN-only and this must not make it so.
 *
 * WHY THIS IS NOT `mayCloseOutCampaign`: that predicate answers "may this user
 * freeze the money and release held orders". This one answers "may this user set
 * the terms". They evaluate identically today, and deliberately remain separate
 * declarations — the owner can widen who may configure a share without also
 * widening who may close a fundraiser out. Do not collapse them into one.
 *
 * Compares strictly: a truthy-but-not-true isSuperAdmin, or a lowercased role,
 * must not open a financial gate.
 */
export function mayManageFundraiserFinancialTerms(user: {
    role?: unknown;
    isSuperAdmin?: unknown;
}): boolean {
    if (user.isSuperAdmin === true) return true;
    return user.role === 'ADMIN';
}

/** Response body for an unauthorized explicit share override. Never silently ignored. */
export const ORG_SHARE_FORBIDDEN_MESSAGE =
    'Only an administrator can set the organization share for a fundraiser.';

export const MIN_ORG_SHARE_PERCENT = 0;
export const MAX_ORG_SHARE_PERCENT = 100;

export type OrgShareParseResult =
    | { ok: true; percent: number }
    | { ok: false; error: string };

/**
 * Server-authoritative parse + validate of a client-supplied organization share.
 *
 * Accepts a number or a numeric string (form inputs arrive as strings). Rejects
 * NaN, Infinity, blank, non-numeric text, and anything outside 0–100 inclusive.
 * Rounds to 2dp to match NUMERIC(5,2) rather than letting Postgres round
 * silently — a value the tenant typed should not change meaning on the way in.
 *
 * HTML min/max is a convenience, never the guard: this runs on the server.
 */
export function parseOrgSharePercent(input: unknown): OrgShareParseResult {
    if (input === null || input === undefined || input === '') {
        return { ok: false, error: 'Organization share is required.' };
    }

    // Booleans and arrays coerce to numbers in JS; refuse them explicitly.
    if (typeof input !== 'number' && typeof input !== 'string') {
        return { ok: false, error: 'Organization share must be a number.' };
    }

    if (typeof input === 'string' && input.trim() === '') {
        return { ok: false, error: 'Organization share is required.' };
    }

    const n = Number(input);
    if (!Number.isFinite(n)) {
        return { ok: false, error: 'Organization share must be a number.' };
    }

    if (n < MIN_ORG_SHARE_PERCENT || n > MAX_ORG_SHARE_PERCENT) {
        return {
            ok: false,
            error: `Organization share must be between ${MIN_ORG_SHARE_PERCENT} and ${MAX_ORG_SHARE_PERCENT}.`,
        };
    }

    // NUMERIC(5,2) — normalise here so what we store is what we validated.
    return { ok: true, percent: Math.round(n * 100) / 100 };
}

/**
 * The complete decision for one client-supplied organization share, in the one
 * order it may be evaluated. Campaign create and campaign edit both route
 * through here so the two can never drift apart on precedence.
 *
 *   not supplied  -> { change: false }   the DB default (20.00) stands, and the
 *                                        caller's own route permissions govern.
 *   supplied      -> 403 unauthorized  (checked FIRST: an unauthorized caller is
 *                                       refused outright, and cannot use the
 *                                       response to probe closeout state or
 *                                       learn whether their number parsed)
 *                 -> 409 already closed (the share is frozen at closeout)
 *                 -> 400 invalid value
 *                 -> { change: true, percent }
 *
 * `campaignClosed` is always false at create time — a campaign being created
 * cannot already be closed — which is why create passes it as such rather than
 * this function guessing.
 */
export type OrgShareChangeDecision =
    | { change: false }
    | { change: true; percent: number }
    | { change: false; rejected: true; status: 403 | 409 | 400; error: string };

export function decideOrgShareChange(input: {
    requested: unknown;
    user: { role?: unknown; isSuperAdmin?: unknown };
    campaignClosed: boolean;
}): OrgShareChangeDecision {
    const { requested, user, campaignClosed } = input;

    // Omission is not a change. This is what keeps every pre-INV-A caller — and
    // every non-admin creating an ordinary fundraiser — working untouched.
    if (requested === undefined || requested === null || requested === '') {
        return { change: false };
    }

    if (!mayManageFundraiserFinancialTerms(user)) {
        return { change: false, rejected: true, status: 403, error: ORG_SHARE_FORBIDDEN_MESSAGE };
    }

    if (campaignClosed) {
        return {
            change: false,
            rejected: true,
            status: 409,
            error: 'This fundraiser has been closed out. The organization share is frozen and can no longer be changed.',
        };
    }

    const parsed = parseOrgSharePercent(requested);
    if (!parsed.ok) {
        return { change: false, rejected: true, status: 400, error: parsed.error };
    }

    return { change: true, percent: parsed.percent };
}

/** Narrowing helper so route code reads plainly. */
export function isOrgShareRejected(
    d: OrgShareChangeDecision
): d is { change: false; rejected: true; status: 403 | 409 | 400; error: string } {
    return (d as any).rejected === true;
}

/**
 * The organization's cut of a gross amount, at a given percent.
 * Rounded to cents at the boundary, per CALCULATION_CONSTITUTION LAW 3
 * (round once, at the edge — not mid-chain).
 */
export function organizationShareAmount(grossAmount: number, percent: number): number {
    if (!Number.isFinite(grossAmount) || !Number.isFinite(percent)) return 0;
    return Math.round(grossAmount * (percent / 100) * 100) / 100;
}

/**
 * What the organization owes the tenant: gross minus the organization's share.
 * Tax and any other legitimately separate additions are applied by the caller —
 * this function answers only the share question.
 */
export function balanceDueToTenant(grossAmount: number, percent: number): number {
    if (!Number.isFinite(grossAmount)) return 0;
    return Math.round((grossAmount - organizationShareAmount(grossAmount, percent)) * 100) / 100;
}
