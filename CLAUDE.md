# FreezerIQ Claude Instructions

Read these files before making decisions:

- [CONSTITUTION](docs/ai/CONSTITUTION.md)
- [ARCHITECTURE](docs/ai/ARCHITECTURE.md)
- [ENVIRONMENT](docs/ai/ENVIRONMENT.md)
- [INTEGRATIONS](docs/ai/INTEGRATIONS.md)
- [WORKFLOWS](docs/ai/WORKFLOWS.md)
- [PHASE ROADMAP](docs/rebuild/phase-roadmap.md)

## Project Identity

FreezerIQ is a **standalone multi-tenant SaaS** for frozen food businesses.
Do NOT connect it to Best Brew GO, Crema, or any other app.

## Order Channel Architecture

FreezerIQ has **two separate order-entry channels** that both feed into the same tenant backend (kitchen production, recipes, bundles, labels, prep lists, reporting).

### Channel 1 — Fundraiser / Coordinator (No Payment Processing)

- Routes: `/coordinator/[token]`, `/fundraiser/[token]`, `/api/coordinator/[token]`, `/api/coordinator-actions/[token]`, `/api/fundraiser/[token]`
- **No Stripe. No Square. No payment processing inside FreezerIQ.**
- The coordinator/fundraiser collects money outside FreezerIQ (cash, checks, Venmo, PayPal, etc.).
- If a Venmo/PayPal link appears in this flow, it is an external link the coordinator provides — FreezerIQ does not process, verify, settle, refund, or reconcile those payments.
- Orders from this channel flow into the tenant backend for kitchen production.
- **This channel is LOCKED.** Do not change coordinator pages, fundraiser pages, coordinator APIs, fundraiser token APIs, coordinator order submission, fundraiser-facing order behavior, or external payment-link behavior unless Nathan approves a specific proposal.

### Channel 2 — Tenant Storefront / Customer Ordering (Payment Processing)

- Routes: `/shop/[slug]/*`, `/api/checkout/session`, `/api/checkout/square/*`, `/api/public/order`
- This is where Stripe or Square payment processing may be used.
- Tenants promote their own storefront or webpage.
- Customers order bundles and/or singles online.
- Orders from this channel also flow into the tenant backend for kitchen production.

### Backend Relationship

Both channels are separate customer-facing front ends. Both feed the **same** tenant backend operations: orders, kitchen production, recipes, bundles, labels, prep lists, reporting. Do not merge the channels. Do not add payment processing to Channel 1. Do not remove payment processing from Channel 2.

## Project Rules

- Follow the constitution over convenience.
- Prefer diagnosis and containment over speculative coding.
- Never assume an integration works because routes or helper files exist.
- Never mix platform SaaS billing with tenant commerce billing.
- Treat auth, billing, schema, env loading, and domain routing as protected areas.
- Before edits, summarize files inspected, constraints, risks, and smallest safe change.
- After edits, summarize validation and remaining uncertainty.
- Treat loose root scripts, logs, backups, and debug files as non-authoritative unless verified.
- Do not read or modify `.env*` files unless explicitly asked.

## Rebuild Rules

This codebase is undergoing a phased cleanup. These rules govern ALL rebuild work:

1. **No broad rewrites.** Fix one thing at a time. Small, reviewable changes only.
2. **Do not remove working features.** Every change must preserve existing behavior.
3. **Do not modify `next.config.js` to hide errors.** `ignoreBuildErrors` and `ignoreDuringBuilds` are tech debt to be resolved, not preserved.
4. **Do not change the database schema** without an explicit migration plan approved by Nathan.
5. **Do not change auth logic** (NextAuth config, session callbacks, middleware auth checks).
6. **Do not change payment logic** (Stripe platform billing, Stripe Connect, Square checkout).
7. **Do not change pricing calculations** (`buildBundlePriceMap`, `pricing.ts`).
8. **Do not change serving-size math** (`serving_multipliers.ts`, `getServingMultiplier`, `resolveVariantSize`).
9. **Do not change recipe/bundle cost calculations** (`kitchen_engine.ts`, `cost_engine.ts`).
10. **Do not change coordinator token behavior** (`/api/coordinator/[token]`).
11. **Do not change fundraiser/coordinator channel.** This includes coordinator pages, fundraiser pages, coordinator APIs, fundraiser token APIs, coordinator order submission, fundraiser-facing order behavior, and external payment-link behavior. This channel has NO payment processing — do not add any.
12. **Do not add payment processing to the fundraiser/coordinator channel.** Stripe and Square belong to Channel 2 (tenant storefront) only.

## Sensitive Core Files

These files require the **proposal-first approval workflow** before ANY edit:

| File | Protected Area |
|------|---------------|
| `components/RecipeEditor.tsx` | Recipe editor UI |
| `components/BundleEditor.tsx` | Bundle editor UI |
| `app/coordinator/[token]/page.tsx` | Coordinator portal UI (Channel 1 — LOCKED) |
| `app/fundraiser/[token]/page.tsx` | Fundraiser scoreboard (Channel 1 — LOCKED) |
| `lib/pricing.ts` | Price validation engine |
| `lib/serving_multipliers.ts` | Serving size math |
| `lib/kitchen_engine.ts` | Production calculations |
| `lib/cost_engine.ts` | Cost calculations |
| `lib/statusWorkflow.ts` | Order lifecycle |
| `app/api/orders/route.ts` | Order CRUD |
| `app/api/public/order/route.ts` | Storefront order creation (Channel 2) |
| `app/api/checkout/session/route.ts` | Checkout/payment flow (Channel 2) |
| `app/api/checkout/square/*/route.ts` | Square checkout flow (Channel 2) |
| `app/api/coordinator/[token]/route.ts` | Coordinator API (Channel 1 — LOCKED) |
| `app/api/coordinator-actions/*/route.ts` | Coordinator actions (Channel 1 — LOCKED) |
| `app/api/fundraiser/[token]/route.ts` | Fundraiser token API (Channel 1 — LOCKED) |
| `app/api/webhooks/stripe/route.ts` | Platform webhook |
| `app/api/stripe/webhook/route.ts` | Duplicate webhook (to be removed) |
| `app/api/stripe/checkout/route.ts` | Platform billing checkout |
| `prisma/schema.prisma` | Database schema |
| `middleware.ts` | Auth + tenant routing |
| `auth.ts` / `auth.config.ts` | Auth configuration |

### Required Approval Workflow for Sensitive Files

Before editing ANY file in the table above:

1. Read the current file and summarize what it does in plain English.
2. Identify the exact pain point or risk.
3. Explain what you want to change in layman's terms.
4. List the exact files you would touch.
5. Explain what will stay the same.
6. Explain what could break.
7. Explain how you would test it.
8. **STOP and wait for Nathan's approval before editing.**

## Known Tech Debt (Phase 0 Baseline)

- `next.config.js` silences TypeScript and ESLint build errors
- Duplicate Stripe webhook handlers at two different paths
- `OrderStatus` enum has duplicate lowercase/UPPERCASE values
- Billing page has hardcoded test Stripe price IDs
- Error messages leak internal details to API callers
- Manual order POST skips centralized price validation
- `$executeRawUnsafe` used in recipes API (should be `$executeRaw`)
- `(session.user as any)` casts despite `next-auth.d.ts` having the types
- 157 loose scripts in `/scripts` directory
- Sidebar polls branding API every 5 seconds
- No automated tests for critical business logic
