# FreezerIQ AI Constitution
Last updated: 2026-03-09

## 1) Product Identity
FreezerIQ is a multi-tenant SaaS platform for freezer meal businesses.
It includes:
- Super Admin platform backend
- Tenant business backend
- Customer-facing storefronts
- SaaS subscription billing for tenants
- Optional tenant payment processing integrations for customer orders

## 2) Non-Negotiable Architecture Rules
1. Platform SaaS billing and tenant storefront payment processing are separate domains.
2. FreezerIQ platform Stripe credentials must never be mixed with tenant payment credentials.
3. Test and live Stripe accounts must never be mixed in code, config, documentation, or debugging.
4. All tenant-owned business data must remain scoped by business/org ID.
5. Premium features must not be treated as available unless plan gating exists in backend and frontend.
6. Partial integrations are allowed only if clearly marked as stub, planned, or disabled.
7. Environment variable cleanup and system integrity outrank new feature work.
8. Never invent credentials, IDs, product mappings, webhook secrets, or OAuth settings.
9. Never silently rename schema fields, enums, or integration contracts without an explicit migration plan.
10. Never treat "route exists" as "integration works."

## 3) Current Tech Stack
- Next.js 16
- React 19
- Tailwind 4
- NextAuth v5 credentials auth
- Supabase Postgres
- Prisma 5.x
- Vercel
- Resend
- Stripe
- Square
- QuickBooks Online
- Twilio
- OpenAI
- Cloudflare R2

Do not propose stack swaps unless explicitly asked.

## 4) Current Repo Priorities
Priority order:
1. Stabilize environment configuration
2. Resolve Stripe account mismatch
3. Fix broken storage config
4. Normalize schema inconsistencies
5. Enforce subscription and plan-gating architecture
6. Verify integrations one by one
7. Only then continue feature work

## 5) Known Critical Problems
- S3_ACCESS_KEY_ID is misconfigured
- Stripe test/live accounts are mixed
- OrderStatus enum is semantically duplicated
- Plan gating is missing
- Trial enforcement is missing
- Upgrade/downgrade flow is incomplete
- Several integrations exist in code but are not production-configured

Treat these as active constraints in all planning.

## 6) Source-of-Truth Rules
When analyzing or editing the repo, treat the following as source-of-truth areas:
- Prisma schema for data model truth
- env contract documentation for configuration truth
- billing/integration mapping docs for payment truth
- architecture docs for system boundaries
- not one-off scripts, logs, backups, or debug files

Assume root-level loose scripts may be stale unless verified.

## 7) Required Working Style
Before making changes:
1. Read the relevant architecture and environment docs
2. Inspect the exact files involved
3. State the intended change in plain English
4. Identify risks, especially billing/auth/data risks
5. Make the smallest safe change
6. Verify with typecheck/lint/tests where available
7. Report exactly what changed and what remains uncertain

## 8) Forbidden Behaviors
Do not:
- change billing credentials casually
- generate fake secrets or placeholder "working" IDs
- wire live billing flows without explicit confirmation of canonical account
- make schema changes without migration notes
- modify more files than necessary
- leave TODO-style half-integrations masquerading as complete
- add new env vars without documenting ownership and purpose
- rely on deprecated or duplicate enum values continuing forever

## 9) Billing Law
FreezerIQ platform billing:
- charges tenants for SaaS plans
- belongs to the platform's Stripe account only

Tenant storefront billing:
- charges end customers for meal orders
- must use tenant-connected payment credentials
- must not be confused with platform subscription billing

Any code path mixing those domains is a bug.

## 10) Integration Status Vocabulary
Use exactly one of these labels when discussing integrations:
- active
- configured-not-verified
- stubbed
- broken
- planned
- deprecated

Do not call something "working" unless it is verified end-to-end.

## 11) Environment Rules
- One canonical env contract must exist
- Variable names must be standardized
- Test vs live values must be clearly separated
- Missing secrets should fail loudly in non-dev paths
- Secret-bearing files must not be casually read, copied, or rewritten

## 12) Schema Rules
- Enums must have one semantic casing style
- Business/org scoping must be explicit
- Billing status fields must map cleanly to provider semantics
- Migrations must preserve existing production data

## 13) Output Expectations for AI Agents
When asked to work, return:
1. what files were inspected
2. what constraints apply
3. exact proposed change
4. minimal diff strategy
5. validation steps
6. follow-up risks

## 14) If Unclear
If architecture, billing ownership, integration status, or env truth is unclear:
- stop implementation
- report ambiguity
- recommend the smallest audit or documentation update needed

## 15) Fundraiser Commerce Architecture
Fundraiser flows are campaign-scoped tenant commerce flows and must not be flattened into generic storefront or generic customer logic without preserving coordinator roles, private-link access patterns, and fundraiser attribution.
