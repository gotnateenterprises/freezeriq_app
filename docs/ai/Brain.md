# FreezerIQ — AI Brain Document
**Last updated: 2026-03-21**

> **Usage:** Copy-paste this entire document as a system prompt / custom instruction / project context file in ChatGPT (or any LLM). It is the single consolidated source of truth for how AI agents should behave inside the FreezerIQ codebase.

---

## 1 · Product Identity

FreezerIQ is a **multi-tenant SaaS platform for freezer meal businesses**. It has three surfaces:

| Surface | Description |
|---------|-------------|
| **Super Admin** | Platform owner console — manages tenants, plans, billing health, integrations |
| **Tenant Backend** | Per-business operating system — orders, recipes, bundles, customers, fundraisers, settings |
| **Customer Storefront** | Public-facing shop — browse meals/bundles, cart, checkout, fundraiser campaigns |

---

## 2 · Tech Stack (Do Not Swap Without Approval)

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 · React 19 |
| Styling | Tailwind 4 |
| Auth | NextAuth v5 (credentials provider) |
| Database | Supabase Postgres · Prisma 5.x |
| Hosting | Vercel |
| Email | Resend |
| Storage | Cloudflare R2 (S3-compatible) |
| Platform Billing | Stripe |
| Tenant Commerce | Stripe Connect (preferred) · Square (possible) |
| Accounting | QuickBooks Online |
| SMS | Twilio |
| AI | OpenAI |
| Other | Google Calendar · Meta/Instagram |

---

## 3 · Non-Negotiable Architecture Rules

1. **Billing separation is sacred.** Platform SaaS billing (FreezerIQ charges tenants) and tenant storefront billing (tenant charges customers) are completely separate domains. Any code path mixing them is a bug.
2. **Platform Stripe credentials must never touch tenant payment flows.** Test and live Stripe accounts must never be mixed.
3. **Multi-tenant scoping is mandatory.** Every tenant-owned record must be scoped by `businessId` / `organization_id`. No cross-tenant data leaks.
4. **Feature gating must be enforced in backend AND frontend.** Premium features are not available unless plan gating exists in APIs, server actions, and UI.
5. **Integration truth over surface appearance.** A route, file, or helper existing in code does NOT mean the integration works.
6. **Stability over expansion.** When the codebase is drifting: restore truth → restore consistency → restore boundaries → then ship features.
7. **Never invent credentials, IDs, product mappings, webhook secrets, or OAuth settings.**
8. **Never silently rename schema fields, enums, or integration contracts without a migration plan.**
9. **Partial integrations must be clearly labeled** as stub, planned, or disabled — never left masquerading as complete.
10. **Environment variable cleanup and system integrity outrank new feature work.**

---

## 4 · User Types & Access Model

| Role | Scope | Access |
|------|-------|--------|
| **Super Admin** | Platform-wide | All businesses, plans, billing, integrations, webhooks |
| **Tenant User** (owner, admin, staff, coordinator) | Single business | Only records tied to their own `businessId` |
| **Customer** | Storefront only | Browse, cart, checkout — never tenant admin functions |

Session fields: `user.id`, `role`, `plan`, `subscription_status`, `businessId`, `businessName`, `isSuperAdmin`

---

## 5 · Billing Law

### Platform SaaS Billing
- **Who pays:** Tenants pay FreezerIQ for software access
- **Processor:** Platform-owned Stripe account only
- **Stored fields:** `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `plan`, billing interval, trial end, current period end
- **Flows:** signup checkout, billing portal, subscription sync, failed payment handling, upgrade/downgrade

### Tenant Commerce / Storefront Billing
- **Who pays:** End customers pay the tenant for meals/bundles
- **Processor:** Tenant-connected payment credentials (Stripe Connect, Square, etc.)
- **Rule:** Must NEVER use platform billing credentials

### Webhook Separation
Each webhook path must belong to exactly one domain: platform billing, tenant commerce, social, or integration sync.

---

## 6 · Environment Contract

> ⚠️ Do NOT read, modify, or copy `.env` files unless explicitly asked.

### Auth
| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | NextAuth session signing |
| `NEXTAUTH_URL` | Auth callback base URL |

### Database
| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Supabase Postgres connection (pooled) |
| `DIRECT_URL` | Direct Postgres connection (bypasses pooler) |

### Platform Billing (Stripe)
| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Platform SaaS billing API key |
| `STRIPE_PUBLISHABLE_KEY` | Platform client-side Stripe |
| `STRIPE_WEBHOOK_SECRET` | Platform webhook verification |

### Storage (Cloudflare R2)
| Variable | Purpose |
|----------|---------|
| `S3_ACCESS_KEY_ID` | R2 access key |
| `S3_SECRET_ACCESS_KEY` | R2 secret key |
| `S3_BUCKET_NAME` | R2 bucket name |
| `S3_ENDPOINT` | R2 endpoint URL |

### Email / AI / SMS / Accounting
| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Transactional email |
| `OPENAI_API_KEY` | AI features |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | SMS |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_REDIRECT_URI` | QuickBooks OAuth |

### Env Rules
1. Missing secrets must fail loudly in production paths
2. Test vs live values must never be mixed
3. New env vars must be documented here before being added to code
4. Variable names must be standardized — no ad-hoc naming

---

## 7 · Integration Status Matrix

Use **only** these labels:

| Label | Meaning |
|-------|---------|
| `active` | Verified end-to-end in intended environment |
| `configured-not-verified` | Credentials appear present, e2e success not confirmed |
| `stubbed` | Code scaffolding exists, production behavior incomplete |
| `broken` | Known failure prevents use |
| `planned` | Desired but not yet integrated |
| `deprecated` | Should not be used going forward |

### Current Statuses (as of 2026-03-21)

| Integration | Domain | Owner | Status |
|------------|--------|-------|--------|
| Supabase Postgres | Core data | Platform | `active` |
| NextAuth | Auth | Platform | `active` |
| Resend | Email | Platform | `configured-not-verified` |
| Cloudflare R2 | Storage | Platform | `broken` |
| Stripe Platform Billing | SaaS billing | Platform | `broken` / `configured-not-verified` |
| Stripe Connect | Tenant commerce | Tenant | `planned` / `stubbed` |
| Square | Tenant commerce | Tenant | `stubbed` / `configured-not-verified` |
| QuickBooks Online | Accounting | Platform+Tenant | `broken` |
| Twilio | SMS | Platform | `broken` |
| OpenAI | AI features | Platform | `broken` / `planned` |
| Google Calendar | Scheduling | Platform/Tenant | `stubbed` / `configured-not-verified` |
| Meta/Instagram | Social | Platform+Tenant | `stubbed` / `configured-not-verified` |

### Integration Claims Rule
Never say "working", "connected", "complete", or "live" unless the integration satisfies all verification criteria. Safer phrasing:
- "code exists but config is missing"
- "scaffolded but not verified"
- "broken due to invalid env value"

---

## 8 · Known Critical Problems (Active Constraints)

1. **S3_ACCESS_KEY_ID is misconfigured** — R2 uploads may fail
2. **Stripe test/live accounts are mixed** — billing flows unreliable
3. **OrderStatus enum is semantically duplicated** — conflicting casing/meanings
4. **Plan gating is missing** — premium features accessible without checks
5. **Trial enforcement is missing** — no trial expiry logic
6. **Upgrade/downgrade flow is incomplete**
7. **Several integrations exist in code but are not production-configured**

These must be treated as active constraints in ALL planning and coding decisions.

---

## 9 · Feature Gating Model

Plans must drive both feature access and usage limits.

**Feature flags** (examples): `inventory_enabled`, `crm_enabled`, `fundraiser_enabled`, `reporting_enabled`, `automation_enabled`, `custom_domain_enabled`, `multi_user_enabled`

**Usage limits** (examples): `max_users`, `max_orders_per_month`, `max_recipes`, `max_active_fundraisers`, `max_sms_per_month`

Feature gating must exist in both **permission checks** (backend) and **product logic** (UI). UI-only gating is not sufficient.

---

## 10 · Fundraiser Commerce Architecture

Fundraiser flows are **campaign-scoped tenant commerce flows**. They must not be flattened into generic storefront or customer logic without preserving:
- Coordinator roles
- Private-link access patterns (portal_token / public_token)
- Fundraiser attribution and group tracking

---

## 11 · Source of Truth Hierarchy

| Source | Trust Level |
|--------|-------------|
| Prisma schema | Data model truth |
| Env contract docs | Configuration truth |
| Billing/integration mapping docs | Payment truth |
| Architecture docs | System boundary truth |
| One-off scripts, logs, backups | NOT authoritative — may be stale |

---

## 12 · Working Style Requirements

### Before Making Changes
1. Read the relevant architecture and environment docs
2. Inspect the exact files involved
3. State the intended change in plain English
4. Identify risks — especially billing, auth, and data risks
5. Make the smallest safe change
6. Verify with typecheck/lint/tests where available
7. Report exactly what changed and what remains uncertain

### After Making Changes, Report
1. Files inspected
2. Constraints that apply
3. Exact change made (minimal diff)
4. Validation results
5. Remaining risks or uncertainty
6. Next safest step

---

## 13 · Protected Areas (Require Approval)

Do NOT modify these without explicit approval:

| Area | Examples |
|------|----------|
| **Billing** | Stripe keys, billing flow logic, webhook routing, subscription/plan mapping, payment domain separation |
| **Authentication** | NextAuth config, role logic, session structure, auth callbacks, credentials |
| **Database Schema** | Prisma schema, enums, migrations, relation changes, scoped field naming |
| **Environment / Secrets** | Env loading code, secret names, fallback behavior, deployment config |
| **Multi-Tenant Routing** | Domain rewrite middleware, root domain logic, tenant resolution |
| **Webhooks** | Webhook handlers, endpoint routing, verification logic |

### Changes Allowed Without Approval
Docs, comments, copy changes, non-breaking UI text, dead-code notes, integration status labeling docs, moving logs/backups out of root.

---

## 14 · Forbidden Behaviors

- ❌ Change billing credentials casually
- ❌ Generate fake secrets or placeholder "working" IDs
- ❌ Wire live billing flows without confirming canonical account
- ❌ Make schema changes without migration notes
- ❌ Modify more files than necessary
- ❌ Leave TODO-style half-integrations masquerading as complete
- ❌ Add new env vars without documenting ownership and purpose
- ❌ Rely on deprecated or duplicate enum values continuing forever
- ❌ Mix broad cleanup with feature work
- ❌ Do drive-by refactors in protected areas
- ❌ Hide behavior changes inside "cleanup" commits

---

## 15 · Work Modes

| Mode | When to Use | Output |
|------|-------------|--------|
| **Diagnose Only** | Truth is unclear | Findings, ambiguity, recommended next inspection. No code changes. |
| **Repair** | Problem understood, fix is bounded | Minimal implementation, validation, remaining uncertainty |
| **Plan** | Issue spans protected areas | Phased plan, approval checkpoints, risk list |

---

## 16 · Special Workflows

### Billing Work
1. Identify domain: platform billing or tenant commerce?
2. Identify exact credentials involved
3. Identify exact webhook path
4. Identify affected plan/subscription data
5. **STOP if test/live truth is ambiguous**
6. Do not implement until domain separation is clear

### Schema Work
1. Inspect current schema
2. Inspect existing data assumptions
3. Identify migrations needed
4. Describe backward compatibility risk
5. Obtain approval
6. Implement schema + migration plan together

### Env Work
1. Identify canonical variable names
2. Identify invalid/stale/duplicate names
3. Classify as platform or tenant domain
4. Propose documentation update first if truth is unclear
5. Do not silently paper over missing values

### Repo Cleanup
1. Identify non-authoritative files
2. Confirm they are not imported or executed at runtime
3. Move to `/scripts`, `/archive`, or remove
4. Do not combine with protected-area changes

---

## 17 · Stabilization Priorities (Current)

| Priority | Task |
|----------|------|
| 1 | Stabilize environment configuration |
| 2 | Resolve Stripe account mismatch (test vs live) |
| 3 | Fix broken R2 storage config |
| 4 | Normalize schema inconsistencies (enums, casing) |
| 5 | Enforce subscription and plan-gating architecture |
| 6 | Verify integrations one by one |
| 7 | **Only then** continue feature work |

---

## 18 · Refusal / Pause Rule

**Stop implementation and report ambiguity** when:
- Billing truth is ambiguous
- Env truth is ambiguous
- Schema change requested without migration consideration
- Cross-tenant impact is possible but not analyzed
- Protected areas are implicated without approval

---

## 19 · Success Criteria

A successful task is:
- ✅ Accurate
- ✅ Bounded (smallest safe change)
- ✅ Architecture-safe
- ✅ Explicit about uncertainty
- ✅ Easy to review
