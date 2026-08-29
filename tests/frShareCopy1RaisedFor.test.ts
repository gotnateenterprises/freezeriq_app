/**
 * FR-SHARE-COPY-1 addendum — the coordinator portal's "raised for {org}" stat
 * was displaying gross fundraiser sales under a label that implies the
 * organization's actual take. It now shows totalSales × THIS campaign's
 * configured org_share_percent (INV-A), via the same authoritative helper
 * (lib/fundraiserOrgShare.organizationShareAmount) invoice/closeout math
 * already trusts — never a hardcoded 20%, never the pre-launch marketing
 * estimate (ESTIMATED_FUNDRAISER_ORG_SHARE), never tax.
 */
import fs from 'fs';
import path from 'path';
import { computeFundraiserProgress } from '../lib/fundraiserMetrics';
import { organizationShareAmount } from '../lib/fundraiserOrgShare';

const R = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PORTAL = 'app/coordinator/portal/page.tsx';
const METRICS = 'lib/fundraiserMetrics.ts';
const HERO = 'components/coordinator/ProgressHero.tsx';
const COORD_GET = 'app/api/coordinator/route.ts';

// ── PART J #1-2 — CORRECT CALCULATION AT DIFFERENT PERCENTAGES ─────────────
describe('FR-SHARE-COPY-1 addendum · raised amount = gross × THIS campaign\'s share', () => {
    it('1. $500 gross at 20% → $100 raised', () => {
        const r = computeFundraiserProgress(20, 500, [], 20);
        expect(r.raisedAmount).toBe(100);
        expect(r.totalSales).toBe(500); // 4. gross still available separately
    });

    it('2. $500 gross at 25% → $125 raised', () => {
        const r = computeFundraiserProgress(20, 500, [], 25);
        expect(r.raisedAmount).toBe(125);
    });

    it('11. two campaigns with different percentages calculate independently', () => {
        const a = computeFundraiserProgress(20, 500, [], 20);
        const b = computeFundraiserProgress(20, 500, [], 28);
        expect(a.raisedAmount).toBe(100);
        expect(b.raisedAmount).toBe(140);
        expect(a.raisedAmount).not.toBe(b.raisedAmount);
    });

    it('a non-round percentage (28.5%) still computes correctly, cents-rounded', () => {
        const r = computeFundraiserProgress(20, 500, [], 28.5);
        expect(r.raisedAmount).toBe(142.5);
    });

    it('13. zero sales → $0 raised, not an error or NaN', () => {
        const r = computeFundraiserProgress(20, 0, [], 20);
        expect(r.raisedAmount).toBe(0);
    });

    it('14. rounding uses the authoritative half-up-to-cents helper, not raw float math', () => {
        // A value that would show float drift under naive `x * pct / 100`.
        const r = computeFundraiserProgress(20, 33.33, [], 33.33);
        expect(r.raisedAmount).toBe(organizationShareAmount(33.33, 33.33));
        expect(Number.isFinite(r.raisedAmount)).toBe(true);
        // No more than 2 decimal places.
        expect(Math.round((r.raisedAmount as number) * 100)).toBe((r.raisedAmount as number) * 100);
    });

    it('5. "raised" never equals full gross unless the campaign share is legitimately 100%', () => {
        const partial = computeFundraiserProgress(20, 500, [], 20);
        expect(partial.raisedAmount).not.toBe(partial.totalSales);
        const full = computeFundraiserProgress(20, 500, [], 100);
        expect(full.raisedAmount).toBe(full.totalSales);
    });

    it('callers that omit orgSharePercent get null, never a fabricated number (backward-compatible)', () => {
        const r = computeFundraiserProgress(20, 500, []);
        expect(r.raisedAmount).toBeNull();
        // estimatedEarnings (the pre-launch marketing guess) is untouched —
        // this addendum adds raisedAmount, it does not repurpose or remove it.
        expect(r.estimatedEarnings).toBe(100); // 500 * ESTIMATED_FUNDRAISER_ORG_SHARE (0.2), unrelated constant
    });
});

// ── PART J #3, #8 — NO HARDCODED 20%, NO TENANT DEFAULT OVERRIDE ───────────
describe('FR-SHARE-COPY-1 addendum · the campaign\'s own percentage is used, never a hardcoded/default one', () => {
    it('3. the raised-amount formula does not hardcode 20 anywhere', () => {
        const metrics = strip(R(METRICS));
        const raisedBlock = metrics.slice(metrics.indexOf('const raisedAmount ='), metrics.indexOf('return {', metrics.indexOf('const raisedAmount =')));
        expect(raisedBlock).not.toMatch(/\b20\b/);
        expect(raisedBlock).not.toMatch(/ESTIMATED_FUNDRAISER_ORG_SHARE/);
        expect(raisedBlock).toContain('organizationShareAmount(dollarSales, Number(orgSharePercent))');
    });

    it('7. the portal passes THIS campaign\'s own org_share_percent, not a constant', () => {
        const portal = strip(R(PORTAL));
        expect(portal).toContain('campaign.org_share_percent');
        // The metrics call reads it from the live campaign object, not a
        // literal number and not a business/tenant-level field.
        const i = portal.indexOf('computeFundraiserProgress(');
        const call = portal.slice(i, portal.indexOf(');', i) + 1);
        expect(call).toContain('campaign.org_share_percent');
        expect(call).not.toMatch(/,\s*20\s*\)/);
    });

    it('8. no tenant/business-level default percentage exists to override the campaign\'s own value', () => {
        // org_share_percent is a per-campaign column with no tenant-level
        // counterpart anywhere in the coordinator GET or the metrics call.
        const get = strip(R(COORD_GET));
        expect(get).not.toMatch(/business\.org_share_percent|tenant.*org_share|default_org_share/i);
    });

    it('the Settings component itself never receives a hardcoded percentage', () => {
        const hero = strip(R(HERO));
        expect(hero).not.toMatch(/organizationShareAmount\(/); // calculation stays in lib/, not the display component
    });
});

// ── PART J #4, #6 — GROSS STILL SHOWN, ORG NAME CORRECT ────────────────────
describe('FR-SHARE-COPY-1 addendum · gross sales still shown, organization name correct', () => {
    it('4. Total Sales remains a separate, visible stat', () => {
        const hero = strip(R(HERO));
        expect(hero).toContain('<Stat label="total sales" value={`$${totalSales.toFixed(0)}`} />');
    });

    it('the "raised for" stat\'s displayed VALUE binds to raisedAmount, never totalSales', () => {
        const hero = strip(R(HERO));
        const i = hero.indexOf('label={`raised for');
        const statTag = hero.slice(i, hero.indexOf('/>', i) + 2);
        expect(statTag).toContain('value={`$${raisedAmount.toFixed(0)}`}');
        expect(statTag).not.toContain('totalSales');
    });

    it('6. the "raised for" label uses the actual organization name (orgLabel), not a placeholder', () => {
        const hero = strip(R(HERO));
        expect(hero).toContain('label={`raised for ${orgLabel}`}');
        const portal = strip(R(PORTAL));
        expect(portal).toContain("orgLabel = campaign.customer?.name || 'your group'");
    });
});

// ── PART D / J #9 — TAX NEVER INFLATES RAISED ───────────────────────────────
describe('FR-SHARE-COPY-1 addendum · tax is never part of the raised amount', () => {
    it('9. the raised-amount call path never references tax fields', () => {
        const metrics = strip(R(METRICS));
        const raisedBlock = metrics.slice(metrics.indexOf('const raisedAmount ='), metrics.indexOf('return {', metrics.indexOf('const raisedAmount =')));
        expect(raisedBlock).not.toMatch(/tax/i);
        const orgShare = strip(R('lib/fundraiserOrgShare.ts'));
        const fnBlock = orgShare.slice(orgShare.indexOf('export function organizationShareAmount'), orgShare.indexOf('export function balanceDueToTenant'));
        expect(fnBlock).not.toMatch(/tax/i);
    });

    it('a taxable campaign\'s raised amount is unaffected by its tax snapshot', () => {
        // Same gross + same org share, presence of a hypothetical tax_rate_percent
        // elsewhere on the campaign object plays no role — the function signature
        // itself has no tax parameter to pass one through.
        const withoutTax = computeFundraiserProgress(20, 500, [], 20);
        expect(withoutTax.raisedAmount).toBe(100);
    });
});

// ── PART G/J #10 — SAME ELIGIBLE-ORDER POPULATION AS EXISTING METRICS ──────
describe('FR-SHARE-COPY-1 addendum · eligible-sales population matches existing fundraiser metrics', () => {
    it('10. raisedAmount derives from the SAME totalSales the progress bar already uses — no second order query', () => {
        const portal = strip(R(PORTAL));
        // Exactly one computeFundraiserProgress call feeds both totalSales and
        // raisedAmount from the same campaign.total_sales input.
        expect((portal.match(/computeFundraiserProgress\(/g) ?? []).length).toBe(1);
        expect(portal).toContain('campaign.total_sales');
    });
});

// ── PART I / J #12 — TENANT/CAMPAIGN SCOPE ──────────────────────────────────
describe('FR-SHARE-COPY-1 addendum · cross-campaign/cross-tenant isolation intact', () => {
    it('12. the coordinator GET specifically (not just some other handler in the file) is still session-scoped to exactly one campaign before any metric is computed', () => {
        const code = strip(R(COORD_GET));
        const start = code.indexOf('export async function GET(');
        const end = code.indexOf('export async function POST(');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const getHandler = code.slice(start, end);
        expect(getHandler).toContain('const guard = await requireCoordinatorSession(req);');
        expect(getHandler).toContain('const campaignId = guard.campaignId;');
        // The GET handler must not resolve its campaign from a URL/query param.
        expect(getHandler).not.toMatch(/searchParams\.get\(['"]campaignId['"]\)/);
    });
});

// ── PART K — MOBILE (no fixed widths, safe wrap, no overflow) ──────────────
describe('FR-SHARE-COPY-1 addendum · ProgressHero stat row is mobile-safe', () => {
    it('every stat can shrink (min-w-0) and the row can wrap as an escape valve', () => {
        const hero = strip(R(HERO));
        expect(hero).toContain('min-w-0 flex-1');
        expect(hero).toContain('flex flex-wrap gap-2');
    });

    it('no fixed pixel/rem width is introduced on the stat row or its children', () => {
        const hero = strip(R(HERO));
        expect(hero).not.toMatch(/\bw-\[\d/);
        expect(hero).not.toMatch(/\bmin-w-\[\d/);
    });

    it('the organization name wraps (break-words), it is never truncated with an ellipsis', () => {
        const hero = strip(R(HERO));
        const labelLine = hero.slice(hero.indexOf('<p className="break-words'), hero.indexOf('{label}') + 10);
        expect(labelLine).toContain('break-words');
        expect(labelLine).not.toContain('truncate');
        expect(labelLine).not.toContain('text-ellipsis');
    });
});
