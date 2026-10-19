/**
 * COORDINATOR-CONTACT-DATE-1 — coordinator portal email links and dates.
 *
 * EMAIL: Recent orders renders a supporter's address as a STANDARD `mailto:` link the
 * browser hands to the device's own mail handler, built only from an address that can
 * actually be a recipient, with a small Copy fallback beside it. Nothing intercepts the
 * click and nothing is written.
 *
 * DATES: three different kinds of value, three different rules.
 *   - DATE-only (delivery_date, end_date): the stored calendar day, in every timezone.
 *   - INSTANT (created_at, paid_at): shown in the TENANT's zone (Business.timezone).
 *   - "today" for days-left / last day: the tenant's calendar day, never an instant
 *     comparison against UTC midnight.
 * delivery_time is free text ("4:00 PM") and is passed through untouched.
 *
 * Every machine-timezone claim is proven by switching process.env.TZ (Node re-reads it),
 * so a test run on a UTC server, a Pacific laptop or a Tokyo box must agree.
 * Fixtures are fictional: Jordan Example, *.example.test.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { format as dateFnsFormat } from 'date-fns';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';
import { coordinatorSessionCookieName } from '@/lib/coordinatorSession';
import { mailtoHref, usableEmailAddress } from '@/lib/mailtoLink';
import { formatCalendarDateValue } from '@/lib/calendarDate';
import { calendarDaysUntil, formatInstantInTimeZone } from '@/lib/tenantTimezone';
import { formatPaidDate } from '@/lib/supporterPayment';
import { RecentOrders, type TrackerOrder } from '@/components/coordinator/RecentOrders';
import { DeliveryPrep } from '@/components/coordinator/DeliveryPrep';
import { WhatsNext } from '@/components/coordinator/WhatsNext';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Machine zones a coordinator's browser or FreezerIQ's server might be running in. */
const MACHINE_ZONES = ['UTC', 'America/Chicago', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Pacific/Kiritimati'];
const ORIGINAL_TZ = process.env.TZ;
function inMachineZone<T>(zone: string, fn: () => T): T {
    process.env.TZ = zone;
    try { return fn(); } finally { process.env.TZ = ORIGINAL_TZ; }
}
afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

const STAMP = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const;

const order = (over: Partial<TrackerOrder> = {}): TrackerOrder => ({
    id: 'order-jordan', customer_name: 'Jordan Example', participant_name: null, email: 'jordan@example.test',
    phone: null, total_amount: 125, amount_due: 125, paid_at: null, created_at: '2026-07-15T23:30:00.000Z',
    canceled_at: null, items: [{ quantity: 1, variant_size: 'serves_5', item_name: 'Fixture Bundle (Serves 5)' }],
    ...over,
});
const renderOrders = (orders: TrackerOrder[], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(RecentOrders as any, { orders, onCancel: () => {}, limit: 99, ...extra }));

// ── element-tree access, for props that static markup cannot show (handlers) ─────────────────────
type El = { type: any; props: any };
// The CommonJS exports object the compiled component reads `useState` from at call time
// (a TS namespace import is a getter-only wrapper and cannot be spied on).
const ReactCjs = require('react');
function withHooksStubbed<T>(fn: () => T): T {
    const s = jest.spyOn(ReactCjs, 'useState').mockImplementation(((init: any) => [typeof init === 'function' ? init() : init, () => {}]) as any);
    const e = jest.spyOn(ReactCjs, 'useEffect').mockImplementation((() => {}) as any);
    try { return fn(); } finally { s.mockRestore(); e.mockRestore(); }
}
function walk(node: any, visit: (el: El, ancestors: El[]) => void, ancestors: El[] = []) {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, visit, ancestors)); return; }
    if (!('props' in node)) return;
    visit(node, ancestors);
    walk(node.props?.children, visit, [...ancestors, node]);
}
function treeOf(orders: TrackerOrder[]) {
    return withHooksStubbed(() => (RecentOrders as any)({ orders, onCancel: jest.fn(), onMarkPaid: jest.fn(), onMarkUnpaid: jest.fn(), limit: 99 }));
}
function anchorsIn(tree: any) {
    const found: { el: El; ancestors: El[] }[] = [];
    walk(tree, (el, ancestors) => { if (el.type === 'a') found.push({ el, ancestors }); });
    return found;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PART D — EMAIL
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('D. email links', () => {
    it('1. a valid supporter address -> href is exactly mailto:<address>', () => {
        expect(mailtoHref('jordan@example.test')).toBe('mailto:jordan@example.test');
        const html = renderOrders([order()]);
        expect(html).toContain('href="mailto:jordan@example.test"');
        expect(html).toMatch(/<a href="mailto:jordan@example\.test"[^>]*>jordan@example\.test<\/a>/);
    });

    it('2. the supporter contact on an order row is a standard mailto link (a native <a>, not a component)', () => {
        const anchors = anchorsIn(treeOf([order()]));
        const mail = anchors.filter((a) => String(a.el.props.href).startsWith('mailto:'));
        expect(mail).toHaveLength(1);
        expect(mail[0].el.type).toBe('a');
        expect(mail[0].el.props.href).toBe('mailto:jordan@example.test');
    });

    it('3. no email (null, empty, whitespace) -> no mailto anchor and no copy button at all', () => {
        for (const email of [null, undefined, '', '   ']) {
            const html = renderOrders([order({ email: email as any })]);
            expect(html).not.toContain('mailto:');
            expect(html).not.toContain('data-copy-email');
            expect(html).not.toContain('data-unusable-email');
        }
    });

    it('4. plus-addressing reaches the mail app unchanged', () => {
        expect(mailtoHref('jordan+fall@example.test')).toBe('mailto:jordan+fall@example.test');
        expect(renderOrders([order({ email: 'jordan+fall@example.test' })])).toContain('href="mailto:jordan+fall@example.test"');
    });

    it('5. surrounding whitespace is trimmed from both the link and the visible text; case is preserved', () => {
        const html = renderOrders([order({ email: '  Jordan.Example@Example.Test  ' })]);
        expect(html).toContain('href="mailto:Jordan.Example@Example.Test"');
        expect(html).toContain('>Jordan.Example@Example.Test</a>');
        expect(html).not.toMatch(/mailto:\s/);
    });

    it('6. no Next.js / internal-router involvement: plain <a>, no router import in the component', () => {
        const src = read('components/coordinator/RecentOrders.tsx');
        expect(src).not.toMatch(/from 'next\/link'|from "next\/link"|useRouter|next\/navigation/);
        for (const { el } of anchorsIn(treeOf([order()]))) expect(typeof el.type).toBe('string');
    });

    it('7. clicking the address cannot mutate data: the anchor carries no handler, sits in no clickable parent, and Copy only writes the clipboard', async () => {
        const tree = treeOf([order()]);
        const [{ el, ancestors }] = anchorsIn(tree).filter((a) => String(a.el.props.href).startsWith('mailto:'));
        for (const k of Object.keys(el.props)) expect(k).not.toMatch(/^on[A-Z]/);
        for (const a of ancestors) {
            expect(a.type).not.toBe('button');
            for (const k of Object.keys(a.props)) expect(k).not.toMatch(/^onClick/);
        }
        // the Copy fallback: find it, render it, press it
        let copyEl: El | null = null;
        walk(tree, (n) => { if (typeof n.type === 'function' && n.props?.address) copyEl = n; });
        expect(copyEl).not.toBeNull();
        const button = withHooksStubbed(() => (copyEl as any).type((copyEl as any).props));
        expect(button.type).toBe('button');
        expect(button.props.type).toBe('button');
        const writeText = jest.fn(async () => {});
        const fetchSpy = jest.fn();
        const oldNav = (global as any).navigator; const oldFetch = (global as any).fetch;
        Object.defineProperty(global, 'navigator', { value: { clipboard: { writeText } }, configurable: true });
        (global as any).fetch = fetchSpy;
        try { await button.props.onClick(); } finally {
            Object.defineProperty(global, 'navigator', { value: oldNav, configurable: true });
            (global as any).fetch = oldFetch;
        }
        expect(writeText).toHaveBeenCalledWith('jordan@example.test');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('8. an address is never turned into an http(s) or internal route', () => {
        for (const e of ['jordan@example.test', 'Jordan+Fall@Example.Test', 'jordan?cc=boss@example.test', 'jordan#x@example.test']) {
            const href = mailtoHref(e);
            expect(href).toMatch(/^mailto:/);
            expect(href).not.toMatch(/^(https?:|\/)/);
        }
        const html = renderOrders([order()]);
        expect(html).not.toMatch(/href="\/[^"]*jordan/);
        expect(html).not.toMatch(/href="https?:[^"]*jordan/);
    });

    it('9. accessibility: a native, focusable link whose visible text is the address; Copy is a labelled button', () => {
        const html = renderOrders([order()]);
        expect(html).toMatch(/<a href="mailto:jordan@example\.test"[^>]*title="jordan@example\.test"[^>]*>jordan@example\.test<\/a>/);
        expect(html).not.toMatch(/<a[^>]*tabindex="-1"/);
        expect(html).toMatch(/<button type="button" aria-label="Copy email address jordan@example\.test"[^>]*>Copy<\/button>/);
    });

    it('10. an unusable stored address is shown as plain text, never as a link that would silently fail', () => {
        for (const bad of ['jordan.example.test', 'jordan@@example.test', 'jordan@example', 'jordan @example.test', '@example.test', 'jordan@', 'jordan@-bad.test']) {
            expect(mailtoHref(bad)).toBeNull();
            const html = renderOrders([order({ email: bad })]);
            expect(html).not.toContain('mailto:');
            expect(html).not.toContain('data-copy-email');
            expect(html).toContain('data-unusable-email');
        }
    });

    it('11. no other scheme can be smuggled in, and URI-meaningful characters are percent-encoded (RFC 6068)', () => {
        expect(mailtoHref('javascript:alert(1)//@example.test')).toBeNull();
        expect(mailtoHref('javascript:alert(1)')).toBeNull();
        expect(mailtoHref('<script>@example.test')).toBeNull();
        expect(mailtoHref(42)).toBeNull();
        expect(mailtoHref({ toString: () => 'jordan@example.test' })).toBeNull();
        // `?` would otherwise start a header list (cc=, body=) inside the mail app
        expect(mailtoHref('jordan?cc=boss@example.test')).toBe('mailto:jordan%3Fcc=boss@example.test');
        expect(mailtoHref('jordan#x@example.test')).toBe('mailto:jordan%23x@example.test');
        expect(mailtoHref('jordan%40@example.test')).toBe('mailto:jordan%2540@example.test');
        expect(mailtoHref('a/b@example.test')).toBe('mailto:a%2Fb@example.test');
        expect(usableEmailAddress(' Jordan@Example.test ')).toBe('Jordan@Example.test');
    });

    it('12. the coordinator\'s own addresses elsewhere on the panel stay text (no self-mail links invented)', () => {
        const launch = read('components/coordinator/LaunchSteps.tsx');
        expect(launch).toMatch(/we&apos;ll email <strong>\{notifyEmail\}<\/strong>/);
        expect(read('components/coordinator/CoordinatorSetupFields.tsx')).not.toMatch(/mailto:/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PART E — DATES
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('E. date-only business values keep their calendar day in every machine zone', () => {
    it('THE BUG, reproduced: the old portal expression shows a stored 2026-10-20 as "October 19" in Central', () => {
        const old = inMachineZone('America/Chicago', () => dateFnsFormat(new Date('2026-10-20T00:00:00.000Z'), 'MMMM d'));
        expect(old).toBe('October 19');
    });

    it.each([
        ['1. 2026-10-20', '2026-10-20', 'October 20'],
        ['2. near spring DST 2026-03-08', '2026-03-08', 'March 8'],
        ['3. near fall DST 2026-11-01', '2026-11-01', 'November 1'],
        ['   year end', '2026-12-31', 'December 31'],
        ['   leap day', '2028-02-29', 'February 29'],
    ])('%s -> %s in every machine zone, as a JSON string, an ISO midnight and a Date', (_l, iso, expected) => {
        for (const zone of MACHINE_ZONES) {
            inMachineZone(zone, () => {
                expect(formatCalendarDateValue(iso)).toBe(expected);
                expect(formatCalendarDateValue(`${iso}T00:00:00.000Z`)).toBe(expected);
                expect(formatCalendarDateValue(new Date(`${iso}T00:00:00.000Z`))).toBe(expected);
            });
        }
    });

    it('9. a coordinator browser in Pacific / Eastern / Hawaii / Tokyo sees the same pickup day on the panel cards', () => {
        for (const zone of MACHINE_ZONES) {
            inMachineZone(zone, () => {
                const label = formatCalendarDateValue('2026-10-09T00:00:00.000Z') ?? undefined;
                expect(renderToStaticMarkup(createElement(DeliveryPrep, { deliveryDateLabel: label, onDownloadPickupSheet: () => {} })))
                    .toContain('Pickup is October 9');
                expect(renderToStaticMarkup(createElement(WhatsNext, { tenantName: 'Fixture Kitchen', deliveryWindowLabel: label })))
                    .toContain('Food arrives October 9');
            });
        }
    });

    it('10. invalid / missing date-only values -> null, never "Invalid Date"', () => {
        for (const v of [null, undefined, '', 'not-a-date', '2026-13-45']) {
            const out = formatCalendarDateValue(v as any);
            expect(out).toBeNull();
        }
    });
});

describe('E. real instants are shown in the TENANT zone (IANA, DST-aware), never the machine zone', () => {
    it('4/5. summer Central (CDT, UTC-5) from a UTC instant', () => {
        expect(formatInstantInTimeZone('2026-07-15T23:30:00.000Z', 'America/Chicago', STAMP)).toBe('Jul 15, 6:30 PM');
    });

    it('6. winter Central (CST, UTC-6)', () => {
        expect(formatInstantInTimeZone('2026-01-15T23:30:00.000Z', 'America/Chicago', STAMP)).toBe('Jan 15, 5:30 PM');
    });

    it('   the DST transitions themselves are the IANA rules, not an offset', () => {
        expect(formatInstantInTimeZone('2026-03-08T07:59:00.000Z', 'America/Chicago', STAMP)).toBe('Mar 8, 1:59 AM');
        expect(formatInstantInTimeZone('2026-03-08T08:00:00.000Z', 'America/Chicago', STAMP)).toBe('Mar 8, 3:00 AM');
        expect(formatInstantInTimeZone('2026-11-01T06:59:00.000Z', 'America/Chicago', STAMP)).toBe('Nov 1, 1:59 AM');
        expect(formatInstantInTimeZone('2026-11-01T07:00:00.000Z', 'America/Chicago', STAMP)).toBe('Nov 1, 1:00 AM');
    });

    it('7. a tenant in another IANA zone gets ITS local time, not Central', () => {
        const at = '2026-07-15T23:30:00.000Z';
        expect(formatInstantInTimeZone(at, 'America/Los_Angeles', STAMP)).toBe('Jul 15, 4:30 PM');
        expect(formatInstantInTimeZone(at, 'America/New_York', STAMP)).toBe('Jul 15, 7:30 PM');
        expect(formatInstantInTimeZone(at, 'Asia/Tokyo', STAMP)).toBe('Jul 16, 8:30 AM');
        expect(formatInstantInTimeZone(at, 'UTC', STAMP)).toBe('Jul 15, 11:30 PM');
    });

    it('8. server on UTC, browser in Pacific or Tokyo: the order row shows the tenant\'s time all the same', () => {
        for (const zone of MACHINE_ZONES) {
            inMachineZone(zone, () => {
                const html = renderOrders([order({ paid_at: '2026-10-21T03:30:00.000Z' })], { timeZone: 'America/Chicago' });
                expect(html).toContain('Jul 15, 6:30 PM');
                // marked paid at 10:30 PM Central on Oct 20 — the tenant's Oct 20, not UTC's Oct 21
                expect(html).toContain('Paid · Oct 20');
            });
        }
    });

    it('   the same order under a Tokyo tenant renders Tokyo time (proves nothing is hardcoded to Central)', () => {
        const html = renderOrders([order({ paid_at: '2026-10-21T03:30:00.000Z' })], { timeZone: 'Asia/Tokyo' });
        expect(html).toContain('Jul 16, 8:30 AM');
        expect(html).toContain('Paid · Oct 21');
    });

    it('10. invalid / missing tenant zone or instant -> no time shown (no guessed zone, no "Invalid Date")', () => {
        for (const tz of [null, undefined, '', 'CST', 'EST', '-05:00', 'Mars/Olympus', 'america/chicago']) {
            expect(formatInstantInTimeZone('2026-07-15T23:30:00.000Z', tz as any, STAMP)).toBeNull();
            const html = renderOrders([order({ paid_at: '2026-10-21T03:30:00.000Z' })], { timeZone: tz });
            expect(html).not.toMatch(/Jul 1\d, \d/);
            expect(html).toContain('✓ Paid</span>');
            expect(html).not.toContain('Invalid Date');
        }
        for (const v of [null, undefined, '', 'garbage']) {
            expect(formatInstantInTimeZone(v as any, 'America/Chicago', STAMP)).toBeNull();
            expect(renderOrders([order({ created_at: v as any })], { timeZone: 'America/Chicago' })).not.toContain('Invalid Date');
        }
    });

    it('   formatPaidDate with the tenant zone keeps the tenant\'s calendar day across the UTC midnight', () => {
        expect(formatPaidDate('2026-10-21T03:30:00.000Z', { timeZone: 'America/Chicago' })).toBe('Oct 20');
        expect(formatPaidDate('2026-10-21T03:30:00.000Z', { timeZone: 'UTC' })).toBe('Oct 21');
    });
});

describe('E. days left / last day use the tenant calendar day', () => {
    const oldFormula = (end: string, now: string) => Math.ceil((new Date(end).getTime() - new Date(now).getTime()) / 86_400_000);

    it('12. end_date 2026-10-20, Central: the evening before is still 1 day left (the old formula said 0 = "Last day")', () => {
        const now = '2026-10-20T00:30:00.000Z'; // Oct 19, 7:30 PM CDT
        expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date(now))).toBe(1);
        expect(oldFormula('2026-10-20T00:00:00.000Z', now) === 0).toBe(true);
    });

    it('12. the deadline evening is still the last day (the old formula already said "complete")', () => {
        const now = '2026-10-21T00:30:00.000Z'; // Oct 20, 7:30 PM CDT
        expect(calendarDaysUntil('2026-10-20T00:00:00.000Z', 'America/Chicago', new Date(now))).toBe(0);
        expect(oldFormula('2026-10-20T00:00:00.000Z', now)).toBe(-1);
    });

    it('   noon the day before, noon the day of, and the next morning', () => {
        expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-19T17:00:00.000Z'))).toBe(1);
        expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-20T17:00:00.000Z'))).toBe(0);
        expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-21T05:00:00.000Z'))).toBe(-1);
        expect(calendarDaysUntil('2026-10-27', 'America/Chicago', new Date('2026-10-17T23:00:00.000Z'))).toBe(10);
    });

    it('   winter (CST, UTC-6): 6:30 PM the evening before is still 1 day left', () => {
        expect(calendarDaysUntil('2026-12-15', 'America/Chicago', new Date('2026-12-15T00:30:00.000Z'))).toBe(1);
    });

    it('   across the spring and fall DST days the count is whole days', () => {
        expect(calendarDaysUntil('2026-03-08', 'America/Chicago', new Date('2026-03-08T05:30:00.000Z'))).toBe(1); // Mar 7 11:30 PM CST
        expect(calendarDaysUntil('2026-03-08', 'America/Chicago', new Date('2026-03-08T06:30:00.000Z'))).toBe(0); // Mar 8 0:30 CST
        expect(calendarDaysUntil('2026-03-10', 'America/Chicago', new Date('2026-03-08T12:00:00.000Z'))).toBe(2);
        expect(calendarDaysUntil('2026-11-02', 'America/Chicago', new Date('2026-11-01T12:00:00.000Z'))).toBe(1);
        expect(calendarDaysUntil('2026-11-01', 'America/Chicago', new Date('2026-11-01T05:30:00.000Z'))).toBe(0); // Nov 1 0:30 CDT
    });

    it('7. a non-Central tenant counts by its own calendar', () => {
        expect(calendarDaysUntil('2026-10-20', 'Asia/Tokyo', new Date('2026-10-19T15:30:00.000Z'))).toBe(0);         // Oct 20 0:30 JST
        expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-19T15:30:00.000Z'))).toBe(1);    // Oct 19 10:30 AM CDT
        expect(calendarDaysUntil('2026-10-20', 'America/Los_Angeles', new Date('2026-10-21T06:30:00.000Z'))).toBe(0); // Oct 20 11:30 PM PDT
    });

    it('8/9. the machine zone never changes the answer', () => {
        for (const zone of MACHINE_ZONES) {
            inMachineZone(zone, () => {
                expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-20T00:30:00.000Z'))).toBe(1);
                expect(calendarDaysUntil('2026-10-20', 'America/Chicago', new Date('2026-10-21T00:30:00.000Z'))).toBe(0);
            });
        }
    });

    it('10. missing end date or unusable zone -> null (no date-driven phase), never NaN', () => {
        expect(calendarDaysUntil(null, 'America/Chicago')).toBeNull();
        expect(calendarDaysUntil('', 'America/Chicago')).toBeNull();
        expect(calendarDaysUntil('garbage', 'America/Chicago')).toBeNull();
        for (const tz of [null, '', 'CST', '-05:00', 'Mars/Olympus']) expect(calendarDaysUntil('2026-10-20', tz as any)).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The portal page and the API are wired to the above
// ═════════════════════════════════════════════════════════════════════════════════════════════
describe('wiring: the portal page', () => {
    const page = read('app/coordinator/portal/page.tsx');

    it('11. delivery_date renders through the date-only formatter, not date-fns in the viewer zone', () => {
        expect(page).not.toMatch(/from 'date-fns'/);
        expect(page).not.toMatch(/new Date\(campaign\.delivery_date/);
        expect(page).toMatch(/const deliveryDateLabel = formatCalendarDateValue\(campaign\.delivery_date\) \?\? undefined;/);
    });

    it('12. days left comes from the tenant calendar, not instant arithmetic on end_date', () => {
        expect(page).not.toMatch(/new Date\(campaign\.end_date/);
        expect(page).toMatch(/const daysRemaining = calendarDaysUntil\(campaign\.end_date, tenantTimeZone\);/);
        expect(page).toMatch(/const tenantTimeZone: string \| null = campaign\.customer\?\.business\?\.timezone \?\? null;/);
    });

    it('   every Recent orders list receives the tenant zone', () => {
        const mounts = page.match(/<RecentOrders\b[\s\S]*?\/>/g) || [];
        expect(mounts.length).toBe(3);
        for (const m of mounts) expect(m).toContain('timeZone={tenantTimeZone}');
    });

    it('   no surface in this change hardcodes a zone or a fixed offset', () => {
        const code = (p: string) => read(p).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
        for (const p of ['app/coordinator/portal/page.tsx', 'components/coordinator/RecentOrders.tsx', 'lib/mailtoLink.ts', 'lib/tenantTimezone.ts', 'lib/calendarDate.ts']) {
            expect(code(p)).not.toMatch(/America\/Chicago|['"]CST['"]|['"]CDT['"]|getTimezoneOffset|[-+]\s*[56]\s*\*\s*(60|3600)/);
        }
    });
});

let mock: PrismaMock;
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__ccd1Prisma; } }));
jest.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => (name === (global as any).__ccd1CookieName ? { name, value: 'ccd1-session-secret' } : undefined),
        set: () => undefined,
        delete: () => undefined,
    }),
}));

describe('wiring: GET /api/coordinator supplies the tenant zone and leaves the stored dates and time text alone', () => {
    const CAMPAIGN = 'camp-ccd1';
    const campaign = (tz: string) => ({
        id: CAMPAIGN, name: 'Fixture Booster Club Fundraiser', status: 'Closed', closed_at: new Date('2026-10-14T01:00:00Z'),
        settlement_total: '0', end_date: new Date('2026-10-13T00:00:00Z'), delivery_date: new Date('2026-10-20T00:00:00Z'),
        delivery_time: '4:00 PM', pickup_location: 'Fixture School Gym', payment_instructions: null, external_payment_link: null,
        bundle_goal: 40, total_sales: '0', org_share_percent: '20.00', participant_label: 'Student',
        bundle_selection_status: 'selected', bundle_selection_limit: 2, public_token: 'public-ccd1', customer_id: 'org-ccd1',
        customer: {
            name: 'Fixture Booster Club', contact_name: 'Jordan Example', contact_email: 'jordan@example.test', business_id: 'biz-ccd1',
            business: { name: 'Fixture Kitchen', display_name: 'Fixture Kitchen', slug: 'fixture-kitchen', custom_domain: null, logo_url: null, plan: 'PRO', subscription_status: 'active', timezone: tz },
        },
        orders: [],
    });
    const request = (url: string) => new Request(`http://localhost${url}`, { headers: { origin: 'http://localhost' } });

    beforeEach(() => { (global as any).__ccd1CookieName = coordinatorSessionCookieName(); });

    it.each(['America/Chicago', 'America/Los_Angeles'])('13. tenant %s: zone in the response, dates and delivery_time unconverted', async (tz) => {
        mock = createPrismaMock({ results: {
            'coordinatorSession.findUnique': { id: 's-ccd1', campaign_id: CAMPAIGN, expires_at: new Date(Date.now() + 3_600_000), revoked_at: null },
            'fundraiserCampaign.findFirst': campaign(tz),
            'order.findMany': [],
            'bundle.findMany': [],
        } });
        (global as any).__ccd1Prisma = mock.client;
        const res = await readJson(await require('@/app/api/coordinator/route').GET(request('/api/coordinator')));
        expect(res.status).toBe(200);
        expect(mock.firstCall('fundraiserCampaign.findFirst')!.args.select.customer.select.business.select.timezone).toBe(true);
        expect(res.body.customer.business.timezone).toBe(tz);
        expect(res.body.delivery_date).toBe('2026-10-20T00:00:00.000Z');
        expect(res.body.end_date).toBe('2026-10-13T00:00:00.000Z');
        expect(res.body.delivery_time).toBe('4:00 PM');
        expect(res.body.share.pickupDeliveryLines).toEqual(['Date: Tuesday, October 20', 'Time: 4:00 PM', 'Location: Fixture School Gym']);
        expect(res.body.share.deadlineLabel).toBe('Tuesday, October 13');
        expect(JSON.stringify(res.body)).not.toMatch(/portal_token/);
    });
});
