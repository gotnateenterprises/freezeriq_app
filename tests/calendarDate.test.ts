/**
 * FR-RETENTION-3C — calendar-date regression tests.
 *
 * The bug: a lineup stored as Sep 1 – Nov 30 rendered as "Aug 31 – Nov 29" in
 * America/Chicago, because a UTC-midnight instant was formatted in local time.
 *
 * These pin the fix. `process.env.TZ` is set to America/Chicago below so the
 * suite reproduces the exact environment the bug appeared in — if the helper
 * ever reverts to local-timezone formatting, these fail rather than silently
 * shifting a tenant's dates again.
 */

process.env.TZ = 'America/Chicago';

import {
    formatCalendarDate,
    formatCalendarDateShort,
    formatCalendarRange,
    toCalendarInputValue,
} from '@/lib/calendarDate';

/** How a date-only input value is actually stored: UTC midnight. */
const stored = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('environment', () => {
    it('runs in America/Chicago, where the bug reproduced', () => {
        expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Chicago');
        // Proof the naive approach really is broken here.
        expect(stored('2026-09-01').toLocaleDateString('en-US', { month: 'long', day: 'numeric' }))
            .toBe('August 31');
    });
});

describe('formatCalendarDate', () => {
    it('renders Sep 1 as September 1, not August 31', () => {
        expect(formatCalendarDate(stored('2026-09-01'))).toBe('September 1');
    });

    it('renders Nov 30 as November 30, not November 29', () => {
        expect(formatCalendarDate(stored('2026-11-30'))).toBe('November 30');
    });

    it('holds across a DST spring-forward boundary', () => {
        // US DST begins 2026-03-08.
        expect(formatCalendarDate(stored('2026-03-07'))).toBe('March 7');
        expect(formatCalendarDate(stored('2026-03-08'))).toBe('March 8');
        expect(formatCalendarDate(stored('2026-03-09'))).toBe('March 9');
    });

    it('holds across a DST fall-back boundary', () => {
        // US DST ends 2026-11-01.
        expect(formatCalendarDate(stored('2026-10-31'))).toBe('October 31');
        expect(formatCalendarDate(stored('2026-11-01'))).toBe('November 1');
        expect(formatCalendarDate(stored('2026-11-02'))).toBe('November 2');
    });

    it('holds on Jan 1, the worst case for a negative UTC offset', () => {
        expect(formatCalendarDate(stored('2027-01-01'))).toBe('January 1');
    });

    it('holds on a leap day', () => {
        expect(formatCalendarDate(stored('2028-02-29'))).toBe('February 29');
    });
});

describe('formatCalendarRange', () => {
    it('renders the reported failing case correctly', () => {
        expect(formatCalendarRange(stored('2026-09-01'), stored('2026-11-30')))
            .toBe('September 1 – November 30');
    });
});

describe('formatCalendarDateShort', () => {
    it('keeps the year on the right side of a New Year boundary', () => {
        expect(formatCalendarDateShort(stored('2027-01-01'))).toBe('Jan 1, 2027');
        expect(formatCalendarDateShort(stored('2026-12-31'))).toBe('Dec 31, 2026');
    });
});

describe('toCalendarInputValue', () => {
    it('round-trips a stored date back to the same input value', () => {
        for (const iso of ['2026-09-01', '2026-11-30', '2027-01-01', '2028-02-29', '2026-03-08']) {
            expect(toCalendarInputValue(stored(iso))).toBe(iso);
        }
    });
});
