# Mission Control — Dashboard Implementation Handoff (exact code)

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §15 (+ §14 doctrine for all inquiry copy) — spec wins.
**Pixel reference:** `docs/ai/prototypes/mission_control_prototype.html` — interactive; study the range toggle, inquiry Reply flow, and funnel bar.
**Phases:** MC-0 → MC-1 → MC-2 → MC-3 → MC-4 → MC-5. Each = its own diff.

## HARD RULES

1. NEVER touch locked files (§0). The dashboard reads; it never mutates orders/campaigns directly — every action deep-links to the owning board or calls existing endpoints.
2. Reuse `/api/dashboard` (extend additively — `range` param, new fields; never change existing response fields), `lib/orderStatus.ts`, `lib/fundraiserMetrics.ts` (org-share), the CRM/coordinator template helpers (post-FIX-3), `sonner` toasts, existing confetti.
3. **No auto-sent replies to inquirers** except the menu-signup welcome receipt (tenant toggle, default ON). Every other reply is Review & Send. §14 applies to all copy.
4. New components in `components/dashboard2/`; new libs in `lib/dashboard/`. Design tokens: spec §1.
5. Attention/pulse sources degrade gracefully: wrap each source in its own try/catch returning `[]` — one broken source must never blank the dashboard (the existing social-feed catch is the model).

---

## MC-0 — API fixes (`app/api/dashboard/route.ts` unless noted)

**0.1 Chart bucketing** — replace the weekday-name map with date keys over ONE rolling window:

```ts
// Window: rolling 7 days INCLUSIVE of today — use for BOTH the query and the buckets.
const weekStart = new Date(); weekStart.setHours(0,0,0,0); weekStart.setDate(weekStart.getDate() - 6);
// query: created_at: { gte: weekStart }
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const daysMap = new Map<string, { label: string; amount: number; orders: number }>();
for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    daysMap.set(dayKey(d), { label: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()], amount: 0, orders: 0 });
}
ordersThisWeek.forEach(o => {
    const e = o.created_at && daysMap.get(dayKey(o.created_at));
    if (e) { e.amount += Number(o.total_amount); e.orders += 1; }
});
```

**0.2 Low stock** — proper fix: `Ingredient.low_stock_threshold Decimal?` (JOINS CB-1 migration, proposal-first). Interim (ships now, no schema):

```ts
// lib/dashboard/lowStock.ts — unit-aware defaults until the column lands
const DEFAULT_THRESHOLDS: Array<[RegExp, number]> = [
    [/lb|pound|kg/i, 10], [/oz|gram/i, 32], [/qt|quart|gal|liter|l\b/i, 4],
    [/each|piece|ct|count|can|jar|case/i, 12], [/tsp|tbsp/i, 8],
];
export function lowStockThreshold(unit: string | null, override?: number | null): number {
    if (override != null) return Number(override);
    for (const [re, t] of DEFAULT_THRESHOLDS) if (unit && re.test(unit)) return t;
    return 10;
}
// route: fetch candidates with stock_quantity < 50, filter in JS by threshold, take 5.
```

**0.3 Itemless-order size guess** — delete the price-based `unmappedOrders` sizing; return `demandBreakdown.unmapped = unmappedOrders.length` and let the UI say "N orders need items mapped" (a fix prompt, not a fake stat).

**0.4** — the Family/Couple panel is removed with MC-1 (no API change; `demandAgg` by `variant_size` stays and feeds a generic per-tier list if wanted).

**Additive `range` param** (MC-1 uses it): `?range=day|week|month` — `day` = today 00:00→now vs yesterday same-window; `week`/`month` = existing logic. Response gains `{ range, revenue, inProgress, growth… }` under a new `pulse` key; existing fields untouched.

---

## MC-1 — Mission Control board

### `lib/dashboard/attention.ts` (complete — the cross-platform strip)

```ts
/** Ranked attention items across every system. Each source isolated; failures return []. */
export type AttentionItem = { emoji: string; title: string; sub: string; href: string;
    stripe: 'red' | 'amber' | 'indigo' | 'emerald'; rank: number };

export async function buildAttention(businessId: string, prisma: any): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const safe = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.warn('[attention]', e); } };

    await safe(async () => { // At-risk campaigns (GE-3 when merged; interim: 0-order active campaigns ending <10d)
        const risky = await prisma.fundraiserCampaign.findMany({
            where: { customer: { business_id: businessId }, status: 'Active', closed_at: null,
                     end_date: { lte: new Date(Date.now() + 10 * 864e5) }, orders: { none: {} } },
            select: { id: true, name: true, customer: { select: { id: true, name: true } } }, take: 1 });
        for (const c of risky) items.push({ emoji: '🚨', stripe: 'red', rank: 1,
            title: `${c.customer.name} at risk`, sub: 'no orders yet — nudge the coordinator',
            href: `/fundraisers/${c.customer.id}` });
    });

    await safe(async () => { // Batches due (orders due within 3 days not yet cooked)
        const due = await prisma.order.count({ where: { business_id: businessId,
            status: { in: ['production_ready', 'in_production'] as any },
            delivery_date: { lte: new Date(Date.now() + 3 * 864e5) } } });
        if (due > 0) items.push({ emoji: '🍳', stripe: 'amber', rank: 2,
            title: `${due} order${due > 1 ? 's' : ''} due within 3 days`,
            sub: 'open the Kitchen Board', href: '/production' });
    });

    await safe(async () => { // Waiting inquiries (Messenger activity unreplied + recent leads)
        const msgs = await prisma.activity.count({ where: { business_id: businessId,
            type: { in: ['message', 'comment'] }, status: { notIn: ['archived', 'replied'] } } });
        if (msgs > 0) items.push({ emoji: '💬', stripe: 'indigo', rank: 3,
            title: `${msgs} inquir${msgs > 1 ? 'ies' : 'y'} waiting`, sub: 'reply below', href: '#inquiries' });
    });

    await safe(async () => { // Settled campaigns without an invoice (7E)
        const settled = await prisma.fundraiserCampaign.findFirst({
            where: { customer: { business_id: businessId }, closed_at: { not: null },
                     settlement_total: { gt: 0 } /* + invoice link null once campaign_id lands on Invoice */ },
            select: { id: true, name: true, settlement_total: true, customer_id: true } });
        if (settled) items.push({ emoji: '💰', stripe: 'emerald', rank: 4,
            title: `${settled.name} settled — invoice it`,
            sub: `$${Number(settled.settlement_total).toLocaleString()} frozen at closeout`,
            href: `/customers/${settled.customer_id}?tab=fundraisers&action=invoice` });
    });

    return items.sort((a, b) => a.rank - b.rank).slice(0, 4);
}
```

Expose via the dashboard route (`attention: await buildAttention(...)`). UI: reuse the CRM handoff's `AttentionStrip` card pattern (left-stripe cards, deep links) — copy those exact Tailwind classes.

### Board assembly (`app/DashboardClient.tsx` render replacement; fetch/refresh logic kept)
Per the prototype: greeting header (user name + day context) · range toggle (drives `?range=` refetch; persist in localStorage) · attention strip · pulse row — **Revenue** (sparkline from weeklyBreakdown, growth), **Orders in progress**, **Batches to cook** (from prep data), **Raised for groups** = `orgShare(sum of active campaigns' computed sales)` via `lib/fundraiserMetrics.ts` — a SEPARATE stat; revenue keeps its fundraiser exclusions · grid: left = Inquiries (MC-2) + Funnel bar; right = Week strip + Fundraiser pulse.

**Week strip:** 7 `cday` cells (prototype classes) fed by: order cutoffs (`order_cutoff_date` of storefront bundles), delivery/pickup days (orders' `delivery_date` counts + fulfillment_type), campaign `delivery_date`/`end_date` in-window. One additive query block in the dashboard route returning `calendar: [{date, events:[{type,label}]}]`.

**Funnel bar:** `prisma.customer.groupBy({ by: ['status'], where: { business_id, archived: false }, _count: true })` → stages in `STATUS_LABELS` order; each segment links `/customers?status=X`. Stale-lead line: count LEAD customers with `updated_at` older than 14d → link to filtered CRM (+ "send follow-ups ✨" opens MC-2's composer with the win-back template preloaded — Review & Send).

---

## MC-2 — Funnel Autopilot

### `GET /api/dashboard/inquiries` (new, session-scoped)
Merge, newest-first, take 8: **BusinessLead** rows (last 14d, not converted/dismissed — read the model for its status fields; source chips from `source` prefix: `fundraiser_*` → FUNDRAISER LEAD, `storefront_menu_signup` → MENU LIST, else LEAD) · **Activity** messages (existing social feed query — chip MESSENGER) · fundraiser-request rows if stored separately (read `app/api/public/fundraiser-request/route.ts` to learn where it writes). Normalize: `{ id, kind, name, message, when, meta }`.

### `lib/dashboard/suggestedReply.ts` (complete)

```ts
/** §14: suggestions are drafts — ALWAYS Review & Send. Uses post-FIX-3 tenant-branded templates. */
import { orgShare } from '@/lib/growth/math'; // if GE not merged: inline the 0.2 from lib/fundraiserMetrics.ts

export function suggestedReply(kind: string, ctx: { tenantName: string; storefrontUrl: string; firstName?: string }): string | null {
    const hi = ctx.firstName ? `Hi ${ctx.firstName}!` : 'Hi!';
    switch (kind) {
        case 'fundraiser_lead':
            return `${hi} Great to hear from you — groups like yours typically raise $1,500–$3,000, and your group keeps 20% of every sale. I'd love to get you set up; it takes about two minutes. Here's how it works: ${ctx.storefrontUrl}/raise-funds`;
        case 'messenger':
            return `${hi} Thanks for reaching out! This week's menu and ordering are here: ${ctx.storefrontUrl} — happy to answer anything. 🧡 — ${ctx.tenantName}`;
        case 'menu_signup':
            return null; // handled by the auto-welcome receipt, no manual reply needed
        default:
            return `${hi} Thanks for your interest in ${ctx.tenantName}! Our current menu is at ${ctx.storefrontUrl} — what can I help with?`;
    }
}
```

### `components/dashboard2/InquiryCard.tsx`
Prototype exactly: source chip · name · age · message · collapsed ✨ suggested reply (contentEditable for edits) · buttons: **✨ Reply** (expand) → **Review & send** (Messenger kind → existing `/api/integrations/meta/reply`; email kinds → existing `/api/email/send` with tenant sender) → success state "✓ Sent — moved to Leads" · **Convert**: fundraiser leads → open CRM-4 wizard with org/contact prefilled (or `/customers?type=ORGANIZATION&action=new&prefill=` until CRM-4 merges); others → customer-create prefilled · **Later** (dismiss — sets the lead's dismissed/snooze field; read the model).

### Auto-welcome receipt (the ONE auto-response)
In the menu-signup route (SF-2's `/api/public/menu-signup`): after creating the BusinessLead, if tenant toggle ON (default ON — store beside the GE-5 automation settings), send the branded welcome ("You're on the list! Next week's menu comes every Thursday. Browse anytime: {storefrontUrl}"). Idempotent per email.

### `lib/statusWorkflow.ts` addition (pure — NO writes, NO sends)

```ts
/** MC-2: suggestion map — the UI shows these next to a customer's stage. Never auto-executed. */
export const STAGE_SUGGESTIONS: Record<string, { action: string; templateKind?: string }> = {
    LEAD:      { action: 'Send intro + how-it-works', templateKind: 'intro' },
    AGREEMENT: { action: 'Send the agreement / confirm dates' },
    ONBOARDING:{ action: 'Send the info packet', templateKind: 'info' },
    ACTIVE:    { action: 'Check coordinator momentum (shares & first orders)' },
    PRODUCTION:{ action: 'Confirm delivery window with the org' },
    DELIVERY:  { action: 'Send the impact report + rebook ask', templateKind: 'impact' },
};
```

---

## MC-3 — ⌘K palette + live pulse

### `components/dashboard2/CommandPalette.tsx` (complete skeleton)

```tsx
'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type Item = { label: string; hint: string; href?: string; run?: () => void; keywords: string };

export function CommandPalette() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState('');
    const [data, setData] = useState<Item[]>([]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o); }
            if (e.key === 'Escape') setOpen(false);
        };
        window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => { // lazy index on first open — existing list endpoints, small selects
        if (!open || data.length) return;
        (async () => {
            const ACTIONS: Item[] = [
                { label: '＋ New order', hint: 'action', href: '/orders?action=new', keywords: 'new order create manual' },
                { label: '🚀 Start a fundraiser', hint: 'action', href: '/fundraisers?action=new', keywords: 'fundraiser wizard campaign start' },
                { label: '✨ Create a random bundle', hint: 'action', href: '/bundles?action=auto', keywords: 'bundle random creator auto' },
                { label: '🍳 Kitchen Board', hint: 'go to', href: '/production', keywords: 'kitchen production cook batches' },
                { label: '🚚 Delivery Day', hint: 'go to', href: '/delivery', keywords: 'delivery route pack stops' },
                { label: '📇 Customers', hint: 'go to', href: '/customers', keywords: 'crm customers people orgs' },
            ];
            const [cust, rec, bun, camp] = await Promise.all([
                fetch('/api/customers').then(r => r.json()).catch(() => ({ customers: [] })),
                fetch('/api/recipes').then(r => r.json()).catch(() => []),
                fetch('/api/bundles').then(r => r.json()).catch(() => []),
                fetch('/api/campaigns').then(r => r.json()).catch(() => []),
            ]);
            const items: Item[] = [...ACTIONS,
                ...(cust.customers ?? cust ?? []).slice(0, 300).map((c: any) => ({ label: c.name, hint: 'customer', href: `/customers/${c.id}`, keywords: `${c.name} ${c.contact_name ?? ''}`.toLowerCase() })),
                ...(rec ?? []).slice(0, 300).map((r: any) => ({ label: r.name, hint: 'recipe', href: `/recipes/${r.id}`, keywords: r.name.toLowerCase() })),
                ...(bun ?? []).slice(0, 200).map((b: any) => ({ label: b.name, hint: 'bundle', href: `/bundles/${b.id}`, keywords: b.name.toLowerCase() })),
                ...(Array.isArray(camp) ? camp : []).filter((c: any) => !c.is_placeholder).slice(0, 100).map((c: any) => ({ label: c.name, hint: 'campaign', href: `/fundraisers/${c.customer_id}`, keywords: `${c.name} ${c.customer?.name ?? ''}`.toLowerCase() })),
            ];
            setData(items);
        })();
    }, [open, data.length]);

    const results = useMemo(() => {
        const term = q.trim().toLowerCase();
        if (!term) return data.slice(0, 8);
        return data.filter(i => i.keywords.includes(term) || i.label.toLowerCase().includes(term)).slice(0, 8);
    }, [q, data]);

    if (!open) return null;
    return (
        <div className="fixed inset-0 z-[100] grid place-items-start justify-center bg-slate-900/40 pt-[15vh]" onClick={() => setOpen(false)}>
            <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900" onClick={e => e.stopPropagation()}>
                <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                    placeholder="Search customers, recipes, bundles… or type an action"
                    className="w-full border-b border-slate-200 bg-transparent px-4 py-3.5 text-sm outline-none dark:border-slate-700 dark:text-white" />
                <div className="max-h-80 overflow-y-auto p-1.5">
                    {results.map((r, i) => (
                        <button key={i} onClick={() => { setOpen(false); r.run ? r.run() : router.push(r.href!); }}
                            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-indigo-50 dark:hover:bg-slate-800">
                            <span className="min-w-0 flex-1 truncate font-semibold text-slate-800 dark:text-slate-100">{r.label}</span>
                            <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{r.hint}</span>
                        </button>
                    ))}
                    {!results.length && <p className="px-3 py-6 text-center text-xs text-slate-400">Nothing matches — try fewer letters</p>}
                </div>
            </div>
        </div>
    );
}
```

Mount once in the tenant layout (not just the dashboard). Action hrefs use query params existing pages already handle (verify `?action=` handlers; where absent, route to the page plainly).

### Live pulse
`GET /api/dashboard/pulse?since=<ISO>` (new, session-scoped): counts + latest 3 of orders and inquiries created after `since`. Client: 60s interval while tab visible (`document.visibilityState`), toast per new item via sonner ("🧡 New order — Kim R., $180"), update `since`. No polling when hidden.

---

## MC-4 — Attribution + records

### `lib/dashboard/attribution.ts` (complete)

```ts
/** Rule-based delta explanation — NO AI. "▲18% — mostly Family Favorites (+$540)". */
export function explainDelta(
    current: Array<{ bundle_name: string; source: string; amount: number }>,
    prior: Array<{ bundle_name: string; source: string; amount: number }>,
): string | null {
    const sum = (rows: typeof current, key: (r: any) => string) => {
        const m = new Map<string, number>();
        rows.forEach(r => m.set(key(r), (m.get(key(r)) ?? 0) + r.amount));
        return m;
    };
    const cur = sum(current, r => r.bundle_name), pri = sum(prior, r => r.bundle_name);
    const movers = [...cur.entries()].map(([k, v]) => [k, v - (pri.get(k) ?? 0)] as const)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2)
        .filter(([, d]) => Math.abs(d) >= 50);
    if (!movers.length) return null;
    return 'mostly ' + movers.map(([name, d]) =>
        `${name} (${d >= 0 ? '+' : '−'}$${Math.abs(Math.round(d))})`).join(' and ');
}
```

Feed with per-bundle sums for current/prior periods (one extra groupBy pair in the `range` handler). Render under the revenue growth line.

### Personal records
Dashboard route addition: `bestDay = MAX(daily revenue)` via groupBy on `created_at` date (or raw query), returned as `{ amount, date }`. Client: when today's total exceeds it → 🏆 banner + existing confetti, celebrated once (`localStorage kb_record_<date>`). Copy stays playful ONLY for revenue/orders — never attach celebration to serious metrics.

---

## MC-5 — Day-One Mode

Dashboard route addition: `activation: { recipes: n>0, bundles: n>0, storefront: nShowOnStorefront>0, firstOrder: n>0 }` (four cheap counts). Client: if any false, render the setup checklist INSTEAD of the board — §14 checklist pattern (numbered steps, one primary action each, progress bar):
① Add your first recipes (`/recipes/new` + "or import a CSV") → ② Build a bundle ("✨ try the Random Creator", `/bundles?action=auto`) → ③ Put it on your storefront (`/bundles` toggle hint) → ④ Get your first order (share storefront link + copy button). Completed steps collapse with ✓. Once all four are true the board renders forever (no reversion if data later drops to zero — check a `localStorage` graduation flag OR simply activation-complete-once server flag omitted: keep it computed; four trues = board).

---

## Acceptance checklist

- [ ] MC-0: chart bars match a hand-count of the last 7 days; low-stock list sensible across unit types; no price-guessed sizes anywhere; `range=day|week|month` returns consistent shapes; existing response fields byte-identical.
- [ ] Attention strip: each source failing (throw injected) leaves the others rendering; max 4 items; every link lands on the right board.
- [ ] "Raised for groups" uses org-share framing and does NOT alter revenue stats.
- [ ] Inquiries: all sources merge newest-first; suggested replies are editable; NOTHING sends without the Review & Send click; menu-signup welcome sends once per email and respects the toggle; convert buttons prefill correctly.
- [ ] Funnel: stage counts match the CRM's own filters; clicks land filtered; stale-lead count accurate.
- [ ] ⌘K: opens everywhere in the tenant backend; finds a customer/recipe/bundle/campaign by partial name; actions navigate; index loads lazily (no fetch until first open).
- [ ] Pulse: no polling when tab hidden; toasts dedupe; zero toasts for fundraiser-hold orders.
- [ ] Attribution line appears only when movers ≥ $50; records banner fires once per record day.
- [ ] Day-One Mode: fresh tenant sees the checklist, each step's CTA works, board appears when all four complete; established tenant never sees it.
- [ ] Per-phase diff gate; MC-0.2's column shipped inside the CB-1 proposal; no locked files; no new `@ts-ignore`/`as any`.
