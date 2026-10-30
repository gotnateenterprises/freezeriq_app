/**
 * FR-SUPPORTER-SHARE-INTEGRITY-1 — what a supporter is told about the ordering deadline.
 *
 * THE BUG THIS REPLACES
 * The public page counted down with `Math.ceil((noon-local end_date - now) / 1 day)` in the
 * BROWSER. `end_date` is a calendar date, so that sum depended on the visitor's timezone and on
 * the hour: on the morning of the last day a supporter read "1 Day Left", and from noon of the last
 * day — while ordering was still open — "0 Days Left".
 *
 * THE RULE
 * The answer is a CALENDAR question asked in the TENANT's timezone, the same one the server uses
 * to decide whether an order is accepted (isCampaignPastOrderDeadline, via
 * lib/tenantTimezone.calendarDaysUntil). It is computed on the server, in the same render that
 * resolves the ordering mode, and the ordering mode wins: if ordering is closed, the countdown
 * says so, whatever the arithmetic would have said.
 *
 * PURE: the clock and the zone are parameters.
 */
import { calendarDaysUntil } from './tenantTimezone';

export type SupporterDeadline =
    | { kind: 'none' }
    | { kind: 'closed' }
    | { kind: 'today' }
    | { kind: 'days'; days: number };

export function describeSupporterDeadline(input: {
    endDate: Date | string | null | undefined;
    /** Business.timezone — the tenant's IANA zone. */
    timeZone: string | null | undefined;
    /** The SERVER ordering authority's answer (resolveCampaignOrderMode). */
    orderingOpen: boolean;
    now?: Date;
}): SupporterDeadline {
    if (!input.orderingOpen) return { kind: 'closed' };
    if (input.endDate === null || input.endDate === undefined || input.endDate === '') return { kind: 'none' };
    const days = calendarDaysUntil(input.endDate, input.timeZone, input.now ?? new Date());
    // An unreadable date or zone: say nothing rather than guess a number.
    if (days === null) return { kind: 'none' };
    // Past the date while the authority still says open cannot be shown as a countdown; ordering
    // is open, so it is the last chance, not "0 days" or a negative number.
    if (days <= 0) return { kind: 'today' };
    return { kind: 'days', days };
}

/** One truthful sentence, or null when there is nothing to say. */
export function supporterDeadlineLabel(d: SupporterDeadline | null | undefined): string | null {
    if (!d) return null;
    switch (d.kind) {
        case 'closed': return 'Ordering closed';
        case 'today': return 'Ends today';
        case 'days': return d.days === 1 ? '1 day left' : `${d.days} days left`;
        default: return null;
    }
}

/** The hero stat pill: a big value and a small caption. Null hides the pill. */
export function supporterDeadlinePill(d: SupporterDeadline | null | undefined): { value: string; caption: string } | null {
    if (!d) return null;
    if (d.kind === 'today') return { value: 'Today', caption: 'Ordering Ends' };
    if (d.kind === 'days') return { value: String(d.days), caption: d.days === 1 ? 'Day Left' : 'Days Left' };
    return null;
}
