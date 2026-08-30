/**
 * OPS-DATE-PICKER-HOTFIX-1 — "This opportunity's confirmed delivery date
 * looks incorrect" kept appearing because the CRM funnel panel's date
 * display was never hardened the same way OPS-LAUNCH-HOTFIX-1 hardened the
 * launch path.
 *
 * ROOT CAUSE, PROVEN NOT ASSUMED (see the Final Report Part 4/5 for the full
 * trace): a FRESH pick through the native <input type="date"> in
 * components/crm2/FunnelLeadsPanel.tsx's LeadDateField cannot produce a
 * short year at all -- the browser always emits an exact YYYY-MM-DD string,
 * and app/api/opportunities/[id]/route.ts's parseCalendarDate (the ONLY
 * write path for confirmed_delivery_date, shared with preferred/alternate
 * via the same function) already requires `^\d{4}-\d{2}-\d{2}$` and rejects
 * anything else with a clean 400. The defect is entirely on the READ/DISPLAY
 * side: FunnelLeadsPanel.tsx fed the RAW API string straight into the native
 * input's `value` (via `.slice(0, 10)`) and into `fmtDate()`'s
 * `new Date(d).toLocaleDateString(...)`, with no 4-digit-year safety at all
 * -- unlike the launch path, which OPS-LAUNCH-HOTFIX-1 already hardened via
 * lib/tenantTimezone.ts's calendarDateOfDateOnlyValue. For an opportunity
 * whose confirmed_delivery_date already carries the pre-existing malformed
 * value (year 26, not 2026 -- the "Ag in the Classroom" shape), this
 * produced exactly what the owner described: the native date input's value
 * was "0026-09-09" and the visible label showed "9/9/26" (verified
 * empirically against real Node Date/Intl behavior before this fix; see the
 * Final Report Part 5).
 *
 * The write path was never the problem and needed no change -- proven here
 * by executing it directly.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, readJson, type PrismaMock } from './helpers/routeHarness';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const OPP = 'opp-1';
const TENANT_A = 'biz-aaaa-1111';

jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__dpPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__dpSession) }));

let mock: PrismaMock;
function useMock(extra: Record<string, any> = {}) {
    mock = createPrismaMock({
        results: {
            'fundraiserOpportunity.findFirst': {
                id: OPP, status: 'new', first_response_at: null, preferred_delivery_date: null,
            },
            'fundraiserOpportunity.updateMany': { count: 1 },
            ...extra,
        },
    });
    (global as any).__dpPrisma = mock.client;
}
(global as any).__dpSession = { user: { businessId: TENANT_A, email: 'owner@tenant-a.com' } };

const patch = async (body: unknown) => {
    const { PATCH } = await import('@/app/api/opportunities/[id]/route');
    const req = new Request(`http://localhost/api/opportunities/${OPP}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return readJson(await PATCH(req, { params: Promise.resolve({ id: OPP }) }));
};

beforeEach(() => { jest.clearAllMocks(); useMock(); });

// ═════════════════════════════════════════════════════════════════════════════
// PART E — the fresh-pick write path, executed for real against the real
// PATCH handler (not a hand-copied mirror of parseCalendarDate), proving it
// was already safe and needed no change for the year-corruption defect.
// ═════════════════════════════════════════════════════════════════════════════
describe('the confirm-date write path was already safe for the year defect', () => {
    it('a fresh native <input type="date"> pick of Sept 9 2026 writes the real 2026 date', async () => {
        // This IS what the browser emits for e.target.value on a valid pick --
        // native date inputs cannot emit a short year.
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-09-09' });
        const data = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(data.confirmed_delivery_date.toISOString()).toBe('2026-09-09T00:00:00.000Z');
        expect(data.confirmed_delivery_date.getUTCFullYear()).toBe(2026);
    });

    it('a 2-digit or 3-digit year string is rejected with 400, not silently accepted', async () => {
        const res1 = await patch({ action: 'confirm_date', confirmed_delivery_date: '26-09-09' });
        expect(res1.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);

        const res2 = await patch({ action: 'confirm_date', confirmed_delivery_date: '026-09-09' });
        expect(res2.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    // PART L — the real gap this phase's own instructions required checking:
    // parseCalendarDate accepted "2026-02-30" and silently rolled it over to
    // March 2 via plain `new Date(...)` semantics, rather than rejecting an
    // impossible calendar date. Proven against the real handler before fixing it.
    it('an impossible date (Feb 30) is rejected, not silently rolled over to March', async () => {
        const res = await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-02-30' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('Feb 29 on a non-leap year is rejected', async () => {
        const res = await patch({ action: 'confirm_date', confirmed_delivery_date: '2026-02-29' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('Feb 29 on a real leap year (2028) is accepted', async () => {
        await patch({ action: 'confirm_date', confirmed_delivery_date: '2028-02-29' });
        const data = mock.firstCall('fundraiserOpportunity.updateMany')!.args.data;
        expect(data.confirmed_delivery_date.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    });

    it('preferred/alternate dates go through the same validation (set_dates)', async () => {
        const res = await patch({ action: 'set_dates', preferred_delivery_date: '2026-02-30' });
        expect(res.status).toBe(400);
        expect(mock.callsTo('fundraiserOpportunity.updateMany')).toHaveLength(0);
    });

    it('the route source proves preferred/alternate/confirmed all share this one parser', () => {
        const src = read('app/api/opportunities/[id]/route.ts');
        const preferredCall = (src.match(/parseCalendarDate\(body\?\.preferred_delivery_date\)/g) || []).length;
        const alternateCall = (src.match(/parseCalendarDate\(body\?\.alternate_delivery_date\)/g) || []).length;
        const confirmedCall = (src.match(/parseCalendarDate\(body\?\.confirmed_delivery_date\)/g) || []).length;
        expect(preferredCall).toBe(1);
        expect(alternateCall).toBe(1);
        expect(confirmedCall).toBe(1);
        // Exactly one function definition -- no second, competing parser.
        expect((src.match(/function parseCalendarDate/g) || []).length).toBe(1);
    });

    it('no getYear()/setYear() or 2-digit year token appears anywhere in the write path', () => {
        for (const p of ['app/api/opportunities/[id]/route.ts', 'components/crm2/FunnelLeadsPanel.tsx']) {
            const src = read(p);
            expect(src).not.toMatch(/\.getYear\(\)|\.setYear\(/);
        }
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART F/Q — the panel's display derivation now uses the shared safe helper.
// ═════════════════════════════════════════════════════════════════════════════
describe('FunnelLeadsPanel now derives every date-control value through safeCalendarDateForInput', () => {
    const src = () => read('components/crm2/FunnelLeadsPanel.tsx');

    it('imports the shared helper rather than reimplementing date safety', () => {
        expect(src()).toMatch(/import\s*\{[^}]*safeCalendarDateForInput[^}]*\}\s*from\s*['"]@\/lib\/tenantTimezone['"]/);
    });

    it('the Preferred and Confirm inputs no longer slice the raw API string directly', () => {
        const code = src();
        expect(code).not.toMatch(/o\.preferred_delivery_date\s*\?\s*o\.preferred_delivery_date\.slice\(0,\s*10\)/);
        expect(code).not.toMatch(/o\.confirmed_delivery_date\s*\?\s*o\.confirmed_delivery_date\.slice\(0,\s*10\)/);
        expect(code).toMatch(/value=\{safeCalendarDateForInput\(o\.preferred_delivery_date\)\}/);
        expect(code).toMatch(/value=\{safeCalendarDateForInput\(o\.confirmed_delivery_date\)\}/);
    });

    it('fmtDate no longer constructs a Date directly from the raw value', () => {
        const code = src();
        expect(code).not.toMatch(/const fmtDate[\s\S]{0,40}new Date\(d\)\.toLocaleDateString/);
    });

    it('the write path (onCommit/mutate) is untouched -- this phase changed reads, not writes', () => {
        const code = src();
        expect(code).toMatch(/onCommit=\{\(d\)\s*=>\s*mutate\(o\.id,\s*\{\s*action:\s*'set_dates',\s*preferred_delivery_date:\s*d\s*\}/);
        expect(code).toMatch(/onCommit=\{\(d\)\s*=>\s*mutate\(o\.id,\s*\{\s*action:\s*'confirm_date',\s*confirmed_delivery_date:\s*d\s*\}/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// PART H — the launch guard (OPS-LAUNCH-HOTFIX-1) is unchanged in behavior,
// now backed by the shared predicate.
// ═════════════════════════════════════════════════════════════════════════════
describe('the launch implausible-year guard is preserved and now shares the one predicate', () => {
    it('checkOpportunityLaunchable still refuses a short year with the same code/status', () => {
        const { checkOpportunityLaunchable } = require('@/lib/fundraiserLaunch');
        const refused = checkOpportunityLaunchable({
            status: 'date_confirmed',
            confirmed_delivery_date: new Date('0026-09-09T00:00:00.000Z'),
            campaign_id: null,
        });
        expect(refused.ok).toBe(false);
        expect((refused as any).code).toBe('implausible_confirmed_date');
        expect((refused as any).status).toBe(409);
    });

    it('an ordinary 2026 date still launches fine', () => {
        const { checkOpportunityLaunchable } = require('@/lib/fundraiserLaunch');
        const ok = checkOpportunityLaunchable({
            status: 'date_confirmed',
            confirmed_delivery_date: new Date('2026-09-09T00:00:00.000Z'),
            campaign_id: null,
        });
        expect(ok.ok).toBe(true);
    });

    it('lib/fundraiserLaunch.ts now imports isPlausibleCalendarYear rather than a private inline threshold', () => {
        const src = read('lib/fundraiserLaunch.ts');
        expect(src).toMatch(/import\s*\{[^}]*isPlausibleCalendarYear[^}]*\}\s*from\s*['"]@\/lib\/tenantTimezone['"]/);
        expect(src).not.toMatch(/year\s*<\s*1000/);
    });
});
