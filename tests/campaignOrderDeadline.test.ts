/**
 * FR-TENANT-TZ-1 + FR-ORDERABILITY-1-R — the supporter ordering deadline, in the
 * tenant's own calendar day, and the public listing predicate.
 *
 * THREE DEFECTS THESE TESTS EXIST TO PREVENT
 *
 * 1. Nothing on the public order path consulted `end_date`, so an expired
 *    campaign kept taking supporter money. NOT a legacy-bypass problem: CRM4
 *    Runtime Test reached `selected` through the modern coordinator gate and was
 *    still orderable 20 days late, so the gate must precede the mode branch.
 *
 * 2. The first fix compared UTC days. For a Central tenant that closed a
 *    fundraiser advertised as ending August 31 at 7:00 PM Central on August 31.
 *    The deadline is a calendar day in the TENANT's zone, and only the IANA
 *    engine knows that Chicago is UTC-5 in August and UTC-6 in December.
 *
 * 3. The storefront listing compared `status = 'ACTIVE'` against a stored
 *    vocabulary of 'Active' — matching nothing — and used a UTC date, which
 *    would disagree with the order gate for five hours every evening.
 *
 * America/Chicago is the LAUNCH DEFAULT of Business.timezone. It is asserted
 * here as data, never as behaviour: every test passes a zone explicitly, and a
 * second zone proves the helper is not secretly Central-only.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const mockPrisma = { campaignBundle: { findMany: jest.fn(async () => []) } };
jest.mock('@/lib/db', () => ({ prisma: mockPrisma }));

import { isCampaignPastOrderDeadline } from '@/lib/campaignBundleSelection';
import { resolveCampaignOrderMode, validateBundleEligibility } from '@/lib/campaignOrderBundles';
import {
    isValidIanaTimeZone, calendarDateInTimeZone, calendarDateOfDateOnlyValue,
    isPlausibleCalendarYear, safeCalendarDateForInput,
} from '@/lib/tenantTimezone';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .map((l) => l.replace(/^\s*--.*$/, '')).join('\n');

const CHI = 'America/Chicago';
const NYC = 'America/New_York';
/** A DATE column arrives as UTC midnight of that calendar day. */
const endDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const at = (iso: string) => new Date(iso);

const campaign = (over: Record<string, unknown> = {}) => ({
    id: 'campaign-under-test',
    status: 'Active',
    closed_at: null,
    end_date: endDate('2026-08-31'),
    bundle_selection_status: 'not_required',
    bundle_selection_limit: 2,
    ...over,
});

beforeEach(() => {
    mockPrisma.campaignBundle.findMany.mockReset();
    mockPrisma.campaignBundle.findMany.mockResolvedValue([]);
});

// ── Timezone primitives ──────────────────────────────────────────────────────

describe('tenant timezone helpers', () => {
    it('accepts real IANA zones', () => {
        for (const tz of [CHI, NYC, 'America/Los_Angeles', 'UTC', 'Europe/London'])
            expect(isValidIanaTimeZone(tz)).toBe(true);
    });

    it('rejects anything unusable', () => {
        for (const bad of ['', '   ', 'Mars/Olympus', null, undefined, 5, {}])
            expect(isValidIanaTimeZone(bad as unknown)).toBe(false);
    });

    it('rejects fixed offsets, which cannot express DST', () => {
        // Intl ACCEPTS these and resolves them to themselves. A tenant stored as
        // '-05:00' would be an hour wrong for half the year, silently.
        for (const bad of ['-05:00', '+05:00', '-06:00'])
            expect(isValidIanaTimeZone(bad)).toBe(false);
    });

    it('rejects ambiguous abbreviations that Intl silently remaps', () => {
        // 'EST' resolves to America/Panama (no DST); 'CST' to America/Chicago;
        // 'GMT' to UTC. Silent remapping is worse than refusal.
        for (const bad of ['EST', 'CST', 'GMT'])
            expect(isValidIanaTimeZone(bad)).toBe(false);
    });

    it('reads a DATE column as its own calendar day, with no local shift', () => {
        expect(calendarDateOfDateOnlyValue(endDate('2026-08-31'))).toBe('2026-08-31');
        expect(calendarDateOfDateOnlyValue('2026-08-31')).toBe('2026-08-31');
    });

    it('OPS-LAUNCH-HOTFIX-1: pads the year so a short-year Date round-trips into a parseable date string', () => {
        // A Date whose UTC year is not 4 digits (e.g. a value stored via some
        // non-standard write path -- the numeric Date.UTC(26, ...) constructor
        // form would actually give 1926 via JS's legacy 2-digit-year offset;
        // the ISO STRING form treats an explicit short year literally, which is
        // how a genuinely short year would have reached the database) must
        // still produce a string every caller can safely reconstruct with
        // `new Date(`${x}T00:00:00.000Z`)`. Unpadded, getUTCFullYear() for
        // year 26 returns the number 26, producing "26-08-28" -- not a valid
        // ISO date, and the exact shape that broke
        // app/api/opportunities/[id]/launch/route.ts's delivery_date
        // construction in Production (FR-FLOW-2 launch error:
        // PrismaClientValidationError, "Invalid value for argument `delivery_date`").
        const shortYear = new Date('0026-08-28T00:00:00.000Z'); // year 26, not 2026
        const result = calendarDateOfDateOnlyValue(shortYear);
        expect(result).toBe('0026-08-28');
        expect(Number.isNaN(new Date(`${result}T00:00:00.000Z`).getTime())).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // OPS-DATE-PICKER-HOTFIX-1 — the shared plausibility predicate, extracted
    // from lib/fundraiserLaunch.ts's checkOpportunityLaunchable so the launch
    // gate and the CRM funnel panel's date display can never define
    // "plausible year" two different ways.
    // ═══════════════════════════════════════════════════════════════════════
    describe('isPlausibleCalendarYear', () => {
        it('accepts an ordinary 4-digit year', () => {
            expect(isPlausibleCalendarYear(2026)).toBe(true);
        });
        it('rejects a short year like the one that broke launch', () => {
            expect(isPlausibleCalendarYear(26)).toBe(false);
        });
        it('rejects year 0 and negative years', () => {
            expect(isPlausibleCalendarYear(0)).toBe(false);
            expect(isPlausibleCalendarYear(-5)).toBe(false);
        });
        it('accepts the boundary years 1000 and 9999', () => {
            expect(isPlausibleCalendarYear(1000)).toBe(true);
            expect(isPlausibleCalendarYear(9999)).toBe(true);
        });
        it('rejects 999 and 10000', () => {
            expect(isPlausibleCalendarYear(999)).toBe(false);
            expect(isPlausibleCalendarYear(10000)).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════
    // OPS-DATE-PICKER-HOTFIX-1 — PART F before-fix proof. This is the exact
    // defect the owner saw: components/crm2/FunnelLeadsPanel.tsx fed a raw,
    // un-4-digit-padded, unplausibility-checked API string straight into the
    // native <input type="date">'s value and into fmtDate()'s
    // `new Date(d).toLocaleDateString(...)`, for an opportunity whose
    // confirmed_delivery_date already carried a short year (the exact
    // Production shape OPS-LAUNCH-HOTFIX-1 diagnosed for "Ag in the
    // Classroom" but explicitly did not repair — Production data and code
    // fixes are separate). safeCalendarDateForInput is the one place that
    // now decides "is this value safe to show in a date control" so the
    // panel's two input fields and its label cannot drift into different
    // answers.
    // ═══════════════════════════════════════════════════════════════════════
    describe('safeCalendarDateForInput', () => {
        it('returns a clean YYYY-MM-DD for an ordinary date', () => {
            expect(safeCalendarDateForInput('2026-09-09T00:00:00.000Z')).toBe('2026-09-09');
            expect(safeCalendarDateForInput(new Date('2026-09-09T00:00:00.000Z'))).toBe('2026-09-09');
        });
        it('returns empty string for null/undefined/empty', () => {
            expect(safeCalendarDateForInput(null)).toBe('');
            expect(safeCalendarDateForInput(undefined)).toBe('');
            expect(safeCalendarDateForInput('')).toBe('');
        });
        it('BEFORE THE FIX, this exact value produced "0026-09-09" fed straight into the native date input -- returns empty string instead', () => {
            // The exact malformed shape from Production: a stored
            // confirmed_delivery_date whose year is not 4 digits.
            const badStoredValue = '0026-09-09T00:00:00.000Z';
            expect(safeCalendarDateForInput(badStoredValue)).toBe('');
        });
        it('an unparseable string also returns empty string, not a throw', () => {
            expect(safeCalendarDateForInput('not-a-date')).toBe('');
        });

        // PART M — no timezone drift for the representative dates, including
        // a DST-transition date (2026-03-08, the US spring-forward Sunday)
        // and both calendar-year boundaries. safeCalendarDateForInput reads
        // UTC fields deliberately (via calendarDateOfDateOnlyValue), so a
        // stored midnight-UTC date-only value must round-trip to the SAME
        // calendar day regardless of which day of year it is.
        it.each([
            '2026-01-01', '2026-03-08', '2026-09-09', '2026-11-01', '2026-12-31',
        ])('%s round-trips to the same calendar date with no day shift', (day) => {
            expect(safeCalendarDateForInput(`${day}T00:00:00.000Z`)).toBe(day);
        });
    });

    it('returns the calendar date as seen in the given zone', () => {
        // 04:30 UTC on Sep 1 is still Aug 31 in Chicago (CDT, UTC-5).
        expect(calendarDateInTimeZone(CHI, at('2026-09-01T04:30:00Z'))).toBe('2026-08-31');
        expect(calendarDateInTimeZone('UTC', at('2026-09-01T04:30:00Z'))).toBe('2026-09-01');
    });

    it('returns null rather than guessing for an unusable zone', () => {
        expect(calendarDateInTimeZone('Mars/Olympus', at('2026-09-01T04:30:00Z'))).toBeNull();
    });
});

// ── The approved Chicago acceptance example ──────────────────────────────────

describe('America/Chicago tenant, end_date 2026-08-31 (the approved example)', () => {
    const END = endDate('2026-08-31');
    const past = (now: string) => isCampaignPastOrderDeadline({ end_date: END }, CHI, at(now));

    it('is open on the morning of the deadline day', () => {
        expect(past('2026-08-31T14:00:00Z')).toBe(false); // 9am Central
    });

    it('is open in the afternoon of the deadline day', () => {
        expect(past('2026-08-31T20:00:00Z')).toBe(false); // 3pm Central
    });

    it('is OPEN at 7:00 PM Central — the rejected UTC cutoff', () => {
        // The previous implementation closed here. This is the whole revision.
        expect(past('2026-09-01T00:00:00Z')).toBe(false); // 7:00 pm Central
    });

    it('is open at 11:59:59 PM Central on the deadline day', () => {
        expect(past('2026-09-01T04:59:59Z')).toBe(false);
    });

    it('is CLOSED at 12:00:00 AM Central the next day', () => {
        expect(past('2026-09-01T05:00:00Z')).toBe(true);
    });

    it('is open even though UTC has already reached September 1', () => {
        // 04:30Z on Sep 1 — UTC says September, Chicago still says August 31.
        expect(calendarDateInTimeZone('UTC', at('2026-09-01T04:30:00Z'))).toBe('2026-09-01');
        expect(past('2026-09-01T04:30:00Z')).toBe(false);
    });
});

// ── A second zone proves it is not Central-only ──────────────────────────────

describe('the rule follows the tenant, not a hardcoded zone', () => {
    const END = endDate('2026-08-31');

    it('closes New York an hour before Chicago at the same instant', () => {
        // 04:30Z: New York (EDT, UTC-4) is already Sep 1; Chicago (CDT) is not.
        expect(isCampaignPastOrderDeadline({ end_date: END }, NYC, at('2026-09-01T04:30:00Z'))).toBe(true);
        expect(isCampaignPastOrderDeadline({ end_date: END }, CHI, at('2026-09-01T04:30:00Z'))).toBe(false);
    });

    it('closes a UTC tenant at UTC midnight', () => {
        expect(isCampaignPastOrderDeadline({ end_date: END }, 'UTC', at('2026-09-01T00:00:00Z'))).toBe(true);
        expect(isCampaignPastOrderDeadline({ end_date: END }, 'UTC', at('2026-08-31T23:59:59Z'))).toBe(false);
    });
});

describe('daylight saving is handled by the timezone engine', () => {
    it('uses UTC-5 for Chicago in summer (CDT)', () => {
        const END = endDate('2026-08-31');
        expect(isCampaignPastOrderDeadline({ end_date: END }, CHI, at('2026-09-01T04:59:59Z'))).toBe(false);
        expect(isCampaignPastOrderDeadline({ end_date: END }, CHI, at('2026-09-01T05:00:00Z'))).toBe(true);
    });

    it('uses UTC-6 for Chicago in winter (CST) — an hour later in UTC', () => {
        const END = endDate('2026-12-31');
        // Still Dec 31 in Chicago at 05:59:59Z, which would already be closed
        // under the summer offset. Only the IANA rules get this right.
        expect(isCampaignPastOrderDeadline({ end_date: END }, CHI, at('2027-01-01T05:59:59Z'))).toBe(false);
        expect(isCampaignPastOrderDeadline({ end_date: END }, CHI, at('2027-01-01T06:00:00Z'))).toBe(true);
    });

    it('proves the two seasons genuinely differ', () => {
        // A fixed offset cannot satisfy both of the assertions above.
        expect(calendarDateInTimeZone(CHI, at('2026-09-01T05:30:00Z'))).toBe('2026-09-01');
        expect(calendarDateInTimeZone(CHI, at('2026-12-01T05:30:00Z'))).toBe('2026-11-30');
    });
});

// ── Invalid timezone must fail closed ────────────────────────────────────────

describe('a tenant with an unusable timezone', () => {
    it('is treated as past deadline by the predicate — never reopened', () => {
        expect(isCampaignPastOrderDeadline({ end_date: endDate('2099-01-01') }, 'Mars/Olympus',
            at('2026-08-31T12:00:00Z'))).toBe(true);
    });

    it('refuses ordering without falling back to UTC or the launch default', async () => {
        const m = await resolveCampaignOrderMode(campaign({ end_date: endDate('2099-01-01') }), 'biz', 'Mars/Olympus');
        expect(m.allowed).toBe(false);
        expect((m as any).reasonCode).toBe('timezone_unavailable');
    });

    it('never leaks the bad zone to the customer', async () => {
        const m = await resolveCampaignOrderMode(campaign(), 'biz', 'Mars/Olympus');
        const safe = (m as any).safeMessage;
        expect(safe).not.toMatch(/Mars|Olympus|timezone|UTC|Chicago/i);
        expect(safe).toBe('This fundraiser is temporarily unavailable. Please try again later.');
    });
});

// ── The order path ───────────────────────────────────────────────────────────

describe('the order path', () => {
    const EXPIRED = endDate('2026-01-31');
    const FUTURE = endDate('2099-01-01');

    it('allows a campaign before its deadline', async () => {
        const m = await resolveCampaignOrderMode(campaign({ end_date: FUTURE }), 'biz', CHI);
        expect(m.allowed).toBe(true);
        expect(m.mode).toBe('legacy');
    });

    it('refuses an expired LEGACY not_required campaign', async () => {
        const m = await resolveCampaignOrderMode(
            campaign({ end_date: EXPIRED, bundle_selection_status: 'not_required' }), 'biz', CHI);
        expect(m.allowed).toBe(false);
        expect((m as any).reasonCode).toBe('deadline_passed');
    });

    it('refuses an expired MODERN selected campaign — the CRM4 regression', async () => {
        mockPrisma.campaignBundle.findMany.mockResolvedValue([
            { bundle: { id: 'b1', business_id: 'biz', is_active: true, family_id: 'f1', serving_tier: 'serves_5' } },
        ]);
        const m = await resolveCampaignOrderMode(
            campaign({ end_date: EXPIRED, bundle_selection_status: 'selected' }), 'biz', CHI);

        expect(m.allowed).toBe(false);
        expect((m as any).reasonCode).toBe('deadline_passed');
        // Evaluated before the bundle matrix, so no bundle work happens.
        expect(mockPrisma.campaignBundle.findMany).not.toHaveBeenCalled();
    });

    it('tells the supporter something true and non-technical', async () => {
        const m = await resolveCampaignOrderMode(campaign({ end_date: EXPIRED }), 'biz', CHI);
        const safe = (m as any).safeMessage;
        expect(safe).toBe('This fundraiser is no longer accepting orders.');
        expect(safe).not.toMatch(/status|end_date|campaign_id|Archived|Closed|timezone/i);
    });

    it('surfaces the refusal through the submission eligibility gate', async () => {
        const m = await resolveCampaignOrderMode(campaign({ end_date: EXPIRED }), 'biz', CHI);
        const r = validateBundleEligibility(m, []);
        expect(r.ok).toBe(false);
        expect((r as any).status).toBe(400);
        expect((r as any).error).toBe('This fundraiser is no longer accepting orders.');
    });

    it('still allows a campaign with no end_date at all', async () => {
        const m = await resolveCampaignOrderMode(campaign({ end_date: null }), 'biz', CHI);
        expect(m.allowed).toBe(true);
    });

    it('leaves tenant-facing callers unaffected when no zone is supplied', async () => {
        // The coordinator portal, tracker, pickup sheet, flyer and packet routes
        // pass no zone on purpose: a coordinator still needs their tracker after
        // supporter ordering has closed.
        const m = await resolveCampaignOrderMode(campaign({ end_date: EXPIRED }), 'biz');
        expect(m.allowed).toBe(true);
    });
});

describe('lifecycle status refuses independently of the deadline', () => {
    const FUTURE = endDate('2099-01-01');

    it.each(['Closed', 'Archived', 'Settled', 'Completed'])(
        'refuses a %s campaign even with a future deadline', async (status) => {
            const m = await resolveCampaignOrderMode(campaign({ status, end_date: FUTURE }), 'biz', CHI);
            expect(m.allowed).toBe(false);
            expect((m as any).reasonCode).toBe('closed');
        });

    it('refuses a campaign with closed_at set', async () => {
        const m = await resolveCampaignOrderMode(
            campaign({ closed_at: new Date('2026-07-11T01:32:47Z'), end_date: FUTURE }), 'biz', CHI);
        expect(m.allowed).toBe(false);
    });

    it('keeps the modern coordinator gate: pending setup stays non-orderable', async () => {
        const m = await resolveCampaignOrderMode(
            campaign({ bundle_selection_status: 'pending', end_date: FUTURE }), 'biz', CHI);
        expect(m.allowed).toBe(false);
        expect(m.mode).toBe('pending');
    });
});

// ── Where it cannot be raced, and what discovery shows ───────────────────────

describe('the deadline is enforced where it cannot be raced', () => {
    const route = code(read('app/api/public/order/route.ts'));
    const tx = route.slice(route.indexOf('$transaction'));

    it('preflight passes the server-resolved tenant zone', () => {
        expect(route).toMatch(/resolveCampaignOrderMode\(\s*campaign,\s*businessId,\s*business\.timezone\s*\)/);
    });

    it('rechecks the deadline inside the transaction', () => {
        expect(tx).toContain('isCampaignPastOrderDeadline');
    });

    it('re-reads the tenant zone from the durable Business row, not the preflight value', () => {
        expect(tx).toMatch(/customer:\s*\{\s*select:\s*\{\s*business:\s*\{\s*select:\s*\{\s*timezone:\s*true/);
        expect(tx).toContain('currentCampaign?.customer?.business?.timezone');
    });

    it('fails closed on an unusable zone at transaction time', () => {
        expect(tx).toContain('!isValidIanaTimeZone(tenantZone)');
    });

    it('keeps the existing closed-state recheck and idempotency', () => {
        expect(tx).toContain('isCampaignClosed');
        expect(tx).toContain('CampaignClosedError');
        expect(route).toContain('submissionKey');
    });
});

describe('the public listing predicate', () => {
    const tenant = read('app/api/public/tenant/[slug]/route.ts');
    const sql = code(tenant);

    it('matches the vocabulary the application actually stores', () => {
        expect(sql).toContain("fc.status = 'Active'");
        expect(sql).not.toContain("fc.status = 'ACTIVE'");
    });

    it('uses the tenant calendar day, not the cluster UTC day', () => {
        expect(sql).toMatch(/fc\.end_date >= \(CURRENT_TIMESTAMP AT TIME ZONE \$\{tenantZone\}\)::date/);
        expect(sql).not.toMatch(/fc\.end_date >= CURRENT_DATE/);
        expect(sql).not.toMatch(/end_date >= CURRENT_TIMESTAMP\b/);
    });

    it('binds the zone as a parameter rather than interpolating text', () => {
        // Prisma tagged template: ${tenantZone} is bound, never concatenated.
        expect(sql).not.toMatch(/AT TIME ZONE '/);
        expect(sql).toMatch(/AT TIME ZONE \$\{tenantZone\}/);
    });

    it('lists nothing when the tenant zone is unusable', () => {
        expect(sql).toMatch(/!isValidIanaTimeZone\(tenantZone\)\s*\?\s*\[\]/);
    });

    it('does not advertise a campaign the order path would refuse', () => {
        expect(sql).toMatch(/bundle_selection_status\s*<>\s*'pending'/);
    });

    it('cannot list a closed or archived campaign', () => {
        expect(sql).not.toMatch(/status\s*(=|IN)\s*.*(Closed|Archived|Lead|Production)/);
    });
});

// ── The tenant timezone authority itself ─────────────────────────────────────

describe('Business.timezone is the authority', () => {
    const schema = read('prisma/schema.prisma');
    const migration = read('prisma/migrations/20260819000000_fr_tenant_tz_1_business_timezone/migration.sql');

    it('exists on Business with the launch default', () => {
        expect(schema).toMatch(/timezone\s+String\s+@default\("America\/Chicago"\)/);
    });

    it('is added by an additive, non-null, defaulted migration', () => {
        expect(migration).toMatch(
            /ALTER TABLE "businesses" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America\/Chicago';/);
    });

    it('changes nothing else', () => {
        // Only executable SQL counts — the header deliberately NAMES the tables
        // it does not touch, so scanning comments would defeat the assertion.
        const stmts = migration.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
        expect(stmts).toHaveLength(1);
        const sql = stmts.join('\n');
        expect(sql).not.toMatch(/DROP|DELETE|TRUNCATE|PasswordResetToken|fundraiser_campaigns|orders|invoices/);
    });

    it('is a launch default only — no comparison helper hardcodes a zone', () => {
        const helper = code(read('lib/tenantTimezone.ts'));
        const selection = code(read('lib/campaignBundleSelection.ts'));
        expect(helper).not.toMatch(/America\/Chicago/);
        expect(selection).not.toMatch(/America\/Chicago/);
        expect(code(read('lib/campaignOrderBundles.ts'))).not.toMatch(/America\/Chicago/);
    });
});
