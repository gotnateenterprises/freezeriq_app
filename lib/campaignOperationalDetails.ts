/**
 * CRM-CAMPAIGN-DETAILS-1 — the tenant's own correction path for a live fundraiser's
 * OPERATIONAL details, and the one rule that stops a legacy organization blob from
 * silently undoing it.
 *
 * THE PROBLEM THIS SOLVES
 * A fundraiser's pickup time was entered as 9:00 AM and needed to be 4:00 PM. There was
 * no tenant path to fix it, so it took a database edit. Two separate gaps caused that:
 *
 *   1. `PATCH /api/campaigns/[id]` accepted delivery_date, end_date and pickup_location
 *      but NOT delivery_time — the column exists (FR-FLOW-3) and every read surface
 *      already prefers it, but nothing tenant-facing could write it.
 *   2. The only tenant UI for these values, components/crm/FundraiserSetup.tsx, is
 *      ORGANIZATION-scoped: it edits `Customer.fundraiser_info`, a JSON blob shared by
 *      every campaign that organization ever runs, which then syncs down to "whichever
 *      campaign was created most recently". FR-FLOW-3 already blocked that sync from
 *      overwriting a coordinator-confirmed `delivery_time`, and its comment says the
 *      tenant "changes it through the campaign, not the org profile" — but that
 *      campaign-scoped surface was never built. Every one of the 7 open campaigns had
 *      `bundle_selection_status = 'selected'`, so the guard was active on all of them
 *      and the org form could not fix a single live pickup time.
 *
 * WHY THE SYNC HAD TO BE NARROWED TOO
 * delivery_date, end_date and pickup_location were pushed down UNCONDITIONALLY. Audited
 * against Production 2026-09-25: all 7 open campaigns disagreed with their organization
 * blob on all four fields — e.g. campaign `f81c8467` held '4:00 pm' while its blob held
 * '3 PM'. So a tenant who corrected a date in a new campaign editor, then saved the
 * organization profile for any unrelated reason, would have had the correction reverted
 * from stale JSON. Adding the editor without narrowing the sync would have shipped a trap.
 *
 * THE RULE, extended from the one FR-FLOW-3 already applied to delivery_time alone:
 * the organization blob may FILL a campaign field that has no meaningful value, and may
 * never OVERWRITE one that does. It stays a legacy setup input and a fallback; the
 * campaign row stays canonical. No second synchronisation model, no new storage, and
 * nothing here touches money — org_share_percent, goal_amount, tax and settlement are
 * all absent on purpose.
 */

import { calendarDateOfDateOnlyValue } from './tenantTimezone';
import { checkOrderDeadline } from './fundraiserLaunch';
import {
    CHECKS_PAYABLE_MAX,
    DELIVERY_TIME_MAX,
    PICKUP_LOCATION_MAX,
} from './coordinatorSetup';

/**
 * Length bounds come from lib/coordinatorSetup.ts, the module the COORDINATOR's own setup
 * form validates against — not from new numbers invented here.
 *
 * This module first carried its own (60 for the time, 300 for the location), which made the
 * tenant's editor STRICTER than the coordinator's form for delivery_time: a coordinator
 * could store a 70-character pickup window that the tenant would then be unable to correct
 * or even re-save. One bound per field, owned by one module.
 */
export { CHECKS_PAYABLE_MAX, DELIVERY_TIME_MAX, PICKUP_LOCATION_MAX };

/**
 * The operational fields this editor owns. Named as a list so a test can assert the
 * editor's reach by name, and so the forbidden set below can be checked against it.
 */
export const CAMPAIGN_OPERATIONAL_FIELDS = [
    'delivery_date',
    'delivery_time',
    'end_date',
    'pickup_location',
    // CRM-CAMPAIGN-DETAILS-1A: added after the live acceptance caught the org-profile save
    // rewriting it. `checks_payable` is COORDINATOR-OWNED in exactly the way delivery_time
    // is — app/api/coordinator/bundle-selection writes both from the same `setupValues`
    // spread, in the same transaction — but FR-FLOW-3 guarded only delivery_time, so this
    // one kept being pushed from the organization blob. Worse than a stale value: the org
    // form defaults the key to `customer.name`, so saving it for any unrelated reason
    // replaced a coordinator's stated payee with the organization's raw name
    // ('BBT4' -> 'The Best Brew Test 4', observed live 2026-09-25).
    'checks_payable',
] as const;

/**
 * The fundraiser progress goal shares this editor's dialog but NOT this module's
 * decision function. `bundle_goal` already has one — `decideBundleGoalChange` in
 * lib/fundraiserMetrics.ts (FR-GOAL-CONFIG-1) — already wired into the same PATCH
 * route and already carrying the identical closeout gate. Re-deciding it here would
 * be a second opinion on one field, which is the exact failure this task exists to
 * fix. The dialog sends `bundleGoal` and that path handles it, unchanged.
 */
export const CAMPAIGN_GOAL_FIELD = 'bundle_goal' as const;

/**
 * Fields this editor must NEVER write. Not the mechanism — the explicit allow-list
 * below is — but naming them lets a test fail loudly if an operational editor ever
 * grows into a financial control screen.
 *
 * org_share_percent and goal_amount are the pointed ones: both are already reachable
 * through `PATCH /api/campaigns/[id]`, org_share_percent behind a role gate AND a
 * closeout gate. A "details" modal that quietly carried either would undo that design.
 */
export const CAMPAIGN_FORBIDDEN_DETAIL_FIELDS = [
    'org_share_percent',
    'goal_amount',
    'total_sales',
    'settlement_total',
    'settlement_notes',
    'settled_externally',
    'closed_at',
    'closed_by',
    'tax_status',
    'tax_rate_percent',
    'status',
    'portal_token',
    'public_token',
    'bundle_selection_status',
    'bundle_selection_limit',
] as const;

/**
 * Does a stored campaign field already hold a real answer?
 *
 * The whole preserve-canonical rule turns on this, so it is defined once. A blank or
 * whitespace-only string is NOT a value — several legacy rows carry '' where the column
 * was written by a form that submitted an empty input, and treating those as "already
 * set" would permanently block the legacy fill that still populates them.
 */
export function hasMeaningfulValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    return true;
}

/* ── The tenant edit ─────────────────────────────────────────────────────────── */

export interface CampaignOperationalState {
    delivery_date: Date | string | null;
    delivery_time: string | null;
    end_date: Date | string | null;
    pickup_location: string | null;
    checks_payable: string | null;
}

export interface CampaignOperationalPatch {
    delivery_date?: Date;
    delivery_time?: string | null;
    end_date?: Date;
    pickup_location?: string | null;
    checks_payable?: string | null;
}

export type OperationalDetailsDecision =
    | { change: false }
    | { change: true; data: CampaignOperationalPatch }
    | { change: false; rejected: true; status: 400 | 409; error: string };

/** Narrowing helper so route code reads plainly, matching the org-share/goal pattern. */
export function isOperationalDetailsRejected(
    d: OperationalDetailsDecision
): d is { change: false; rejected: true; status: 400 | 409; error: string } {
    return (d as any).rejected === true;
}

/**
 * A date-only field arriving from a client, normalised to the calendar day the tenant
 * picked.
 *
 * `delivery_date` and `end_date` are `@db.Date`. The existing bug class here is real:
 * `new Date('2026-10-15')` is UTC midnight, and reading it back with LOCAL getters
 * yields the 14th for anyone west of Greenwich. `calendarDateOfDateOnlyValue` is the
 * repository's answer (OPS-DATE-PICKER-HOTFIX-1) — it reads with UTC getters and
 * returns 'YYYY-MM-DD'. Writing that back as `T00:00:00.000Z` round-trips exactly, so
 * the day the tenant chose is the day that is stored and the day that is displayed.
 */
function normalizeCalendarDay(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' && !(value instanceof Date)) return null;
    return calendarDateOfDateOnlyValue(
        typeof value === 'string' ? `${value.slice(0, 10)}T00:00:00.000Z` : value
    );
}

/** A normalised calendar day as the UTC-midnight Date a `@db.Date` column expects. */
export function calendarDayToDate(day: string): Date {
    return new Date(`${day}T00:00:00.000Z`);
}

/**
 * The complete decision for one tenant edit of a campaign's operational details.
 *
 * Every field is OPTIONAL and omission means "leave it alone" — the editor may send
 * only the pickup time, and the stored date and deadline must survive untouched. An
 * explicitly empty string CLEARS delivery_time or pickup_location (a tenant who
 * recorded the wrong location must be able to remove it), but never a date: a
 * fundraiser with no delivery date is not a correction, it is a broken campaign.
 *
 * The deadline is validated against the EFFECTIVE delivery date — the newly requested
 * one if present, otherwise the stored one — through the existing
 * `checkOrderDeadline`, so this route enforces exactly the relationship launch already
 * enforces ("ordering must close on or before delivery") rather than a second opinion.
 *
 * `campaignClosed` gates the whole edit, using the caller's `isCampaignClosed` result.
 * A closed or settled fundraiser's logistics are history: its invoice, packing slips
 * and settlement were all produced against those values.
 */
export function decideOperationalDetailsChange(input: {
    requested: {
        delivery_date?: unknown;
        delivery_time?: unknown;
        end_date?: unknown;
        pickup_location?: unknown;
        checks_payable?: unknown;
    };
    campaign: CampaignOperationalState;
    campaignClosed: boolean;
}): OperationalDetailsDecision {
    const { requested, campaign, campaignClosed } = input;

    const touches = CAMPAIGN_OPERATIONAL_FIELDS.some(
        (f) => (requested as Record<string, unknown>)[f] !== undefined,
    );

    if (!touches) return { change: false };

    if (campaignClosed) {
        return {
            change: false,
            rejected: true,
            status: 409,
            error: 'This fundraiser has been closed out. Its delivery details can no longer be changed.',
        };
    }

    const data: CampaignOperationalPatch = {};

    /* Delivery / pickup date */
    let effectiveDeliveryDay: string | null = normalizeCalendarDay(campaign.delivery_date);
    if (requested.delivery_date !== undefined) {
        if (requested.delivery_date === null || requested.delivery_date === '') {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: 'Enter the delivery or pickup date.',
            };
        }
        const day = normalizeCalendarDay(requested.delivery_date);
        if (!day) {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: 'Enter a valid delivery or pickup date.',
            };
        }
        data.delivery_date = calendarDayToDate(day);
        effectiveDeliveryDay = day;
    }

    /* Supporter order deadline — the existing launch rule, not a new one */
    if (requested.end_date !== undefined) {
        if (!effectiveDeliveryDay) {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: 'Set the delivery or pickup date before the supporter order deadline.',
            };
        }
        const deadline = checkOrderDeadline({
            endDate: requested.end_date,
            confirmedDeliveryDate: effectiveDeliveryDay,
        });
        if (!deadline.ok) {
            return { change: false, rejected: true, status: 400, error: deadline.error };
        }
        data.end_date = calendarDayToDate(deadline.endDate);
    } else if (data.delivery_date && hasMeaningfulValue(campaign.end_date)) {
        // Moving the delivery date EARLIER must not silently leave ordering open past
        // it. Re-check the stored deadline against the new day and refuse rather than
        // quietly rewriting a deadline the tenant did not ask to change.
        const storedDeadline = normalizeCalendarDay(campaign.end_date);
        if (storedDeadline && effectiveDeliveryDay && storedDeadline > effectiveDeliveryDay) {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: 'Supporter ordering must close on or before the delivery date. '
                    + 'Move the supporter order deadline as well.',
            };
        }
    }

    /* The three free-text fields, all handled by one rule: trim, an empty value clears,
       anything longer than the coordinator's own bound is refused. Stated once rather than
       three times so they cannot drift into three different notions of "valid text". */
    const TEXT_FIELDS = [
        { key: 'delivery_time', max: DELIVERY_TIME_MAX, label: 'delivery or pickup time', hint: ', for example 4:00 PM' },
        { key: 'pickup_location', max: PICKUP_LOCATION_MAX, label: 'delivery or pickup location', hint: '' },
        { key: 'checks_payable', max: CHECKS_PAYABLE_MAX, label: 'name checks are payable to', hint: '' },
    ] as const;

    for (const f of TEXT_FIELDS) {
        const value = (requested as Record<string, unknown>)[f.key];
        if (value === undefined) continue;
        if (value === null || value === '') {
            data[f.key] = null;
            continue;
        }
        if (typeof value !== 'string') {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: `Enter the ${f.label} as text${f.hint}.`,
            };
        }
        const trimmed = value.trim();
        if (trimmed === '') {
            data[f.key] = null;
        } else if (trimmed.length > f.max) {
            return {
                change: false,
                rejected: true,
                status: 400,
                error: `Keep the ${f.label} under ${f.max} characters.`,
            };
        } else {
            data[f.key] = trimmed;
        }
    }

    return Object.keys(data).length > 0 ? { change: true, data } : { change: false };
}

/* ── The narrowed organization-profile sync ──────────────────────────────────── */

/** The organization blob's key names, which differ from the campaign column names. */
export interface OrgProfileOperationalInfo {
    delivery_date?: unknown;
    delivery_time?: unknown;
    /** The blob calls the supporter deadline `deadline`; the campaign calls it end_date. */
    deadline?: unknown;
    pickup_location?: unknown;
    /** And it calls the payee `checks_payable_to`; the campaign calls it checks_payable. */
    checks_payable_to?: unknown;
}

/**
 * What the organization profile is still allowed to write to a campaign's operational
 * fields: only the ones that have no meaningful value yet.
 *
 * This REPLACES the unconditional push. It is the same rule FR-FLOW-3 already applied
 * to delivery_time, now applied to all four — and stated once, here, so the two cannot
 * drift into different notions of "already set".
 *
 * Legacy fill is deliberately preserved rather than removed: the flyer, packet and
 * tracker download routes read these columns, and an organization that fills in its
 * setup form before any campaign-level edit must still populate a blank campaign.
 * What can no longer happen is a stale blob reverting a correction.
 *
 * Returns a Prisma-ready partial. An empty object means "the campaign already knows
 * better than the organization profile does" — the caller should still run its update
 * for the non-operational fields it owns.
 */
export function operationalFillFromOrgProfile(input: {
    campaign: CampaignOperationalState;
    info: OrgProfileOperationalInfo;
}): CampaignOperationalPatch {
    const { campaign, info } = input;
    const out: CampaignOperationalPatch = {};

    if (!hasMeaningfulValue(campaign.delivery_date)) {
        const day = normalizeCalendarDay(info.delivery_date);
        if (day) out.delivery_date = calendarDayToDate(day);
    }
    if (!hasMeaningfulValue(campaign.end_date)) {
        const day = normalizeCalendarDay(info.deadline);
        if (day) out.end_date = calendarDayToDate(day);
    }
    const fillText = (
        stored: string | null,
        offered: unknown,
        max: number,
        into: 'delivery_time' | 'pickup_location' | 'checks_payable',
    ) => {
        if (hasMeaningfulValue(stored)) return;
        if (typeof offered !== 'string') return;
        const trimmed = offered.trim();
        if (trimmed === '') return;
        out[into] = trimmed.slice(0, max);
    };

    fillText(campaign.delivery_time, info.delivery_time, DELIVERY_TIME_MAX, 'delivery_time');
    fillText(campaign.pickup_location, info.pickup_location, PICKUP_LOCATION_MAX, 'pickup_location');
    // CRM-CAMPAIGN-DETAILS-1A. This line is the fix: the sync used to write
    // `checks_payable: fi.checks_payable_to || undefined` unconditionally, and the
    // organization form defaults that key to the organization's own name, so an unrelated
    // save replaced the coordinator's stated payee. Now it only ever FILLS a blank.
    fillText(campaign.checks_payable, info.checks_payable_to, CHECKS_PAYABLE_MAX, 'checks_payable');

    return out;
}

/* ── Coordinator setup readiness ─────────────────────────────────────────────── */

export type CoordinatorSetupReadiness =
    | { ready: true }
    | { ready: false; missing: ('delivery_date' | 'delivery_time')[]; error: string };

/**
 * May this campaign's coordinator setup invitation go out yet?
 *
 * The tenant owns the fundraiser's delivery date and pickup time; the coordinator
 * chooses bundles. Sending the setup invitation before those two exist asks the
 * coordinator to run a fundraiser whose fulfilment day nobody has decided, and it was
 * how the pickup time came to be owned by the coordinator's form in the first place.
 *
 * DELIBERATELY EVALUATED AT SEND TIME, not stored as a state. There is no new
 * lifecycle state, no migration and no backfill: the check runs only when a tenant
 * asks to preview or send an invitation, so it applies prospectively to newly prepared
 * fundraisers and cannot retroactively invalidate anything. Audited against Production
 * 2026-09-25: all 7 Active campaigns already carry both values, so no live fundraiser
 * is affected. A campaign whose invitation was already sent is likewise untouched —
 * nothing re-evaluates it.
 */
export function checkCoordinatorSetupReadiness(campaign: {
    delivery_date: Date | string | null;
    delivery_time: string | null;
}): CoordinatorSetupReadiness {
    const missing: ('delivery_date' | 'delivery_time')[] = [];
    if (!hasMeaningfulValue(campaign.delivery_date)) missing.push('delivery_date');
    if (!hasMeaningfulValue(campaign.delivery_time)) missing.push('delivery_time');

    if (missing.length === 0) return { ready: true };

    const what =
        missing.length === 2
            ? 'a delivery/pickup date and time'
            : missing[0] === 'delivery_date'
                ? 'a delivery/pickup date'
                : 'a delivery/pickup time';

    return {
        ready: false,
        missing,
        error: `Set ${what} for this fundraiser before sending the coordinator setup invitation. `
            + 'Use Edit details on the fundraiser to add it.',
    };
}
