/**
 * INV-A — client-side form logic for the campaign organization share.
 *
 * This module decides what the fundraiser create/edit UI SHOWS and what it
 * SENDS. It is presentation plumbing only: the server's decideOrgShareChange()
 * remains the authority on who may change the financial term, and every payload
 * this module builds is re-validated and re-authorized there.
 *
 * The authorization predicate is IMPORTED from the server's own module rather
 * than re-implemented, so the client can never disagree with the server about
 * who is authorized — the classic insecure-client-copy bug is structurally
 * impossible here.
 *
 * Failure modes this module exists to prevent:
 *  - an unauthorized form serializing an orgSharePercent override anyway
 *    (a disabled HTML input still submits its value; we omit the KEY)
 *  - 25% being sent as 0.25 (the API parser treats input as PERCENT)
 *  - a blank field being sent and rejected, when omission is the correct
 *    "use the 20.00 default" behaviour
 *  - a closed campaign submitting a share mutation the server would 409
 */

import {
    parseOrgSharePercent,
    mayManageFundraiserFinancialTerms,
    DEFAULT_ORG_SHARE_PERCENT,
} from '@/lib/fundraiserOrgShare';

/** What the create form's share input starts at. Matches the DB default. */
export const ORG_SHARE_DEFAULT_INPUT = String(DEFAULT_ORG_SHARE_PERCENT);

/** Helper copy shown under the input. */
export const ORG_SHARE_HELPER_TEXT =
    'Percentage of fundraiser sales the organization receives.';

/** Shown instead of an input when the viewer may not manage financial terms. */
export const ORG_SHARE_ADMIN_MANAGED_NOTE =
    'Financial terms are managed by an administrator.';

/** Shown when the campaign is financially closed. */
export const ORG_SHARE_LOCKED_NOTE =
    'Organization share is locked after fundraiser closeout.';

/**
 * May this session user edit the share? Same predicate the server enforces —
 * re-exported so components import ONE name and cannot fork the rule.
 */
export const canManageOrgShare = mayManageFundraiserFinancialTerms;

export type OrgShareFieldMode = 'editable' | 'readonly' | 'locked';

/**
 * How the share field renders on a given surface.
 *
 *  locked   — campaign is financially closed; show the frozen value + lock note.
 *             Locked wins over readonly: "this cannot change any more" is more
 *             truthful for a non-admin than "an admin manages this".
 *  readonly — viewer may not manage financial terms; show value + admin note.
 *  editable — ADMIN / super-admin on an open campaign (or create form).
 */
export function orgShareFieldMode(input: {
    user: { role?: unknown; isSuperAdmin?: unknown };
    campaignClosed: boolean;
}): OrgShareFieldMode {
    if (input.campaignClosed) return 'locked';
    if (!canManageOrgShare(input.user)) return 'readonly';
    return 'editable';
}

/**
 * The share portion of a campaign create/update request body.
 *
 * Returns an object to SPREAD into the JSON body:
 *  - unauthorized viewer      -> {}  (the KEY is never serialized — a disabled
 *                                     input's value must not ride along)
 *  - blank / untouched-empty  -> {}  (omission = the 20.00 default, by contract)
 *  - otherwise                -> { orgSharePercent: <trimmed string> }
 *
 * The value is passed through as the PERCENT string the user typed ("25", not
 * 0.25); the server parser owns numeric interpretation and rounding.
 */
export function orgShareRequestField(input: {
    user: { role?: unknown; isSuperAdmin?: unknown };
    raw: string;
}): { orgSharePercent: string } | Record<string, never> {
    if (!canManageOrgShare(input.user)) return {};
    const trimmed = input.raw.trim();
    if (trimmed === '') return {};
    return { orgSharePercent: trimmed };
}

/**
 * Client-side pre-submit check for an EDITABLE field. Convenience only — the
 * server re-validates — but it lets the form refuse junk before a round trip.
 * Blank is submittable because blank is omitted (the default applies).
 */
export function orgShareInputError(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const parsed = parseOrgSharePercent(trimmed);
    return parsed.ok ? null : parsed.error;
}

/**
 * Display formatting: natural percentages, never engineering notation.
 *   20 / "20.00" -> "20%"     27.5 / "27.50" -> "27.5%"
 * A missing value displays as the default — a pre-INV-A campaign IS 20%.
 */
export function formatOrgShare(value: number | string | null | undefined): string {
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
        return `${DEFAULT_ORG_SHARE_PERCENT}%`;
    }
    // toFixed(2) then parseFloat strips trailing zeros without float dust.
    return `${parseFloat(n.toFixed(2))}%`;
}
