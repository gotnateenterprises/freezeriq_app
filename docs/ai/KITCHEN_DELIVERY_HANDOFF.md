# Kitchen Board + Delivery Day — Implementation Handoff (exact code)

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §12 — spec wins on any conflict.
**Pixel references:** `docs/ai/prototypes/kitchen_board_prototype.html` + `docs/ai/prototypes/delivery_day_prototype.html` — open in a browser; match them when look/copy is ambiguous. Both are interactive: study the check-off gating and lane behavior.
**Phases:** DD-0 → KB-1 → DD-1 → DD-2 → DD-3 → DD-4 → DD-5. Each = its own diff.

## HARD RULES

1. NEVER touch: `app/api/coordinator/**`, `app/api/checkout/**`, `app/api/webhooks/**`, `app/api/stripe/**`, `app/api/public/order/route.ts`, `prisma/schema.prisma`, `middleware.ts`, `auth.ts`, `lib/pricing.ts`, `lib/serving_multipliers.ts`, `lib/kitchen_engine.ts`, RecipeEditor/BundleEditor.
2. PRESERVE and reuse verbatim: `lib/orderStatus.ts` helpers (all status reads via `toDbOrderStatusReadCandidates`, writes via the existing writers), `/api/orders/bulk-status`, `/api/orders/batch-update-by-bundle`, `/api/delivery/optimize`, `/api/delivery/route/reorder`, the multi-stop Google Maps URL builder in `app/delivery/page.tsx` (~line 530) and `openGoogleMaps` (~line 469), the ProductionCalculator (renamed tab only), all print pages, the inventory CRUD.
3. New components: `components/kitchen/` (KB) and `components/delivery2/` (DD). Existing components swap out per phase; delete only what the phase names.
4. Design tokens: spec §1 (indigo accent, slate ground, amber=cooking, emerald=done). Kitchen/Driver Mode = a wrapper class scaling type/targets ~8–15% (see prototypes).
5. No new `@ts-ignore`/`as any`. Every board must be clean at 768px (tablet) — test there first.
6. Packing is cardboard boxes. No cooler/returnable-asset features (spec §12 decision).

---

## DD-0 — Pipeline correctness (build first; each fix is independently shippable)

### DD-0.1 — Released fundraiser orders must reach the kitchen
`app/api/production/dashboard/route.ts`: all three queries currently have `source: { not: 'fundraiser' }`. Replace with a status exclusion so post-closeout orders appear:

```ts
// BEFORE (all three queries):
source: { not: 'fundraiser' as any },
// AFTER — held fundraiser orders stay out; RELEASED (production_ready+) ones flow in:
NOT: { status: 'fundraiser_hold' as any },
```

Keep the existing `NOT: { source: 'storefront', status: 'pending' }` clause on the pending query (unpaid storefront exclusion) — combine with AND semantics (`AND: [ ... ]` if needed to hold both NOTs).

### DD-0.2 — order_count counts orders, not line items
Same file, aggregation loop (~line 122): track distinct order ids.

```ts
const prepMap = new Map<string, { /* existing fields */ order_ids: Set<string> }>();
// in the item loop, replace `entry.order_count += 1;` with:
entry.order_ids.add(order.id);
// when serializing:
prep: Array.from(prepMap.values()).map(({ order_ids, ...e }) => ({ ...e, order_count: order_ids.size })),
```

### DD-0.3 — Week-filter leak
`app/api/orders/route.ts` GET (~lines 31–43): the OR pins ALL null-dated and ALL completed orders into every week. Scope the escape hatches to recent rows:

```ts
const thirtyDaysAgo = new Date(Date.now() - 30 * 864e5);
whereClause.OR = [
    { delivery_date: { gte: weekStart, lt: weekEnd } },
    { delivery_date: null, created_at: { gte: thirtyDaysAgo } },
    { status: { in: toDbOrderStatusReadCandidates('completed') as any },
      created_at: { gte: thirtyDaysAgo } },
];
```

Companion backfill (**PROPOSAL-FIRST script**, `scripts/backfill_stale_completed.ts`): mark completed/COMPLETED rows older than 60 days with no later status as `delivered`; print a count before writing; require an explicit `--apply` flag.

### DD-0.4 — Run page can no longer deliver uncooked food
`app/delivery/run/page.tsx` (~line 47): change the fetch to `status=ready_to_ship` only (drop `production_ready`). The DD-1 board makes this visible ("Waiting on Pack station").

### DD-0.5 — Orders PATCH transition guard (PROPOSAL-FIRST — order mutation)
`app/api/orders/route.ts` PATCH: before writing a status, validate the transition:

```ts
import { toCanonicalOrderStatus } from '@/lib/orderStatus'; // verify exact export name

const ALLOWED_PRIOR: Record<string, string[]> = {
    production_ready: ['pending'],
    in_production:    ['production_ready'],
    completed:        ['in_production', 'production_ready'],
    ready_to_ship:    ['completed', 'in_production', 'production_ready'],
    delivered:        ['ready_to_ship', 'completed'],
    pending:          [], // never backward via this route
};
// fetch current order (already done for ownership); then:
const from = toCanonicalOrderStatus(existing.status);
const to = toCanonicalOrderStatus(body.status);
if (ALLOWED_PRIOR[to] && !ALLOWED_PRIOR[to].includes(from)) {
    return NextResponse.json({ error: `Cannot move an order from '${from}' to '${to}'` }, { status: 400 });
}
// Idempotency: run the production_ready side effects (invoice→PAID, loyalty award)
// ONLY when from !== 'production_ready' — i.e., on the actual transition, not repeats.
```

Match helper names against `lib/orderStatus.ts` before coding. Verify the fundraiser flows are unaffected: coordinator/closeout writers do NOT use this PATCH (closeout uses updateMany; coordinator uses its own handlers) — confirm by grep before merging.

**DD-0 validation:** close a test campaign → its orders appear on the kitchen dashboard AND delivery; prep card for an order with 2 same-bundle lines shows 1 order; week view no longer lists a 6-month-old completed order; run page shows only ready_to_ship; PATCH delivered-from-pending returns 400; repeated PATCH to production_ready awards loyalty once.

---

## KB-1 — Kitchen Board UI

**Files:** `app/production/page.tsx` (render replacement; keep `refreshData`, tab state) + new `components/kitchen/*`. ProductionCalculator untouched except the tab label ("Shopping & Prep Sheets") and a `prefill` prop (array of `{bundle_id, quantity}` from the To-Cook lane).

### Shared: `components/kitchen/StatTile.tsx` + `Lane.tsx`

```tsx
'use client';
export function StatTile({ n, l, tone = '' }: { n: string | number; l: string; tone?: 'indigo' | 'amber' | 'emerald' | '' }) {
    const c = { indigo: 'text-indigo-600', amber: 'text-amber-700', emerald: 'text-emerald-600', '': 'text-slate-900 dark:text-white' }[tone];
    return (
        <div className="flex flex-1 items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
            <span className={`text-2xl font-black tabular-nums ${c}`}>{n}</span>
            <span className="text-[11px] font-bold uppercase leading-tight tracking-wide text-slate-500">{l}</span>
        </div>
    );
}
export function Lane({ title, count, tone, children }: { title: string; count: number; tone: 'indigo' | 'amber' | 'emerald'; children: React.ReactNode }) {
    const c = { indigo: 'text-indigo-600', amber: 'text-amber-700', emerald: 'text-emerald-600' }[tone];
    return (
        <div className="rounded-2xl bg-slate-100 p-3 dark:bg-slate-800/60">
            <h3 className={`mb-3 flex items-center gap-2 px-1 text-xs font-black uppercase tracking-widest ${c}`}>
                {title}
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 tabular-nums text-slate-900 dark:bg-slate-900 dark:text-white">{count}</span>
            </h3>
            <div className="space-y-3">{children}</div>
        </div>
    );
}
```

### `components/kitchen/BatchCard.tsx` (the core interaction — matches prototype exactly)

```tsx
'use client';
import { useState } from 'react';

export function BatchCard({ batch, onPacked, onPrintPrep, onPrintLabels }: {
    batch: { bundle_id: string; bundle_name: string; status: string; total_quantity: number;
             order_count: number; recipes: Array<{ id: string; name: string; quantity: number }> };
    onPacked: () => void; onPrintPrep: () => void; onPrintLabels: () => void;
}) {
    // Check-off is LOCAL UI state (kitchen session), persisted per bundle+day so a
    // page refresh mid-shift doesn't lose progress:
    const key = `kb_${batch.bundle_id}_${new Date().toISOString().slice(0, 10)}`;
    const [done, setDone] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(key) ?? '[]')));
    const toggle = (id: string) => setDone(prev => {
        const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id);
        localStorage.setItem(key, JSON.stringify([...next])); return next;
    });
    const allDone = batch.recipes.length > 0 && batch.recipes.every(r => done.has(r.id));
    const pct = batch.recipes.length ? (done.size / batch.recipes.length) * 100 : 0;

    return (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-baseline gap-2">
                <b className="text-[15px] text-slate-900 dark:text-white">{batch.bundle_name}</b>
                <span className="ml-auto whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-extrabold text-amber-800">
                    {batch.order_count} order{batch.order_count === 1 ? '' : 's'}
                </span>
            </div>
            <p className="mb-1 mt-0.5 text-xs text-slate-500">
                Make <b>{batch.total_quantity} units</b> of each recipe · {batch.recipes.length} recipes
            </p>
            <div className="my-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="divide-y divide-dashed divide-slate-100 dark:divide-slate-800">
                {batch.recipes.map(r => (
                    <button key={r.id} onClick={() => toggle(r.id)}
                        className="flex w-full items-center gap-3 py-2 text-left text-sm">
                        <span className={`grid h-6 w-6 flex-none place-items-center rounded-lg border-2 text-xs font-black text-white transition ${
                            done.has(r.id) ? 'border-emerald-500 bg-emerald-500' : 'border-slate-300 dark:border-slate-600'}`}>
                            {done.has(r.id) ? '✓' : ''}
                        </span>
                        <span className={done.has(r.id) ? 'text-slate-400 line-through' : 'text-slate-800 dark:text-slate-200'}>{r.name}</span>
                        <span className="ml-auto text-xs font-bold tabular-nums text-slate-500">×{batch.total_quantity * r.quantity}</span>
                    </button>
                ))}
            </div>
            <div className="mt-3 flex gap-2">
                <button onClick={onPrintPrep} className="flex-1 rounded-xl bg-slate-100 py-2.5 text-xs font-extrabold text-slate-600 dark:bg-slate-800 dark:text-slate-300">🖨 Prep sheet</button>
                <button onClick={onPrintLabels} className="flex-1 rounded-xl bg-slate-100 py-2.5 text-xs font-extrabold text-slate-600 dark:bg-slate-800 dark:text-slate-300">🏷 Labels</button>
                <button onClick={onPacked} disabled={!allDone}
                    className="flex-[1.4] rounded-xl bg-amber-600 py-2.5 text-xs font-extrabold text-white disabled:opacity-40">
                    📦 All cooked → Pack
                </button>
            </div>
        </div>
    );
}
```

`onPacked` → existing `batch-update-by-bundle` to `ready_to_ship`. `onPrintLabels` → existing label print flow. In-production batches render the same card with a "Start cooking" primary (→ `in_production`) when status is `production_ready` — read the current PrepList for the exact fetch bodies and reuse them.

### Page assembly
Header: title + view tabs (Today's Board / Shopping & Prep Sheets / Schedule → links `app/production/schedule`) + Kitchen Mode toggle (`kitchen` class on the page root; CSS scales per prototype). Day chips (This week default / Today / Next week / Everything) drive a client-side filter on `delivery_date` (data already includes it — verify; if not, add the field to the dashboard select, additive). Stats row from the fetched data. Lanes: New orders (order cards: customer, bundle summary, due chip, paid ✓ from source/status, one **Approve** button → existing bulk-status `production_ready`; keep archive/delete in an overflow menu) · To cook (BatchCards) · Packed & ready (read-only list linking to the Delivery page — **the mark-delivered buttons are DELETED here**; keep label reprint).

---

## DD-1 — Delivery Day board

**Files:** `app/delivery/page.tsx` rebuild + `components/delivery2/*`. Keep intact and rewire: `openGoogleMaps`, the multi-stop `/maps/dir/` builder, the Auto-Arrange handler calling `/api/delivery/optimize`, dnd-kit sequence saving via `/api/delivery/route/reorder`, inventory CRUD (moves to its tab), BoxCounter math, stats fetch.

Structure per prototype: day chips (next delivery day default) · stat row (boxes left to pack / stops by zone / pickups in window / boxes needed ≈ $packaging using inventory costs) · three lanes:

- **Pack station** (`PackCard`): per order — checklist (meals pulled, labels on) with progress; "Loaded in van" unlocks at 100% (writes `ready_to_ship` if not already, records loaded state locally per day like BatchCard). Fundraiser handoff cards (DD-2) stage here.
- **Route** (`StopCard`): header buttons **⚡ Auto-arrange** (existing optimize call) + **🗺 Open full route in Google Maps** (existing URL builder); route progress bar; numbered stops in `delivery_sequence` order with drag grips, zone tag, Maps link, Call (`tel:`), and **✓ Delivered** (disabled until the order's PackCard is loaded) → orders PATCH `delivered` (now guarded by DD-0.5).
- **Pickups**: window-scoped `fulfillment_type=PICKUP` orders with payment state chip — unpaid manual orders show "owes $X — collect on pickup" (derive from invoice/payment fields already returned; if not derivable, show source chip only and note it).

Tabs: **Supplies & Boxes** (existing inventory CRUD + DD-5 cost/nudge later) · **Print Center** (buttons → existing print-manifest / print-packing-slips / print-batch / tracker pickup-sheet URLs, passing the selected day/week param). **Driver Mode** toggle mirrors Kitchen Mode. `/delivery/run` page becomes a redirect to the board's route lane (or stays as the phone-only deep link — implementer's choice; if kept, it inherits DD-0.4).

---

## DD-2 — Fundraiser Handoff Kit

New route `app/api/campaigns/[id]/handoff-labels/route.ts` (session + ownership check — copy the closeout route's pattern): groups the campaign's released orders by `customer_name`:

```ts
// after ownership check; campaign must be closed (closed_at set) or explicitly requested with ?includeHeld=false only
const orders = await prisma.order.findMany({
    where: { campaign_id: id, canceled_at: null, NOT: { status: 'fundraiser_hold' as any } },
    select: { id: true, customer_name: true, participant_name: true,
              items: { select: { quantity: true, bundle: { select: { name: true } } } } },
    orderBy: { customer_name: 'asc' },
});
const families = new Map<string, { name: string; items: Record<string, number>; orderCount: number }>();
for (const o of orders) {
    const key = (o.customer_name ?? 'Unknown').trim().toLowerCase();
    if (!families.has(key)) families.set(key, { name: o.customer_name ?? 'Unknown', items: {}, orderCount: 0 });
    const f = families.get(key)!; f.orderCount++;
    for (const it of o.items) if (it.bundle) f.items[it.bundle.name] = (f.items[it.bundle.name] ?? 0) + Number(it.quantity);
}
return NextResponse.json({ campaign_name: campaign.name, org_name: campaign.customer.name, families: [...families.values()] });
```

Label rendering: a print page `app/delivery/fundraiser-labels/[campaignId]/page.tsx` mirroring `print-batch`'s print CSS — one label per family per bag: **big customer name**, org + campaign line, contents list with counts, "Bag {i} of {n}" (n = ceil(total meals / mealsPerBag; mealsPerBag prompt, default 5), and the storefront QR (`qrcode.react`, existing dep) linking `/shop/{slug}` per SF-9. The Delivery board's handoff card gets "🏷 Print family bag labels (A–Z)" + the A–Z check-off list (local state per day, same pattern as PackCard). Compare output against `/api/tracker/pickup-sheet` totals — they MUST agree (same source data, assert in validation).

## DD-3 — Scan-to-deliver

Packing slips + bag labels gain an order QR (`qrcode.react`) encoding `freezeriq:order:{order_id}`. The existing scanner page (`app/scan` or `app/scanner` — read both, extend the one with the active `@yudiel/react-qr-scanner` flow) gets a **Delivery mode** toggle: on scan match of the prefix → confirm sheet ("Kim Reynolds — Family Favorites ×1 — mark delivered?") → orders PATCH `delivered` (guarded). Wrong-tenant scans fail naturally via the PATCH ownership check — verify a cross-tenant order id returns 403/404, not success.

## DD-4 — Notifications (per-tenant toggles, default OFF; never to fundraiser buyers)

Trigger points: "Loaded in van" per day (first load-out fires the batch) → **out-for-delivery** email to that day's route customers with an email on file ("Your meals are on the way — window {X}"); pack completion for PICKUP orders → **ready-for-pickup** ("Packed and ready — {window}, {location}"). Both via `lib/email.ts` `getTenantSender`/`sendEmail`, one template each in the existing template style, sent-log dedup per order+type (GrowthLog if merged, else a local dedupe check on an `Activity` record — read what exists). Orders with `source='fundraiser'` are ALWAYS skipped (no buyer emails in that flow, by design).

## DD-5 — Cleanup + cost visibility

Archive to `archive/` (git mv): `components/production/InProductionArea.tsx` (zero imports), `app/api/production/deduct/route.ts` (zero callers — re-verify with grep first). Supplies tab additions: packaging cost per selected day (BoxCounter count × inventory unit costs) and a low-stock nudge when `stock / avg boxes-per-week < 2` (from inventory quantities if tracked; if quantity isn't tracked in the inventory model, ship cost-per-run only and note it).

---

## Acceptance checklist

- [ ] DD-0: all five validations from the DD-0 block pass; backfill ran as approved proposal with printed counts.
- [ ] Closed-campaign orders flow: closeout → kitchen New lane → batch cook → pack → handoff card → labels A–Z → delivered/handed off. End-to-end on a test campaign.
- [ ] Every order appears in exactly one lane on each board; the same ticket is visible on Kitchen (until packed) and Delivery (from pack onward) with consistent status.
- [ ] Batch check-off survives a page refresh mid-shift (localStorage per bundle+day); Pack button locked until all recipes checked; Delivered locked until loaded.
- [ ] Auto-arrange still calls /api/delivery/optimize and reorders; full-route Maps link opens with all remaining stops in sequence; drag reorder still persists.
- [ ] Production page has ZERO delivered buttons; delivery run/board is the only delivered writer; scan-to-deliver respects the transition guard.
- [ ] Bag labels match pickup-sheet totals exactly; each label QR resolves to the tenant storefront.
- [ ] Notifications: default OFF; enabling sends once per order per type; fundraiser-source orders never emailed.
- [ ] Tablet 768px: both boards clean, no horizontal scroll; Kitchen/Driver Mode scales visibly.
- [ ] Per-phase diff gate; DD-0.5 and the backfill shipped as approved proposals; no locked files touched.
