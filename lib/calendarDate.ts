/**
 * FR-RETENTION-3C — calendar-date rendering.
 *
 * THE BUG THIS FIXES
 * A Seasonal Lineup start/end is a CALENDAR DATE, not an instant. The date
 * input submits "2026-09-01", which is stored as 2026-09-01T00:00:00.000Z.
 * Formatting that with the default local timezone in America/Chicago (UTC-5/6)
 * renders "August 31" — the lineup silently loses a day.
 *
 * THE FIX
 * Read the UTC calendar fields directly. The stored calendar date is the
 * displayed calendar date, in every timezone, with no DST edge cases — because
 * no timezone conversion happens at all.
 *
 * Deliberately scoped: this is ONLY for date-only values. Real timestamps
 * (created_at, accepted_at, sent times) must keep normal local formatting, so
 * nothing here touches them.
 *
 * We do NOT store fake noon timestamps to paper over the conversion — that
 * hides the bug rather than fixing it, and breaks again in a far-enough
 * timezone.
 */

const MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = MONTHS_LONG.map((m) => m.slice(0, 3));

/** "September 1" — timezone-independent. */
export function formatCalendarDate(value: Date): string {
    return `${MONTHS_LONG[value.getUTCMonth()]} ${value.getUTCDate()}`;
}

/** "Sep 1, 2026" — timezone-independent. */
export function formatCalendarDateShort(value: Date): string {
    return `${MONTHS_SHORT[value.getUTCMonth()]} ${value.getUTCDate()}, ${value.getUTCFullYear()}`;
}

/** "September 1 – November 30" — timezone-independent. */
export function formatCalendarRange(from: Date, to: Date): string {
    return `${formatCalendarDate(from)} – ${formatCalendarDate(to)}`;
}

/** "2026-09-01" for a date input, without a local-timezone round trip. */
export function toCalendarInputValue(value: Date): string {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// ── FR-COORD-ROUTING-DATE-1 ─────────────────────────────────────────────────
//
// The formatters above take a Date. The tenant CRM receives campaign dates as
// JSON strings ("2026-10-07T00:00:00.000Z") and was calling
// `new Date(value).toLocaleDateString()` on them — reintroducing, on the
// fundraiser list, the exact bug this module was written to end. A campaign
// whose supporter deadline is October 7 was shown to the tenant as October 6
// in every U.S. timezone.
//
// These are string-tolerant entry points to the SAME UTC-field rule, so the
// CRM can be fixed by reusing this module rather than by growing another
// private date helper. Scope is unchanged: date-only values only. Real
// timestamps (created_at, closed_at, bundle_selection_at, uploaded_at) must
// keep normal local formatting and none of them go through here.

/** The stored calendar date, or null when the value is absent/unparseable. */
function calendarDateFrom(value: Date | string | null | undefined): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 7, 2026" from a Date OR an ISO string — timezone-independent. */
export function formatCalendarDateShortValue(value: Date | string | null | undefined): string | null {
    const d = calendarDateFrom(value);
    return d ? formatCalendarDateShort(d) : null;
}

/**
 * "10/7/2026" — the numeric form, timezone-independent.
 *
 * Exists so call sites that already rendered `toLocaleDateString()` keep their
 * exact visual format and change only in that they stop shifting a day. This
 * is a display-bug fix, not a redesign of how dates look.
 */
export function formatCalendarDateNumericValue(value: Date | string | null | undefined): string | null {
    const d = calendarDateFrom(value);
    if (!d) return null;
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}
