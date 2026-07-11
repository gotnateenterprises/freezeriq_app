# CRM Redesign — Implementation Handoff (exact code)

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §5 — spec wins on any conflict.
**Approved look:** `docs/ai/prototypes/crm_prototype.html` — the approved interactive prototype, checked into this repo. Open it in a browser; whenever layout, spacing, copy, or color is ambiguous, match the prototype. The Tailwind classes below reproduce it — do not restyle.
**Phases:** CRM-1 (dashboard) → CRM-2 (org profile) → CRM-3 (customers toggle) → CRM-4 (wizard). Each is its own diff.

## HARD RULES

1. UI-layer only. Allowed files per phase are listed inside each phase. NEVER touch: `app/api/coordinator/**`, `app/api/checkout/**`, `app/api/webhooks/**`, `app/api/stripe/**`, `lib/pricing.ts`, `lib/serving_multipliers.ts`, `lib/kitchen_engine.ts`, `prisma/schema.prisma`, `middleware.ts`, `auth.ts`, `auth.config.ts`, RecipeEditor/BundleEditor.
2. New components go in `components/crm2/` (namespaced so the old CRM components keep working until each phase swaps them in).
3. Data comes from the EXISTING `/api/campaigns` and `/api/customers` responses. No API shape changes. Campaign rows already provide: `id, name, status, start_date, end_date, goal_amount, bundle_goal, sales_total, customer_id, customer{name, contact_name}, is_placeholder, business_slug, portal_token, held_order_count, held_order_total`, and (post-closeout) `closed_at, settlement_total`.
4. CRM-4 depends on 7B-0 (campaign POST ownership fix) and FIX-3 (tenant-branded templates). Verify both are merged before starting CRM-4; stop and report if not.
5. No new `@ts-ignore` / `as any`. Dark mode (`dark:`) variants on every new element.

## Design tokens

Card: `bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl`
Accent `indigo-600`; soft `bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200`
Money `text-emerald-600` · Urgency `bg-amber-50 text-amber-800` · Numbers `tabular-nums`
Muted `text-xs text-slate-500` · Section labels `text-[10px] font-extrabold uppercase tracking-widest text-slate-400`

## Shared: `components/crm2/StageChip.tsx`

```tsx
'use client';

const STAGE_STYLES: Record<string, string> = {
    lead:       'bg-amber-100 text-amber-800',
    agreement:  'bg-sky-100 text-sky-800',
    onboarding: 'bg-sky-100 text-sky-800',
    active:     'bg-emerald-100 text-emerald-700',
    production: 'bg-violet-100 text-violet-700',
    delivery:   'bg-indigo-100 text-indigo-700',
    closed:     'bg-orange-100 text-orange-800',
    settled:    'bg-slate-200 text-slate-600',
    archived:   'bg-slate-200 text-slate-600',
    completed:  'bg-orange-100 text-orange-800',
};

export function StageChip({ status }: { status: string }) {
    const key = (status || '').toLowerCase();
    return (
        <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${STAGE_STYLES[key] ?? 'bg-slate-100 text-slate-500'}`}>
            {status}
        </span>
    );
}

/** Closed-family predicate — keep in sync with app/fundraisers/page.tsx isCampaignClosed() */
export function isClosedFamily(f: { closed_at?: string | null; status: string }): boolean {
    return Boolean(f.closed_at) || ['Closed', 'Settled', 'Completed', 'Archived'].includes(f.status);
}
```

---

## CRM-1 — Fundraisers dashboard

**Files:** `app/fundraisers/page.tsx` + new `components/crm2/AttentionStrip.tsx`, `components/crm2/OrgGroupList.tsx`, `StageChip.tsx`. Keep the existing closeout modal, data fetch, and `isCampaignClosed` exactly as they are — this phase replaces the stat cards + table render only.

### `components/crm2/AttentionStrip.tsx`

```tsx
'use client';
import Link from 'next/link';

type Item = { emoji: string; title: string; sub: string; stripe: string; href: string };

export function AttentionStrip({ fundraisers }: { fundraisers: any[] }) {
    const now = Date.now(), week = 7 * 864e5, fortnight = 14 * 864e5;
    const real = fundraisers.filter(f => !f.is_placeholder);

    const endingSoon = real.filter(f => f.status === 'Active' && f.end_date &&
        new Date(f.end_date).getTime() - now > 0 && new Date(f.end_date).getTime() - now < week);
    const held = real.filter(f => (f.held_order_count ?? 0) > 0 && !f.closed_at);
    const heldTotal = held.reduce((s, f) => s + Number(f.held_order_total || 0), 0);
    const staleLeads = fundraisers.filter(f => f.status === 'Lead' &&
        (!f.updated_at || now - new Date(f.updated_at).getTime() > fortnight));

    const items: Item[] = [];
    if (endingSoon.length) items.push({
        emoji: '⏰', stripe: 'border-l-amber-500', href: '?filter=active',
        title: `${endingSoon.length} campaign${endingSoon.length > 1 ? 's' : ''} end within 7 days`,
        sub: endingSoon.slice(0, 3).map(f => f.customer?.name).join(' · '),
    });
    if (held.length) items.push({
        emoji: '📦', stripe: 'border-l-indigo-500', href: '?filter=active',
        title: `${held.reduce((s, f) => s + f.held_order_count, 0)} held orders · $${heldTotal.toLocaleString()} awaiting closeout`,
        sub: 'Close a campaign to release orders to production',
    });
    if (staleLeads.length) items.push({
        emoji: '📞', stripe: 'border-l-red-500', href: '?filter=lead',
        title: `${staleLeads.length} leads silent for 14+ days`,
        sub: staleLeads.slice(0, 4).map(f => f.customer?.name).join(' · '),
    });
    if (!items.length) return null;

    return (
        <div className="mb-4 flex flex-wrap gap-2.5">
            {items.map((it, i) => (
                <Link key={i} href={it.href}
                    className={`flex min-w-[220px] flex-1 items-center gap-2.5 rounded-xl border border-slate-200 border-l-4 bg-white px-3.5 py-2.5 dark:border-slate-800 dark:bg-slate-900 ${it.stripe}`}>
                    <span className="text-lg">{it.emoji}</span>
                    <span><b className="block text-[13px] text-slate-900 dark:text-white">{it.title}</b>
                    <span className="text-[11px] text-slate-500">{it.sub}</span></span>
                </Link>
            ))}
        </div>
    );
}
```

### `components/crm2/OrgGroupList.tsx`

```tsx
'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { StageChip } from './StageChip';

export function OrgGroupList({
    fundraisers, filter, query, onCloseout,
}: {
    fundraisers: any[];                 // rows from /api/campaigns (existing shape)
    filter: string;                     // 'all' | 'lead' | 'onboarding' | 'active' | 'production' | 'closed'
    query: string;
    onCloseout: (f: any) => void;       // existing openCloseoutModal
}) {
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    const groups = useMemo(() => {
        const q = query.toLowerCase();
        const matchesFilter = (f: any) =>
            filter === 'all' ? true :
            filter === 'closed' ? ['closed', 'settled', 'completed', 'archived'].includes((f.status || '').toLowerCase()) || f.closed_at :
            (f.status || '').toLowerCase() === filter;
        const matchesQuery = (f: any) => !q ||
            f.name?.toLowerCase().includes(q) ||
            f.customer?.name?.toLowerCase().includes(q) ||
            f.customer?.contact_name?.toLowerCase().includes(q);

        const map = new Map<string, { org: any; camps: any[] }>();
        for (const f of fundraisers) {
            if (!matchesFilter(f) || !matchesQuery(f)) continue;
            const key = f.customer_id;
            if (!map.has(key)) map.set(key, { org: f, camps: [] });
            map.get(key)!.camps.push(f);
        }
        return [...map.values()];
    }, [fundraisers, filter, query]);

    if (!groups.length) return <p className="py-10 text-center text-sm text-slate-400">No campaigns match.</p>;

    const initials = (name: string) => name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    return (
        <div className="space-y-3">
            {groups.map(({ org, camps }) => {
                const heldCount = camps.reduce((s, c) => s + (c.held_order_count ?? 0), 0);
                const heldTotal = camps.reduce((s, c) => s + Number(c.held_order_total ?? 0), 0);
                const isCollapsed = collapsed[org.customer_id];
                return (
                    <div key={org.customer_id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                        {/* org header */}
                        <button onClick={() => setCollapsed(p => ({ ...p, [org.customer_id]: !p[org.customer_id] }))}
                            className="flex w-full items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3 text-left dark:border-slate-800 dark:bg-slate-800/40">
                            <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-indigo-50 text-xs font-black text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">
                                {initials(org.customer?.name ?? '?')}
                            </span>
                            <span className="min-w-0">
                                <b className="block truncate text-sm text-slate-900 dark:text-white">{org.customer?.name}</b>
                                <span className="text-[11px] text-slate-500">Coordinator: {org.customer?.contact_name || '—'}</span>
                            </span>
                            <span className="ml-auto flex items-center gap-4">
                                {heldCount > 0 && (
                                    <span className="text-right"><b className="block text-[13px] tabular-nums">{heldCount} held</b>
                                    <span className="text-[10px] uppercase tracking-wide text-slate-400">${heldTotal.toLocaleString()}</span></span>
                                )}
                                <span className="text-right"><b className="block text-[13px] tabular-nums">{camps.length}</b>
                                <span className="text-[10px] uppercase tracking-wide text-slate-400">campaign{camps.length > 1 ? 's' : ''}</span></span>
                                <span className={`text-slate-400 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}>▾</span>
                            </span>
                        </button>
                        {/* campaign rows */}
                        {!isCollapsed && camps.map(c => (
                            <div key={c.id} className="grid grid-cols-[1fr_120px_150px_190px_auto] items-center gap-3 border-b border-slate-100 py-2.5 pl-12 pr-4 last:border-b-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50">
                                <Link href={`/fundraisers/${c.customer_id}`} className="min-w-0">
                                    <b className="block truncate text-[13px] text-slate-900 dark:text-white">{c.name}</b>
                                    <span className="text-[11px] text-slate-400">ID {String(c.id).slice(0, 8)}</span>
                                </Link>
                                <StageChip status={c.closed_at ? 'Closed' : c.status} />
                                <span className="text-xs text-slate-500">
                                    {c.end_date ? new Date(c.end_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No date'}
                                </span>
                                <CampaignProgress c={c} />
                                <span className="flex justify-end gap-1.5">
                                    {c.status === 'Active' && !c.closed_at && (<>
                                        {c.portal_token && <Link href={`/coordinator/${c.portal_token}`} target="_blank" className="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Portal</Link>}
                                        <button onClick={() => onCloseout(c)} className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] font-bold text-amber-800">Close out</button>
                                    </>)}
                                    {c.settlement_total != null && Number(c.settlement_total) > 0 && (
                                        <Link href={`/customers/${c.customer_id}?tab=fundraisers&action=invoice&campaignId=${c.id}&amount=${c.settlement_total}`}
                                            className="rounded-lg border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-[11px] font-bold text-emerald-800">Invoice</Link>
                                    )}
                                    {c.is_placeholder && (
                                        <Link href={`/fundraisers/${c.customer_id}`} className="rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-bold text-slate-600 dark:border-slate-700 dark:text-slate-300">Follow up</Link>
                                    )}
                                </span>
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

function CampaignProgress({ c }: { c: any }) {
    if (c.settlement_total != null && Number(c.settlement_total) > 0) {
        return <span className="text-xs font-extrabold text-orange-800">Settled: ${Number(c.settlement_total).toLocaleString()}</span>;
    }
    const goal = Number(c.bundle_goal || 0);
    if (!goal) return <span className="text-[11px] italic text-slate-400">No goal yet — set one →</span>;
    const sold = Number(c.sales_total || 0); // dollars; if a bundle-count metric exists, prefer it
    const pct = Math.min((sold / Number(c.goal_amount || goal * 100 || 1)) * 100, 100);
    return (
        <span>
            <b className="text-xs tabular-nums">${sold.toLocaleString()}</b>
            <span className="text-[11px] text-slate-400"> · goal {goal} bundles</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <span className="block h-full rounded-full bg-indigo-600" style={{ width: `${pct}%` }} />
            </span>
        </span>
    );
}
```

**Wiring in `app/fundraisers/page.tsx`:** keep fetch/closeout logic; replace the 3 stat cards with `<AttentionStrip fundraisers={fundraisers} />`; replace the `<table>` with search input + chip row (All/Leads/Onboarding/Active/Production/**Closed**) + `<OrgGroupList fundraisers={filtered} filter={filterStatus} query={searchQuery} onCloseout={openCloseoutModal} />`. The Closed chip's predicate must use the closed-family match (fixes the COMPLETED mismatch). Keep the "Launch New Fundraiser" CTA but relabel **"+ Start a Fundraiser"** (it will target the wizard in CRM-4).

**Validate:** counts match old table; closed/settled campaigns appear under Closed; placeholder rows show only Follow up; org groups collapse; search hits org, coordinator, campaign names.

---

## CRM-2 — Organization profile

**Files:** `app/fundraisers/[id]/page.tsx` (render layer; keep `fetchCustomer`, save handlers, tabs data intact) + new `components/crm2/PipelineStepper.tsx`, `components/crm2/CampaignCard.tsx`.

### `components/crm2/PipelineStepper.tsx`

```tsx
'use client';

const STAGES = ['Lead', 'Agreement', 'Onboarding', 'Active', 'Production', 'Delivery', 'Closed'];

export function PipelineStepper({ current, onAdvance }: { current: string; onAdvance?: (stage: string) => void }) {
    const norm = ['Settled', 'Completed', 'Archived'].includes(current) ? 'Closed' : current;
    const idx = Math.max(STAGES.indexOf(norm), 0);
    return (
        <div className="flex overflow-x-auto rounded-2xl border border-slate-200 bg-white px-5 py-3.5 dark:border-slate-800 dark:bg-slate-900">
            {STAGES.map((s, i) => (
                <button key={s} onClick={() => onAdvance?.(s)} disabled={!onAdvance}
                    className="relative min-w-[86px] flex-1 text-center text-[10px] font-extrabold uppercase tracking-wide disabled:cursor-default">
                    <span className={`relative z-10 mx-auto mb-1.5 block h-3 w-3 rounded-full ${
                        i < idx ? 'bg-emerald-500' : i === idx ? 'bg-indigo-600 ring-4 ring-indigo-100 dark:ring-indigo-950' : 'bg-slate-200 dark:bg-slate-700'}`} />
                    {i < STAGES.length - 1 && (
                        <span className={`absolute left-[calc(50%+8px)] top-[5px] h-0.5 w-[calc(100%-16px)] ${i < idx ? 'bg-emerald-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                    )}
                    <span className={i < idx ? 'text-emerald-700' : i === idx ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-400'}>{s}</span>
                </button>
            ))}
        </div>
    );
}
```

`onAdvance` wires to the existing status PATCH (`/api/campaigns/[id]` or the customer status route the page already uses) — advancing to "Closed" must route through the existing closeout modal, never a bare status write.

### `components/crm2/CampaignCard.tsx`

```tsx
'use client';
import Link from 'next/link';
import { StageChip } from './StageChip';

export function CampaignCard({ c, businessSlug }: { c: any; businessSlug?: string }) {
    const closed = Boolean(c.closed_at) || ['Closed', 'Settled'].includes(c.status);
    const daysLeft = c.end_date ? Math.max(Math.ceil((new Date(c.end_date).getTime() - Date.now()) / 864e5), 0) : null;
    return (
        <section className="mb-3.5 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center gap-2.5">
                <h3 className="text-[15px] font-black text-slate-900 dark:text-white">{c.name}</h3>
                <StageChip status={closed ? 'Closed' : c.status} />
            </div>
            <p className="mb-2.5 mt-0.5 text-[11px] text-slate-500">
                {closed && c.closed_at ? `Closed ${new Date(c.closed_at).toLocaleDateString()}` :
                 c.end_date ? `Ends ${new Date(c.end_date).toLocaleDateString()}` : 'No end date'}
                {c.bundle_goal ? ` · Goal: ${c.bundle_goal} bundles` : ''}
            </p>

            {!closed && (
                <>
                    <div className="flex gap-2">
                        <Stat v={`$${Number(c.total_sales ?? c.sales_total ?? 0).toLocaleString()}`} l="sales" money />
                        <Stat v={String(c.held_order_count ?? 0)} l="held orders" />
                        {daysLeft != null && <Stat v={String(daysLeft)} l="days left" />}
                    </div>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {businessSlug && <Kit href={`/shop/${businessSlug}/fundraiser/${c.id}`} label="🛒 Public order page" />}
                        {c.portal_token && <Kit href={`/coordinator/${c.portal_token}`} label="🎯 Coordinator portal" />}
                        {c.public_token && <Kit href={`/fundraiser/${c.public_token}`} label="🏆 Scoreboard" />}
                    </div>
                </>
            )}

            {closed && c.settlement_total != null && (
                <div className="mt-1 flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 px-3.5 py-2.5 dark:border-orange-900 dark:bg-orange-950">
                    <span>💰</span>
                    <span className="text-[12px] text-orange-900 dark:text-orange-200">
                        <b className="text-sm tabular-nums">${Number(c.settlement_total).toLocaleString()}</b><br />
                        Settlement frozen at closeout{c.invoice_id ? ' — invoiced ✓' : ' — not yet invoiced'}
                    </span>
                    {!c.invoice_id && (
                        <Link href={`/customers/${c.customer_id}?tab=fundraisers&action=invoice&campaignId=${c.id}&amount=${c.settlement_total}`}
                            className="ml-auto rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-extrabold text-white">Create invoice</Link>
                    )}
                </div>
            )}
        </section>
    );
}

function Stat({ v, l, money = false }: { v: string; l: string; money?: boolean }) {
    return (
        <div className="flex-1 rounded-xl bg-slate-50 px-2 py-1.5 text-center dark:bg-slate-800">
            <b className={`block text-sm tabular-nums ${money ? 'text-emerald-600' : 'text-slate-900 dark:text-white'}`}>{v}</b>
            <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{l}</span>
        </div>
    );
}
function Kit({ href, label }: { href: string; label: string }) {
    return <Link href={href} target="_blank" className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">{label}</Link>;
}
```

**Note:** `invoice_id` on a campaign does not exist yet — treat it as optional (`c.invoice_id` undefined ⇒ show "Create invoice"). When the 7E settlement-invoice work adds the link, this card lights up automatically.

**Header layout** (inline in the page): avatar initials + org name + "Organization · N campaigns" + contact links (coordinator, mailto, tel) with `✉️ Send email` (ghost) and `+ New campaign` (primary) buttons right-aligned. Move the existing edit form behind an "Edit" action.

---

## CRM-3 — Customers unification

**File:** `app/customers/page.tsx` only. Add a segmented toggle above the table:

```tsx
const [lens, setLens] = useState<'people' | 'orgs'>('people');
// people: type === 'Individual' (or direct_customer)
// orgs:   type === 'Organization' || type === 'Fundraiser' (fundraiser_org/organization)
```

```tsx
<div className="flex w-fit rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
    {(['people', 'orgs'] as const).map(t => (
        <button key={t} onClick={() => setLens(t)}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-extrabold ${lens === t ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-600'}`}>
            {t === 'people' ? 'People' : 'Organizations'}
        </button>
    ))}
</div>
```

Filter the existing rows by the lens; org rows' primary link goes to `/fundraisers/{id}` (the CRM-2 profile) instead of `/customers/{id}`. Keep the existing table/grouped-columns for both lenses — this phase is filtering + routing, not a table rewrite.

---

## CRM-4 — Start a Fundraiser wizard

**Files:** new `components/crm2/StartFundraiserWizard.tsx` (modal or route `app/fundraisers/new/page.tsx` — implementer's choice, modal preferred) + swap the dashboard CTA to open it. **Verify 7B-0 and FIX-3 are merged first — stop and report if not.**

> **⚠ CB-4 AMENDMENT (spec §8 — Coordinator Bundle Selection).** Before implementing
> Step 2's bundle picker, check whether CB-1 (schema: `CampaignBundle.state`,
> `FundraiserCampaign.bundle_selection_status/_at/_limit`, `Bundle.family_id`) is merged:
> - **CB-1 merged →** Step 2 builds the CANDIDATE POOL, not active assignments:
>   the picker selects bundle FAMILIES (grouped by `family_id`, both tiers shown as
>   one card); writing = `state='candidate'` rows + `bundle_selection_status='pending'`
>   + a "coordinator chooses" limit input (default 2). Families missing an active
>   Serves-2 pair are shown disabled with "create the Serves 2 version first."
>   Step 3's launch kit then features the coordinator portal link with copy:
>   "First step for your coordinator: choose their {N} bundles."
> - **CB-1 NOT merged →** build Step 2 as originally specified below (direct active
>   assignments via `/api/campaigns/[id]/bundles`); CB-4 will migrate it later.
> GE-10 seasonal suggestions pre-check the pool in both modes.

Orchestration (existing endpoints, this exact order, stop-and-surface on any failure):

```ts
// Step 1 → dup check while typing (existing list endpoint):
GET /api/customers            // filter client-side: name match + type org — offer "use existing"
// on Create:
1. POST /api/customers        // only if not using existing — body: { name, contact_name, contact_email, contact_phone, type: 'Organization' }
2. POST /api/campaigns        // { customerId, name, bundleGoal, endDate }  → returns campaign with portal_token/public_token
3. POST /api/campaigns/{id}/bundles   // selected bundle ids
4. GET  /api/flyer/download?campaignId=...        // flyer PDF (existing route/params — verify exact query shape before calling)
5. POST /api/documents/tracking-sheet             // tracking/sales sheet (existing body shape)
6. Draft info-packet email via the SHARED template helper (post-FIX-3, tenant-branded)
   — display with Send now (POST /api/email/send) / Preview / Send later. NEVER auto-send.
```

Step panes (same look as prototype):

```tsx
// Step shell
<div className="mx-auto max-w-[620px] rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">

// Dup-check banner (step 1, shown when name matches an existing org)
<div className="mb-3 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[13px] dark:bg-amber-950">
        ⚠️ <b>{existing.name}</b> already exists ({existing.contact_name}) —
        <button onClick={() => useExisting(existing)} className="font-extrabold text-indigo-600">use existing</button>
    </div>
    <div className="px-3 py-2 text-[11px] text-slate-400">…or create new below</div>
</div>

// Inputs
<label className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400">Organization
    <input className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white" />
</label>

// Bundle checklist (step 2)
<label className="flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] font-semibold text-slate-700 has-[:checked]:border-indigo-600 has-[:checked]:bg-indigo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:has-[:checked]:bg-indigo-950">
    <input type="checkbox" /> {bundle.name} · ${bundle.price}
</label>

// Launch kit result card (step 3, one per artifact)
<div className="rounded-2xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
    <b className="text-[13px]">🎯 Coordinator portal</b>
    <p className="my-1 truncate font-mono text-[11px] text-slate-500">{portalUrl}</p>
    <button onClick={() => copy(portalUrl)} className="rounded-lg bg-indigo-50 px-2.5 py-1.5 text-[11px] font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">Copy link</button>
</div>

// Success banner (step 3, top)
<div className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
    <b className="text-sm">🎉 Fundraiser created — launch kit ready</b>
    <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">Everything below was generated automatically.</p>
</div>
```

Stepper header: reuse `PipelineStepper` pattern with 3 steps (`1 · Organization`, `2 · Campaign`, `3 · Launch Kit`).

**Rules:** partial-failure handling — if any post-create generation step fails, the campaign still exists; show the kit with the failed item marked "retry" (do NOT roll back the campaign). If `/api/flyer/download` needs different params than assumed, read that route first and adapt — do not modify the route.

### `components/crm2/StartFundraiserWizard.tsx` (complete skeleton — fill fetch shapes from real routes)

```tsx
'use client';
import { useEffect, useState } from 'react';

type Prefill = { customerId?: string; orgName?: string; goal?: number };

export function StartFundraiserWizard({ prefill, onClose }: { prefill?: Prefill; onClose: () => void }) {
    const [step, setStep] = useState(prefill?.customerId ? 2 : 1);
    const [busy, setBusy] = useState(false);
    // Step 1 state
    const [org, setOrg] = useState({ name: prefill?.orgName ?? '', contact_name: '', contact_email: '', contact_phone: '' });
    const [existing, setExisting] = useState<any>(null);        // dup match
    const [useExistingId, setUseExistingId] = useState<string | null>(prefill?.customerId ?? null);
    // Step 2 state
    const year = new Date().getFullYear();
    const [camp, setCamp] = useState({ name: '', endDate: '', bundleGoal: prefill?.goal ?? 0 });
    const [bundles, setBundles] = useState<any[]>([]);          // GE-10 response rows
    const [picked, setPicked] = useState<Set<string>>(new Set());
    // Step 3 state
    const [kit, setKit] = useState<any>(null);                  // { campaign, portalUrl, orderUrl, failures: string[] }

    // Dup-check while typing (Step 1) — client-side filter of the existing customers list
    useEffect(() => {
        if (step !== 1 || org.name.trim().length < 3) { setExisting(null); return; }
        const t = setTimeout(async () => {
            const res = await fetch('/api/customers', { cache: 'no-store' });
            const data = await res.json();
            const list = data.customers || data;
            const hit = list.find((c: any) =>
                (c.type === 'Organization' || c.type === 'Fundraiser') &&
                c.name?.toLowerCase().includes(org.name.trim().toLowerCase()));
            setExisting(hit ?? null);
        }, 350);
        return () => clearTimeout(t);
    }, [org.name, step]);

    // Load GE-10 suggestions when entering Step 2 (re-runs when end date changes → season-aware)
    useEffect(() => {
        if (step !== 2) return;
        const params = new URLSearchParams();
        if (useExistingId) params.set('customerId', useExistingId);
        if (camp.endDate) params.set('campaignEnd', camp.endDate);
        fetch(`/api/growth/bundle-suggestions?${params}`)
            .then(r => r.json())
            .then(d => {
                setBundles(d.bundles ?? []);
                setPicked(new Set((d.bundles ?? []).filter((b: any) => b.suggested).map((b: any) => b.id)));
                if (!camp.name) setCamp(c => ({ ...c, name: `${org.name || existing?.name || ''} ${d.season_label} ${year}`.trim() }));
            });
    }, [step, camp.endDate, useExistingId]);

    // Step 3 orchestration — EXISTING endpoints, in order; partial failures collected
    const launch = async () => {
        setBusy(true);
        const failures: string[] = [];
        try {
            let customerId = useExistingId;
            if (!customerId) {
                const res = await fetch('/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...org, type: 'Organization' }) });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not create organization');
                customerId = data.id;
            }
            const cRes = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ customerId, name: camp.name, bundleGoal: camp.bundleGoal, endDate: camp.endDate }) });
            const campaign = await cRes.json();
            if (!cRes.ok) throw new Error(campaign.error || 'Could not create campaign');

            const bRes = await fetch(`/api/campaigns/${campaign.id}/bundles`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundleIds: [...picked] }) });
            if (!bRes.ok) failures.push('bundles');

            setKit({
                campaign, failures,
                portalUrl: `${window.location.origin}/coordinator/${campaign.portal_token}`,
                orderUrl: null, // build /shop/{slug}/fundraiser/{id} from the business slug the page already loads
            });
            setStep(3);
        } catch (e: any) {
            alert(e.message); // match the codebase's existing toast pattern instead if available
        } finally { setBusy(false); }
    };

    /* RENDER — all styling per the prototype (docs/ai/prototypes/crm_prototype.html, wizard screen).
       Shell: fixed overlay + max-w-[620px] white rounded-2xl card (same classes as AutoBundleModal).
       3-step header: reuse PipelineStepper with steps ['1 · Organization','2 · Campaign','3 · Launch Kit'].
       Step 1: search-style name input; amber dup banner when `existing` (“{name} already exists — use existing”
         → setUseExistingId(existing.id); setStep(2)); 2×2 grid of labeled inputs (label classes from CRM-3 snippet).
       Step 2: name/endDate/goal inputs; GE-9 below-minimum amber warning when bundleGoal*125 < 1250;
         bundle checklist rows per the GE-10 render rules (badges, has-[:checked] highlight), toggling `picked`;
         GE-6 checkbox “Show a team leaderboard on the public scoreboard”;
         footer: ghost “← Back” + primary “Create & build launch kit →” (calls launch(), disabled while busy).
       Step 3: emerald success banner; 2×2 kit cards (portal link + copy, order page link + copy, flyer download
         → existing flyer URL, tracking sheet → existing docs URL) with any `failures` rendered as amber “retry”
         chips; info-packet email card with Send now / Preview / Send later (drafted via shared post-FIX-3
         template helper — NEVER auto-send); “Done” closes and refreshes the dashboard. */
    return null; // replace with the render described above — every visual element exists in the prototype
}
```

**Validate:** full run creates org + campaign + bundle assignments visible on the dashboard group; dup-check offers the existing Karen Seuring org; kit links resolve (portal opens, order page opens); email drafts with tenant branding (no MyFreezerChef strings); nothing auto-sends; `git diff --stat` per phase shows only that phase's files.
