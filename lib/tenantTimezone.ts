/**
 * FR-TENANT-TZ-1 — tenant-local calendar dates.
 *
 * WHY THIS EXISTS
 * A fundraiser's `end_date` is a DATE: a business deadline with no time on it.
 * Asking whether that deadline has passed is asking what today's calendar date
 * is — and a calendar date only exists inside a timezone. The answer must come
 * from the tenant, because every other candidate is wrong:
 *
 *   the database's zone  — this cluster runs UTC, so a Central fundraiser ending
 *                          August 31 would stop taking orders at 7:00 PM Central;
 *   the server's zone    — a deployment-region accident;
 *   the browser's zone   — client input, and therefore not authority.
 *
 * So `Business.timezone` is the authority and it is passed in explicitly. No
 * function here reads a global, an environment variable, or a default zone.
 *
 * WHAT THIS IS NOT
 * This does not replace lib/calendarDate.ts. Those helpers deliberately format
 * stored dates without any timezone conversion, which is right for DISPLAY —
 * "September 1" must read as September 1 everywhere. This module answers a
 * different question: which calendar day is it right now, for this tenant.
 *
 * DST is handled by the IANA database via Intl, never by offset arithmetic:
 * America/Chicago is UTC-5 in September and UTC-6 in December, and only the
 * timezone engine knows that.
 */

/**
 * True when the runtime can resolve `tz` as an IANA zone.
 *
 * Deliberately strict. A misconfigured tenant must fail closed at the call
 * site rather than silently fall back to UTC or to the launch default — a
 * fallback would quietly reopen a fundraiser that should be shut.
 */
export function isValidIanaTimeZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || tz.trim() === '') return false;

    let resolved: string;
    try {
        // Throws RangeError on an unknown zone.
        resolved = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).resolvedOptions().timeZone;
    } catch {
        return false;
    }

    // Intl is more permissive than this product can afford, in two ways that
    // both silently break the deadline:
    //
    //   '-05:00' and '+05:00' are ACCEPTED and resolve to themselves. They are
    //   fixed offsets with no DST rules at all — precisely the bug this whole
    //   revision exists to remove. A tenant stored as '-05:00' would be an hour
    //   wrong for half the year with nothing to indicate it.
    //
    //   'EST' is ACCEPTED and resolves to 'America/Panama'; 'CST' resolves to
    //   'America/Chicago'; 'GMT' to 'UTC'. Abbreviations are ambiguous (CST is
    //   also China Standard Time) and the silent remapping is worse than a
    //   rejection, because it looks like it worked.
    //
    // So require a canonical zone: the value must be exactly what Intl resolves
    // it to, and it must be a Region/City identifier (or plain UTC). Anything
    // else is refused, and the caller fails closed.
    if (resolved !== tz) return false;
    return tz === 'UTC' || tz.includes('/');
}

/**
 * The calendar date at `instant`, as seen in `timeZone`, as 'YYYY-MM-DD'.
 *
 * Uses formatToParts rather than parsing a formatted string: the parts are
 * addressed by name, so no locale's ordering or separators can change the
 * result. Returns null for an unusable zone so callers must handle it.
 */
export function calendarDateInTimeZone(timeZone: string, instant: Date): string | null {
    if (!isValidIanaTimeZone(timeZone)) return null;
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(instant);

    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    const y = get('year');
    const m = get('month');
    const d = get('day');
    if (!y || !m || !d) return null;
    return `${y}-${m}-${d}`;
}

/**
 * The calendar date a DATE column represents, as 'YYYY-MM-DD'.
 *
 * A DATE arrives from the driver as UTC midnight of that day, so its own
 * calendar date is its UTC year/month/day. Reading it with local getters is the
 * classic way to shift a stored date by one day, so this reads UTC fields
 * deliberately — the same reasoning as lib/calendarDate.ts.
 *
 * OPS-LAUNCH-HOTFIX-1: the year is zero-padded to (at least) 4 digits, same as
 * month/day. getUTCFullYear() for an unusual short year (e.g. 26) previously
 * returned it unpadded, producing "26-08-28" — not a valid ISO date, so every
 * caller that reconstructs a Date from this string via
 * `new Date(`${x}T00:00:00.000Z`)` got Invalid Date back. This is what broke
 * campaign launch in Production for one opportunity whose confirmed_delivery_date
 * had reached the database with a non-4-digit year through some path other
 * than this app's own normal writes.
 */
export function calendarDateOfDateOnlyValue(value: Date | string): string | null {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${String(d.getUTCFullYear()).padStart(4, '0')}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
