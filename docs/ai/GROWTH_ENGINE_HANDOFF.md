# Growth Engine — Implementation Handoff (exact code)

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §6 + §6.1 — spec wins on any conflict.
**Approved look:** `docs/ai/prototypes/crm_prototype.html` (Growth Engine tab + wizard Step 2) — open in a browser and match it whenever layout/copy is ambiguous.
**PREREQUISITE GATE:** CRM-1..4 (`docs/ai/CRM_REDESIGN_HANDOFF.md`) must be merged first — the Growth tab and wizard prefill land inside those components. Verify before starting; stop and report if not merged.
**Phases:** GE-1 → GE-2 → GE-3 → GE-4 → GE-5 → GE-6..9. Each phase = its own reviewable diff.

## HARD RULES

1. Allowed new locations: `app/api/growth/**`, `app/api/cron/growth/route.ts`, `app/api/public/fundraiser-lead/route.ts`, `components/crm2/growth/**`, `lib/growth/**`, `vercel.json` (cron entry only). Allowed edits: the CRM-2 org profile and CRM-1 dashboard (adding Growth surfaces), `app/fundraiser/[token]/ScoreboardClient.tsx` (GE-6 leaderboard + GE-2 CTA only), wizard Step 2/3 (GE-6 toggle, GE-9 goal math).
2. NEVER touch: `app/api/coordinator/**`, `app/api/checkout/**`, `app/api/webhooks/**`, `app/api/stripe/**`, `middleware.ts`, `auth.ts`, `auth.config.ts`, `lib/pricing.ts`, `lib/kitchen_engine.ts`, RecipeEditor/BundleEditor. `lib/serving_multipliers.ts` and `lib/fundraiserMetrics.ts` are **read-only imports** — never edit them.
3. Every `/api/growth/**` route: session auth + `business_id` scoping in the query itself (`where: { customer: { business_id } }` pattern). The public lead route derives tenant from slug/token only.
4. No email auto-sends without the per-tenant toggle check (GE-5). No emails to fundraiser buyers ever. No Stripe/Square anywhere.
5. Schema: ZERO additions except the two flagged below (`GrowthLog`, `Business.growth_settings`) — both proposal-first: generate the diff, stop for approval.

---

## Shared: `lib/growth/math.ts` (build first — everything imports it)

```ts
/**
 * Growth Engine business math — SPEC §6.1 GE-9 (locked decisions).
 * Pricing itself NEVER changes here; this is goal/expectation math only.
 */
import { getServingMultiplier } from '@/lib/serving_multipliers';

/** Org keeps 20% of gross sales — mirrors lib/fundraiserMetrics.ts (authoritative). */
export const ORG_SHARE = 0.2;

/** Delivery-worthiness floor: $1,250 sales = 10 serves-5 equivalent sets. */
export const MIN_CAMPAIGN_SALES = 1250;
export const MIN_EQUIVALENT_SETS = 10;

/** What the ORG earns from gross sales — the only "raised for your group" number we show. */
export function orgShare(grossSales: number): number {
    return grossSales * ORG_SHARE;
}

/**
 * Serves-5 equivalent units for a set of order items.
 * serves_2 counts as 0.5 (LOCKED multiplier) so goals can't be met with half-size bundles.
 * Item shape matches existing OrderItem rows: { quantity, variant_size }.
 */
export function equivalentSets(items: Array<{ quantity: number; variant_size?: string | null }>): number {
    return items.reduce((sum, it) =>
        sum + Number(it.quantity || 0) * getServingMultiplier(it.variant_size ?? 'serves_5'), 0);
}

/** Rebook ask: last result +10%, rounded to a friendly $50, never below the minimum. */
export function suggestedRebookAsk(lastGrossSales: number): number {
    return Math.max(Math.round((lastGrossSales * 1.1) / 50) * 50, MIN_CAMPAIGN_SALES);
}

/** New-org goal suggestion in serves-5 equivalent BUNDLES, from tenant's own history. */
export function suggestedBundleGoal(tenantAvgGrossSales: number | null): number {
    const target = Math.max(tenantAvgGrossSales ?? MIN_CAMPAIGN_SALES, MIN_CAMPAIGN_SALES);
    return Math.max(Math.ceil(target / 125), MIN_EQUIVALENT_SETS); // $125 = one serves-5 set
}

export function isBelowMinimum(grossSales: number): boolean {
    return grossSales < MIN_CAMPAIGN_SALES;
}
```

**Wizard warning copy (GE-9.3):** when an entered/suggested goal × $125 < `MIN_CAMPAIGN_SALES`: `⚠ Below your delivery minimum ($1,250 / 10 full sets) — small campaigns may not cover delivery costs.` Amber banner, non-blocking.

**Display rule everywhere:** `Your group keeps ~$X` = `orgShare(gross)`. Never present gross sales as "raised for the org."

---

## GE-1 — Rebook pipeline

### `app/api/growth/rebook/route.ts`

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { suggestedRebookAsk, orgShare } from '@/lib/growth/math';

export async function GET() {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const businessId = session.user.businessId;

    const now = Date.now();
    const mo = 30 * 864e5;
    // Closed 6–12 months ago, tenant-scoped in the query itself
    const closed = await prisma.fundraiserCampaign.findMany({
        where: {
            customer: { business_id: businessId },
            closed_at: { gte: new Date(now - 12 * mo), lte: new Date(now - 6 * mo) },
        },
        select: {
            id: true, name: true, closed_at: true, settlement_total: true, customer_id: true,
            customer: { select: { id: true, name: true, contact_name: true, contact_email: true } },
        },
        orderBy: { closed_at: 'asc' },
    });

    // Exclude orgs that already have a newer campaign
    const rows = [];
    for (const c of closed) {
        const newer = await prisma.fundraiserCampaign.count({
            where: { customer_id: c.customer_id, created_at: { gt: c.closed_at! } },
        });
        if (newer > 0) continue;
        const last = Number(c.settlement_total || 0);
        rows.push({
            customer_id: c.customer_id,
            org_name: c.customer.name,
            coordinator: c.customer.contact_name,
            last_campaign: c.name,
            last_closed_at: c.closed_at,
            last_gross: last,
            last_org_share: orgShare(last),          // what THEY earned — show this
            suggested_ask: suggestedRebookAsk(last), // gross target
            suggested_org_share: orgShare(suggestedRebookAsk(last)),
        });
    }
    return NextResponse.json({ rebook: rows, pipeline_total: rows.reduce((s, r) => s + r.suggested_ask, 0) });
}
```

### `components/crm2/growth/RebookList.tsx` (complete)

```tsx
'use client';
import { useEffect, useState } from 'react';

export function RebookList({ onClone }: { onClone: (row: any) => void }) {
    const [data, setData] = useState<{ rebook: any[]; pipeline_total: number } | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
        fetch('/api/growth/rebook')
            .then(r => { if (!r.ok) throw new Error(); return r.json(); })
            .then(setData)
            .catch(() => setError(true));
    }, []);

    if (error) return null;
    if (!data) return <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-400 dark:border-slate-800 dark:bg-slate-900">Loading rebook pipeline…</div>;
    if (!data.rebook.length) return null;

    return (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h4 className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">
                🔁 Ready to rebook — ${data.pipeline_total.toLocaleString()} est. pipeline
            </h4>
            <p className="mb-1 mt-1 text-[11px] text-slate-500">
                Last campaign 6–12 months ago, nothing scheduled since. Ask = last result +10%.
            </p>
            {data.rebook.map(r => (
                <div key={r.customer_id}
                    className="grid grid-cols-[1fr_150px_150px_auto] items-center gap-3 border-t border-slate-100 py-2.5 dark:border-slate-800">
                    <span className="min-w-0">
                        <b className="block truncate text-[13px] text-slate-900 dark:text-white">{r.org_name}</b>
                        <span className="text-[11px] text-slate-400">
                            {r.last_campaign} · their group earned ${Math.round(r.last_org_share).toLocaleString()}
                        </span>
                    </span>
                    <span className="text-xs text-slate-500">
                        Closed {new Date(r.last_closed_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </span>
                    <span className="text-xs">
                        <b className="tabular-nums text-slate-900 dark:text-white">Suggest ${r.suggested_ask.toLocaleString()}</b>
                        <span className="block text-[10px] text-slate-400">≈ ${Math.round(r.suggested_org_share)} for their group</span>
                    </span>
                    <button onClick={() => onClone(r)}
                        className="justify-self-end rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-[11px] font-bold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        Clone into wizard →
                    </button>
                </div>
            ))}
        </section>
    );
}
```

`onClone(r)` opens the CRM-4 wizard with the org preselected (skip Step 1) and Step 2 prefilled: name = `${r.org_name} ${seasonLabel} ${year}`, goal = `Math.ceil(r.suggested_ask / 125)`, bundles = GE-10 suggestions with `customerId=r.customer_id`.

### `app/fundraisers/growth/page.tsx` — Growth tab layout (complete shell)

```tsx
'use client';
import { RebookList } from '@/components/crm2/growth/RebookList';
import { LeadsInbox } from '@/components/crm2/growth/LeadsInbox';      // GE-2: same list pattern as RebookList
import { AtRiskCard } from '@/components/crm2/growth/AtRiskCard';      // GE-3: card w/ reasons + 3 action buttons
import { AutomationsCard } from '@/components/crm2/growth/AutomationsCard'; // GE-5: toggles ↔ growth settings

export default function GrowthPage() {
    return (
        <div className="mx-auto max-w-6xl space-y-4 p-6">
            <header>
                <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">Growth Engine</h1>
                <p className="text-xs text-slate-500">Turn finished fundraisers into next season's pipeline — automatically.</p>
            </header>
            <div className="grid items-start gap-4 lg:grid-cols-[1.6fr_1fr]">
                <div className="space-y-4">
                    <RebookList onClone={(r) => {/* open wizard, see above */}} />
                    <LeadsInbox />
                </div>
                <div className="space-y-4">
                    <AtRiskCard />
                    <AutomationsCard />
                </div>
            </div>
        </div>
    );
}
```

`LeadsInbox`, `AtRiskCard`, `AutomationsCard` follow the exact same section pattern as `RebookList` (same card classes, same header style — copy it); their data endpoints and contents are specified in GE-2/GE-3/GE-5 above. Nav entry: add "Growth Engine" to the Fundraisers section of `components/Sidebar.tsx` (one nav item, no restructuring).

---

## GE-2 — Inbound lead capture

### `app/api/public/fundraiser-lead/route.ts` (public, token-scoped — NO session)

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const { public_token, group_name, contact_name, contact_email, message } = await req.json();
        if (!public_token || !group_name || !contact_email) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }
        // Tenant derived from the token — never from client input
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { public_token },
            select: { id: true, customer: { select: { business_id: true } } },
        });
        if (!campaign) return NextResponse.json({ error: 'Not found' }, { status: 404 });

        // READ prisma/schema.prisma model BusinessLead first and map to its ACTUAL fields.
        // Expected shape (verify): business_id, name/org fields, email, source, notes/message.
        await prisma.businessLead.create({
            data: {
                business_id: campaign.customer.business_id,
                // map: group_name, contact_name, contact_email, message,
                source: `fundraiser_scoreboard:${campaign.id}`,
            } as any, // remove cast once fields are confirmed against the real model
        });
        return NextResponse.json({ success: true });
    } catch (e) {
        console.error('[fundraiser-lead]', e);
        return NextResponse.json({ error: 'Failed to submit' }, { status: 500 });
    }
}
```

Basic abuse guard: reject if `message`/names exceed 500 chars; optionally add a honeypot field.

### Scoreboard CTA (in `ScoreboardClient.tsx`, below the share buttons)

```tsx
<div className="rounded-3xl border border-indigo-100 bg-indigo-50 p-6 text-center">
    <p className="text-sm font-black text-indigo-900">Could YOUR group use a fundraiser like this?</p>
    <p className="mt-1 text-xs text-indigo-700">Teams, classrooms, troops, boosters — groups keep 20% of every sale.</p>
    <button onClick={() => setShowLeadForm(true)}
        className="mt-3 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-extrabold text-white">
        Tell me more</button>
</div>
```

Modal form: group name, your name, email, optional message → POST above → "Thanks — {tenantName} will reach out!" Same CTA (smaller) on the storefront order-success screen is allowed ONLY as additive JSX on the success state — no checkout logic changes.

### Leads inbox: `app/api/growth/leads/route.ts` — session-scoped GET of `businessLead` where `business_id` matches, `source` starts with `fundraiser_`; render as a card list on the Growth tab with "Start in wizard →" (prefills Step 1 org fields from the lead).

---

## GE-3 — Campaign health flag

### `lib/growth/health.ts`

```ts
import { equivalentSets, MIN_CAMPAIGN_SALES } from '@/lib/growth/math';

export type Health = 'on_pace' | 'at_risk' | 'no_signal' | 'n/a';

export function campaignHealth(c: {
    status: string; closed_at?: Date | null; end_date?: Date | null; created_at: Date;
    gross_sales: number; goal_gross: number;           // goal_gross = bundle_goal * 125 or goal_amount
    last_order_at?: Date | null; engagement_count: number; // CoordinatorActionEvent count
}): { health: Health; reasons: string[] } {
    if (c.closed_at || c.status !== 'Active' || !c.end_date) return { health: 'n/a', reasons: [] };
    const now = Date.now();
    const total = c.end_date.getTime() - c.created_at.getTime();
    const elapsed = Math.max(now - c.created_at.getTime(), 0);
    const expected = c.goal_gross * Math.min(elapsed / Math.max(total, 1), 1);
    const daysLeft = (c.end_date.getTime() - now) / 864e5;
    const daysSinceOrder = c.last_order_at ? (now - c.last_order_at.getTime()) / 864e5 : Infinity;

    const reasons: string[] = [];
    if (c.gross_sales === 0 && elapsed > 3 * 864e5) reasons.push('no orders yet');
    if (c.gross_sales < expected * 0.5) reasons.push('under 50% of expected pace');
    if (daysSinceOrder > 7) reasons.push('no orders in 7+ days');
    if (c.engagement_count === 0 && elapsed > 3 * 864e5) reasons.push('coordinator has not shared');
    if (daysLeft < 10 && c.gross_sales < MIN_CAMPAIGN_SALES) reasons.push('trending below $1,250 delivery minimum');

    if (reasons.length >= 2) return { health: 'at_risk', reasons };
    if (c.gross_sales > 0) return { health: 'on_pace', reasons: [] };
    return { health: 'no_signal', reasons };
}
```

> **CB hook (spec §8.7):** once Coordinator Bundle Selection lands, add to the inputs
> `bundle_selection_status`/`bundle_selection_at` and an immediate at_risk reason when
> `pending` is older than 5 days: `'coordinator hasn't chosen bundles — ordering is locked'`.
> The GE-5 cron's at-risk sweep then nudges coordinator + tenant automatically.

Integration: compute in the existing `/api/campaigns` GET (it already loads orders per campaign; add a lightweight `CoordinatorActionEvent` count per campaign) and attach `health`/`health_reasons` to each row. Dashboard rows render `⚠ at risk` (red) / `on pace` (emerald) inline; AttentionStrip adds the at-risk item; the Growth tab at-risk card lists `reasons` with the three actions (boost message → existing AI generator; log check-in → existing notes/activity; extend end date → existing campaign PATCH).

---

## GE-4 — Impact report + lifetime value

- `app/api/growth/impact-report/[campaignId]/route.ts` — session + ownership check (same pattern as closeout route), then build PDF using the same lib the flyer uses (`jspdf`, mirror `lib/generateFlyer.ts` structure — read it first). Content: org name, campaign name, `Raised for your group: $orgShare(settlement_total)` (headline number), gross sales (secondary), N orders, N equivalent sets (`equivalentSets` over the campaign's order items), date range, tenant branding, testimonial ask line with a mailto/review link. Button lives on the closed `CampaignCard` (CRM handoff already has the slot).
- Lifetime value: in the org profile fetch, aggregate `SUM(settlement_total)` over the customer's closed campaigns → header shows `Lifetime raised for them: $orgShare(sum)` + `Lifetime sales: $sum`.

---

## GE-5 — Automation layer (cron)

### `vercel.json` (add crons entry only — do not touch other config)

```json
{ "crons": [{ "path": "/api/cron/growth", "schedule": "0 13 * * *" }] }
```

(Daily 13:00 UTC ≈ 8am ET. Railway equivalent: scheduled job hitting the same path.)

### `app/api/cron/growth/route.ts` (skeleton — jobs check their own calendars)

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request) {
    // 1. Auth: shared-secret header, fail closed
    if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const results: Record<string, any> = {};
    // 2. Iterate tenants with growth automations enabled
    const businesses = await prisma.business.findMany({ select: { id: true /*, growth_settings */ } });
    for (const b of businesses) {
        const settings = getGrowthSettings(b); // defaults: digest ON, at_risk_alert ON, everything outbound OFF
        if (settings.weekly_digest && isMonday()) results[`digest:${b.id}`] = await runOnce(b.id, 'digest', weekKey(), () => sendWeeklyDigest(b.id));
        if (settings.at_risk_alert)              results[`risk:${b.id}`]   = await runAtRiskSweep(b.id);
        if (settings.rebook_nudge)               results[`rebook:${b.id}`] = await runRebookNudges(b.id);
        if (settings.goal_celebration)           results[`goal:${b.id}`]   = await runGoalCelebrations(b.id);
        if (settings.winback)                    results[`winback:${b.id}`]= await runWinback(b.id);
        if (settings.season_kickoff)             results[`season:${b.id}`] = await runSeasonKickoff(b.id);
    }
    return NextResponse.json({ ok: true, results });
}
```

**Idempotency (`runOnce`):** before sending, check a sent-log keyed `(business_id, job, entity_id, period_key)`; skip if present, write after send. Storage: use the existing `Activity` model if its fields fit (read it first); if not, add the ONE allowed table — `GrowthLog { id, business_id, job, entity_id, period_key, sent_at }` with a unique compound index — **proposal-first schema diff, stop for approval**.

**Jobs (each is a small function using `lib/email.ts` `getTenantSender` + `sendEmail`, tenant-branded post-FIX-3):**
- `sendWeeklyDigest` — to the TENANT: active campaigns w/ health, week's sales, rebook-ready count, leads count. Period key = ISO week.
- `runAtRiskSweep` — campaigns newly `at_risk` (GE-3) → alert the TENANT (not the coordinator). Period key = campaign id + 'at_risk' (once per campaign per week).
- `runRebookNudges` — orgs newly entering the 6–12mo window → email the COORDINATOR (only if `settings.rebook_nudge` — default OFF) with last result (org-share framing) + booking link. Once per org per season.
- `runGoalCelebrations` — active campaigns crossing 50%/100% of goal since last run → congratulate the COORDINATOR w/ scoreboard share prompt (default OFF). Detect via current gross vs thresholds + sent-log. **This runs from cron — NEVER from order-creation routes.**
- `runWinback` — People customers with no order in 6 months → We-Miss-You template (shared post-FIX-3 helper; default OFF). Once per customer per 6 months.
- `runSeasonKickoff` (GE-7) — send-date table:

```ts
const SEASON_BLASTS = [
    { key: 'fall',   sendMonth: 8, sendDay: 1,  copy: 'fall' },    // Aug 1 → fall season
    { key: 'winter', sendMonth: 10, sendDay: 15, copy: 'winter' }, // Oct 15 → winter season
    { key: 'spring', sendMonth: 0, sendDay: 6,  copy: 'spring' },  // Jan 6 → spring season
    { key: 'summer', sendMonth: 4, sendDay: 1,  copy: 'summer_incentive' }, // May 1 — slow-season offer
];
```

Fall/winter/spring: to all past orgs — capacity scarcity copy ("we run a limited number of campaigns each season — reply to hold your week"). Summer: incentive framing with tenant-editable offer text stored in settings (`settings.summer_offer_text`, e.g. "book a summer campaign and your group keeps an extra 5%" — copy only; **profit-split math in the app does NOT change**). Period key = `${year}-${key}`.

**Settings storage:** read the codebase for an existing per-tenant settings JSON home; if none fits, add nullable `Business.growth_settings Json?` — the second allowed proposal-first schema diff. Settings UI: a simple toggles card on the Growth tab (matches the prototype's Automations card).

---

## GE-6 — Group leaderboard (toggleable)

- **Toggle:** `FundraiserCampaign.is_group_enabled` already exists. Surface it: (a) wizard Step 2 checkbox — "Show a team leaderboard on the public scoreboard" + optional `group_label`/`participant_label` inputs (fields exist); (b) same toggle in FundraisersTab campaign settings. Default OFF.
- **Aggregation:** in the scoreboard API (`app/api/fundraiser/[token]/route.ts`) — ONLY when `is_group_enabled`: group active orders by `participant_name` (verify on the Order model whether a group/team field exists; if only `participant_name`, the leaderboard is per-participant labeled with `participant_label`), sum `equivalentSets(items)` per participant, return top 10 as `leaderboard: [{ name, sets }]`. Mask names with the existing `maskName` helper.
- **Render** in `ScoreboardClient.tsx` (complete block — matches the page's existing rounded-card look):

```tsx
{campaign.is_group_enabled && (campaign.leaderboard?.length ?? 0) > 0 && (
    <div className="rounded-[2rem] border border-slate-200 bg-white p-8">
        <h3 className="mb-4 text-center text-xs font-black uppercase tracking-widest text-slate-400">
            🏆 Top {campaign.participant_label || 'Seller'}s
        </h3>
        <div className="space-y-2">
            {campaign.leaderboard.map((row: any, i: number) => (
                <div key={i}
                    className={`flex items-center gap-3 rounded-2xl border px-4 py-3 ${
                        i === 0 ? 'border-amber-200 bg-amber-50' : 'border-slate-100 bg-slate-50'}`}>
                    <span className="w-8 text-center text-lg">
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : <b className="text-xs text-slate-400">#{i + 1}</b>}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">{row.name}</span>
                    <span className="font-black tabular-nums text-indigo-600">
                        {row.sets % 1 === 0 ? row.sets : row.sets.toFixed(1)}
                        <span className="ml-1 text-[10px] font-semibold uppercase text-slate-400">sets</span>
                    </span>
                </div>
            ))}
        </div>
    </div>
)}
```

---

## GE-9 — Smart goal in wizard (math already in `lib/growth/math.ts`)

Wizard Step 2 additions: prefill goal via `suggestedBundleGoal(tenantAvg)` (tenant avg = mean gross of their closed campaigns; null for first-timers → minimum); helper line under the goal input: `≈ $X in sales · your group would keep ~$Y` (org-share framing); amber below-minimum warning per GE-9.3. Progress bars everywhere (dashboard, campaign cards, scoreboard) compute sets via `equivalentSets` — grep for any progress math dividing raw bundle counts and route it through the helper.

---

## GE-10 — Bundle auto-suggest in wizard Step 2

**SEASON-AWARE (spec §6.1 GE-10):** ranking is scoped to the campaign's season across ALL years, not a rolling 12 months.

### `lib/growth/seasons.ts`

```ts
export type Season = 'fall' | 'winter' | 'spring' | 'summer';

/** GE-7 season windows: Fall=Sep–Nov, Winter=Dec–Feb, Spring=Mar–May, Summer=Jun–Aug */
export function seasonOf(d: Date): Season {
    const m = d.getMonth(); // 0-based
    if (m >= 8 && m <= 10) return 'fall';
    if (m === 11 || m <= 1) return 'winter';
    if (m >= 2 && m <= 4) return 'spring';
    return 'summer';
}

export function inSeason(d: Date, s: Season): boolean {
    return seasonOf(d) === s;
}

export const SEASON_LABEL: Record<Season, string> = {
    fall: 'Fall', winter: 'Winter', spring: 'Spring', summer: 'Summer',
};
```

### `app/api/growth/bundle-suggestions/route.ts`

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { seasonOf, inSeason, SEASON_LABEL, type Season } from '@/lib/growth/seasons';

/**
 * GET /api/growth/bundle-suggestions?customerId=<optional>&campaignEnd=<ISO date, optional>
 * Season-aware ranking (spec GE-10):
 *   1. org + same season (any year)  2. tenant + same season (any year)
 *   3. overall all-time fallback     4. no history → plain list
 * Prisma can't filter by month directly → fetch item rows w/ order dates (3yr window)
 * and bucket in JS. Volumes are small (single tenant).
 */
export async function GET(req: Request) {
    const { auth } = await import('@/auth');
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const businessId = session.user.businessId;
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId');
    const campaignEnd = url.searchParams.get('campaignEnd');
    const season: Season = seasonOf(campaignEnd ? new Date(campaignEnd) : new Date());

    // One fetch, bucketed in JS — tenant-scoped in the query itself
    const items = await prisma.orderItem.findMany({
        where: {
            bundle_id: { not: null },
            order: {
                business_id: businessId, canceled_at: null,
                created_at: { gte: new Date(Date.now() - 3 * 365 * 864e5) }, // 3 years of seasons
            },
        },
        select: {
            bundle_id: true, quantity: true,
            order: { select: { created_at: true, source: true, customer_id: true } },
        },
    });

    const tally = (rows: typeof items) => {
        const m = new Map<string, number>();
        for (const it of rows) m.set(it.bundle_id!, (m.get(it.bundle_id!) ?? 0) + Number(it.quantity || 0));
        return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i] as const);
    };
    const rankMap = (rows: typeof items) => new Map(tally(rows));

    const seasonItems = items.filter(it => inSeason(new Date(it.order.created_at), season));
    const orgSeason   = rankMap(customerId ? seasonItems.filter(it => it.order.customer_id === customerId) : []);
    const seasonFund  = rankMap(seasonItems.filter(it => it.order.source === 'fundraiser'));
    const seasonStore = rankMap(seasonItems.filter(it => it.order.source !== 'fundraiser'));
    const hasSeasonData = seasonFund.size + seasonStore.size > 0;
    // Tier-3 fallback: overall all-time when this season has no data yet
    const fRank = hasSeasonData ? seasonFund  : rankMap(items.filter(it => it.order.source === 'fundraiser'));
    const sRank = hasSeasonData ? seasonStore : rankMap(items.filter(it => it.order.source !== 'fundraiser'));

    const bundles = await prisma.bundle.findMany({
        where: { business_id: businessId },
        select: { id: true, name: true, price: true }, // verify field names against the Bundle model
    });

    const TOP_N = 3, PRECHECK_MAX = 4;
    const ranked = bundles.map(b => ({
        ...b,
        org_previous: orgSeason.has(b.id),                    // "↺ they sold this last {season}"
        fundraiser_favorite: (fRank.get(b.id) ?? 99) < TOP_N, // "⭐ {Season} favorite" (or no season label on fallback)
        top_seller: (sRank.get(b.id) ?? 99) < TOP_N,          // "🔥 {Season} top seller"
        sort_score: (orgSeason.has(b.id) ? 1000 - (orgSeason.get(b.id) ?? 0) : 0)
            + Math.max(0, 100 - (fRank.get(b.id) ?? 100))
            + Math.max(0, 50 - (sRank.get(b.id) ?? 50)),
    })).sort((a, b) => b.sort_score - a.sort_score);

    let checked = 0;
    const withPrecheck = ranked.map(b => {
        const suggest = checked < PRECHECK_MAX &&
            (b.org_previous || b.fundraiser_favorite || (orgSeason.size === 0 && b.top_seller));
        if (suggest) checked++;
        return { ...b, suggested: suggest };
    });

    return NextResponse.json({
        bundles: withPrecheck,
        season, season_label: SEASON_LABEL[season],
        season_based: hasSeasonData,      // false ⇒ UI drops the season word from badges
        has_history: fRank.size + sRank.size > 0,
    });
}
```

### Wizard Step 2 integration

Replace the wizard's plain bundle fetch with this endpoint (pass `customerId` when the org
is known — always known by Step 2). Render rules:

```tsx
// checklist item — sorted by API order, checked = b.suggested (tenant can toggle freely)
<label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:has-[:checked]:bg-indigo-950">
    <input type="checkbox" defaultChecked={b.suggested} value={b.id} />
    {b.name} · ${b.price}
    {b.org_previous && <Badge cls="bg-emerald-100 text-emerald-800">↺ THEY SOLD THIS</Badge>}
    {!b.org_previous && b.fundraiser_favorite && <Badge cls="bg-purple-100 text-purple-800">⭐ FUNDRAISER FAVORITE</Badge>}
    {!b.org_previous && !b.fundraiser_favorite && b.top_seller && <Badge cls="bg-orange-100 text-orange-800">🔥 TOP SELLER</Badge>}
</label>
// Badge = <span className={`ml-auto rounded px-1.5 py-0.5 text-[9px] font-extrabold ${cls}`}>
// When has_history === false: render the plain alphabetical list, no badges, nothing pre-checked.
// Section header gains: "✨ suggested picks pre-checked from your sales history" (only when has_history).
```

One badge per bundle, priority: org_previous > fundraiser_favorite > top_seller. Badge copy uses `season_label` when `season_based` is true ("⭐ Fall favorite"), plain otherwise ("⭐ Fundraiser favorite"). Wizard passes `campaignEnd` from Step 2's end-date field so the season updates live if the date changes.

**Validate:** a fall-dated campaign ranks by Sep–Nov history across years (verify with mixed-season test orders); org with prior fall sales → those bundles badged "↺ they sold this last Fall" and pre-checked first; tenant with spring-only history creating a fall campaign → falls back to all-time ranking with non-seasonal badges; fresh tenant → plain list; cross-tenant isolation with a second business.

---

## GE-11 — Auto Bundle Builder (Bundles page)

**Files:** new `lib/bundles/autoBuilder.ts`, new `app/api/bundles/auto-suggest/route.ts`, additive UI on `app/bundles/page.tsx`. **Do NOT touch `components/BundleEditor.tsx` (locked) or `lib/pricing.ts`/`lib/kitchen_engine.ts` (read-only reuse).**

### `lib/bundles/autoBuilder.ts` (v2 — Random Bundle Creator constraints, approved 2026-07-12)

```ts
/**
 * Random Bundle Creator — SPEC §6.1 GE-11 (locked constraints, v2):
 *   - exactly 5 meals; container mix 2 tray + 3 bag OR 3 tray + 2 bag
 *   - at least 3 DIFFERENT proteins across the 5 meals
 *   - food cost ≤ 35% of the serves-5 price
 *   - max 2 "expensive" recipes (top-quartile cost)
 *   - among valid candidates, MAXIMIZE ingredient overlap
 *     (fewest distinct ingredients = simplest supplier order + prep day)
 */
export type Protein = 'chicken' | 'beef' | 'pork' | 'turkey' | 'seafood' | 'lamb' | 'vegetarian';
export type CandidateRecipe = {
    id: string; name: string; container_type: 'tray' | 'bag'; cost: number;
    ingredientIds: string[];        // child ingredient ids (from the same costing traversal)
    ingredientNames: string[];      // lowercase, for protein detection
    categoryNames?: string[];       // fallback protein signal
};
export type BuiltBundle = {
    recipes: CandidateRecipe[]; totalCost: number; foodCostPct: number; estMargin: number;
    mix: { tray: number; bag: number }; proteins: Protein[];
    distinctIngredients: number; sharedIngredients: number;   // overlap telemetry for the preview
    constraintsMet: boolean; notes: string[];
};

export const BUNDLE_PRICE = 125;
export const TARGET_FOOD_COST_PCT = 0.35;   // emerald zone
export const MAX_FOOD_COST_PCT = 0.40;      // hard cap — BAND decision 2026-07-12
export const MIN_PROTEINS = 3;
export const MAX_EXPENSIVE = 2;
const MIXES: Array<[number, number]> = [[2, 3], [3, 2]]; // [tray, bag]

const PROTEIN_KEYWORDS: Record<Protein, string[]> = {
    chicken:  ['chicken'],
    beef:     ['beef', 'sirloin', 'ground chuck', 'steak', 'brisket', 'meatball', 'meatloaf'],
    pork:     ['pork', 'ham', 'bacon', 'sausage', 'chorizo'],
    turkey:   ['turkey'],
    seafood:  ['shrimp', 'salmon', 'fish', 'cod', 'tilapia', 'crab'],
    lamb:     ['lamb'],
    vegetarian: [], // assigned when nothing else matches
};

/** Detect a recipe's protein from its ingredients (primary) or categories (fallback). */
export function detectProtein(r: Pick<CandidateRecipe, 'ingredientNames' | 'categoryNames' | 'name'>): Protein {
    const hay = [...r.ingredientNames, ...(r.categoryNames ?? []), r.name].join(' ').toLowerCase();
    for (const [p, words] of Object.entries(PROTEIN_KEYWORDS) as [Protein, string[]][]) {
        if (words.some(w => hay.includes(w))) return p;
    }
    return 'vegetarian';
}

const sample = <T,>(arr: T[], n: number): T[] => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

export function buildRandomBundle(all: CandidateRecipe[], opts?: { price?: number; tries?: number }): BuiltBundle | null {
    const price = opts?.price ?? BUNDLE_PRICE;
    const tries = opts?.tries ?? 120;                     // more tries: we rank, not first-valid
    const trays = all.filter(r => r.container_type === 'tray' && r.cost > 0);
    const bags  = all.filter(r => r.container_type === 'bag'  && r.cost > 0);
    if (trays.length < 2 || bags.length < 2 || trays.length + bags.length < 5) return null;

    const costs = [...all.map(r => r.cost)].sort((a, b) => a - b);
    const expensiveCut = costs[Math.floor(costs.length * 0.75)] ?? Infinity;

    const evaluate = (pick: CandidateRecipe[], t: number, b: number): BuiltBundle => {
        const totalCost = pick.reduce((s, r) => s + r.cost, 0);
        const foodCostPct = totalCost / price;
        const expensive = pick.filter(r => r.cost >= expensiveCut).length;
        const proteins = [...new Set(pick.map(detectProtein))];
        const allIng = pick.flatMap(r => r.ingredientIds);
        const distinct = new Set(allIng).size;
        const notes: string[] = [];
        if (foodCostPct > MAX_FOOD_COST_PCT) notes.push(`food cost ${(foodCostPct * 100).toFixed(0)}% (hard cap 40%)`);
        if (expensive > MAX_EXPENSIVE) notes.push(`${expensive} high-cost meals (max ${MAX_EXPENSIVE})`);
        if (proteins.length < MIN_PROTEINS) notes.push(`only ${proteins.length} protein${proteins.length === 1 ? '' : 's'} (need ${MIN_PROTEINS}+)`);
        return {
            recipes: pick, totalCost, foodCostPct, estMargin: price - totalCost,
            mix: { tray: t, bag: b }, proteins,
            distinctIngredients: distinct, sharedIngredients: allIng.length - distinct,
            constraintsMet: notes.length === 0, notes,
        };
    };

    let bestValid: BuiltBundle | null = null;
    let bestAny: BuiltBundle | null = null;
    for (let i = 0; i < tries; i++) {
        const [t, b] = MIXES[Math.floor(Math.random() * MIXES.length)];
        if (trays.length < t || bags.length < b) continue;
        const c = evaluate([...sample(trays, t), ...sample(bags, b)], t, b);
        if (c.constraintsMet) {
            // BAND-AWARE OVERLAP RANKING: emerald-zone (≤35%) beats band (35–40%);
            // within a zone, fewer distinct ingredients wins; tiebreak lower cost.
            const zone = (x: BuiltBundle) => (x.foodCostPct <= TARGET_FOOD_COST_PCT ? 0 : 1);
            if (!bestValid
                || zone(c) < zone(bestValid)
                || (zone(c) === zone(bestValid) && c.distinctIngredients < bestValid.distinctIngredients)
                || (zone(c) === zone(bestValid) && c.distinctIngredients === bestValid.distinctIngredients && c.totalCost < bestValid.totalCost)) {
                bestValid = c;
            }
        }
        if (!bestAny || c.notes.length < bestAny.notes.length) bestAny = c;
    }
    return bestValid ?? bestAny; // valid best-overlap, else closest attempt (constraintsMet=false → UI shows notes)
}
```

**Preview additions (AutoBundleModal):** protein chips row (🐔🥩🐷 detected proteins), and the overlap line — `"These 5 meals share {sharedIngredients} ingredients — {distinctIngredients} items on the shopping list"` — styled emerald. That line IS the Production-page connection: fewer distinct items = shorter supplier order and simpler prep day, and the created bundle flows into Kitchen Board batches automatically.

**Data plumbing:** the auto-suggest API's candidate mapping must now also collect, per recipe, `ingredientIds` + lowercase `ingredientNames` (both available in the same `child_items` traversal the extracted costing helper already walks — no extra queries) and `categoryNames` from the recipe's categories.

**CB connection (fundraiser-ready pairs):** the preview gains an optional checkbox — `"Also create the Serves 2 version (fundraiser-ready)"`. When checked, after creating the serves-5 bundle the client repeats the create with the serves-2 mapping (same recipe-name `"(Serves 2)"` convention + `-S2` SKU the BundleEditor clone uses — replicate that mapping in the creator, do NOT modify BundleEditor) and, once CB-1's `family_id` exists, stamps both with a shared family id — making creator output immediately eligible for coordinator candidate pools. When a recipe lacks a Serves 2 sibling, the checkbox shows "3 of 5 recipes have Serves 2 versions — create those first" and disables.

### `app/api/bundles/auto-suggest/route.ts`

```ts
// Session auth + businessId (same pattern as /api/growth/*).
// Recipe costs: REUSE the server-side cost calculation — app/recipes/page.tsx already
// computes recursive per-recipe cost in-memory (calculateCostInMemory). EXTRACT that
// function into lib/recipes/costing.ts as a pure helper (page imports it back —
// behavior-identical move, verify recipes page renders same costs after) and call it
// here for all tenant recipes. Map to CandidateRecipe:
//   container_type: recipe.container_type === 'bag' ? 'bag' : 'tray'  (default tray, matches existing heuristic)
// Exclude recipes with cost 0/unknown (isAccurate=false) — a random bundle built on
// missing cost data is worse than none; return their count as `excluded_no_cost`.
// GET → { bundle: buildRandomBundle(candidates), excluded_no_cost }
```

### `components/bundles/AutoBundleModal.tsx` (complete) + button on `app/bundles/page.tsx`

Button next to the existing new-bundle CTA:
```tsx
<button onClick={() => setShowAutoBuilder(true)}
    className="rounded-xl bg-indigo-50 px-4 py-2.5 text-sm font-extrabold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
    ✨ Auto-build a bundle
</button>
```

```tsx
'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

export function AutoBundleModal({ onClose }: { onClose: () => void }) {
    const router = useRouter();
    const [result, setResult] = useState<any>(null);   // { bundle, excluded_no_cost }
    const [busy, setBusy] = useState(false);

    const roll = useCallback(() => {
        setBusy(true);
        fetch('/api/bundles/auto-suggest')
            .then(r => r.json()).then(setResult).finally(() => setBusy(false));
    }, []);
    useEffect(roll, [roll]);

    const b = result?.bundle;
    const create = async () => {
        setBusy(true);
        // READ the existing POST /api/bundles payload shape first and match it exactly.
        const res = await fetch('/api/bundles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: `Auto Bundle — ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`,
                contents: b.recipes.map((r: any) => ({ recipe_id: r.id, quantity: 1 })),
            }),
        });
        const data = await res.json();
        if (res.ok && data.id) router.push(`/bundles?edit=${data.id}`); // or the editor's real open mechanism
        else setBusy(false);
    };

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4" onClick={onClose}>
            <div className="w-full max-w-md rounded-2xl bg-white p-5 dark:bg-slate-900" onClick={e => e.stopPropagation()}>
                <h3 className="text-base font-black text-slate-900 dark:text-white">✨ Auto-built bundle</h3>
                <p className="mb-3 text-[11px] text-slate-500">
                    5 meals · balanced cost · {b ? `${b.mix.tray} tray + ${b.mix.bag} bag` : '…'}
                    {result?.excluded_no_cost > 0 && ` · ${result.excluded_no_cost} recipes skipped (no cost data)`}
                </p>

                {!b && !busy && <p className="py-6 text-center text-sm text-slate-400">Not enough recipe variety yet — you need at least 2 tray and 2 bag recipes with costs.</p>}
                {b && (
                    <>
                        <div className="divide-y divide-slate-100 dark:divide-slate-800">
                            {b.recipes.map((r: any) => (
                                <div key={r.id} className="flex items-center gap-2 py-2 text-sm">
                                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-extrabold uppercase ${
                                        r.container_type === 'tray' ? 'bg-sky-100 text-sky-800' : 'bg-teal-100 text-teal-800'}`}>
                                        {r.container_type}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate font-semibold text-slate-800 dark:text-slate-200">{r.name}</span>
                                    <span className="tabular-nums text-xs text-slate-500">${r.cost.toFixed(2)}</span>
                                </div>
                            ))}
                        </div>
                        <div className={`mt-3 rounded-xl px-3 py-2 text-xs font-bold tabular-nums ${
                            b.constraintsMet ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                             : 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}`}>
                            Food cost: {(b.foodCostPct * 100).toFixed(0)}% · Est. margin: ${b.estMargin.toFixed(2)} / set
                            {!b.constraintsMet && <span className="block font-medium">⚠ {b.notes.join(' · ')} — try a shuffle</span>}
                        </div>
                    </>
                )}

                <div className="mt-4 flex gap-2">
                    <button onClick={roll} disabled={busy}
                        className="flex-1 rounded-xl bg-slate-100 py-2.5 text-sm font-extrabold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        🎲 Shuffle
                    </button>
                    <button onClick={create} disabled={busy || !b || !b.constraintsMet}
                        className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
                        Create this bundle
                    </button>
                </div>
                <button onClick={onClose} className="mt-2 w-full py-1 text-xs font-bold text-slate-400">Cancel</button>
            </div>
        </div>
    );
}
```

The builder never saves without the tenant clicking Create (button disabled until constraints are met); the editor remains the review step.

**Validate:** 30 consecutive shuffles → every result is 2/3 or 3/2 tray/bag, ≤2 top-quartile-cost meals, food cost ≤40% (or clearly flagged when the pool can't satisfy it); tenant with <2 trays or <2 bags gets a friendly "not enough recipe variety yet" message; created bundle opens in the editor with 5 contents and correct pricing behavior; recipes page costs unchanged after the costing extraction; no BundleEditor/locked-file edits in the diff.

---

## Acceptance checklist

- [ ] Per-phase `git diff --stat` shows only that phase's allowed files; the two schema items (if needed) shipped as separate proposal-first diffs.
- [ ] All `/api/growth/**` routes: verified cross-tenant 403 with a second test business.
- [ ] Rebook list excludes orgs with a newer campaign; ask ≥ $1,250; all "earned" figures are 20% share, labeled.
- [ ] Lead POST from scoreboard creates a BusinessLead on the CORRECT tenant (token-derived); junk-length input rejected.
- [ ] Health flag: Hilltop-style campaign (0 orders, no shares) reads at_risk with reasons; healthy campaign reads on_pace.
- [ ] Impact report PDF renders with org-share headline; LTV shows on profile.
- [ ] Cron: request without `CRON_SECRET` → 401; run twice same day → zero duplicate sends (sent-log verified); outbound coordinator/customer emails do NOT send with default settings.
- [ ] Season blast dates fire only on their calendar day; summer blast uses tenant offer text; no profit-split math changed anywhere.
- [ ] Leaderboard: hidden when `is_group_enabled` false; counts in serves-5 equivalents (2× serves-2 orders = 1.0 set); names masked.
- [ ] Wizard: goal ≥ minimum passes clean; below-minimum shows the warning but does not block.
- [ ] Bundle suggestions: SEASON-scoped ranking verified with mixed-season data; org's prior same-season bundles pre-checked first; season fallback to all-time works; fresh tenant gets a plain list; cross-tenant isolation verified.
- [ ] Auto Bundle Builder: 30 shuffles all satisfy mix + cost constraints (or flag clearly); zero-cost recipes excluded; created bundle reviewed in the normal editor; no locked-file edits.
- [ ] No edits to `lib/serving_multipliers.ts`, `lib/fundraiserMetrics.ts`, `lib/pricing.ts`, or any locked file. No new `@ts-ignore`/`as any` (except the flagged BusinessLead cast until fields are confirmed — must be removed before merge).
