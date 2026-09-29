/**
 * CRM-DEADLINE-TIMEZONE-1 — the Fundraiser CRM's "has this campaign ended?"
 * question, answered in the tenant's own calendar day instead of a raw UTC
 * instant.
 *
 * THE BUG THIS FIXES
 * `end_date` is a DATE column with no time component, stored as UTC midnight
 * of that calendar day (e.g. 2026-09-29 → 2026-09-29T00:00:00.000Z). Three
 * independent call sites — components/crm2/CampaignPriorityList.tsx,
 * lib/growth/nextAction.ts's hasEndedWithHeldOrders(), and
 * lib/growth/campaignContextUi.ts's detailLifecycle()/detailDateLine() — each
 * wrote their own `new Date(end_date).getTime() < now.getTime()`. For an
 * America/Chicago tenant (UTC-5 in September) that compares a UTC-midnight
 * instant against "now", so the campaign started reading as "Ended" at
 * 7:00 PM Central on the evening BEFORE the deadline date, and stayed wrong
 * for the entire deadline day itself — a ~29 hour window.
 *
 * REAL-WORLD MOTIVATING CASE: "Edgar County Farm Bureau Fundraiser",
 * end_date 2026-09-29, Business.timezone 'America/Chicago' — reported by the
 * owner as "Ended September 29, 2026" / "Needs attention" while their own
 * local calendar still read September 28. See the "Edgar" describe block
 * below for the direct reproduction at the reported time.
 *
 * THE FIX: one shared helper, hasCampaignEndedForTenant(), built on the SAME
 * calendar-day primitives (calendarDateOfDateOnlyValue / calendarDateInTimeZone)
 * that lib/campaignBundleSelection.ts's isCampaignPastOrderDeadline() already
 * uses for the supporter-facing order cutoff — never an instant comparison.
 *
 * FAIL-CLOSED DIRECTION: deliberately the OPPOSITE of isCampaignPastOrderDeadline().
 * That function protects MONEY (missing/invalid zone → treat as past deadline,
 * block new orders). This one protects ATTENTION (missing/invalid zone → treat
 * as NOT YET ENDED, never prematurely end or flag a healthy campaign). Both
 * postures refuse to guess; they just guess safe in opposite directions because
 * they guard against opposite harms. See tests C/G below.
 *
 * OUT OF SCOPE, reported separately as follow-ups (same bug family, not one of
 * the three named sites for this task):
 *   - components/crm2/ArchivedCampaignList.tsx:82 (display-only, already-archived)
 *   - components/crm2/CampaignCard.tsx (daysLeft countdown)
 *   - app/coordinator/portal/page.tsx (daysRemaining / campaignPhase — also
 *     inside the locked Channel-1 coordinator surface)
 *
 * IMPORTANT: lib/growth/health.ts is NOT touched by this task. "On pace" and
 * "Needs attention" are independent axes — a campaign can be health: 'on_pace'
 * (GE-3's sales-pace verdict) and STILL be priority: 'needs_attention' (because
 * its window ended with orders still held). The bug was never that these two
 * labels could coexist; it was that the deadline was considered passed too
 * early. See test group F below.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { hasCampaignEndedForTenant, isCampaignPastOrderDeadline } from '@/lib/campaignBundleSelection';
import { hasEndedWithHeldOrders, triageCampaign, type CampaignForTriage } from '@/lib/growth/nextAction';
import { detailLifecycle, detailDateLine } from '@/lib/growth/campaignContextUi';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');

const CHI = 'America/Chicago';
const NYC = 'America/New_York';
/** A DATE column arrives as UTC midnight of that calendar day. */
const endDate = (iso: string) => `${iso}T00:00:00.000Z`;
const at = (iso: string) => new Date(iso);

const campaign = (over: Partial<CampaignForTriage> = {}): CampaignForTriage => ({
    status: 'Active',
    closed_at: null,
    end_date: endDate('2026-09-29'),
    business_timezone: CHI,
    held_order_count: 0,
    health: 'on_pace',
    health_reasons: [],
    is_placeholder: false,
    organization_archived: false,
    ...over,
});

// ── A. Edgar's exact boundary: evening-before / start / end / after ─────────

describe('hasCampaignEndedForTenant — America/Chicago, end_date 2026-09-29 (Edgar County)', () => {
    const c = campaign();

    it('A: is NOT ended at 10:00 PM Central the evening before the deadline — the exact old bug window', () => {
        // 10:00 PM CDT Sep 28 = 03:00 UTC Sep 29. The old `getTime() < now.getTime()`
        // compared this against UTC-midnight end_date and wrongly said "Ended" here.
        expect(hasCampaignEndedForTenant(c, at('2026-09-29T03:00:00Z'))).toBe(false);
    });

    it('B: UTC has already turned over to the deadline date, but Chicago has not', () => {
        expect(hasCampaignEndedForTenant(c, at('2026-09-29T00:00:01Z'))).toBe(false);
    });

    it('C: is NOT ended at the very start of the deadline day, local midnight Central', () => {
        expect(hasCampaignEndedForTenant(c, at('2026-09-29T05:00:00Z'))).toBe(false);
    });

    it('C: is NOT ended at 11:59:59 PM Central on the deadline day itself — the last open second', () => {
        expect(hasCampaignEndedForTenant(c, at('2026-09-30T04:59:59Z'))).toBe(false);
    });

    it('D: IS ended one second later, at local midnight beginning the next day', () => {
        expect(hasCampaignEndedForTenant(c, at('2026-09-30T05:00:00Z'))).toBe(true);
    });

    it('D: stays ended well into the following day', () => {
        expect(hasCampaignEndedForTenant(c, at('2026-10-02T12:00:00Z'))).toBe(true);
    });
});

// ── A second zone proves the rule follows the tenant, not a hardcoded zone ──

describe('the rule follows business_timezone, not a hardcoded zone', () => {
    it('closes New York an hour before Chicago at the same instant', () => {
        const c = campaign({ business_timezone: NYC });
        // 04:00Z Sep 30: New York (EDT, UTC-4) has already reached midnight
        // Sep 30; Chicago (CDT, UTC-5) has not.
        expect(hasCampaignEndedForTenant(c, at('2026-09-30T04:00:00Z'))).toBe(true);
        expect(hasCampaignEndedForTenant(campaign({ business_timezone: CHI }), at('2026-09-30T04:00:00Z'))).toBe(false);
    });

    it('no comparison helper hardcodes America/Chicago', () => {
        expect(code(read('lib/campaignBundleSelection.ts'))).not.toMatch(/America\/Chicago/);
        expect(code(read('lib/growth/nextAction.ts'))).not.toMatch(/America\/Chicago/);
        expect(code(read('lib/growth/campaignContextUi.ts'))).not.toMatch(/America\/Chicago/);
    });
});

// ── C/G. Fail-closed on missing or invalid timezone — TOWARD "not ended" ────

describe('fail-closed: a missing or invalid timezone never prematurely ends a campaign', () => {
    it('no business_timezone at all → not ended, even decades past the deadline', () => {
        const c = campaign({ business_timezone: null, end_date: endDate('2020-01-01') });
        expect(hasCampaignEndedForTenant(c, at('2026-09-28T12:00:00Z'))).toBe(false);
    });

    it('business_timezone undefined → not ended', () => {
        const c = campaign({ business_timezone: undefined, end_date: endDate('2020-01-01') });
        expect(hasCampaignEndedForTenant(c, at('2026-09-28T12:00:00Z'))).toBe(false);
    });

    it('an unresolvable IANA zone → not ended', () => {
        const c = campaign({ business_timezone: 'Mars/Olympus', end_date: endDate('2020-01-01') });
        expect(hasCampaignEndedForTenant(c, at('2026-09-28T12:00:00Z'))).toBe(false);
    });

    it('no end_date at all → never "ended" by this rule', () => {
        const c = campaign({ end_date: null });
        expect(hasCampaignEndedForTenant(c, at('2099-01-01T00:00:00Z'))).toBe(false);
    });

    it('DELIBERATE CONTRAST: isCampaignPastOrderDeadline fails the OPPOSITE way (toward blocking orders)', () => {
        // Same unusable zone, same call shape — the money-protecting helper
        // and the attention-protecting helper must disagree on purpose.
        expect(isCampaignPastOrderDeadline({ end_date: endDate('2099-01-01') }, 'Mars/Olympus', at('2026-09-28T12:00:00Z')))
            .toBe(true);
        expect(hasCampaignEndedForTenant(
            { end_date: endDate('2099-01-01'), business_timezone: 'Mars/Olympus' },
            at('2026-09-28T12:00:00Z'),
        )).toBe(false);
    });
});

// ── E. hasEndedWithHeldOrders — timing of the escalation ────────────────────

describe('hasEndedWithHeldOrders — only escalates once truly ended AND orders are held', () => {
    it('not ended yet, held orders waiting → false', () => {
        const c = campaign({ held_order_count: 3 });
        expect(hasEndedWithHeldOrders(c, at('2026-09-29T03:00:00Z'))).toBe(false); // 10pm Central evening before
    });

    it('ended, but nothing held → false', () => {
        const c = campaign({ held_order_count: 0 });
        expect(hasEndedWithHeldOrders(c, at('2026-10-02T12:00:00Z'))).toBe(false);
    });

    it('ended AND held orders waiting → true', () => {
        const c = campaign({ held_order_count: 2 });
        expect(hasEndedWithHeldOrders(c, at('2026-10-02T12:00:00Z'))).toBe(true);
    });

    it('flips true at the exact local-midnight boundary, not before', () => {
        const c = campaign({ held_order_count: 1 });
        expect(hasEndedWithHeldOrders(c, at('2026-09-30T04:59:59Z'))).toBe(false);
        expect(hasEndedWithHeldOrders(c, at('2026-09-30T05:00:00Z'))).toBe(true);
    });

    it('a closed-family campaign never escalates, even ended with held orders', () => {
        const c = campaign({ held_order_count: 5, status: 'Closed', closed_at: new Date('2026-09-30T06:00:00Z') });
        expect(hasEndedWithHeldOrders(c, at('2026-10-02T12:00:00Z'))).toBe(false);
    });

    it('a non-Active status (e.g. Lead) never escalates', () => {
        const c = campaign({ held_order_count: 5, status: 'Lead' });
        expect(hasEndedWithHeldOrders(c, at('2026-10-02T12:00:00Z'))).toBe(false);
    });
});

// ── F. The CRM row's Ends → Ended transition (drawer lifecycle + date line) ─

describe('detailLifecycle / detailDateLine — the Ends → Ended transition', () => {
    it('reads "active" / "Ends Sep 29, 2026" at 10pm Central the evening before — NOT the old false "Ended"', () => {
        const c = campaign();
        const now = at('2026-09-29T03:00:00Z');
        expect(detailLifecycle(c, now)).toBe('active');
        expect(detailDateLine(c, now)).toBe('Ends Sep 29, 2026');
    });

    it('still reads "active" / "Ends" through the last second of the deadline day', () => {
        const c = campaign();
        const now = at('2026-09-30T04:59:59Z');
        expect(detailLifecycle(c, now)).toBe('active');
        expect(detailDateLine(c, now)).toBe('Ends Sep 29, 2026');
    });

    it('flips to "ended_open" / "Ended Sep 29, 2026" once the deadline day has fully passed', () => {
        const c = campaign();
        const now = at('2026-09-30T05:00:00Z');
        expect(detailLifecycle(c, now)).toBe('ended_open');
        expect(detailDateLine(c, now)).toBe('Ended Sep 29, 2026');
    });

    it('a closed-family campaign is "completed", regardless of the deadline math', () => {
        const c = campaign({ status: 'Completed' });
        expect(detailLifecycle(c, at('2026-10-02T12:00:00Z'))).toBe('completed');
    });
});

// ── Source-scan: the three named sites delegate, none re-derive the logic ───

describe('the three fix sites delegate to the shared helper — no duplicated date logic', () => {
    it('components/crm2/CampaignPriorityList.tsx uses hasCampaignEndedForTenant, not a raw getTime() comparison', () => {
        const src = code(read('components/crm2/CampaignPriorityList.tsx'));
        expect(src).toContain('hasCampaignEndedForTenant');
        expect(src).not.toMatch(/end[!.]?\.getTime\(\)\s*<\s*now\.getTime\(\)/);
    });

    it('lib/growth/nextAction.ts\'s hasEndedWithHeldOrders delegates, with no independent getTime() comparison', () => {
        const src = code(read('lib/growth/nextAction.ts'));
        expect(src).toContain('hasCampaignEndedForTenant');
        const fn = src.slice(src.indexOf('export function hasEndedWithHeldOrders'));
        expect(fn.slice(0, fn.indexOf('\n\n'))).not.toMatch(/getTime\(\)/);
    });

    it('lib/growth/campaignContextUi.ts uses the helper for BOTH lifecycle and the date line', () => {
        const src = code(read('lib/growth/campaignContextUi.ts'));
        const lifecycleFn = src.slice(src.indexOf('export function detailLifecycle'), src.indexOf('export function detailLifecycle') + 600);
        const dateLineFn = src.slice(src.indexOf('export function detailDateLine'));
        expect(lifecycleFn).toContain('hasCampaignEndedForTenant');
        expect(dateLineFn).toContain('hasCampaignEndedForTenant');
        // The separate display-digits bug: must use the UTC-field formatter,
        // never a local-zone toLocaleDateString().
        expect(dateLineFn).toContain('formatCalendarDateShortValue');
        expect(dateLineFn).not.toContain('toLocaleDateString');
    });

    it('the shared helper lives in exactly one place', () => {
        const occurrences = [
            'lib/campaignBundleSelection.ts',
            'lib/growth/nextAction.ts',
            'lib/growth/campaignContextUi.ts',
            'components/crm2/CampaignPriorityList.tsx',
        ].filter((f) => code(read(f)).includes('export function hasCampaignEndedForTenant'));
        expect(occurrences).toEqual(['lib/campaignBundleSelection.ts']);
    });
});

// ── H. "On pace" is untouched, and coexists independently with "needs attention" ─

describe('"On pace" is unchanged and independent from the ended/held-orders escalation', () => {
    it('lib/growth/health.ts carries none of this task\'s changes', () => {
        const src = read('lib/growth/health.ts');
        expect(src).not.toContain('hasCampaignEndedForTenant');
        expect(src).not.toContain('business_timezone');
    });

    it('a running campaign with health on_pace, well before its deadline, triages to on_pace', () => {
        const c = campaign({ end_date: endDate('2099-01-01'), health: 'on_pace' });
        const t = triageCampaign(c, at('2026-09-28T12:00:00Z'));
        expect(t.priority).toBe('on_pace');
    });

    it('health stays "on_pace" on the row even once priority escalates to needs_attention', () => {
        // The exact coexistence the task calls out: GE-3's sales-pace verdict
        // (health) and the ended-with-held-orders escalation (priority) are
        // independent axes. triageCampaign never overwrites c.health.
        const c = campaign({ held_order_count: 4, health: 'on_pace' });
        const now = at('2026-10-02T12:00:00Z'); // fully past the deadline
        const t = triageCampaign(c, now);
        expect(t.priority).toBe('needs_attention');
        expect(c.health).toBe('on_pace'); // untouched input — not overwritten
    });

    it('at_risk health alone (before any deadline question) still triages needs_attention, as before', () => {
        const c = campaign({ end_date: endDate('2099-01-01'), health: 'at_risk' });
        const t = triageCampaign(c, at('2026-09-28T12:00:00Z'));
        expect(t.priority).toBe('needs_attention');
    });
});

// ── I. Timezone-independent DIGITS — only the Ends/Ended word depends on zone ─

describe('detailDateLine renders the same calendar digits regardless of business_timezone', () => {
    it.each([CHI, NYC, 'UTC', 'Pacific/Auckland'])('%s: end_date 2026-10-07 always reads "Oct 7, 2026"', (tz) => {
        const c = campaign({ end_date: endDate('2026-10-07'), business_timezone: tz });
        const line = detailDateLine(c, at('2026-09-01T00:00:00Z'));
        expect(line).toBe('Ends Oct 7, 2026');
    });
});

// ── Other real campaigns are protected automatically — no special-casing ────

describe('every campaign gets the same rule — no special-casing by name or id', () => {
    it.each([
        ['Shelby County', '2026-10-06'],
        ['Cumberland Co', '2026-10-07'],
        ['Jasper/Clark', '2026-10-12'],
    ])('%s (end_date %s, America/Chicago) follows the identical boundary', (_name, end) => {
        const c = campaign({ end_date: endDate(end) });
        const localMidnightNextDay = at(`${end}T05:00:00Z`).getTime() + 24 * 60 * 60 * 1000;
        // Still the deadline day itself: not ended.
        expect(hasCampaignEndedForTenant(c, new Date(localMidnightNextDay - 1000))).toBe(false);
        // One second into the next local day: ended.
        expect(hasCampaignEndedForTenant(c, new Date(localMidnightNextDay))).toBe(true);
    });

    it('no source file special-cases a campaign name or id', () => {
        for (const f of ['lib/campaignBundleSelection.ts', 'lib/growth/nextAction.ts', 'lib/growth/campaignContextUi.ts']) {
            const src = code(read(f));
            expect(src).not.toMatch(/Edgar|Shelby|Cumberland|Jasper|Clark/i);
        }
    });
});

// ── Edgar County Farm Bureau Fundraiser — the exact reported scenario ───────

describe('Edgar County Farm Bureau Fundraiser — the reported scenario, reproduced', () => {
    const edgar = campaign({ end_date: endDate('2026-09-29'), business_timezone: CHI, held_order_count: 0 });

    it('point 1 — evening before the deadline: not ended, "Ends"', () => {
        const now = at('2026-09-29T02:00:00Z'); // ~9pm Central Sep 28
        expect(hasCampaignEndedForTenant(edgar, now)).toBe(false);
        expect(detailDateLine(edgar, now)).toBe('Ends Sep 29, 2026');
        expect(triageCampaign(edgar, now).priority).not.toBe('needs_attention');
    });

    it('point 2 — during the deadline day itself: still not ended, "Ends"', () => {
        const now = at('2026-09-29T18:00:00Z'); // 1pm Central Sep 29
        expect(hasCampaignEndedForTenant(edgar, now)).toBe(false);
        expect(detailDateLine(edgar, now)).toBe('Ends Sep 29, 2026');
    });

    it('point 3 — after the deadline day has fully passed: ended, "Ended"', () => {
        const now = at('2026-09-30T12:00:00Z'); // well into Sep 30 Central
        expect(hasCampaignEndedForTenant(edgar, now)).toBe(true);
        expect(detailDateLine(edgar, now)).toBe('Ended Sep 29, 2026');
    });
});
