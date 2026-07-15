# UI REDESIGN SPEC — Source of Truth

Status: APPROVED DIRECTION — implementation phased, proposal-first where marked.
Scope: Coordinator Panel redesign + Recipe Library redesign + CRM redesign + Growth
Engine + Prospect Finder + Coordinator Bundle Selection (§8) + Storefront redesign (§9).
This file is the single source of truth for both redesigns. If a chat transcript,
handoff doc, or mockup disagrees with this file, this file wins.

---

## 0. Non-negotiable guardrails (apply to every phase below)

1. **UI-only unless a phase explicitly says otherwise.** No changes to any
   `app/api/**` route, fetch URL, request/response shape, or `prisma/schema.prisma`.
2. **Locked files** (proposal-first — produce a diff for human approval before applying):
   - `components/RecipeEditor.tsx`, `components/BundleEditor.tsx`
   - `app/coordinator/[token]/page.tsx`, `app/api/coordinator/[token]/route.ts`
   - `app/api/public/order/route.ts`, `app/api/checkout/session/route.ts`
   - `app/api/webhooks/stripe/route.ts`, `app/api/stripe/webhook/route.ts`,
     `app/api/webhooks/square/route.ts`
   - `lib/pricing.ts`, `lib/serving_multipliers.ts`, `lib/kitchen_engine.ts`
   - `prisma/schema.prisma`, `middleware.ts`, `auth.ts`, `auth.config.ts`
3. **Payment boundaries (permanent):**
   - Platform SaaS billing = platform Stripe → `/api/stripe/webhook` (`STRIPE_WEBHOOK_SECRET_PLATFORM`).
   - Tenant storefront = Stripe Connect → `/api/webhooks/stripe` (`STRIPE_WEBHOOK_SECRET`), or Square → `/api/webhooks/square`.
   - Coordinator/fundraiser flow processes NO payments — external collection only
     (cash/check/Venmo/PayPal link fields). Never add Stripe/Square to it.
4. **Do not fix unrelated issues in passing.** Known security gaps (e.g. missing auth
   on `/api/recipes/[id]/categories`) are tracked as separate tasks. Redesign diffs
   must stay pure.
5. **Every phase's diff gate:** `git diff --stat` must show only the files that
   phase allows. Anything else = stop and report.

---

## 1. Design tokens (both redesigns)

| Role | Tailwind |
|---|---|
| Page ground | `bg-slate-50 dark:bg-slate-950` |
| Panel/card | `bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl` (coordinator) / `rounded-xl` (recipe library) |
| Accent | `indigo-600`; soft state `indigo-50 text-indigo-700` (dark: `indigo-950/indigo-200`) |
| Money | `text-emerald-600` |
| Urgency | `amber-600`, soft `amber-50 text-amber-800` |
| Big numbers | `font-black tracking-tight tabular-nums` |
| Muted meta | `text-xs text-slate-500` |

Dark mode variants are mandatory on every new element (recipe library); the
coordinator panel is currently light-only — match its existing treatment.

---

## 2. Coordinator Panel redesign

**Target:** `app/coordinator/[token]/page.tsx` (LOCKED — proposal-first) + new files
in `components/coordinator/`.

### 2.1 Core concept
One page, four states driven by the existing `campaignPhase` value
(`'setup' | 'launch' | 'push' | 'lastDay' | 'complete'`, computed ~line 623).
The phase decides section ORDER, not just banner copy:

```
setup:     SetupChecklist, ProgressHero(dimmed), minimal share link
launch:    ProgressHero(+pace), ShareCenter, RecentOrders, QuietLinks
push/lastDay: UrgencyBanner, ProgressHero(hot), DeliveryPrep, ShareCenter, RecentOrders
complete:  CompleteBanner, FinalScoreboard, WhatsNext, DeliveryKit, RunItAgain
```

### 2.2 Fixed elements
- Sticky bottom ActionBar on every phase except `complete`: **+ Add Order**
  (opens existing order modal via `setShowOrderModal(true)`) and **Share**
  (scrolls to Share Center). On `complete` it becomes a read-only closed bar
  routing late orders to the tenant.
- SetupChecklist = ① payment instructions (opens existing Settings modal)
  → ② share link → ③ first order. Completion derived from existing data
  (`payment_instructions`/`external_payment_link` set; orders count > 0).
- ShareCenter consolidates: canonical share link + QR + flyer + scoreboard link,
  with the AI generator demoted to a "✨ Write a message for me" trigger inside it
  (existing state: `isAiGenerating/aiContent/aiChannel/aiRemaining`; existing
  `/generate` endpoint and its 40-cap untouched).
- Guide/downloads/engagement collapse into one QuietLinks row on launch phase.

### 2.3 Reuse contract (existing state in page.tsx — do not rename)
`campaign, campaignPhase, progress, totalBundlesSold, bundleGoal, daysRemaining,
bundlesPerDay, coachingTip, metrics.totalSales, metrics.estimatedEarnings,
formatBundleCount(), setShowOrderModal, setShowSettingsModal`, all copy/share
handler state, cancel/restore modal state. All existing modals stay byte-identical.

### 2.4 Out of scope (do not build or stub)
- Paid/Owes pill on orders (no schema field exists).
- Server-backed "closed" campaign state, settlement invoice card, campaign→invoice
  generation — that is Phase 7E backend work with its own proposal (includes one
  schema addition: nullable `campaign_id` on `Invoice`). Until 7E lands, `complete`
  remains the client-side date check.

### 2.5 Phase sequence (approved order)
- 7B-0: Campaign POST customer-ownership fix (`app/api/campaigns/route.ts` —
  verify `customerId` belongs to `session.user.businessId` before create). SECURITY, one file.
- 7B-1: Guide page token-auth fix (`app/coordinator/[token]/guide/page.tsx` —
  remove session/plan gate, fetch via `/api/coordinator/[token]` like the main panel).
- 7C: Sticky ActionBar.
- 7D: SetupChecklist + payment-instructions visibility.
- 7E: Closeout engine (PROPOSAL-FIRST: order transitions `fundraiser_hold`→pipeline,
  campaign terminal status, settlement invoice, coordinator read-only complete state).

---

## 3. Recipe Library redesign

**Target:** `components/RecipeBrowser.tsx` (NOT locked) + new files in
`components/recipes/`. `app/recipes/page.tsx` and `RecipeEditor.tsx` untouched in v1.

### 3.1 Core concept
Three panes replace folder drill-in + card grid:
- **Left:** always-visible category tree with live counts (folders + subfolders +
  "All recipes" + "Uncategorized"), every node a drag-drop target.
- **Middle:** searchable compact name list (default view) — grip · name · categories
  · yield · cost. Existing card grid preserved behind a List/Cards toggle
  (persist in `localStorage('recipeView')`).
- **Right:** read-only quick-view panel opened by clicking a row — yield,
  cost/batch, cost/serving (only when yield unit matches /serv/i), ingredients
  (sub-recipes marked ↳), kitchen prep text. **Edit** button → `/recipes/[id]`
  (full editor) exactly as today. On `< lg` screens the panel is a slide-over.

### 3.2 Hard contracts
- **Drag-and-drop contract (must not change):** droppable ids `folder-drop-<categoryId>`
  with `data.type === 'category'`; draggable recipes with `data.type === 'recipe'`.
  `handleDragEnd` stays byte-identical (PUT `/api/recipes/[id]/categories`).
  Tree + list must both render inside the existing `DndContext`.
- `currentCategoryId` keeps its name; meaning shifts from "drilled-in folder" to
  "active tree filter." Its role in handleDragEnd's move-vs-add logic is preserved
  by that shift — do not alter the handler.
- **Financials gate:** `recipe.calculated_cost === null` means the user lacks
  VIEW_FINANCIALS — render NO cost values anywhere (not `$0.00`).
- Existing search scoring block (name startsWith > includes > ingredient match,
  `matchReason`) is reused as-is, feeding the new list.
- Data = existing props only (`recipes`, `categories`). No new fetches in v1.
- Category filter includes descendants (selecting "Entrées" shows its children).

### 3.3 Out of scope for v1
- "Used in bundles" section (needs a server include on `app/recipes/page.tsx` — later phase).
- SUB badge unless an explicit flag already exists on the Recipe model.
- Print/Duplicate in quick view (no endpoints).
- Removing `@ts-nocheck` from `app/recipes/page.tsx` (separate hygiene task).

### 3.4 Keep reachable
CSV importer, backup download (`/api/recipes/backup`), New Folder modal,
category-onto-category drag (folder nesting), AI generator (in `RecipePageClient`).
Importer + backup move into a "⋯" overflow menu.

---

## 4. Facebook & link-routing phase (approved 2026-07-09)

**Law: every outward-facing fundraiser link must route supporters to the ORDER page**
(`/shop/{businessSlug}/fundraiser/{campaignId}`), never dead-end at the scoreboard.
The scoreboard (`/fundraiser/{public_token}`) is a display surface only and must
itself link onward to the order page (or show a "contact your coordinator to order"
fallback when no business slug exists).

Sub-phases, in order:

- **FB-1 — AI generator order-link fix** (`app/api/coordinator/[token]/generate/route.ts`,
  PROPOSAL-FIRST: coordinator-flow API). Replace `buildPublicFundraiserUrl()` (scoreboard)
  with the shop-order URL pattern already used by `app/api/flyer/download/route.ts:138`
  (`/shop/{slug}/fundraiser/{id}`, scoreboard fallback only when slug missing). No other
  changes to the route; 40-generation cap untouched.
- **FB-2 — Scoreboard "Order Now" CTA.** (a) `app/api/fundraiser/[token]/route.ts`: add
  business slug (or prebuilt order URL) to the response — additive select only, keep PII
  masking exactly as is. (b) `app/fundraiser/[token]/ScoreboardClient.tsx`: prominent
  Order Now button; share/copy actions switch from `window.location.href` to the order
  URL; fallback copy "Contact your coordinator to order" when no slug.
- **FB-3 — Dynamic OG image.** New `opengraph-image.tsx` (Next.js `ImageResponse`) on
  `app/shop/[slug]/fundraiser/[fundraiserId]/` — branded 1200×630 card (campaign name,
  org, tenant logo). Optionally same for the scoreboard route with live progress.
  Purely additive new files; also add `images` to the existing `generateMetadata` openGraph.
- **FB-4 — Facebook post pack.** Phase-matched prompt variants on the existing
  `facebook` channel (launch / midway / final-week / last-day / thank-you), surfaced in
  ShareCenter per campaign phase. Counts against the existing 40-cap; no new infra.

**Out of scope permanently unless explicitly re-approved:** auto-posting via the Meta
Graph API (coordinator page OAuth + Meta app review — rejected as too heavy for
volunteer coordinators). The copy-then-share-dialog flow is the sanctioned pattern.

---

## 5. CRM redesign + Fundraiser Wizard (approved 2026-07-10)

**Exact component code:** `docs/ai/CRM_REDESIGN_HANDOFF.md` — implement from that file so the
result matches the approved prototype. This section holds only the contracts.

- **CRM-1 — Fundraisers dashboard** (`app/fundraisers/page.tsx` + new `components/crm2/`):
  needs-attention strip (ending ≤7 days, held orders awaiting closeout, leads stale 14+ days);
  campaigns grouped by organization (client-side groupBy `customer_id` on the existing
  `/api/campaigns` response — no API change); stage filter chips Leads/Onboarding/Active/
  Production/Closed where Closed matches `Closed|Settled|Completed|Archived` via
  `isCampaignClosed()`; labeled action buttons; Invoice hidden on `is_placeholder` rows;
  public-page link hidden when `business_slug` missing.
- **CRM-2 — Organization profile** (`app/fundraisers/[id]/page.tsx` render layer only):
  relationship header, pipeline stepper (existing status list + Closed), campaign cards;
  closed campaigns show `settlement_total` in a settlement box with "Create invoice" CTA
  prefilling the invoice flow from the frozen settlement amount.
- **CRM-3 — Customers unification** (`app/customers/page.tsx`): People/Organizations
  segmented toggle; org rows link to the same profile CRM-2 uses.
- **CRM-4 — Start a Fundraiser wizard** (new `components/crm2/StartFundraiserWizard.tsx`):
  3 steps — Organization (live dup-check against existing customers by name; offer
  "use existing") → Campaign (name prefilled, end date, bundle goal, bundle checklist)
  → Launch Kit (auto-runs existing endpoints and presents: portal link, order-page link,
  flyer download, tracking sheet, drafted tenant-branded info-packet email with
  Send now / Preview / Later). Orchestrates EXISTING endpoints only, in order:
  `POST /api/customers` → `POST /api/campaigns` → `POST /api/campaigns/[id]/bundles` →
  flyer/tracking-sheet generation → email draft via the shared template helpers.
  No schema changes. DEPENDS ON: 7B-0 (campaign POST ownership fix) and FIX-3
  (tenant-branded templates) landing first.

**Out of scope:** any new generation tech, payment anything, coordinator API changes.

---

## 6. Growth Engine (approved 2026-07-10)

**Principle: no deal dies quietly.** Every closed campaign, public-page visitor, and lapsed
customer feeds the next pipeline automatically. All phases run on EXISTING data
(campaigns, settlement_total, CoordinatorActionEvent, BusinessLead, order history) —
no ML, no payment code, at most trivial additive schema. New UI lives on a Growth
Engine tab in the fundraiser CRM; exact component code will be added to
`docs/ai/CRM_REDESIGN_HANDOFF.md` once CRM-1..4 land (Growth Engine builds on them).

Phases, in dependency order:

- **GE-1 — Rebook pipeline.** Query: orgs whose last campaign closed 6–12 months ago
  with no later campaign. Card list with last result, suggested ask (last +10%), and
  "Clone into wizard" prefilling CRM-4's wizard. Pure read + wizard prefill.
- **GE-2 — Inbound lead capture.** "Run a fundraiser for YOUR group" CTA on the public
  scoreboard and post-checkout confirmation → small form → writes to the existing
  `BusinessLead` model → Leads inbox card on the Growth tab with "Start in wizard."
  CTA placement on scoreboard/storefront is additive UI only — no checkout logic changes.
- **GE-3 — Campaign health flag.** Rule-based score from pace-vs-goal, days since last
  order, and CoordinatorActionEvent counts. Surfaces as: "⚠ at risk / on pace" on
  dashboard rows, an attention-strip alert, and an at-risk card with prescribed actions
  (boost message via existing AI generator, log check-in, extend end date). Computed
  server-side in the existing /api/campaigns response or a small /api/growth endpoint.
- **GE-4 — Impact report + lifetime value.** At/after closeout: branded one-pager PDF
  ("raised $X, N bundles, M families") reusing the existing flyer/PDF generation and
  settlement_total; "Impact report" button on closed campaign cards; lifetime-raised
  rollup on the org profile header; testimonial/review ask link inside the report email.
- **GE-5 — Automation layer.** NEW cron infrastructure: `vercel.json` cron entry +
  `app/api/cron/growth/route.ts` (guard with CRON_SECRET header check). Jobs, all
  tenant-branded via existing lib/email.ts senders, all opt-out-able per tenant:
  (a) Monday digest to tenant (active campaigns, week's sales, at-risk, rebook-ready);
  (b) rebook nudge when an org enters the GE-1 window; (c) same-day at-risk alert;
  (d) goal-hit celebration email to coordinator WITH share prompt — triggered from the
  cron sweep, NOT from inside order-creation routes (keeps locked coordinator flow
  untouched); (e) win-back email to lapsed People customers (no order in 6 months)
  reusing the existing We-Miss-You template (post-FIX-3 tenant-branded version).
  This same cron route is the home for the planned monthly "Top of Mind" coordinator email.

**Hard rules:** no auto-sending without a per-tenant automations settings toggle
(default: digest/alerts ON, outbound coordinator/customer emails OFF until the tenant
enables them). No emails to fundraiser BUYERS (no email captured in that flow — by design).
No Stripe/Square anywhere. GE-5's cron route must be idempotent per day (re-runs must
not double-send; track last-sent per job+entity, e.g. in the existing Activity model or
a tiny sent-log table — if a table is added, that is the ONE allowed schema addition,
proposal-first).

**Paywall note:** the Growth Engine tab is the natural paid-tier boundary (basic
fundraiser tools in core; GE-1..5 as the growth tier) — gate later via Business.plan.

### 6.1 Extended phases — APPROVED 2026-07-10 with refinements

- **GE-6 — Group leaderboard on public scoreboard (toggleable).** Aggregate order counts
  by participant/group from existing fields (`Order.participant_name`, campaign
  `group_label`/`participant_label`) and render a leaderboard on `/fundraiser/[token]`.
  **Toggle:** gated by the existing `FundraiserCampaign.is_group_enabled` field —
  default OFF; switchable in wizard Step 2 and in campaign settings. Display-only.
- **GE-7 — Seasonal Kickoff blasts (3 seasons + summer incentive).** Rides on GE-5 cron.
  Fall/Winter/Spring are the big seasons: kickoff blast to all past orgs ~6 weeks before
  each season window with real capacity scarcity ("we run N campaigns per season").
  **Summer (slowest):** a distinct incentive blast — tenant-editable offer copy
  (e.g. bonus profit share or early-bird fall booking) to fill the slow months.
  Send dates + copy tenant-configurable; automations toggle applies.
- **GE-8 — Auto case-study / pitch sheet.** Aggregate settlement history + GE-4
  testimonials into a tenant-branded PDF ("helped N groups raise $X") via existing
  PDF generation. The tenant's cold-outreach kit, auto-maintained.
- **GE-9 — Smart goal math (BUSINESS RULES — LOCKED DECISIONS).**
  1. **Org share = 20% of sales**, authoritative source `lib/fundraiserMetrics.ts`
     (`estimatedEarnings = dollarSales * 0.2`). ALL "typical raised / your group earns"
     figures in wizard, rebook asks, impact reports, and blasts show the ORG'S 20%
     share — never gross sales — clearly labeled ("your group keeps ~$X").
  2. **Goals are suggested in bundles, counted in serves-5 EQUIVALENTS** using the
     locked multiplier (`serves_2 = 0.5` via `lib/serving_multipliers.ts`, read-only
     import). DECISION RECORDED: per-bundle pricing does NOT change ($125 serves-5 /
     $65 serves-2); only goal/progress counting uses equivalents so 10 serves-2
     bundles read as 5 equivalent sets, not 10.
  3. **Campaign minimum: $1,250 in sales (= 10 serves-5 equivalents)** — default,
     tenant-configurable later. Surfaced as a wizard warning when a suggested/entered
     goal falls below it ("below your delivery minimum") and factored into the GE-3
     health flag (campaign trending below minimum = at risk).

- **GE-10 — Bundle auto-suggest in wizard Step 2 (approved 2026-07-10; SEASON-AWARE
  per pushback 2026-07-10).** Season derived from the campaign's end/start date using
  the GE-7 windows (Fall=Sep–Nov, Winter=Dec–Feb, Spring=Mar–May, Summer=Jun–Aug).
  Suggestion hierarchy, pre-check top picks (max 4):
  1. **Org + same season:** bundles this org sold in this season in ANY prior year
     → badge "↺ they sold this last {season}", preselected first.
  2. **Tenant + same season:** top sellers across the tenant's orders that occurred
     inside this season's month-window across all years — badge "⭐ {Season} favorite"
     (fundraiser channel) / "🔥 {Season} top seller" (storefront).
  3. **Overall fallback:** if the tenant has no sales in that season yet, fall back
     to all-time ranking (channel-split badges, no season label).
  4. No history at all → plain alphabetical list, no badges, nothing pre-checked.
  Suggest-only: the tenant can always uncheck/override. No schema changes.
  (AI-composed NEW bundle suggestions = future idea, not in scope — but see GE-11.)
- **GE-11 — Random Bundle Creator on the Bundles page (approved 2026-07-10;
  v2 constraints approved 2026-07-12).** "✨ Create a Random Bundle" generates a
  candidate 5-meal bundle from the tenant's recipes under LOCKED constraints:
  1. **Container mix:** exactly 2 tray + 3 bag OR 3 tray + 2 bag
     (`Recipe.container_type`).
  2. **Protein variety:** at least 3 DIFFERENT proteins across the 5 meals
     (chicken/beef/pork/turkey/seafood/lamb/vegetarian), detected from recipe
     ingredients (primary) and categories (fallback) — no schema, no manual tagging.
  3. **Margin gate (BAND, decision 2026-07-12):** food cost target ≤ **35%**,
     hard cap **40%** of the serves-5 price ($125 default). ≤35% = emerald;
     35–40% = amber "within variance band" (valid); >40% = rejected. The sampler
     prefers ≤35% candidates before band candidates, then ranks by overlap.
  4. **Cost balance:** max 2 "expensive" recipes (top-quartile cost).
  5. **Ingredient-overlap maximization:** among valid candidates, pick the set
     with the FEWEST distinct ingredients — streamlines supplier ordering and
     prep. Preview surfaces it: "share N ingredients — M shopping-list items."
  Preview shows the 5 meals, protein chips, food-cost %, margin, and the overlap
  line, with Shuffle and "Create this bundle" → EXISTING bundle-create API →
  tenant reviews/names in the normal editor. BundleEditor internals untouched;
  costing reused from the extracted recipes-page helper.
  **CB connection:** optional "also create the Serves 2 version (fundraiser-ready)"
  — clones via the same recipe-sibling/`-S2` SKU convention BundleEditor uses
  (replicated in the creator, editor untouched) and stamps `family_id` once CB-1
  lands, so creator output is immediately eligible for coordinator candidate pools;
  disabled with guidance when Serves-2 recipe siblings are missing.
  **Production connection:** overlap metric = shorter shopping lists; created
  bundles flow into Kitchen Board batches automatically. Optional monthly nudge
  rides GE-5 cron later, default OFF.

Explicitly rejected (do not build): SMS/Twilio nudges (new integration + compliance),
referral attribution tracking (schema cost > insight), cross-tenant benchmarks
(data-sharing implications need their own decision).

### 6.2 Prospect Finder track (PF-1..6) — APPROVED direction 2026-07-10, builds AFTER CRM + GE-1..5 are stable

**Purpose:** outbound local lead sourcing — surface every plausible fundraising entity
(schools, PTAs, booster clubs, youth sports, scouting, churches) within a tenant-set
radius (50/100 mi) and manage outreach inside the Growth Engine.

**LOCKED DATA-SOURCE DECISION — NO SCRAPING.** Prospect data comes from licensed/public
datasets only: NCES public+private school directory (Dept. of Education CSV) and the
IRS Exempt Organizations BMF (NTEE codes for PTAs/boosters/youth sports/scouting/
religious orgs). Both free and legal to store. Scraping Google Maps/Yelp/Facebook is
PROHIBITED (ToS violation, platform risk). A licensed API (e.g. Google Places) may be
evaluated later as a separate proposal — never scraped HTML.

**Architecture (tenant isolation preserved):**
- `ProspectDirectory` — platform-level, read-only reference table imported from the
  datasets (name, type/NTEE, address, lat/long, public contact info). Shared by all
  tenants; refreshed by a platform import script, not by tenants.
- `Prospect` — tenant-scoped (business_id) row per directory entry a tenant engages:
  status pipeline (New → Contacted → Responded → Converted → Not interested /
  Do-Not-Contact), notes, last_contacted_at, next_follow_up.
- Both tables = ONE schema proposal (proposal-first, stop for approval).
- Radius search: haversine from the tenant's kitchen lat/long (from their address/ZIP)
  against ProspectDirectory; 50/100 mi presets.
- "Convert" creates an Organization customer + opens the CRM-4 wizard — prospects feed
  the EXISTING funnel, no parallel pipeline.

**Phases:**
- **PF-1 — Foundation:** schema proposal (2 tables) + radius query + platform import
  script for NCES (schools first — cleanest dataset).
- **PF-2 — Sources:** IRS BMF import with NTEE filtering (PTAs, boosters, youth
  sports, scouting, churches); manual CSV import for tenant-provided lists.
- **PF-3 — Prospect dashboard:** Growth-tab list (same card pattern as Leads inbox):
  type chips, distance, pipeline status, search/filter; Convert → wizard.
- **PF-4 — Compliance + opt-out controls (BEFORE any send button):** per-tenant
  suppression list; Do-Not-Contact status excluded from every view/export;
  unsubscribe link + tenant physical address required in every outreach template;
  CAN-SPAM checklist in the handoff.
- **PF-5 — Outreach templates:** tenant-branded intro emails (shared template
  helpers, post-FIX-3), manual single-send or copy-to-clipboard only. NO bulk send
  in this phase.
- **PF-6 — Follow-up reminders:** next_follow_up surfacing on the attention strip +
  GE-5 cron reminder job (tenant-facing, default ON; it emails the TENANT, not the
  prospect). Bulk/drip outreach automation = future proposal, not in this track.

**Hard rules:** no auto-send to prospects ever without explicit per-send tenant action
(bulk/drip is out of scope for PF-1..6); suppression respected everywhere including
exports; prospect PII stays out of any cross-tenant surface; no payments anywhere.
**Paywall note:** Prospect Finder is the flagship of the paid growth tier.

---

## 7. Acceptance gates (run after every phase)

1. Diff gate (see §0.5).
2. Coordinator phases: temporarily hardcode `campaignPhase` to preview all four
   states; order create/cancel/restore still work with a real token in dev;
   AI cap still enforced; sticky bar never overlaps modals; 375px width clean.
3. Recipe library: drag row → tree folder produces the same PUT payload as before;
   tree filter includes subcategories; no-financials account sees no `$` anywhere;
   Cards toggle shows the old grid; dark mode legible; ~800px width = slide-over,
   no horizontal scroll.
4. No Stripe/Square imports added anywhere. No new `@ts-ignore`/`as any`.
5. Link routing (after any FB-* phase): generate an AI post for each channel and
   confirm the embedded link is `/shop/{slug}/fundraiser/{id}`; paste the order link
   into a Facebook post preview and confirm the OG card renders with image; open the
   scoreboard and confirm Order Now navigates to the order page.
6. Bundle selection (after any CB-* phase): a campaign with a candidate pool blocks
   coordinator AND public ordering (server-side, not just UI) until exactly-N
   submission; legacy campaigns without a pool behave exactly as before; the
   4 activated bundles appear in the order modal, public page, and totals; a crafted
   POST with a non-assigned bundle id is rejected 400.

---

## 8. Coordinator Bundle Selection (CB-1..6) — APPROVED 2026-07-10 (post read-only audit)

**Business flow (LOCKED):** Stage 1 — tenant builds a candidate pool of bundle
FAMILIES in the wizard (not sellable yet, invisible to all ordering/production
surfaces). Stage 2 — coordinator opens the portal and picks exactly N families
(default 2) from that pool only. Stage 3 — the system expands each family into its
Serves-5 + Serves-2 variants and activates them (2 families → 4 sellable bundles).
Stage 4 — only then does ordering unlock; before that, order tools show
"Bundle selection is pending. Choose your bundles before orders can be entered."

### Locked architecture decisions

1. **Two-concept model in ONE table:** `CampaignBundle.state String @default("active")`
   — `candidate` | `active`. The default grandfathers every existing row; no backfill.
2. **Campaign workflow field, NOT the status string and NOT checklist JSON:**
   `FundraiserCampaign.bundle_selection_status String @default("not_required")` —
   `not_required` (legacy/no-pool) | `pending` | `selected` — plus
   `bundle_selection_at DateTime?` and `bundle_selection_limit Int @default(2)`
   (store N; default 2 per business rule — UI reads it, never hardcodes).
3. **Family pairing is structural, never fuzzy:** `Bundle.family_id String?` links
   Serves-5/Serves-2 siblings. One supervised backfill script seeds it from the
   existing `"{sku}-S2"` convention (BundleEditor clone behavior) and emits a report
   of unpaired bundles for the tenant to resolve. Runtime code matches on family_id
   + serving_tier ONLY. BundleEditor's clone action should set family_id going
   forward (locked file — that one-line addition is proposal-first).
4. **Pairing validated at pool-build time:** the wizard refuses to add a family to
   the candidate pool unless both tiers exist and are active. The submission API
   re-validates (defense in depth) but that failure path should be unreachable.
5. **Immediate activation, no tenant review loop:** the tenant pre-approved the pool
   at Stage 1. On submission: Activity record + (once GE-5 exists) tenant alert
   email "{coordinator} selected {A} + {B}".
6. **Re-selection policy:** before the first order, the tenant can reset selection
   to `pending` from the CRM (one action, clears active rows back to the full
   candidate set). After orders exist: tenant-only changes via the existing
   assignments route. The coordinator can never change a submitted selection.
7. **Pending-stall protection:** GE-3 health treats `pending` older than 5 days as
   at_risk ("campaign can't take orders — coordinator hasn't chosen bundles");
   GE-5 cron nudges coordinator + tenant.
8. **Ordering gate helper:** one shared `isCampaignOrderable(campaign)` =
   `bundle_selection_status ∈ {not_required, selected}` — used by EVERY gate below.
9. **Backwards compatibility (critical):** the public fundraiser page's
   zero-assignments fallback ("show all storefront bundles") SURVIVES for
   `not_required` campaigns. Only campaigns created with a candidate pool enter the
   locked lifecycle. Never change the fallback globally.
10. **REJECTED — do not build:** a full `BundleFamily` model (family as the sellable
    unit, sizes as variants). Theoretically cleaner, but ripples through checkout,
    pricing, production, and storefront for zero user-visible gain over family_id.

### Pre-existing security gap — fix regardless of this feature

`POST /api/coordinator/[token]` and `POST /api/public/order` validate submitted
bundle ids against the whole BUSINESS (`buildBundlePriceMap(businessId, …)`), not
against `campaign_bundles` — a crafted request can order any business bundle into a
campaign, bypassing assignments. CB-5 closes this; if CB is deferred, ship CB-5's
gates alone as a security fix. Both files are locked → proposal-first.

### Phases

- **CB-1 — Schema + backfill (PROPOSAL-FIRST):** the three campaign fields,
  CampaignBundle.state, Bundle.family_id, real migration file, supervised backfill
  script + unpaired-bundles report.
- **CB-2 — Submission API:** new `app/api/coordinator/[token]/bundle-selection/route.ts`
  (new file beside the locked route, same token access model): POST validates
  status=`pending`, exactly `bundle_selection_limit` family ids all present in the
  candidate pool, expands via family_id in ONE transaction (write active rows, set
  `selected` + timestamp), idempotent (re-POST after selection → 409 with current
  selection).
- **CB-3 — Portal selection UI (PROPOSAL-FIRST — locked page):** "Step 1: Choose Your
  Bundles" card in the setup phase gated on `pending`; rich family cards (image +
  contents + "includes Serves 5 & Serves 2"), exactly-N selection with confirm step
  ("this can't be changed here"); order tools render the pending-lock message until
  `selected`. Portal share/guide/settings remain usable throughout.
- **CB-4 — Wizard candidate semantics (AMEND CRM-4 BEFORE IT IS BUILT):** wizard
  Step 2's bundle picker becomes the candidate-pool builder — writes
  `state='candidate'` rows + `bundle_selection_status='pending'` + limit; blocks
  unpaired families (decision 4); pool pre-checked by GE-10 seasonal suggestions.
  `docs/ai/CRM_REDESIGN_HANDOFF.md` carries the amendment note.
- **CB-5 — Ordering gates (PROPOSAL-FIRST — locked routes):** `isCampaignOrderable`
  + campaign-scoped bundle validation in coordinator POST and public order POST
  (closes the pre-existing gap above).
- **CB-6 — Surface filters:** every campaign_bundles consumer filters
  `state='active'` (coordinator GET, public page, flyer/packet/tracker/pickup/
  promo-script routes); public page `pending` state shows the locked message plus
  the GE-2 lead-capture CTA ("leave your email — we'll tell you when ordering
  opens"); flyer/packet generation refuses or watermarks while `pending`.

**Dependency order:** CB-1 → CB-2 → CB-3/CB-5 (parallel) → CB-6. CB-4 amends the
CRM-4 handoff immediately (docs change) and binds when CRM-4 is implemented. If
CRM-4 gets built before CB-1 lands, it ships with original active-assignment
semantics and CB-4 migrates it — but the cheap path is CB-1 first.

---

## 9. Storefront Redesign — "Cozy Commerce" (SF-1..12) — APPROVED 2026-07-11

**Exact code:** `docs/ai/STOREFRONT_REDESIGN_HANDOFF.md`. **Pixel reference:**
`docs/ai/prototypes/storefront_prototype.html` (6 screens: First visit / Returning /
Bundle / Bag / Confirmation / Fundraiser). Prototype wins when look or copy is ambiguous.

**Design law:** persuasion by invitation, never pressure. Facts create urgency
(order-by date from real cutoffs); timers and popups are REMOVED. Every upsell is
one warm suggestion, capped small, framed as completing her plan.

**Hard boundaries (unchanged):** `app/api/checkout/**`, `app/api/webhooks/**`,
`app/api/public/order/route.ts` stay locked. The CheckoutModal's details → payment →
confirm steps are UNTOUCHED — SF only re-skins the bag step and everything before/after
payment. No Stripe/Square logic changes anywhere (SF-12 is dashboard config, verified
proposal-first).

### Phases
- **SF-1 — Brand token system.** Storefront layout reads TenantBranding once and emits
  CSS custom properties (`--brand-primary/-ink/-soft/-ground` + derived tints with
  WCAG contrast guard). Replace the 19 scattered inline `primary_color` styles with
  tokens. Curated palettes (6, berry/linen default) + custom mode in StorefrontSettings
  with live preview.
- **SF-2 — Landing re-orchestration.** New/returning conditional (session/customer
  cookie): first visit = hook hero, 3-chip how-it-works, auto-applied welcome offer,
  most-loved badges, founder note, soft menu-email capture (writes BusinessLead,
  source `storefront_menu_signup`); returning = greeting, points chip, "Your usual"
  one-tap reorder. Week strip driven by earliest real `order_cutoff_date`.
  **DELETE CountdownBanner + DealsPopup from the storefront render** (components may
  remain in repo).
- **SF-3 — Cards, serving toggle, gentle upsell.** Bundle cards (photo, real recipe
  names, serves, price, Add); Serves-5/Serves-2 on ONE card via `family_id` pairing
  (CB-1 dependency; until it lands, fall back to two cards as today); one pairing
  suggestion per detail view; sticky bottom cart bar + free-delivery progress bar
  (goal gradient, threshold from delivery settings).
- **SF-4 — Bag redesign.** Sticky "Checkout securely" bar with live total; "round out
  your week" mini-row (≤3 low-price add-ons); loyalty earn line BEFORE checkout;
  pickup/delivery selector. Bag step only.
- **SF-5 — Confirmation retention page.** Named thank-you, 3 concrete next steps,
  points-earned banner, refer-a-friend card (rides existing DiscountCode system).
- **SF-6 — Storefront schema proposal (PROPOSAL-FIRST, one migration):**
  `Order.is_gift Boolean @default(false)`, `Order.gift_note String?`,
  `Order.gift_recipient_name String?`, new `StorefrontReview` table
  (business_id, order_id?, customer_name, rating, quote, status pending/approved,
  created_at). Nothing else.
- **SF-7 — Gifting ("Send dinner to someone you love").** Buyer pays normally; order
  carries recipient address + gift note; gift-shaped confirmation email. NO gift
  cards / stored value.
- **SF-8 — Review loop.** Post-delivery ask email (GE-5 cron, 2 days after
  delivered/pickup) → one-tap star + quote capture route → StorefrontReview pending →
  tenant approves → feeds TestimonialWall. Suppress re-asks per order.
- **SF-9 — Label QR loop.** Label QR encodes `/shop/{slug}/recipe/{recipeId}`
  (existing PublicRecipeDetail) + heating card + "Running low? Reorder →" CTA.
  Tenant-side label config only; no locked files.
- **SF-10 — "Usual box" email (subscription-lite).** Monthly GE-5 cron job (default
  OFF, tenant toggle): customers with 2+ orders get their usual box as a one-tap
  prefilled cart link (`/shop/{slug}?cart=…`); storefront reads the param and
  preloads the bag. NO auto-charge.
- **SF-11 — PWA.** Per-tenant manifest route (name/colors/logo from branding),
  icons, install prompt affordance. No offline/service-worker scope.
- **SF-12 — Express wallets (PROPOSAL-FIRST).** Verify Apple/Google Pay render on
  Stripe hosted Checkout (dashboard payment-method config + session inspection).
  Config only — any code change to checkout session = stop and propose.

### 9.1 Extension seams — build these shapes so deferred features drop in later
1. **True subscriptions (DEFERRED):** payment creation stays behind the existing
   `getPaymentProvider(businessId)` abstraction; SF-10's "usual box" definition
   (customer→bundle set) is stored/derivable so a future subscription = new provider
   method + webhook handling, ZERO storefront rewrite. Do not scatter one-off
   checkout calls that bypass the provider abstraction.
2. **Group orders / payment splitting (DEFERRED):** keep order creation
   single-payer; the gift fields (SF-6) deliberately separate purchaser from
   recipient — a future group order extends that separation (N purchasers) without
   reshaping Order. Do not merge purchaser and recipient concepts anywhere.
3. **REJECTED for storefront:** gift cards/stored value, SMS, countdown/pressure
   widgets (permanent), popup interrupts (permanent).

**Dependencies:** SF-1 first (everything themes through it). SF-3's single-card
toggle wants CB-1's family_id. SF-8/SF-10 want GE-5 cron. SF-6 gates SF-7/SF-8.
Paywall note: SF-7..11 are candidates for the growth tier.

---

## 10. Fundraiser Buyer Page (FR-1..4) — APPROVED 2026-07-11

**Pixel reference:** `docs/ai/prototypes/storefront_prototype.html` → "Fundraiser" screen.
**Exact code:** FR section of `docs/ai/STOREFRONT_REDESIGN_HANDOFF.md`.
**Problem being solved:** the current buyer page's Order button is a `mailto:` link
(`FundraiserClient.tsx:41,410`) — nothing is recorded; the coordinator re-types
emailed orders into the portal. This track replaces it with self-serve ordering
while preserving the LOCKED no-payment fundraiser boundary.

### Locked decisions
1. **Self-serve orders, ZERO online payment.** The form creates a held order; the
   confirmation screen then shows the coordinator's payment instructions
   (`payment_instructions` / `external_payment_link` — existing fields) with an
   "Open Venmo →" style external link. Never Stripe/Square on this page — permanent.
2. **Order shape = coordinator-entered orders exactly:** `source='fundraiser'`,
   `status='fundraiser_hold'`, `campaign_id`, `participant_name`, server-side prices
   via `buildBundlePriceMap`, bundle ids validated against ACTIVE `campaign_bundles`
   (`state='active'` post-CB-1), gated by `isCampaignOrderable()` (CB) and the
   campaign-closed check (7E-1C pattern). This also closes the legacy hazard of
   storefront-sourced orders carrying a campaign_id with the wrong source.
3. **Seller credit:** "Who are you supporting?" writes `participant_name`
   (existing field) — free text, or a picker when GE-6 group mode is enabled.
   Feeds the leaderboard.
4. **Tenant discovery placement law:** founder note, menu-email capture
   (BusinessLead, `source='fundraiser_buyer'`), and "run your own fundraiser" CTA
   appear ONLY on the post-order confirmation and page footer — never above or
   between bundles. Discovery must not compete with the campaign.
5. Buyer PII: the form collects name + phone (order fields that exist); it is NOT
   exposed back on any public surface (scoreboard masking rules unchanged).

### Phases
- **FR-1 — Order endpoint (PROPOSAL-FIRST):** new
  `app/api/public/fundraiser-order/route.ts`, campaign-scoped via the campaign id +
  business slug resolved server-side (same pattern as the page's own data fetch).
  Rate-limit lightly; reject when campaign closed, not orderable (CB), or any bundle
  not an active assignment. Mirrors the coordinator POST's validation — read it,
  do not modify it.
- **FR-2 — Page rebuild:** SF-1 brand tokens + SF-3 BundleCard reuse; progress hero
  with days-left + masked recent-supporters ticker; "no card needed" pay badge ABOVE
  the bundles; order form (bundles → name/phone → supporting whom → submit).
  Replaces the mailto flow entirely.
- **FR-3 — Confirmation + share loop:** goal-impact headline ("that's 15 of 20!"),
  payment-instructions card, share row (text / Facebook / copy — FB-1's corrected
  order-page link), seller-credit echo.
- **FR-4 — Tenant discovery:** founder note + menu-email capture + run-your-own CTA
  per decision 4; FB-3 OG image covers rich sharing.

**Dependencies:** FR-2..4 want SF-1 tokens (fall back to current styling if SF-1
not merged). FR-1 must respect CB gates when CB-1+ land; before CB, it validates
against existing `campaign_bundles` rows as-is. GE-6 leaderboard integrates
automatically via `participant_name`.

---

## 11. Visibility Pack (VP-1..3) — APPROVED 2026-07-11 · VP-F1/F2 FUTURE

**Exact code:** VP section of `docs/ai/STOREFRONT_REDESIGN_HANDOFF.md`.

- **VP-1 — "Add dinners to your calendar" (ICS export).** On the order confirmation:
  one tap downloads an `.ics` scheduling one all-day dinner event per meal
  (name + heating instructions + reorder link), starting the day after
  delivery/pickup. Pure client-side string generation — no backend, no schema.
- **VP-2 — One-tap weekly menu graphic.** Public image route
  `/shop/{slug}/menu-card` renders a branded, IG-portrait menu card
  (this week's `show_on_storefront` bundles, prices, order-by date, QR/URL) via
  `next/og` ImageResponse using SF-1 brand colors. Backend button "📸 Share this
  week's menu" downloads it + copies a pre-written caption. Same image tech as
  FB-3 (synergy, not a hard dependency).
- **VP-3 — Bundle Finder quiz.** "Not sure where to start?" on the first-visit
  landing → 3 questions (household size / food style / prep preference) →
  scored recommendation card with Add button. Pure client-side scoring over
  existing bundle fields (serving_tier, price, contents) — NO AI call.

**FUTURE (approved direction, do NOT build yet):**
- **VP-F1 — Scoreboard TV Mode** (`?tv=1` fullscreen auto-refresh + order QR) —
  build when fundraiser volume justifies it.
- **VP-F2 — Year-end "Wrapped"** (shareable tenant/org stat cards) — build on
  GE-8 + VP-2 image infra once a year of data exists.

**Rules:** all three respect SF-1 tokens and §9 hard boundaries (no checkout/
payment/locked files); VP-2's route is public-read-only and cached; quiz never
auto-adds to cart — recommendation only.

---

## 12. Kitchen Board + Delivery Day (KB/DD) — APPROVED 2026-07-12

**Exact code:** `docs/ai/KITCHEN_DELIVERY_HANDOFF.md`. **Pixel references:**
`docs/ai/prototypes/kitchen_board_prototype.html` and
`docs/ai/prototypes/delivery_day_prototype.html`. One synergistic pipeline:
Kitchen ends at "Packed & ready"; Delivery picks up the same tickets.

**Design laws:** every order appears in exactly ONE lane at a time; time (this
week / today) is the first filter on both boards; the Pack station gates the
route (nothing can be marked delivered that was never cooked and packed);
"delivered" is written by DELIVERY surfaces only. Existing Google routing
(auto-arrange via /api/delivery/optimize + multi-stop Maps export + per-stop
links + drag reorder via /api/delivery/route/reorder) is PRESERVED and promoted
to the route-lane header. Packing is cardboard boxes — no cooler/returnable
tracking (decision recorded 2026-07-12).

### Phases
- **DD-0 — Pipeline correctness (build FIRST, ships value alone):**
  1. Production dashboard fundraiser filter: exclude by `status='fundraiser_hold'`
     instead of `source='fundraiser'` on all three queries — closeout-released
     orders MUST reach the kitchen (today they skip it but appear on delivery).
  2. `order_count` bug: count DISTINCT order ids per bundle, not line items
     (dashboard route aggregation).
  3. Week-filter leak in /api/orders GET: stop pinning ALL completed-status and
     ALL null-delivery_date orders into every week — pin only when created
     within 30 days; add a one-time backfill marking stale completed rows
     delivered (backfill = proposal-first script).
  4. /delivery/run queries `ready_to_ship` only (never production_ready).
  5. Orders PATCH transition guard (PROPOSAL-FIRST — order mutation): allowed
     prior-states map; delivered only from ready_to_ship/completed; make the
     production_ready side effects (loyalty/invoice sync) idempotent.
- **KB-1 — Kitchen Board UI:** replace the production dashboard render with the
  pipeline board (New orders → To cook → Packed & ready), week/today filter,
  4-stat header, batch cards with per-recipe check-off gating the Pack button,
  Kitchen Mode scale toggle. Same three APIs underneath (dashboard, bulk-status,
  batch-update-by-bundle). Rename "Manual Planner" → "Shopping & Prep Sheets",
  pre-filled from the To-Cook lane; give Schedule a real tab. DELETE the
  production page's mark-delivered buttons (delivered moves to DD-1).
- **DD-1 — Delivery Day board UI:** day-first board (Pack station → Route →
  Pickups), load-out stats incl. boxes + packaging cost, pack checklists gating
  "Loaded in van" AND the stop's Delivered button, route lane with Auto-arrange +
  Open-full-route promoted, Driver Mode toggle, pickups lane with payment state
  ("owes $45 — collect"). Supplies & Boxes and Print Center become tabs
  (existing inventory CRUD + manifest/packing-slips/batch-labels/pickup-sheet
  pages consolidated into a day-scoped print bar).
- **DD-2 — Fundraiser Handoff Kit:** per released campaign — bag labels grouped
  by `customer_name` (big name, org, contents, "Bag 1 of N", storefront QR per
  SF-9), A–Z interactive handoff check-off card on the Delivery board. Grouping
  mirrors the existing /api/tracker/pickup-sheet aggregation; label rendering
  reuses the existing batch-label printing.
- **DD-3 — Scan-to-deliver:** order-QR on packing slips + bag labels; the
  existing scanner pages (@yudiel/react-qr-scanner) gain a "delivery mode" that
  marks the scanned order delivered (through the DD-0 guarded transition).
- **DD-4 — Notifications:** "out for delivery" batch email on van load-out and
  "ready for pickup" email on pack completion — tenant-branded via lib/email.ts,
  per-tenant toggles (default OFF), no emails to fundraiser buyers.
- **DD-5 — Cleanup + cost visibility:** archive orphans
  (components/production/InProductionArea.tsx, /api/production/deduct);
  packaging cost per run + low-stock nudge on the Supplies tab.

**FUTURE (do not build yet):** Kitchen Wall Mode (?wall=1 auto-refresh display),
capacity forecast (batch-hours from recipe cook times), photo proof of delivery
(S3 client exists — needs storage wiring + its own proposal).

**Dependencies:** DD-0 first (independent, high value). KB-1/DD-1 in either
order after DD-0. DD-2 needs the closeout engine (shipped) + DD-0.1. DD-3 needs
DD-0.5's guard. DD-4 rides existing email infra. Fundraiser boundary: handoff
kit and boards only ever see RELEASED (post-closeout) fundraiser orders; no
payment anything.

---

## 13. Bundles Page track (BP-1..5) — APPROVED 2026-07-12

Home of the Random Bundle Creator (GE-11) plus five approved upgrades. Exact
code will be added to `docs/ai/GROWTH_ENGINE_HANDOFF.md` alongside GE-11 when
these phases queue (BP-1's flag rides the CB-1 migration — see below).

- **BP-1 — Fundraiser Lineup tab (the coordinator-pool selector).** A 4th tab on
  the Bundles page (Bundles / Catalogs / Surplus / **Fundraiser Lineup**):
  1. Lists bundle FAMILIES (grouped by `family_id`), each with a checkmark —
     checked = "offered to coordinators right now." Storage:
     `Bundle.fundraiser_eligible Boolean @default(false)` on the family
     representative — ADD THIS COLUMN TO THE CB-1 MIGRATION (one proposal,
     not two).
  2. Only PAIRED families (both tiers exist + active) can be checked; unpaired
     rows show the pairing status chip and a one-tap "Create Serves 2 pair"
     action (the GE-11 clone convention). This absorbs former idea #1
     ("fundraiser-ready column").
  3. **SEMANTICS (locked):** the lineup is the DEFAULT candidate pool for NEW
     campaigns — CRM-4/CB-4's wizard Step 2 opens pre-checked from it (tenant
     can still adjust per campaign). Lineup changes do NOT retro-apply to
     running campaigns (their candidate pools were snapshotted into
     campaign_bundles rows at creation) — a coordinator's choices are never
     yanked mid-campaign. Editing a running campaign's pool stays a deliberate
     per-campaign action via the existing assignment route.
  4. Each row shows margin health (BP-2 chip) and velocity (BP-3 chip) so
     lineup curation is informed: offer coordinators what sells AND holds margin.
- **BP-2 — Margin health chips + drift surfacing.** Per-bundle live food-cost %
  chip against the 35/40 band (emerald ≤35, amber 35–40, red >40) computed from
  the extracted costing helper; surface `lib/drift_alert.ts` findings on the row
  ("ingredient costs rose — was 33%, now 38%"). Display-only; no pricing writes.
- **BP-3 — Seller velocity chips.** "🔥 Top seller" / "💤 No sales 60+ days"
  from the GE-10 tally queries (channel-aware: storefront vs fundraiser).
- **BP-4 — Catalog scheduler awakening.** The dormant `Catalog` model
  (start/end/is_active) becomes scheduled menus: "Week of Nov 17" auto-activates
  its bundles' storefront visibility in its window (a small daily check — rides
  GE-5 cron or activation-on-read). Feeds the storefront WeekStrip and the VP-2
  menu graphic. Manual toggling remains available; scheduler is additive.
- **BP-5 — Lineup overlap report.** The GE-11 overlap math pointed at currently
  ACTIVE bundles: "this week's lineup = 31 shopping-list items" + best single-swap
  suggestion. Read-only card on the Bundles tab; direct Production-page synergy.

**Boundaries:** no BundleEditor internal changes; no pricing writes anywhere;
BP-1's flag is the only schema touch (inside CB-1's proposal). Order: BP-1 with
CB-1/CB-4 · BP-2 with GE-11 (shared costing) · BP-3 anytime after GE-10 ·
BP-4/BP-5 independent.

### 13.1 Add-On Bundles: Sides & Desserts — APPROVED 2026-07-12 (cross-cutting)

Sides/dessert bundles as coordinator-offered upsells ("above and beyond" the 2
main families). One schema touch, then amendments to phases already specced:

- **Schema (joins the CB-1 migration — still ONE proposal):**
  `Bundle.bundle_type String @default("meal")` — `meal` | `side` | `dessert`.
  Priced freely (typically small: $9–$45); NO serving-tier pairing requirement.
- **BP-1 amendment:** Lineup tab gains a second section "Add-ons: Sides &
  Desserts" — checkmark = offered to coordinators (`fundraiser_eligible` same
  flag; eligibility rule differs: must be active, pairing NOT required).
- **CB-2/CB-3 amendment:** coordinator selection gains an optional add-ons step
  after the exactly-N main choice — check any/none; add-ons do NOT count toward
  `bundle_selection_limit`; validation exempts `bundle_type != 'meal'` from the
  family-pairing requirement. Selected add-ons become active campaign_bundles
  rows like mains — so the offline-order modal, bundle totals, pickup sheets,
  and DD-2 family bag labels include them with ZERO changes to those surfaces.
- **FR-2 amendment:** buyer page renders add-ons in a separate "Add a little
  extra 🍰" strip BELOW the main bundles (upsell placement); freely orderable —
  an add-on-only order is allowed (DECISION 2026-07-12).
- **GOAL-COUNTING DECISION (locked):** add-ons count toward DOLLARS
  (total_sales, settlement, the org's 20% share — automatic via order totals)
  but NOT toward bundle-set goal progress. `equivalentSets()` and every goal/
  progress computation counts `bundle_type='meal'` items only. Scoreboard/
  coordinator progress bars unaffected by add-on volume; money totals include it.
- **20% share:** NO new math — add-on revenue flows through order totals into
  settlement_total; lib/fundraiserMetrics.ts orgShare applies unchanged.
- **GE-11 note (future, optional):** a "create a dessert add-on" creator mode
  (3-item, side/dessert recipes, same margin band) — not in scope now.

**CB-3 add-on nudge (approved 2026-07-12):** the coordinator's add-ons step is
an INVITATION with the earnings math visible, per the §14 doctrine:
"✨ Boost your total — offer desserts & sides. Supporters love easy extras, and
your group earns 20% on every one." Each add-on card shows "+$X to your group"
(20% of price). Skippable in one tap ("No thanks, just the bundles") — never a
blocker, never a countdown.

---

## 14. Coordinator Buy-In Doctrine — GOVERNS ALL FUNDRAISER-PLATFORM WORK

The entire fundraiser platform depends on volunteer coordinators buying in.
Every phase touching coordinator-facing surfaces (portal, selection, guide,
scoreboard, buyer page, closeout, settlement) MUST satisfy these laws. Agents:
check new work against this section before proposing it.

1. **Setup is minutes, not meetings.** A first-time volunteer completes portal
   setup (payment instructions → bundle choices → first share) unassisted in
   under 5 minutes. Any step that can be pre-filled by the tenant or the system
   IS pre-filled (GE-10 suggestions, launch-kit generation, lineup defaults).
2. **Every screen answers "what do I do next?"** Exactly one primary action per
   state (the phase engine's job). No screen may strand a coordinator — every
   locked, pending, or complete state names the next step or who to contact.
3. **Earnings-framed copy everywhere.** Coordinators act when they see what
   their GROUP gets: show the 20% share ("your group earns ~$X"), never gross
   sales alone, in nudges, previews, selection steps, and reports
   (lib/fundraiserMetrics.ts is the single source of that math).
4. **Nudges are invitations with math, never pressure.** No countdowns, no
   guilt, no blockers. Pattern: benefit + number + one-tap skip (see the CB-3
   add-on nudge). Applies to emails (GE-5/GE-7) and portal copy alike.
5. **Close-and-pay is the payoff, not the chore.** The end of a campaign must
   feel like winning: final scoreboard → "what happens next" in 3 concrete
   steps → settlement statement (what the group keeps, what's owed, how to
   pay — checks_payable/instructions surfaced) → visible "Settled ✓" when the
   tenant marks it paid. A coordinator should never have to ASK what they owe
   or whether it's done.
6. **Their effort is always visible.** Progress bars, pace coaching, leader-
   boards, impact reports — the system celebrates the coordinator's work back
   to them, because recognized volunteers rebook (GE-1 depends on this).
7. **Acceptance test (add to §7 gates for any coordinator-facing phase):** walk
   the full journey as a brand-new coordinator on a phone — receive link →
   set up → select bundles (+add-ons nudge) → share → take an order → close →
   see settlement → know exactly how to pay. Zero moments of "now what?"
