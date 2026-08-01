# Storefront Redesign — Implementation Handoff (exact code)

**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` §9 — spec wins on any conflict.
**Pixel reference:** `docs/ai/prototypes/storefront_prototype.html` — open in a browser; 6 screens (First visit / Returning / Bundle / Bag / Confirmation / Fundraiser). Match it whenever look, spacing, or copy is ambiguous.
**Phases:** SF-1 → SF-12 per spec. Each phase = its own reviewable diff.

**SF-1 status: ✅ Complete — commit `a96b7f4`.** `lib/storefront/brandTokens.ts` ships the
14 `--sf-*` color/surface variables; the regular storefront routes (StorefrontClient,
account, login, loyalty, subscribe) inject them from branding each route already loads;
all 13 eligible inline `primary_color`/`primaryColor` styles under `app/shop/**` were
converted. Six curated primary-color presets were added in
`components/admin/BrandingSettings.tsx` (the actual existing branding-color component —
not `StorefrontSettings.tsx` as originally named below), writing through the existing
`primary_color` state and the existing `POST /api/tenant/branding` save flow; the existing
custom color inputs remain available alongside the presets. **Unsaved-draft live preview
is explicitly deferred** — the repository has no approved seam for previewing colors
before Save (no preview query parameter, `postMessage`, temporary/global preview state,
new API, server action, or persistence was introduced to build one). The saved
`/shop/{slug}` storefront remains the available post-save visual verification path. This
deferral does not block SF-1 closure.

**SF-2 status: ✅ Complete — commit `717840c`.** Fable storefront landing shell ported to
`StorefrontClient.tsx` with 8 new `components/storefront/` files: `StorefrontTopbar`,
`LandingHero`, `HowItWorksChips`, `GreetingCard`, `FounderNote`, `QuoteBlock`,
`EmailCaptureCard`, `WeekStrip`. `CountdownBanner` and `DealsPopup` removed from render
(files left in place). First-visit / returning-visit conditional rendering via
`localStorage sf_last_order` with malformed-input sanitization. Category chips, founder
note, and quote block render only when real tenant data exists — no invented content.
Accepted data-dependent deferrals (not missing features):

1. WelcomeOfferCard deferred until a real tenant discount and automatic-application path exist.
2. YourUsualCard deferred until grounded customer order-history and reorder data exist.
3. CUSTOMER FAVORITE badge deferred until real tenant-scoped order-tally data exist.
4. QuoteBlock stars render only when real rating data exist (truthfulness deviation from prototype's illustrative ★★★★★).
5. FreeDeliveryBar renders nothing without a configured threshold.
6. Topbar retains a discoverable My Account link (no points chip without live loyalty).
7. Real tenant images replace prototype placeholder treatments.
8. Category chips map to real storefront sections (not prototype's illustrative labels).
9. Bundle detail uses a modal rather than a full-page transition.

SF-2 validation: `npx tsc --noEmit` passed; production build passed (166/166 pages);
storefront runtime reviewed at `localhost:3001/shop/my-freezer-chef`; first-visit UI
confirmed functional; returning-visit logic code-verified. SF-1 docs closeout: `855d4b1`.

**SF-3 status: ✅ Complete — commit `4234c93`.** Fable bundle shopping experience ported
with 7 new `components/storefront/` files: `BundleCard`, `BundleDetail`, `CategoryChips`,
`ServingToggle`, `PairingSuggestion`, `StickyCartBar`, `FreeDeliveryBar`. Family pairing
uses only exact non-null `family_id` (CB-1) — no name/price/SKU heuristics. Bundle cards
render with real recipe names, emoji fallback for missing images, and a PERFECT FIRST TRY
badge on the lowest-priced multi-meal entry for first-visit users. Cart integration uses
the existing `CartContext` contract unchanged. BundleDetail dialog with `role="dialog"`,
`aria-modal`, Escape close. Responsive grid: 1 / 2 / 3 columns at mobile / sm / lg.

**SF-3E status: ✅ Complete — commit `a1a94c9`.** Zero-regular-bundles empty state added
inline in the `#shop-bundles` grid. When `displayEntries.length === 0`, a calm editorial
card renders: "This week's menu is being prepared." / "Check back soon for new menu
options." Uses `--sf-*` tokens, `col-span-full`, no fabricated dates or promises.

SF-3 validation: `npx tsc --noEmit` passed; production build passed (166/166 pages);
bundle-card shopping, cart access, and checkout reachability confirmed at runtime; serving
toggle, category chips, pairing suggestion, sticky cart bar all verified; no relevant
browser-console or network failures. **SF-4 is the next active storefront phase.**

## HARD RULES

1. **Locked and untouchable:** `app/api/checkout/**`, `app/api/webhooks/**`, `app/api/public/order/route.ts`, `app/api/stripe/**`, `prisma/schema.prisma` (except the SF-6 proposal), `middleware.ts`, `auth.ts`. The CheckoutModal's details/payment/confirm steps are UNTOUCHED — SF re-skins the bag step and the pages around checkout only.
2. New components in `components/storefront/`. The existing `components/shop/*` stay in place until each SF phase swaps a section in; `DealsPopup` and `CountdownBanner` are removed from the RENDER (SF-2), their files left alone.
3. Every component styles through the **brand tokens** (SF-1) — never a hardcoded brand color. Hardcoding `#a64d66` anywhere = defect; that berry is only the DEFAULT palette value.
4. Data sources are existing: the public tenant API (bundles where `show_on_storefront`, each with `order_cutoff_date`), `TenantBranding` (`primary_color/secondary_color/accent_color/logo_url`), `StorefrontConfig` (hero copy, testimonials, upsell config, how-it-works), LoyaltyPoint, DiscountCode. New fetches only where a phase says so.
5. SF-12 (wallets) is verification + Stripe dashboard config ONLY. Any code change to session creation = stop and propose.
6. No new `@ts-ignore`/`as any`. Mobile-first: every screen must be clean at 375px; test each phase there first.

---

## SF-1 — Brand token system (foundation — build first)

### `lib/storefront/brandTokens.ts`

```ts
/**
 * SF-1: derives the full storefront palette from the tenant's TenantBranding colors.
 * One injection point; every storefront component reads CSS vars, never raw hex.
 */
type HSL = { h: number; s: number; l: number };

function hexToHsl(hex: string): HSL | null {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return null;
    const [r, g, b] = [m[1], m[2], m[3]].map(x => parseInt(x, 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s, l };
}
const hsl = ({ h, s, l }: HSL) => `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

/** WCAG-ish: white text on the primary unless it's too light. */
function onColor(c: HSL): string {
    return c.l > 0.62 ? 'hsl(0 0% 12%)' : '#ffffff';
}

export const DEFAULT_PRIMARY = '#a64d66'; // berry — the prototype default

export function buildBrandVars(primaryHex?: string | null, accentHex?: string | null): Record<string, string> {
    const p = hexToHsl(primaryHex || DEFAULT_PRIMARY) ?? hexToHsl(DEFAULT_PRIMARY)!;
    // Clamp so neon/near-white brand colors still produce a usable UI
    const primary: HSL = { h: p.h, s: Math.min(Math.max(p.s, 0.25), 0.75), l: Math.min(Math.max(p.l, 0.3), 0.55) };
    const warm = primary.h >= 330 || primary.h <= 90; // warm hues get the linen world, cool get a cooler cream
    return {
        '--sf-primary': hsl(primary),
        '--sf-on-primary': onColor(primary),
        '--sf-primary-press': hsl({ ...primary, l: primary.l - 0.07 }),
        '--sf-soft': hsl({ ...primary, s: primary.s * 0.45, l: 0.94 }),          // chips, highlight cards
        '--sf-soft-border': hsl({ ...primary, s: primary.s * 0.35, l: 0.86 }),
        '--sf-ground': warm ? 'hsl(35 45% 96%)' : 'hsl(210 25% 97%)',            // page background
        '--sf-card': '#ffffff',
        '--sf-line': warm ? 'hsl(30 30% 89%)' : 'hsl(215 20% 90%)',
        '--sf-ink': warm ? 'hsl(345 15% 20%)' : 'hsl(220 20% 18%)',
        '--sf-muted': warm ? 'hsl(20 15% 55%)' : 'hsl(220 10% 52%)',
        '--sf-gold': 'hsl(42 65% 90%)', '--sf-gold-ink': 'hsl(35 50% 33%)',      // loyalty/points
        '--sf-sage': 'hsl(105 15% 50%)',                                          // success / progress fill
        '--sf-accent': accentHex || hsl({ ...primary, h: (primary.h + 30) % 360 }),
    };
}
```

### Injection — in the shop layout (`app/shop/[slug]/layout.tsx` or the client root)

```tsx
import { buildBrandVars } from '@/lib/storefront/brandTokens';
// branding = the TenantBranding already fetched for this slug
const vars = buildBrandVars(branding?.primary_color, branding?.accent_color);
return (
    <div style={vars as React.CSSProperties} className="min-h-screen bg-[var(--sf-ground)] text-[var(--sf-ink)]">
        {children}
    </div>
);
```

**Refactor pass:** replace all 19 existing inline `style={{ backgroundColor: primary_color }}` usages under `app/shop/**` with `bg-[var(--sf-primary)] text-[var(--sf-on-primary)]` etc. Behavior-identical, verified page by page.

**Curated palettes** — ✅ implemented in `components/admin/BrandingSettings.tsx` (additive UI, the actual existing branding-color component): six swatches writing `primary_color` — Berry `#a64d66` (default, imported as `DEFAULT_PRIMARY`), Sage `#6c7f5e`, Navy `#33506b`, Terracotta `#b0603f`, Plum `#6d4467`, Charcoal `#3d4045` — plus the existing custom color inputs. The live preview iframe described here would require previewing *unsaved* draft colors; no approved seam for that exists in the repository (it would need a preview query parameter, `postMessage`, temporary/global preview state, a new API, or a server action — none of which is authorized). **Deferred, not built.** The saved `/shop/{slug}` storefront is the available post-save preview.

---

## SF-2 — Landing re-orchestration

**File:** `app/shop/[slug]/StorefrontClient.tsx` (render order + conditionals; data fetch untouched) + new components below. **Remove `<CountdownBanner/>` and `<DealsPopup/>` from the render.**

**Returning detection:** `const isReturning = Boolean(customerSession) || Boolean(localStorage.getItem('sf_last_order'))` (set that key on the confirmation page). New render order:

```
Topbar (logo + name + [points chip | welcome-offer chip])
WeekStrip
Hero (config headline; first-visit gets the hook default)
[first] HowItWorksChips   [returning] —
[first] WelcomeOfferCard  [returning] YourUsualCard
Category chips (existing FilterBar/StickyCategoryBar consolidated to one row)
Bundle cards (SF-3)
FounderNote → QuoteBlock (best testimonial)
[first] EmailCaptureCard
FreeDeliveryBar + StickyCartBar (SF-3)
(Fundraisers / surplus sections remain below, unchanged)
```

### `components/storefront/WeekStrip.tsx`

```tsx
'use client';

export function WeekStrip({ bundles }: { bundles: Array<{ order_cutoff_date?: string | null }> }) {
    const cutoffs = bundles.map(b => b.order_cutoff_date).filter(Boolean).map(d => new Date(d!));
    if (!cutoffs.length) return null;
    const next = new Date(Math.min(...cutoffs.map(d => d.getTime())));
    if (next.getTime() < Date.now()) return null;
    const week = new Date(next); week.setDate(week.getDate() + 4); // delivery week ≈ cutoff + lead; adjust to tenant settings if present
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const day = next.toLocaleDateString('en-US', { weekday: 'short' });
    return (
        <div className="flex items-center gap-2 bg-[var(--sf-soft)] px-4 py-2 text-xs font-semibold text-[var(--sf-ink)]">
            📦 Ordering for the week of <b>{fmt(week)}</b> · order by {day} 9pm
        </div>
    );
}
```

### `components/storefront/HowItWorksChips.tsx`

```tsx
'use client';
const STEPS = [
    { e: '🛒', t: 'Order by Wed', s: 'pick your meals' },
    { e: '👩‍🍳', t: 'We cook fresh', s: 'small batches' },
    { e: '🧊', t: 'Stock & relax', s: 'dinner in 25 min' },
];
export function HowItWorksChips() {
    return (
        <div className="flex gap-2 px-4 pt-3">
            {STEPS.map(x => (
                <div key={x.t} className="flex-1 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-2 py-2.5 text-center">
                    <div className="text-lg">{x.e}</div>
                    <b className="block text-[11px]">{x.t}</b>
                    <span className="text-[10px] text-[var(--sf-muted)]">{x.s}</span>
                </div>
            ))}
        </div>
    );
}
```

### `components/storefront/GreetingCard.tsx` (WelcomeOffer + YourUsual in one file)

```tsx
'use client';

export function WelcomeOfferCard({ onStart }: { onStart: () => void }) {
    return (
        <Card emoji="🎁" title="Try us once — we think you'll stay."
            sub="$10 off your first box · applied automatically" cta="Start" onCta={onStart} />
    );
}

export function YourUsualCard({ name, usualName, orderedTimes, onReorder }: {
    name?: string; usualName: string; orderedTimes: number; onReorder: () => void;
}) {
    return (
        <Card emoji="🧡" title={name ? `Welcome back, ${name}!` : 'Welcome back!'}
            sub={`Your usual: ${usualName} · ordered ${orderedTimes}×`} cta="Reorder" onCta={onReorder} />
    );
}

function Card({ emoji, title, sub, cta, onCta }: { emoji: string; title: string; sub: string; cta: string; onCta: () => void }) {
    return (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] px-3.5 py-3">
            <span className="grid h-11 w-11 flex-none place-items-center rounded-xl bg-[var(--sf-soft)] text-xl">{emoji}</span>
            <span className="min-w-0"><b className="block text-[13px]">{title}</b>
            <span className="text-[11px] text-[var(--sf-muted)]">{sub}</span></span>
            <button onClick={onCta}
                className="ml-auto flex-none rounded-xl bg-[var(--sf-primary)] px-3 py-2 text-xs font-extrabold text-[var(--sf-on-primary)] active:bg-[var(--sf-primary-press)]">
                {cta}</button>
        </div>
    );
}
```

`YourUsualCard` data: most-ordered bundle from the customer's order history (customer session) or from `localStorage sf_last_order` for cookieless returners. Welcome offer: auto-apply a `WELCOME` DiscountCode (existing system) when no prior orders — create the code via existing admin tooling, do NOT build new discount logic.

### `components/storefront/FounderNote.tsx` + `QuoteBlock.tsx` — config-driven

FounderNote reads new-ish StorefrontConfig copy (`about` text already exists — reuse it; avatar = branding logo or 👩‍🍳). QuoteBlock takes the single highest-rated testimonial from `storefrontConfig.testimonials`. Styling per prototype: serif italic, star row `text-[#e0a52e]`, attribution muted. Serif = `font-serif` (already used site-wide).

### `components/storefront/EmailCaptureCard.tsx`

```tsx
'use client';
import { useState } from 'react';

export function EmailCaptureCard({ slug }: { slug: string }) {
    const [email, setEmail] = useState(''); const [done, setDone] = useState(false);
    const submit = async () => {
        if (!/.+@.+\..+/.test(email)) return;
        await fetch('/api/public/menu-signup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, email }),
        });
        setDone(true);
    };
    if (done) return <p className="mx-4 my-4 rounded-2xl bg-[var(--sf-soft)] p-4 text-center text-sm font-semibold">You're on the list! 🧡 Next week's menu is coming your way.</p>;
    return (
        <div className="mx-4 my-4 rounded-2xl border-2 border-dashed border-[var(--sf-line)] bg-[var(--sf-card)] p-4 text-center">
            <b className="font-serif text-sm font-normal">Not ready to order?</b>
            <p className="mb-2 mt-0.5 text-[11px] text-[var(--sf-muted)]">Get next week's menu in your inbox — no spam, just dinner ideas.</p>
            <div className="flex gap-1.5">
                <input value={email} onChange={e => setEmail(e.target.value)} placeholder="your@email.com" type="email"
                    className="min-w-0 flex-1 rounded-xl border border-[var(--sf-line)] bg-[var(--sf-ground)] px-3 py-2 text-xs" />
                <button onClick={submit} className="flex-none rounded-xl bg-[var(--sf-ink)] px-3.5 py-2 text-xs font-extrabold text-white">Send it</button>
            </div>
        </div>
    );
}
```

New route `app/api/public/menu-signup/route.ts`: resolve business by slug (server-side, like `public/tenant/[slug]`), create `BusinessLead` with `source: 'storefront_menu_signup'`, basic length/format validation, always return `{success:true}` (no enumeration). READ the BusinessLead model for exact field names first.

---

## SF-3 — Cards, serving toggle, upsell, sticky cart

### `components/storefront/BundleCard.tsx`

```tsx
'use client';

export function BundleCard({ b, badge, onOpen, onAdd, added }: {
    b: any; badge?: string | null; onOpen: () => void; onAdd: () => void; added: boolean;
}) {
    const inside = (b.contents ?? []).slice(0, 5).map((c: any) => c.recipe_name).filter(Boolean).join(' · ');
    return (
        <div onClick={onOpen} className="cursor-pointer overflow-hidden rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)]">
            <div className="relative grid h-32 place-items-center bg-[var(--sf-soft)]">
                {b.image_url
                    ? <img src={b.image_url} alt={b.name} className="h-full w-full object-cover" />
                    : <span className="text-4xl">🍲</span>}
                {badge && <span className="absolute left-2.5 top-2.5 rounded-full bg-white/90 px-2 py-1 text-[9px] font-extrabold tracking-wide text-[var(--sf-primary)]">{badge}</span>}
            </div>
            <div className="p-3.5">
                <h3 className="font-serif text-base">{b.name}</h3>
                {inside && <p className="mb-1.5 mt-0.5 text-[11px] leading-relaxed text-[var(--sf-muted)]">{inside}</p>}
                <div className="flex items-center gap-2">
                    <span className="text-[15px] font-extrabold tabular-nums">${Number(b.price ?? 0).toFixed(0)}</span>
                    <span className="text-[10px] text-[var(--sf-muted)]">
                        · {b.contents?.length ?? '?'} meals · {b.serving_tier === 'family' ? 'serves 5' : 'serves 2'}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); onAdd(); }}
                        className={`ml-auto rounded-xl px-3.5 py-2 text-xs font-extrabold transition active:scale-95 ${
                            added ? 'bg-[var(--sf-sage)] text-white' : 'bg-[var(--sf-primary)] text-[var(--sf-on-primary)]'}`}>
                        {added ? '✓ Added' : 'Add'}
                    </button>
                </div>
            </div>
        </div>
    );
}
```

Badges (computed, max one): `'💛 CUSTOMER FAVORITE'` = highest order count (reuse GE-10-style tally when available, else `stock/order` heuristics off), `'👋 PERFECT FIRST TRY'` = lowest-priced multi-meal bundle shown to first-visit only.

### `components/storefront/ServingToggle.tsx` — one card, both sizes

```tsx
'use client';

/** Requires CB-1 (Bundle.family_id). FALLBACK: if family_id is absent in the schema
 *  or null on this bundle, render nothing — the two tiers remain separate cards (today's behavior). */
export function ServingToggle({ family, active, onPick }: {
    family: Array<{ id: string; serving_tier: string; price: number }>;
    active: string; onPick: (id: string) => void;
}) {
    const five = family.find(b => b.serving_tier === 'family');
    const two = family.find(b => b.serving_tier === 'serves_2');
    if (!five || !two) return null;
    const Opt = ({ b, label, note }: any) => (
        <button onClick={() => onPick(b.id)}
            className={`flex-1 rounded-xl px-2 py-2.5 text-xs font-bold transition ${
                active === b.id ? 'bg-[var(--sf-card)] text-[var(--sf-ink)] shadow-sm' : 'text-[var(--sf-muted)]'}`}>
            {label} <span className="block text-[10px] font-semibold text-[var(--sf-muted)]">${Number(b.price).toFixed(0)} · {note}</span>
        </button>
    );
    return (
        <div className="my-3 flex rounded-2xl bg-[var(--sf-soft)] p-1">
            <Opt b={five} label="Serves 5" note="family night" />
            <Opt b={two} label="Serves 2" note="date night" />
        </div>
    );
}
```

### `components/storefront/PairingSuggestion.tsx` — ONE per detail view

```tsx
'use client';

export function PairingSuggestion({ bundle, onAdd, added }: { bundle: any; onAdd: () => void; added: boolean }) {
    if (!bundle) return null;
    return (
        <div className="mt-3 flex items-center gap-3 rounded-2xl border border-[var(--sf-soft-border)] bg-[var(--sf-soft)] px-3.5 py-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-[var(--sf-card)] text-lg">
                {bundle.image_url ? <img src={bundle.image_url} alt="" className="h-full w-full rounded-xl object-cover" /> : '🍎'}
            </span>
            <span className="min-w-0"><b className="block text-xs">Families also love: {bundle.name}</b>
            <span className="text-[10px] text-[var(--sf-muted)]">+${Number(bundle.price).toFixed(0)}</span></span>
            <button onClick={onAdd}
                className={`ml-auto flex-none rounded-lg border-2 px-2.5 py-1.5 text-[11px] font-extrabold ${
                    added ? 'border-[var(--sf-sage)] bg-[var(--sf-sage)] text-white'
                          : 'border-[var(--sf-primary)] bg-[var(--sf-card)] text-[var(--sf-primary)]'}`}>
                {added ? '✓' : '+ Add'}
            </button>
        </div>
    );
}
```

Pairing pick: the manual upsell from `storefrontConfig` if configured (existing fields), else the cheapest dessert/side-category bundle. One suggestion. Never a carousel.

### `components/storefront/StickyCartBar.tsx` + `FreeDeliveryBar.tsx`

```tsx
'use client';

export function FreeDeliveryBar({ subtotal, threshold }: { subtotal: number; threshold: number | null }) {
    if (!threshold || subtotal <= 0) return null;
    const remain = threshold - subtotal;
    return (
        <div className="sticky bottom-14 z-20 bg-[var(--sf-gold)] px-4 py-2 text-[11px] font-bold text-[var(--sf-gold-ink)]">
            {remain > 0 ? <>🚚 You're <b>${remain.toFixed(0)}</b> away from free home delivery</> : <>🎉 You've unlocked <b>free home delivery</b>!</>}
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/10">
                <div className="h-full rounded-full bg-[var(--sf-sage)] transition-all" style={{ width: `${Math.min(subtotal / threshold * 100, 100)}%` }} />
            </div>
        </div>
    );
}

export function StickyCartBar({ count, total, label = 'Your bag', ctaLabel = 'View →', onCta }: {
    count: number; total: number; label?: string; ctaLabel?: string; onCta: () => void;
}) {
    return (
        <div onClick={onCta} className="sticky bottom-0 z-20 flex cursor-pointer items-center gap-3 bg-[var(--sf-ink)] px-4 py-3 text-white"
            style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
            <span className="grid h-6 min-w-6 place-items-center rounded-full bg-[var(--sf-primary)] text-[11px] font-extrabold">{count}</span>
            <span className="text-sm font-bold">{label}</span>
            <span className="ml-auto font-extrabold tabular-nums">${total.toFixed(0)}</span>
            <button className="rounded-xl bg-white px-3 py-2 text-xs font-extrabold text-[var(--sf-ink)]">{ctaLabel}</button>
        </div>
    );
}
```

`threshold` from existing delivery settings (DeliveryZone/StorefrontConfig — read for the actual field; if none exists, hide the bar rather than inventing config).

---

## SF-4 — Bag redesign (bag STEP only — checkout steps untouched)

Assemble in the bag view: item rows (existing cart state) → **RoundOutRow** → **LoyaltyEarnLine** → pickup/delivery selector (existing fulfillment state) → trust line → `FreeDeliveryBar` → `StickyCartBar` variant with `label="Total"`, `ctaLabel="Checkout securely →"`, `onCta = proceed to the EXISTING details step`.

```tsx
export function RoundOutRow({ addOns, onAdd, addedIds }: { addOns: any[]; onAdd: (b: any) => void; addedIds: Set<string> }) {
    if (!addOns.length) return null;
    return (<>
        <p className="px-4 pt-3 text-[10px] font-extrabold uppercase tracking-widest text-[var(--sf-muted)]">Round out your freezer week</p>
        <div className="flex gap-2.5 overflow-x-auto px-4 py-2" style={{ scrollbarWidth: 'none' }}>
            {addOns.slice(0, 3).map(b => (
                <div key={b.id} className="w-36 flex-none rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] p-2.5">
                    <div className="grid h-14 place-items-center rounded-xl bg-[var(--sf-soft)] text-xl">
                        {b.image_url ? <img src={b.image_url} alt="" className="h-full w-full rounded-xl object-cover" /> : '🍲'}
                    </div>
                    <b className="mt-1.5 block text-[11px] leading-tight">{b.name}</b>
                    <span className="text-[10px] text-[var(--sf-muted)]">${Number(b.price).toFixed(0)}</span>
                    <button onClick={() => onAdd(b)}
                        className={`mt-1.5 w-full rounded-lg py-1.5 text-[11px] font-extrabold ${
                            addedIds.has(b.id) ? 'bg-[var(--sf-sage)] text-white' : 'bg-[var(--sf-soft)] text-[var(--sf-primary)]'}`}>
                        {addedIds.has(b.id) ? '✓ Added' : '+ Add'}
                    </button>
                </div>
            ))}
        </div>
    </>);
}

export function LoyaltyEarnLine({ subtotal, pointsPerDollar = 1.4, centsPerPoint = 5 }: {
    subtotal: number; pointsPerDollar?: number; centsPerPoint?: number;
}) {
    // READ the existing LoyaltyWidget/loyalty API for the tenant's real earn rate — do not hardcode.
    if (subtotal <= 0) return null;
    const pts = Math.round(subtotal * pointsPerDollar);
    return (
        <div className="mx-4 my-3 flex items-center gap-2 rounded-2xl bg-[var(--sf-gold)] px-3.5 py-2.5 text-xs font-semibold text-[var(--sf-gold-ink)]">
            ✨ This order earns <b>{pts} points</b> — ${(pts * centsPerPoint / 100).toFixed(2)} toward next time.
        </div>
    );
}
```

`addOns` = the 3 cheapest active `show_on_storefront` bundles not already in the bag (prefer a "sides/desserts" category when categories exist).

---

## SF-5 — Confirmation retention page

On the existing success step/page, after the thank-you (personalize with the order's `customer_name`): **NextSteps** (3 rows: cooked fresh this week / pickup or delivery details from the order's fulfillment + "we'll email you when it's packed — bring a cooler bag!" / dinner in 25 min — heating card included), **points-earned banner** (LoyaltyEarnLine styling, past tense), **ReferralCard**:

```tsx
export function ReferralCard({ code, onShare }: { code: string; onShare: () => void }) {
    return (
        <div className="mx-4 my-4 rounded-2xl bg-[var(--sf-primary)] p-4 text-[var(--sf-on-primary)]">
            <b className="font-serif text-base font-normal">Know a busy family who needs this?</b>
            <p className="my-1.5 text-xs opacity-90">Give a friend $10 off their first box — you get $10 when they order.</p>
            <button onClick={onShare} className="rounded-xl bg-white px-3.5 py-2 text-xs font-extrabold text-[var(--sf-ink)]">💌 Share your link</button>
        </div>
    );
}
```

Referral = existing DiscountCode system: generate/lookup a per-customer code, share via `navigator.share` fallback clipboard. Crediting the referrer $10 = a second DiscountCode issued on the friend's first order (webhook-free: check at confirmation load). Also set `localStorage.sf_last_order` here (SF-2's returning detection).

---

## SF-6 — Schema proposal (PROPOSAL-FIRST — one migration, stop for approval)

```prisma
// Order additions (gifting, SF-7)
is_gift              Boolean  @default(false)
gift_note            String?
gift_recipient_name  String?

// New model (reviews, SF-8)
model StorefrontReview {
  id            String   @id @default(uuid())
  business_id   String
  order_id      String?  @unique
  customer_name String?
  rating        Int
  quote         String?
  status        String   @default("pending") // pending | approved | hidden
  created_at    DateTime @default(now())
  @@index([business_id, status])
  @@map("storefront_reviews")
}
```

## SF-7 — Gifting

Bag toggle "🎁 This is a gift" → reveals recipient name + gift note + recipient delivery address (reuses the existing address fields/flow — purchaser contact info stays the payer's). Values ride the EXISTING order-creation payload as the three new fields (the public order route accepts them via its existing body → verify the route maps unknown fields safely; if it whitelists, the field addition to that route is proposal-first). Confirmation email: gift-shaped copy when `is_gift` ("Your gift to {recipient} is being cooked fresh…"). **No stored value, no gift codes.**

## SF-8 — Review loop

- `app/api/public/review/route.ts`: POST `{ token }` + rating/quote → validate a signed review token (order id + HMAC using existing secret pattern) → upsert StorefrontReview (one per order). GET page `app/shop/[slug]/review/[token]/page.tsx`: 5 tap-stars, optional quote, brand-tokened, "Thanks 🧡" state.
- Ask email: GE-5 cron job `review_ask` (default ON — it's transactional-adjacent), 2 days after order status `delivered`/`completed`, once per order (GrowthLog).
- Tenant moderation: approve/hide list in StorefrontSettings; `approved` reviews feed TestimonialWall (merge with the config testimonials array at render).

## SF-9 — Label QR loop

Label QR value → `${origin}/shop/{slug}/recipe/{recipeId}` (PublicRecipeDetail already renders recipes publicly — verify its actual route path and reuse it). Add to that page: heating instructions block (the recipe's customer-facing cooking instructions field) + a brand-tokened "Running low? Reorder your box →" CTA to the storefront. Change is in the tenant label config/LabelsClient QR default — NOT in coordinator or checkout code.

## SF-10 — "Usual box" email + cart prefill

- Storefront reads `?cart=` (comma-separated bundle ids, validated against the tenant's active bundles) and preloads the bag + opens it. Reject silently on any invalid id.
- GE-5 cron job `usual_box` (default OFF): monthly, customers with 2+ orders, tenant-branded email "Your {Month} box is ready — order in one tap" linking `/shop/{slug}?cart={their usual bundle ids}`. Once per customer per month (GrowthLog). **No auto-charge — the link only prefills.**

## SF-11 — PWA

`app/shop/[slug]/manifest.webmanifest/route.ts`: JSON from branding — `name` (business name), `theme_color` (primary), `background_color` (ground), `display: 'standalone'`, `start_url: '/shop/{slug}'`, icons from `logo_url` (fallback packaged icon). Link it in the shop layout `<head>`. Optional deferred-install banner after 2nd visit (localStorage counter). No service worker in this phase.

## SF-12 — Express wallets (PROPOSAL-FIRST)

Verification only: (1) Stripe dashboard → Payment Methods on the CONNECTED accounts' checkout config — enable Apple Pay/Google Pay; (2) confirm `checkout.sessions.create` params don't restrict `payment_method_types` in a way that suppresses wallets (READ `app/api/checkout/session/route.ts` — do not edit); (3) live test on a real phone. If a code change is required, STOP and produce a proposal. Square: check Square dashboard digital-wallet settings similarly.

---

## Extension seams (spec §9.1 — verify these shapes in review)

1. **Subscriptions later:** all payment initiation stays behind `getPaymentProvider(businessId)`; SF-10's "usual box" derivation (customer → bundle ids) is a pure function in `lib/storefront/` so a future subscription engine imports it directly. No storefront component may call Stripe/Square directly.
2. **Group orders later:** purchaser ≠ recipient everywhere (SF-7 enforces it); cart state keeps a single `purchaser` object rather than free variables, so adding N contributors later is additive.
3. Rejected permanently: gift cards/stored value, SMS, countdown/pressure widgets, popup interrupts.

## Acceptance checklist

- [ ] Per-phase diff gate; SF-6 shipped as its own approved migration; SF-12 produced a verification report, zero code diffs.
- [ ] Change `TenantBranding.primary_color` → entire storefront re-themes (all 5 screens), text on primary always readable; neon/near-white brand color still yields usable UI.
- [ ] First visit vs returning render the correct card/hero/chips (test cookieless + with `sf_last_order`).
- [ ] WeekStrip shows the real earliest cutoff; hidden when none.
- [ ] Serving toggle appears only when a family pair exists (CB-1); otherwise two cards, exactly as today.
- [ ] Free-delivery bar appears after first add, fills correctly, celebrates at threshold; hidden when no threshold configured.
- [ ] Bag: checkout bar pinned at 375px with 10 items; add-ons row capped at 3; loyalty line uses the tenant's REAL earn rate.
- [ ] Checkout details → payment → confirm steps byte-identical (diff proves it); orders complete end-to-end with Stripe AND Square test tenants.
- [ ] Gift order carries recipient + note through to the order record and tenant order views; non-gift orders unaffected.
- [ ] Review link works once per order; approved reviews render on the storefront; pending ones don't.
- [ ] `?cart=` preloads valid bundles, ignores invalid, never errors.
- [ ] Manifest serves per-tenant values; Add-to-Home-Screen shows tenant name/logo.
- [ ] CountdownBanner + DealsPopup no longer render anywhere on the storefront.
- [ ] No component contains a hardcoded brand hex; grep for `#a64d66` returns only `brandTokens.ts`.

---

# FR track — Fundraiser Buyer Page (spec §10)

**Pixel reference:** the "Fundraiser" screen in `docs/ai/prototypes/storefront_prototype.html`.
**Target files:** `app/shop/[slug]/fundraiser/[fundraiserId]/FundraiserClient.tsx` (NOT locked — the mailto flow lives here and is replaced), one NEW route (FR-1, proposal-first). The server page (`page.tsx`) keeps its data fetch; add `payment_instructions`, `external_payment_link`, `end_date` to what it passes down if missing.

## FR-1 — `app/api/public/fundraiser-order/route.ts` (PROPOSAL-FIRST)

```ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { buildBundlePriceMap } from '@/lib/pricing';
import { resolveVariantSize } from '@/lib/serving_multipliers';

/**
 * Public self-serve fundraiser order. NO PAYMENT — buyer pays the coordinator
 * externally (spec §10 decision 1). Mirrors the coordinator POST's validation
 * (app/api/coordinator/[token]/route.ts — READ it, do not modify it).
 */
export async function POST(req: Request) {
    try {
        const { campaignId, customerName, phone, participantName, items } = await req.json();
        if (!campaignId || !customerName || !Array.isArray(items) || items.length === 0) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }
        if (String(customerName).length > 120 || String(participantName || '').length > 120) {
            return NextResponse.json({ error: 'Input too long' }, { status: 400 });
        }

        // Campaign + tenant resolved SERVER-side from campaignId alone
        const campaign = await prisma.fundraiserCampaign.findUnique({
            where: { id: campaignId },
            select: {
                id: true, status: true, closed_at: true, end_date: true,
                // + bundle_selection_status once CB-1 lands
                customer: { select: { business_id: true } },
            },
        });
        if (!campaign) return NextResponse.json({ error: 'Fundraiser not found' }, { status: 404 });
        const businessId = campaign.customer.business_id!;

        // Gates: closed campaign (7E-1C pattern) + CB ordering lock when present
        if (campaign.closed_at || campaign.status === 'Closed') {
            return NextResponse.json({ error: 'This fundraiser has ended. Contact the organizer for late orders.' }, { status: 400 });
        }
        // if ('bundle_selection_status' in campaign) → reject unless isCampaignOrderable(campaign)  // CB-5 helper

        // Bundles must be ACTIVE campaign assignments (state filter once CB-1 lands)
        const assigned = await prisma.campaignBundle.findMany({
            where: { campaign_id: campaignId /*, state: 'active' — post-CB-1 */ },
            select: { bundle_id: true },
        });
        const allowedIds = new Set(assigned.map(a => a.bundle_id));
        const bundleIds: string[] = items.map((i: any) => i.bundleId).filter(Boolean);
        if (allowedIds.size === 0 || bundleIds.some(id => !allowedIds.has(id))) {
            return NextResponse.json({ error: 'One or more bundles are not part of this fundraiser' }, { status: 400 });
        }

        // Server-side pricing — LAW 1, same as every other intake route
        const priceMap = await buildBundlePriceMap(businessId, bundleIds);
        let total = 0;
        const orderItems = items.map((i: any) => {
            const price = priceMap.get(i.bundleId);
            const qty = Math.max(1, Math.min(20, Number(i.quantity) || 1));
            if (!price || price <= 0) throw new Error('Bundle unavailable');
            total += price * qty;
            return {
                bundle_id: i.bundleId, quantity: qty, unit_price: price,
                variant_size: resolveVariantSize(i.variant_size), // never trust client strings raw
            };
        });

        const order = await prisma.order.create({
            data: {
                external_id: `fundraiser-buyer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                source: 'fundraiser' as any,            // SAME source as coordinator-entered — settlement counts it
                status: 'fundraiser_hold' as any,        // held until closeout, like all fundraiser orders
                customer_name: String(customerName).trim(),
                phone: phone ? String(phone).slice(0, 30) : null,
                participant_name: participantName ? String(participantName).trim() : null,
                business_id: businessId, campaign_id: campaignId, total_amount: total,
                items: { create: orderItems },
            },
            select: { id: true, external_id: true, total_amount: true },
        });

        return NextResponse.json({ success: true, orderRef: order.external_id.slice(-6).toUpperCase(), total: Number(order.total_amount) });
    } catch (e: any) {
        console.error('[fundraiser-order]', e);
        return NextResponse.json({ error: 'Could not place order — please try again' }, { status: 500 });
    }
}
```

Verify `OrderItem` field names (`unit_price` etc.) against the coordinator POST's actual `items.create` shape and match exactly. Add a light per-IP rate limit if the codebase has a helper; otherwise note its absence in the proposal.

## FR-2..4 — Client rebuild (in `FundraiserClient.tsx`)

Replace the mailto plumbing (`buildMailtoUrl`, the `mailtoUrl` prop on BundleCard) with local order state. Structure per the prototype screen:

```
ProgressHero (existing progressPercent + end_date days-left + masked recent supporters
  — reuse the scoreboard's maskName'd list, last 3 names + count)
PayBadge — sage box ABOVE bundles:
  "💵 No card needed here — you'll pay your coordinator directly (Venmo or check).
   We'll show you how after you order."
BundleCards (SF-3 component with tokens; Add toggles into the order)
OrderForm card: running total · name · phone · "Who are you supporting? 🏅"
  (free-text input; when campaign.is_group_enabled, a datalist of participant names
   already seen on this campaign's orders) · [Place my order →]
  · microcopy: "No payment taken online · your order counts toward the goal instantly"
→ POST /api/public/fundraiser-order → on success swap to:
ThanksState:
  headline "You just backed {org}! That's {n} of {goal} bundles — {participant} gets the credit 🏅"
  PaymentCard (2px primary border): payment_instructions text + amount + order ref
    + external_payment_link button ("Open Venmo →") when set
  ShareRow: Text it (sms: link) / Share (FB sharer, FB-1's order-page URL) / Copy
  FounderNote variant: thank-you copy + "get the weekly menu →" (menu-signup route
    from SF-2) + small "Run a fundraiser for YOUR group" link (GE-2)
```

All styling through SF-1 tokens (`--sf-*`); serif headings; if SF-1 isn't merged yet, use the page's existing `primaryColor` prop inline as a temporary bridge and note it for cleanup.

**Validate:** order placed on a phone appears instantly in the coordinator portal's order list and campaign totals as a held fundraiser order; crafted POST with a non-assigned bundle → 400; closed campaign → friendly 400; totals match server prices regardless of client-sent values; scoreboard name masking unchanged; no Stripe/Square imports; `git diff` touches only FundraiserClient.tsx, its page.tsx data pass-through, and the new route.

---

# VP track — Visibility Pack (spec §11)

VP-F1 (TV mode) and VP-F2 (Wrapped) are FUTURE — do not build. All three VP phases: SF-1 tokens, no locked files, no payment code, mobile-first.

## VP-1 — "Add dinners to your calendar" (client-only)

### `lib/storefront/calendarExport.ts`

```ts
/**
 * VP-1: builds an .ics scheduling one all-day dinner event per meal.
 * Pure string generation — no backend, no timezone math (all-day events).
 */
type Meal = { name: string; instructions?: string | null };

const esc = (s: string) => s
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

export function buildMealPlanICS(opts: {
    meals: Meal[]; startDate: Date; tenantName: string; reorderUrl: string;
}): string {
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        `PRODID:-//${esc(opts.tenantName)}//FreezerIQ Meal Plan//EN`, 'CALSCALE:GREGORIAN',
    ];
    opts.meals.forEach((m, i) => {
        const day = new Date(opts.startDate); day.setDate(day.getDate() + i);
        const end = new Date(day); end.setDate(end.getDate() + 1);
        lines.push(
            'BEGIN:VEVENT',
            `UID:meal-${Date.now()}-${i}@freezeriq`,
            `DTSTAMP:${ymd(new Date())}T000000Z`,
            `DTSTART;VALUE=DATE:${ymd(day)}`,
            `DTEND;VALUE=DATE:${ymd(end)}`,
            `SUMMARY:${esc('🍲 Dinner: ' + m.name)}`,
            `DESCRIPTION:${esc((m.instructions || 'Heating card is in your box.') + '\n\nFrom ' + opts.tenantName + ' — reorder: ' + opts.reorderUrl)}`,
            'END:VEVENT',
        );
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

export function downloadICS(ics: string, filename = 'my-dinners.ics') {
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click(); URL.revokeObjectURL(url);
}
```

### Confirmation button (SF-5 page, below NextSteps)

```tsx
<button onClick={() => {
    // meals = flatten ordered bundles' contents from data the page already has:
    // each bundle.contents → { name: recipe_name, instructions: customer-facing cooking field }
    const startDate = order.delivery_date ? new Date(order.delivery_date) : new Date(Date.now() + 3 * 864e5);
    startDate.setDate(startDate.getDate() + 1); // dinners start the day after pickup/delivery
    downloadICS(buildMealPlanICS({ meals, startDate, tenantName, reorderUrl: origin + '/shop/' + slug }));
}} className="mx-4 mt-1 flex w-[calc(100%-2rem)] items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[var(--sf-line)] bg-[var(--sf-card)] py-3 text-xs font-extrabold text-[var(--sf-ink)]">
    📅 Add my dinners to my calendar
</button>
```

If recipe-level cooking instructions aren't in the confirmation payload, use bundle names only (one event per bundle) rather than adding a fetch — note it as a follow-up.

## VP-2 — Weekly menu graphic

### `app/shop/[slug]/menu-card/route.tsx` (public, read-only, cached)

```tsx
import { ImageResponse } from 'next/og';
import { prisma } from '@/lib/db';
import { DEFAULT_PRIMARY } from '@/lib/storefront/brandTokens';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const business = await prisma.business.findUnique({
        where: { slug }, select: { id: true, name: true },
    });
    if (!business) return new Response('Not found', { status: 404 });

    // Branding: resolve TenantBranding the same way the storefront page does (READ that code first)
    const primary = /* branding?.primary_color || */ DEFAULT_PRIMARY;
    const bundles = await prisma.bundle.findMany({
        where: { business_id: business.id, is_active: true, show_on_storefront: true },
        select: { name: true, price: true, order_cutoff_date: true },
        orderBy: { price: 'desc' }, take: 6,
    });
    const cutoff = bundles.map(b => b.order_cutoff_date).filter(Boolean).sort()[0];
    const orderBy = cutoff ? new Date(cutoff as any).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : null;

    return new ImageResponse((
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
            background: 'hsl(35 45% 96%)', color: 'hsl(345 15% 20%)', padding: 64, fontFamily: 'serif' }}>
            <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, color: primary, textTransform: 'uppercase', letterSpacing: 6 }}>
                {business.name} · This Week's Menu
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 28, marginTop: 48, flex: 1 }}>
                {bundles.map(b => (
                    <div key={b.name} style={{ display: 'flex', alignItems: 'baseline', width: '100%' }}>
                        <span style={{ fontSize: 44 }}>{b.name}</span>
                        <span style={{ flex: 1, borderBottom: '3px dotted hsl(30 30% 80%)', margin: '0 18px' }} />
                        <span style={{ fontSize: 44, fontWeight: 700, color: primary }}>${'{'}Number(b.price ?? 0).toFixed(0){'}'}</span>
                    </div>
                ))}
            </div>
            {orderBy && (
                <div style={{ display: 'flex', fontSize: 34, marginTop: 40, padding: '20px 32px',
                    background: primary, color: '#fff', borderRadius: 24, alignSelf: 'flex-start' }}>
                    ⏰ Order by {orderBy} · freezeriq.com/shop/{slug}
                </div>
            )}
        </div>
    ), { width: 1080, height: 1350, headers: { 'Cache-Control': 'public, max-age=3600' } });
}
```

(The `${'{'}…{'}'}` in the price span is markdown-escaping only — write normal JSX `${Number(b.price ?? 0).toFixed(0)}` in the real file.)

### Backend button (tenant dashboard or StorefrontSettings — additive)

```tsx
<button onClick={async () => {
    const a = Object.assign(document.createElement('a'),
        { href: `/shop/${slug}/menu-card`, download: 'this-weeks-menu.png' });
    a.click();
    await navigator.clipboard.writeText(
        `This week's freezer meal menu is live! 🍲 Stock your freezer, skip the dinner stress. Order at ${origin}/shop/${slug} — link in bio!`);
    toast.success('Image downloading — caption copied! Paste it with the image.');
}}>📸 Share this week's menu</button>
```

## VP-3 — Bundle Finder quiz

### `lib/storefront/quiz.ts`

```ts
/** VP-3: pure client-side scoring — NO AI. Answers → best bundle + reason. */
export type QuizAnswers = { size: 'two' | 'family' | 'crowd'; style: 'comfort' | 'lighter' | 'mix'; prep: 'oven' | 'easy' | 'any' };

const KEYWORDS = {
    comfort: ['comfort', 'classic', 'favorite', 'hearty', 'casserole', 'mac', 'pot pie'],
    lighter: ['soup', 'clean', 'paleo', 'keto', 'salad', 'fresh', 'lighter'],
    easy:    ['soup', 'crockpot', 'slow', 'stovetop'],
};
const hits = (text: string, words: string[]) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);

export function scoreBundles(a: QuizAnswers, bundles: any[]): { bundle: any; reason: string } | null {
    if (!bundles.length) return null;
    const scored = bundles.map(b => {
        const text = (b.name + ' ' + (b.contents ?? []).map((c: any) => c.recipe_name).join(' ')).toLowerCase();
        let score = 0;
        if (a.size === 'two' && b.serving_tier === 'serves_2') score += 4;
        if (a.size !== 'two' && b.serving_tier === 'family') score += 4;
        if (a.size === 'crowd' && (b.contents?.length ?? 0) >= 5) score += 2;
        if (a.style !== 'mix') score += hits(text, KEYWORDS[a.style === 'comfort' ? 'comfort' : 'lighter']) * 2;
        if (a.prep === 'easy') score += hits(text, KEYWORDS.easy);
        return { b, score };
    }).sort((x, y) => y.score - x.score);
    const top = scored[0];
    const reason = a.size === 'two' ? 'sized just right for two'
        : a.style === 'comfort' ? 'packed with the comfort classics you picked'
        : a.style === 'lighter' ? 'the lightest lineup on the menu'
        : 'our most-loved all-rounder';
    return { bundle: top.b, reason };
}
```

### `components/storefront/BundleFinderQuiz.tsx`

Entry: a chip under the first-visit hero — `🧭 Not sure where to start? Take the 30-second quiz`. Opens an inline card (not a modal): three questions as chip rows, auto-advance on tap, then the result:

```tsx
'use client';
import { useState } from 'react';
import { scoreBundles, type QuizAnswers } from '@/lib/storefront/quiz';

const QS = [
    { key: 'size', q: 'How many are you feeding?', opts: [['two', 'Just us two 💑'], ['family', '3–5 of us 👨‍👩‍👧'], ['crowd', 'A full house 🏡']] },
    { key: 'style', q: 'What sounds like dinner?', opts: [['comfort', 'Cozy classics 🥧'], ['lighter', 'Lighter fare 🥗'], ['mix', 'Surprise us ✨']] },
    { key: 'prep', q: 'How do you like to cook?', opts: [['oven', 'Oven bakes 🔥'], ['easy', 'Crockpot & stovetop 🍲'], ['any', 'Whatever is easiest 😌']] },
] as const;

export function BundleFinderQuiz({ bundles, onAdd, onView }: { bundles: any[]; onAdd: (b: any) => void; onView: (b: any) => void }) {
    const [step, setStep] = useState(0);
    const [answers, setAnswers] = useState<Partial<QuizAnswers>>({});
    const result = step >= QS.length ? scoreBundles(answers as QuizAnswers, bundles) : null;

    return (
        <div className="mx-4 mt-3 rounded-2xl border border-[var(--sf-line)] bg-[var(--sf-card)] p-4">
            {result ? (
                <div className="text-center">
                    <p className="text-[10px] font-extrabold uppercase tracking-widest text-[var(--sf-muted)]">Your match 💛</p>
                    <h3 className="mt-1 font-serif text-lg">{result.bundle.name}</h3>
                    <p className="mt-0.5 text-xs text-[var(--sf-muted)]">${'{'}Number(result.bundle.price ?? 0).toFixed(0){'}'} · {result.reason}</p>
                    <div className="mt-3 flex gap-2">
                        <button onClick={() => onView(result.bundle)} className="flex-1 rounded-xl bg-[var(--sf-soft)] py-2.5 text-xs font-extrabold text-[var(--sf-primary)]">See what's inside</button>
                        <button onClick={() => onAdd(result.bundle)} className="flex-1 rounded-xl bg-[var(--sf-primary)] py-2.5 text-xs font-extrabold text-[var(--sf-on-primary)]">Add to bag</button>
                    </div>
                    <button onClick={() => { setStep(0); setAnswers({}); }} className="mt-2 text-[10px] font-bold text-[var(--sf-muted)]">↺ Start over</button>
                </div>
            ) : (
                <>
                    <p className="text-[10px] font-extrabold uppercase tracking-widest text-[var(--sf-muted)]">Question {step + 1} of 3</p>
                    <p className="mt-1 font-serif text-base">{QS[step].q}</p>
                    <div className="mt-2.5 flex flex-col gap-1.5">
                        {QS[step].opts.map(([val, label]) => (
                            <button key={val} onClick={() => { setAnswers(a => ({ ...a, [QS[step].key]: val })); setStep(s => s + 1); }}
                                className="rounded-xl border border-[var(--sf-line)] bg-[var(--sf-ground)] px-3 py-2.5 text-left text-sm font-semibold hover:border-[var(--sf-primary)]">
                                {label}
                            </button>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
```

(Same markdown-escape note applies to the price interpolation — write normal JSX in the real file.)

Quiz never auto-adds to cart — recommendation only (spec §11 rule).

## VP acceptance checks

- [ ] VP-1: .ics opens in iOS/Google/Outlook calendars; one event per meal starting the day after delivery; description carries heating text + reorder link; zero network calls.
- [ ] VP-2: `/shop/{slug}/menu-card` renders a PNG with the tenant's real bundles, dotted price leaders aligned, order-by date from real cutoffs; re-themes when `primary_color` changes; cached 1h; backend button downloads + copies caption.
- [ ] VP-3: all 27 answer paths return a recommendation; serves-2 households get a serves_2 bundle when one exists; result card Add works; quiz renders only on the first-visit landing.
- [ ] All three: tokens only (no hardcoded hex beyond brandTokens.ts), no locked files, per-phase diff gate.
