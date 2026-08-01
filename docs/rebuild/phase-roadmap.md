# FreezerIQ Rebuild — Phase Roadmap

> **Created:** July 2, 2026 · **Reconciled:** August 1, 2026
> **Owner:** Nathan
> **Rule:** No phase proceeds without Nathan's approval.

> [!IMPORTANT]
> **Current source of truth:** [`docs/ai/UI_REDESIGN_SPEC.md`](../ai/UI_REDESIGN_SPEC.md) is the design and phase authority. This file is the **implementation ledger and dependency sequence** — it tracks what's done, what's next, and what's parked. **The spec wins on any conflict.**

> [!NOTE]
> **NEXT STOREFRONT PHASE: SF-4 — Bag redesign.** See [`docs/ai/STOREFRONT_REDESIGN_HANDOFF.md`](../ai/STOREFRONT_REDESIGN_HANDOFF.md). DD-0.1 through DD-0.5 and KB-1A/1B are complete. SF-1 through SF-3 (including SF-3E) are complete and validated.

---

## Current Project Position

| | |
|---|---|
| **Last formally completed storefront phase** | SF-3 (including SF-3E) — Fable bundle shopping + empty state (`4234c93`, `a1a94c9`) |
| **Last formally completed pipeline phase** | DD-0.5 + KB-1B |
| **Last launch-readiness phase** | FR-LAUNCH-1E |
| **Next storefront phase** | SF-4 — Bag redesign (per STOREFRONT_REDESIGN_HANDOFF.md) |
| **CB-7 Meal Preview** | Registered — may begin (DD-0.1 prerequisite satisfied) |
| **Password reset** | Parked — see [Parked Work](#parked-work) |
| **Migration-history reconciliation** | Parked — separate future phase |

---

## Order Channel Architecture (Clarified July 3, 2026)

FreezerIQ has two separate order-entry channels that both feed the same tenant backend:

- **Channel 1 — Fundraiser/Coordinator:** No payment processing. Money is collected outside FreezerIQ. Routes: `/coordinator/[token]`, `/fundraiser/[token]`, related APIs. **LOCKED — do not change without Nathan's approval.**
- **Channel 2 — Tenant Storefront:** Stripe/Square payment processing. Routes: `/shop/[slug]/*`, `/api/checkout/*`, `/api/public/order`. Changes require sensitive-file approval workflow.
- **Both channels** feed the same backend: orders, kitchen production, recipes, bundles, labels, prep lists, reporting.

See CLAUDE.md for full details.

---

## Completed Implementation Ledger

### Security & Coordinator

| Item | Status | Evidence |
|---|---|---|
| 7B-0 — Campaign POST customer-ownership fix | ✅ Complete | `4f01457` |
| 7B-1 — Guide page token-auth fix | ✅ Complete | `da916c4` |
| Coordinator panel redesign (phase-engine states) | ✅ Complete | `d806ad5`, `5b4df4b` |
| 7C — Sticky ActionBar | ✅ Complete | shipped in `d806ad5` |
| 7D — SetupChecklist | ✅ Complete | shipped in `d806ad5` |
| 7E — Closeout engine (invoice, payment gate, coordinator read-only complete state) | ✅ Complete | `566b74e`, `2a3d142`, `1bd6599`, `71b1412`, `d0967d3`, `1085f87` |
| FIX-3 — Tenant-branded fundraiser info templates | ✅ Complete | `1ee02f2` |
| Tenant-isolation & route-auth hardening | ✅ Complete (recorded security body of work) | `d247219`, `e1c8659`, `6bd036c`, order-status canonicalization chain (`59710f5`…`a5f8a9c`) |

> FIX-1, FIX-2, and FIX-4 are **not** assigned to commits here — no repository document defines them. See [Open Questions](#open-questions).

### Recipe Library

| Item | Status | Evidence |
|---|---|---|
| Recipe Library redesign | ✅ Complete | `1db7d9b`, `5d49215`, `516d305` |

### CRM

| Item | Status | Evidence |
|---|---|---|
| CRM-1 — Fundraisers dashboard | ✅ Complete | `b53abc5`, `64fa41f` |
| CRM-1B | ✅ Complete (owner-attested) | Label undefined in repo docs — needs formal definition or folding into CRM-1. See [Open Questions](#open-questions). |
| CRM-2 — Organization profile | ✅ Complete | `0e435bd` |
| CRM-3 — Customers unification | ✅ Complete | `516f8f2` |
| CRM-4 — Start a Fundraiser wizard | ✅ Complete | `025d217` (prerequisites 7B-0 + FIX-3 verified before activation) |

### Coordinator Bundle Selection (CB)

| Item | Status | Evidence |
|---|---|---|
| CB-1 — Schema + backfill | ✅ Complete | `381f537`, `7ceec4a` |
| CB-2 — Submission API | ✅ Complete | `df9bb39` |
| CB-3 — Portal selection UI | ✅ Complete | `b6650b2` |
| CB-4 — Wizard candidate semantics | ✅ Complete | `de7bbf7` |
| CB-5 — Ordering gates | ✅ Complete | `3a7e93f`, `ce413db` |
| CB-6 — Surface filters + tenant admin (reset/override) | ✅ Complete | `68071d0` |
| CB candidate/active constraint correction (post-CB-5 hardening) | ✅ Complete | `926dbce` — widened `campaign_bundles` uniqueness to `(campaign_id, bundle_id, state)` |
| CB-5 strict serving-tier correction | ✅ Complete | `364377f` — replaced raw tier comparison with `normalizeStrictServingTier` |
| Selected-bundle flyer/packet labels | ✅ Complete | `1463dff` |
| **CB-7 — Coordinator Bundle Meal Preview** | 🔒 Registered — not started | DD-0.1 prerequisite now satisfied; may begin when queued |

### Kitchen/Delivery Pipeline (DD-0, KB-1)

| Item | Status | Evidence |
|---|---|---|
| DD-0.1 — Released fundraiser orders reach production | ✅ Complete | `8cf9564` |
| DD-0.2 — `order_count` counts distinct orders | ✅ Complete | `9ba3f98` |
| DD-0.3A — Order-week escape hatches bounded | ✅ Complete | `a1e3216` — DD-0.3B backfill **rejected** (completed ≠ delivered; no evidence) |
| DD-0.4 — Delivery run restricted to `ready_to_ship` | ✅ Complete | `5a80b30` |
| DD-0.5 — Illegal order-status transitions guarded | ✅ Complete | `feb3730` |
| KB-1A — Legacy kitchen workflow bridged | ✅ Complete | `ef05e80` |
| KB-1B — Safe kitchen batch transitions enforced | ✅ Complete | `5316ad9` |

### Launch Readiness (FR-LAUNCH)

| Item | Status | Evidence |
|---|---|---|
| FR-LAUNCH-1A — Public fundraiser order lifecycle aligned | ✅ Complete | `033de7e` |
| FR-LAUNCH-1B — Public fundraiser cart + submission UI (Fable) | ✅ Complete | `20ce683` |
| FR-LAUNCH-1C-1 — Fundraiser dashboard weighted progress fix | ✅ Complete | `e7ef40c` |
| FR-LAUNCH-1D — Coordinator transactional order notification | ✅ Complete | `d3dd7aa` |
| FR-LAUNCH-1E — Submission idempotency + concurrency hardening | ✅ Complete | `32d9610` |

### Loyalty Cleanup (LOY-P0)

| Item | Status | Evidence |
|---|---|---|
| LOY-P0a — New loyalty accrual paused behind a shared gate | ✅ Complete | `cadcf0f` |
| LOY-P0b — Loyalty messaging corrected while accrual is paused | ✅ Complete | `011cf3f` |

### Infrastructure Hardening

| Item | Status | Evidence |
|---|---|---|
| Prisma/Vercel build hardening | ✅ Complete | `a8e6d6b` — regenerate Prisma Client before builds |
| Fundraiser supporter-email polish | ✅ Complete | `0473731` |
| Delivery geocoding fix | ✅ Complete | `fa113ce` — classifies not_configured / not_found / provider_error |

### Storefront Redesign (SF)

| Item | Status | Evidence |
|---|---|---|
| SF-1 — Brand token system | ✅ Complete | `a96b7f4` |
| SF-1 documentation closeout | ✅ Complete | `855d4b1` |
| SF-2A — Fable storefront landing shell | ✅ Complete | `717840c` |
| SF-3 — Fable bundle shopping experience | ✅ Complete | `4234c93` |
| SF-3E — Zero-bundle storefront empty state | ✅ Complete | `a1a94c9` |
| SF-2/SF-3 accepted deferrals | 9 data-dependent deferrals recorded | See STOREFRONT_REDESIGN_HANDOFF.md |

**SF-2/SF-3 validation evidence (closeout):** `npx tsc --noEmit` passed · Prisma Client
generation passed · Next.js 16.1.1 production build passed · static generation 166/166
pages · storefront reviewed at runtime on `/shop/my-freezer-chef` (first-visit UI, bundle
cards, cart access, checkout reachability) · returning-state behavior **code-verified**,
not live-tested · no relevant SF-2/SF-3 console or network regressions observed.

> **Scope note:** SF-1 → SF-3E are closed. The storefront redesign as a whole is **not**
> complete — SF-4 through SF-12 remain outstanding.

---

## Active Remaining Sequence

### Storefront redesign (current track)

1. **SF-4** — Bag redesign *(next storefront phase)*
2. SF-5 — Confirmation retention page
3. SF-6 — Schema proposal (PROPOSAL-FIRST)
4. SF-7 — Gifting
5. SF-8 — Review loop (wants GE-5 cron)
6. SF-9 — Label QR loop
7. SF-10 — "Usual box" email + cart prefill (wants GE-5 cron)
8. SF-11 — PWA
9. SF-12 — Express wallets (PROPOSAL-FIRST)

### Kitchen/Delivery pipeline (remaining)

1. DD-1 — Kitchen Board advanced (DD-0 complete ✅)
2. DD-2 — Fundraiser Handoff Kit (DD-0.1 ✅ + closeout ✅)
3. DD-3 — Scan-to-deliver (DD-0.5 guard ✅)
4. DD-4 — Delivery/pickup notifications
5. DD-5 — Cleanup + cost visibility

**CB-7** may now begin (DD-0.1 prerequisite satisfied).

### Remaining program tracks (status by source evidence, no invented ordering)

| Track | Status | Dependency notes |
|---|---|---|
| GE-1 – GE-5 | NOT STARTED | Gate open — CRM-1..4 merged ✅ |
| GE-6 – GE-9 | NOT STARTED | Independent extensions of GE-1..5 |
| GE-10 – GE-11 | NOT STARTED | GE-11 optional CB connection ready (CB-1 ✅) |
| PF-1 – PF-6 | NOT STARTED | DEPENDENCY-GATED — after CRM (✅) **and** GE-1..5 stable |
| SF-4 – SF-12 | NOT STARTED | SF-4 next; SF-8/SF-10 want GE-5 cron |
| FR-1 – FR-4 | NOT STARTED | FR-1 PROPOSAL-FIRST; wants SF-1 tokens ✅; CB gates ✅ |
| VP-1 – VP-3 | NOT STARTED | VP-2 synergy with FB-3 (not a hard dependency) |
| VP-F1, VP-F2 | REGISTERED — FUTURE | Do not build as part of VP-1..3 |
| BP-1 – BP-5 | NOT STARTED | BP-1 needs a **new** schema proposal — see [Missed Shared-Migration Note](#missed-shared-migration-note) |
| §13.1 Add-ons (sides/desserts) | NOT STARTED | Same missed-migration issue (`bundle_type`) |
| MC-0 – MC-5 | NOT STARTED | MC-0.2 needs the same missed-migration proposal (`low_stock_threshold`); MC-2 leans on FIX-3 ✅ |
| FB-1 – FB-4 | NOT STARTED | `generate/route.ts` still uses the pre-FB-1 scoreboard URL builder |

---

## DD-0.1 Definition

**DD-0.1 — Released fundraiser orders must reach the kitchen**

- **Owning sources:** `UI_REDESIGN_SPEC.md` §12 (DD-0 item 1) + `KITCHEN_DELIVERY_HANDOFF.md` (exact code).
- **Scope:** `app/api/production/dashboard/route.ts` — update all three relevant queries: exclude orders by `status: 'fundraiser_hold'` instead of `source: { not: 'fundraiser' }`, preserving the existing unpaid-storefront exclusion with correct AND semantics.
- **Prerequisites:** none — independently shippable, ships value alone.
- **Locked files touched:** none.
- **Proposal-first:** No.
- **Acceptance:** released fundraiser orders (post-closeout) appear on the kitchen dashboard and delivery; held (`fundraiser_hold`) orders remain excluded.

*(Not implemented as part of this reconciliation.)*

---

## Parked Work

### Password reset

**Parked** until migration-history reconciliation is completed and this feature is explicitly reopened.

- `app/login/page.tsx` (forgot-password link)
- `app/api/auth/forgot-password/`
- `app/api/auth/reset-password/`
- `app/forgot-password/`
- `app/reset-password/`
- `PasswordResetToken` schema hunk in `prisma/schema.prisma` (plus its existing EOF-blank-line whitespace issue)

No database migration exists for `PasswordResetToken` yet. **Do not run any Prisma migration command** against this work under the current parked state.

### Migration-history reconciliation

Separate future forensic/baselining phase. The CB-1 and CB-repair migrations were manually owner-applied per their own file headers — this is documented precedent, not a substitute for the reconciliation phase. Do not merge this work into DD-0.1 or password reset. Do not run `prisma migrate dev`, `prisma migrate deploy`, or `prisma migrate resolve` under the current parked state.

---

## Missed Shared-Migration Note

The spec instructed these fields to join the CB-1 migration:

- `Bundle.fundraiser_eligible` (BP-1)
- `Bundle.bundle_type` (§13.1 add-ons)
- `Ingredient.low_stock_threshold` (MC-0.2)

**CB-1 shipped without them** (verified against `20260711000000_cb1_bundle_selection_storage/migration.sql`). When BP-1, §13.1, or MC-0.2 are queued, they require a **new, consolidated schema proposal and migration plan** — the original "join CB-1" instruction is no longer executable as written.

---

## Shared Dependency Notes

- **GE-5 cron infrastructure** is shared by GE-7, SF-8, SF-10, and PF-6 — build once, reuse.
- **PF-1..6** must wait until CRM is complete (✅) **and** GE-1..5 are stable.
- **§14 Coordinator Buy-In Doctrine** is standing law for all fundraiser-facing work — check every coordinator-touching phase against it before proposing.
- **VP-F1 / VP-F2** remain future work; do not build as part of VP-1..3.
- **FB-1..4** remain not started; FB-1 is the prerequisite for FB-2/FB-3 messaging accuracy.

---

## Open Questions

Non-blocking — recorded for Nathan, not invented:

- Define or retire **FIX-1**
- Define or retire **FIX-2**
- Define or retire **FIX-4**
- Define or fold **CRM-1A** into an existing CRM phase
- Define or fold **CRM-1B** into CRM-1

---

## Known Issues — Re-Audited

| Issue | Original severity | Status |
|---|---|---|
| Duplicate Stripe webhook handlers | 🔴 Critical | ✅ Resolved — roles clarified as intentionally separate (platform billing vs. tenant storefront) and secrets hardened (`fd8aed7`) |
| OrderStatus enum had both `pending` and `PENDING` | 🔴 Critical | ✅ Resolved — canonicalization chain complete (`3d6b7a8` … `a5f8a9c`) |
| `ignoreBuildErrors: true` in next.config.js | 🔴 Critical | ⏳ Needs re-audit — verify current status |
| `ignoreDuringBuilds: true` for ESLint | 🔴 Critical | ⏳ Needs re-audit |
| Billing page hardcoded test price IDs | 🔴 Critical | ⏳ Needs re-audit |
| Raw error messages exposed to API callers | 🟠 High | ⏳ Needs re-audit |
| Manual order POST skips `buildBundlePriceMap()` | 🟠 High | ⏳ Needs re-audit |
| `$executeRawUnsafe` in recipes API | 🟠 High | ⏳ Needs re-audit |
| Sidebar polls branding every 5 seconds | 🟡 Medium | ⏳ Open — known re-audit item |
| `(session.user as any)` casts | 🟡 Medium | ⏳ Needs re-audit |
| 157 loose scripts in `/scripts` | 🟡 Medium | ⏳ Needs re-audit |
| `test-header: security-applied` debug header | 🟡 Medium | ⏳ Needs re-audit |
| No automated tests for pricing/orders/auth | 🟡 Medium | ⏳ Open |

*(No fixes performed as part of this reconciliation — status column reflects re-audit findings only.)*

---

## HISTORICAL ROADMAP — SUPERSEDED BY THE UI REDESIGN PROGRAM ON 2026-07-09

> [!NOTE]
> The phases below (0–6) predate `docs/ai/UI_REDESIGN_SPEC.md` and no longer control current sequencing. Retained for historical context only.

### Phase 0: Guardrails + Baseline — SUPERSEDED (baseline since achieved)

**Goal:** Establish a safe foundation before any code changes.

| Task | Status | Notes |
|------|--------|-------|
| Read and audit existing CLAUDE.md | ✅ Done | Original was 21 lines, good rules |
| Read Constitution + Architecture docs | ✅ Done | Solid, well-written |
| Update CLAUDE.md with rebuild rules | ✅ Done | Added sensitive file list, approval workflow |
| Create this phase roadmap | ✅ Done | — |
| Run `npx tsc --noEmit` | ✅ Since passing routinely | Verified as part of subsequent phase validations |
| Run `npm run lint` | ⏳ Historical — not re-verified here | — |
| Run `npm run build` | ✅ Since passing routinely | Verified as part of subsequent phase validations |
| Record error counts | ⏳ Historical — superseded by ongoing validation | — |

### Phase 1: Critical Safety Fixes — SUPERSEDED

**Goal:** Fix issues that could cause data corruption, payment errors, or security leaks.
**Requires:** Phase 0 baseline results + Nathan approval.

Current status of each item: see [Known Issues — Re-Audited](#known-issues--re-audited).

<details>
<summary>Original Phase 1 plan — superseded</summary>

### Planned Tasks (Pending Approval)

| # | Task | Sensitive? | Risk |
|---|------|-----------|------|
| 1 | Delete duplicate webhook `/api/stripe/webhook/route.ts` | ⚠️ Yes | Low — verify Stripe Dashboard URL first |
| 2 | Fix billing page hardcoded price IDs | No | Low |
| 3 | Create `safeErrorResponse()` utility | No (new file) | Low |
| 4 | Apply `safeErrorResponse()` to API routes | ⚠️ Yes | Low — only changes error returns |
| 5 | Fix manual order pricing (use `buildBundlePriceMap`) | ⚠️ Yes | Medium — requires proposal |
| 6 | Replace `$executeRawUnsafe` in recipes API | ⚠️ Yes | Low — requires proposal |
| 7 | Remove unnecessary `(session.user as any)` casts | No | Low — types already exist |

</details>

### Phase 2: Type Safety + Auth Hardening — SUPERSEDED

**Goal:** Remove `as any` abuse, standardize auth checks.
**Requires:** Phase 1 complete + Nathan approval.

Largely absorbed into the tenant-isolation & route-auth hardening body of work recorded above.

<details>
<summary>Original Phase 2 plan — superseded</summary>

### Planned Tasks

- Create `getAuthenticatedSession()` typed utility
- Create `requireSuperAdmin()` typed utility
- Audit all API routes for consistent auth/tenant scoping
- Remove `ignoreBuildErrors` from next.config.js (after fixing TS errors)
- Expand `env.ts` Zod validation for all required env vars

</details>

### Phase 3: SaaS Billing + Onboarding — SUPERSEDED (not restarted under this label)

<details>
<summary>Original Phase 3 plan — superseded</summary>

**Goal:** Real billing, plan gating, self-service onboarding.
**Requires:** Phase 2 complete + Nathan approval.

(No further task breakdown existed beyond the goal statement in the original document.)

</details>

### Phase 4: UI/UX Polish — SUPERSEDED

Absorbed into the UI Redesign Program (coordinator, recipe library, CRM, storefront tracks).

<details>
<summary>Original Phase 4 plan — superseded</summary>

**Goal:** Mobile nav, loading states, empty states.
**Requires:** Phase 3 complete + Nathan approval.

(No further task breakdown existed beyond the goal statement in the original document.)

</details>

### Phase 5: Admin + Observability — SUPERSEDED (not restarted under this label)

<details>
<summary>Original Phase 5 plan — superseded</summary>

**Goal:** Expand super admin dashboard, structured logging.
**Requires:** Phase 4 complete + Nathan approval.

(No further task breakdown existed beyond the goal statement in the original document.)

</details>

### Phase 6: Testing + Documentation — SUPERSEDED (not restarted under this label)

<details>
<summary>Original Phase 6 plan — superseded</summary>

**Goal:** Unit tests for critical paths, updated docs.
**Requires:** Phase 5 complete + Nathan approval.

(No further task breakdown existed beyond the goal statement in the original document.)

</details>

### Former "Phase 7" proposal — SUPERSEDED

A prior uncommitted draft proposed sub-phases 7A–7G for coordinator cleanup and a closeout/payment gate. That draft's lettering does not match what actually shipped (7B-0/7B-1/7C/7D/7E, see [Completed Implementation Ledger](#completed-implementation-ledger)) and is replaced by it. The closeout/payment-gate work it anticipated is complete (7E). The coordinator UX/step-by-step-flow ideas (former 7A/7B) are absorbed into the shipped coordinator panel redesign. The delivery/pickup-sheet + box-label idea (former 7F) is carried forward as DD-2 (Fundraiser Handoff Kit) in the active DD/KB sequence. One concept — the manual-bypass/admin-override idea (former 7G) — has no shipped or scheduled equivalent; it is preserved below rather than discarded.

### Unscheduled historical backlog from the former Phase 7 proposal

> [!NOTE]
> **UNSCHEDULED · NOT PART OF THE ACTIVE SEQUENCE · REQUIRES A FRESH PROPOSAL BEFORE IMPLEMENTATION.**

**Manual Bypass / Admin Override** (original intent, former "Phase 7G"):

For coordinators using paper orders, spreadsheets, or outside systems:

- Tenant/admin can manually enter totals.
- Tenant/admin can accept offline payment confirmation.
- Tenant/admin can approve production manually.
- This bypass must be controlled (logged, auditable) and not self-serve for coordinators.

This does not appear anywhere in the current active sequence and is not committed scope. It has no assigned timing relative to DD-0.1 and requires a fresh proposal before implementation.

---

## Rules for All Phases

1. Each phase must be approved by Nathan before starting.
2. Sensitive core files require the 8-step proposal workflow (see CLAUDE.md).
3. No business logic changes without explicit approval.
4. No schema changes without a migration plan.
5. No payment/auth changes without proposal.
6. Each change should be small enough to review in 5 minutes.
7. After each change, report what changed and what remains uncertain.
8. **Channel 1 (fundraiser/coordinator) is LOCKED.** Do not change coordinator pages, fundraiser pages, coordinator APIs, fundraiser token APIs, order submission behavior, or external payment-link behavior unless Nathan approves a specific proposal.
9. **Do not add payment processing to Channel 1.** Stripe and Square belong to Channel 2 (tenant storefront) only.
10. **`docs/ai/UI_REDESIGN_SPEC.md` overrides this roadmap on any conflict.**
