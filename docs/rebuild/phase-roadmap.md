# FreezerIQ Rebuild — Phase Roadmap

> **Created:** July 2, 2026
> **Owner:** Nathan
> **Rule:** No phase proceeds without Nathan's approval.

### Order Channel Architecture (Clarified July 3, 2026)

FreezerIQ has two separate order-entry channels that both feed the same tenant backend:

- **Channel 1 — Fundraiser/Coordinator:** No payment processing. Money is collected outside FreezerIQ. Routes: `/coordinator/[token]`, `/fundraiser/[token]`, related APIs. **LOCKED — do not change without Nathan's approval.**
- **Channel 2 — Tenant Storefront:** Stripe/Square payment processing. Routes: `/shop/[slug]/*`, `/api/checkout/*`, `/api/public/order`. Changes require sensitive-file approval workflow.
- **Both channels** feed the same backend: orders, kitchen production, recipes, bundles, labels, prep lists, reporting.

See CLAUDE.md for full details.

---

## Phase 0: Guardrails + Baseline ✅ IN PROGRESS

**Goal:** Establish a safe foundation before any code changes.

| Task | Status | Notes |
|------|--------|-------|
| Read and audit existing CLAUDE.md | ✅ Done | Original was 21 lines, good rules |
| Read Constitution + Architecture docs | ✅ Done | Solid, well-written |
| Update CLAUDE.md with rebuild rules | ✅ Done | Added sensitive file list, approval workflow |
| Create this phase roadmap | ✅ Done | — |
| Run `npx tsc --noEmit` | ⏳ Blocked | Terminal sandbox permission issue; Nathan must run manually |
| Run `npm run lint` | ⏳ Blocked | Same terminal issue |
| Run `npm run build` | ⏳ Blocked | Same terminal issue |
| Record error counts | ⏳ Pending | Waiting on manual runs |

### Baseline Validation — Manual Steps for Nathan

Run these three commands in your terminal and paste the results:

```bash
# 1. TypeScript error count
npx tsc --noEmit 2>&1 | tail -1

# 2. ESLint
npm run lint

# 3. Build (will pass because next.config.js silences errors)
npm run build
```

### Known Issues Found During Audit (No Commands Needed)

| Issue | Severity | File(s) |
|-------|----------|---------|
| `ignoreBuildErrors: true` in next.config.js | 🔴 Critical | `next.config.js:16` |
| `ignoreDuringBuilds: true` for ESLint | 🔴 Critical | `next.config.js:19` |
| Duplicate Stripe webhook handlers | 🔴 Critical | `/api/webhooks/stripe/` AND `/api/stripe/webhook/` |
| OrderStatus enum has both `pending` and `PENDING` | 🔴 Critical | `schema.prisma:744-755` |
| Billing page has hardcoded test price IDs | 🔴 Critical | `settings/billing/page.tsx:23-25` |
| Raw error messages exposed to API callers | 🟠 High | Multiple API routes |
| Manual order POST skips `buildBundlePriceMap()` | 🟠 High | `/api/orders/route.ts:145-148` |
| `$executeRawUnsafe` in recipes API | 🟠 High | `/api/recipes/route.ts:43` |
| `(session.user as any)` casts despite types existing | 🟡 Medium | 20+ API routes |
| Sidebar polls branding every 5 seconds | 🟡 Medium | `Sidebar.tsx:122` |
| 157 loose scripts in `/scripts` | 🟡 Medium | `/scripts/` directory |
| `test-header: security-applied` debug header in production | 🟡 Medium | `next.config.js:41` |
| No automated tests for pricing, orders, or auth | 🟡 Medium | — |
| `next-auth.d.ts` types exist but are ignored via `as any` | 🟡 Medium | `types/next-auth.d.ts` |

---

## Phase 1: Critical Safety Fixes (NOT STARTED)

**Goal:** Fix issues that could cause data corruption, payment errors, or security leaks.
**Requires:** Phase 0 baseline results + Nathan approval.

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

---

## Phase 2: Type Safety + Auth Hardening (NOT STARTED)

**Goal:** Remove `as any` abuse, standardize auth checks.
**Requires:** Phase 1 complete + Nathan approval.

### Planned Tasks

- Create `getAuthenticatedSession()` typed utility
- Create `requireSuperAdmin()` typed utility
- Audit all API routes for consistent auth/tenant scoping
- Remove `ignoreBuildErrors` from next.config.js (after fixing TS errors)
- Expand `env.ts` Zod validation for all required env vars

---

## Phase 3: SaaS Billing + Onboarding (NOT STARTED)

**Goal:** Real billing, plan gating, self-service onboarding.
**Requires:** Phase 2 complete + Nathan approval.

---

## Phase 4: UI/UX Polish (NOT STARTED)

**Goal:** Mobile nav, loading states, empty states.
**Requires:** Phase 3 complete + Nathan approval.

---

## Phase 5: Admin + Observability (NOT STARTED)

**Goal:** Expand super admin dashboard, structured logging.
**Requires:** Phase 4 complete + Nathan approval.

---

## Phase 6: Testing + Documentation (NOT STARTED)

**Goal:** Unit tests for critical paths, updated docs.
**Requires:** Phase 5 complete + Nathan approval.

---

## Rules for All Phases

1. Each phase must be approved by Nathan before starting.
2. Sensitive core files require the 8-step proposal workflow (see CLAUDE.md).
3. No business logic changes without explicit approval.
4. No schema changes without migration plan.
5. No payment/auth changes without proposal.
6. Each change should be small enough to review in 5 minutes.
7. After each change, report what changed and what remains uncertain.
8. **Channel 1 (fundraiser/coordinator) is LOCKED.** Do not change coordinator pages, fundraiser pages, coordinator APIs, fundraiser token APIs, order submission behavior, or external payment-link behavior unless Nathan approves a specific proposal.
9. **Do not add payment processing to Channel 1.** Stripe and Square belong to Channel 2 (tenant storefront) only.
