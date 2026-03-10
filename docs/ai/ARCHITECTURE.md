# FreezerIQ Architecture
Last updated: 2026-03-09

## Purpose
This document defines the intended architecture of FreezerIQ so AI agents and human developers do not make conflicting assumptions.

FreezerIQ is a multi-tenant SaaS platform for freezer meal businesses. It has three major surfaces:

1. Super Admin platform
2. Tenant business backend
3. Customer-facing storefront

---

## Core User Types

### 1. Super Admin
Platform owner/operator.
Responsibilities:
- manage tenant businesses
- manage plans and feature access
- oversee billing health
- monitor integrations
- review system-wide operations

### 2. Tenant Users
Business owners and staff for a specific freezer meal business.
Examples:
- owner
- admin
- kitchen staff
- fulfillment coordinator
- fundraiser coordinator

Tenant users must only access records tied to their own `businessId` / `organization_id`.

### 3. Customer
End buyer using a tenant storefront to browse and purchase meals or bundles.

Customers are not platform operators and should never have access to tenant admin functions.

---

## Architecture Principles

### A. Multi-Tenant First
FreezerIQ is multi-tenant by default.
Every tenant-owned record must be scoped to a single business/organization.

Required rule:
- no tenant business data may be queried or mutated without business scoping

Typical scope field:
- `businessId`
or
- `organization_id`

Use one canonical naming convention over time. Do not allow mixed meanings.

### B. Domain Separation
There are two different payment domains:

#### 1. Platform SaaS Billing
This is when the tenant pays FreezerIQ for software access.
- Processor: platform Stripe account
- Owner: FreezerIQ
- Purpose: subscription billing

#### 2. Tenant Commerce / Storefront Billing
This is when the tenant's customer buys meals or bundles.
- Processor: tenant-owned Stripe, Square, or supported POS/payment provider
- Owner: tenant business
- Purpose: customer order payment

These domains must never be mixed.

### C. Feature Gating Is Required
Premium or tiered features must not be treated as available by default.
Feature access must be enforced in:
- backend APIs
- server actions
- UI rendering
- navigation
- usage-limited actions

### D. Integration Truth Over Surface Appearance
A file, helper, route, or callback existing in the repo does not mean the integration works.
Integrations must be treated as one of:
- active
- configured-not-verified
- stubbed
- broken
- planned
- deprecated

### E. Stability Over Expansion
When the codebase is drifting, priorities are:
1. restore truth
2. restore consistency
3. restore boundaries
4. then ship features

---

## Current Intended Stack

### Frontend
- Next.js 16
- React 19
- Tailwind 4

### Authentication
- NextAuth v5
- credentials provider currently active

### Backend / Data
- Supabase Postgres
- Prisma ORM
- PgBouncer / direct URL split as needed

### Hosting
- Vercel

### Email
- Resend

### Storage
- Cloudflare R2 (S3-compatible)

### Payments
- Stripe for platform SaaS billing
- Stripe Connect preferred for tenant payment connections
- Square possible as tenant integration
- future provider abstraction allowed

### Other Integrations
- QuickBooks Online
- Twilio
- OpenAI
- Google Calendar
- Meta / Instagram

---

## System Surfaces

## 1. Super Admin Surface
Intended responsibilities:
- view all businesses
- view subscription state
- monitor plan usage
- issue plan overrides
- suspend/reactivate tenants
- inspect integration health
- monitor webhook failures
- support tenant onboarding

Super Admin must be explicitly separated from tenant admin views.

---

## 2. Tenant Business Backend
Primary business operating system for each tenant.

Main domains:
- dashboard
- orders
- recipes
- ingredients
- bundles
- catalogs
- production
- delivery
- labels
- customers
- campaigns
- fundraisers
- suppliers
- calendar
- settings
- branding
- training

All of these must be scoped per tenant business.

---

## 3. Customer-Facing Storefront
Each tenant may have:
- platform subdomain storefront
- custom domain storefront

Storefront responsibilities:
- browse bundles
- browse meals
- browse fundraiser campaigns
- manage cart
- checkout
- pickup/delivery selections
- order confirmation
- customer account features if enabled

Storefronts must use tenant business branding and tenant payment settings.

---

## Authentication Model

Current auth is based on NextAuth credentials.

Expected session fields may include:
- user id
- role
- plan
- subscription status
- businessId
- businessName
- isSuperAdmin

Rules:
- Super Admin can access platform-wide data
- Tenant users can access only their business data
- Customers can access only their own storefront/customer context

Future auth evolution is allowed, but not during stabilization unless explicitly requested.

---

## Billing Architecture

## Platform SaaS Billing
Purpose:
- charge tenants monthly or yearly for FreezerIQ access

Canonical provider:
- Stripe

Expected stored fields at business/org level:
- stripe_customer_id
- stripe_subscription_id
- subscription_status
- plan
- billing interval
- trial end
- current period end

Required flows:
- signup checkout
- billing portal
- subscription sync
- failed payment handling
- upgrade/downgrade

### Important
Platform SaaS billing must use one canonical Stripe account per environment.
Test and live accounts must be clearly separated and documented.

---

## Tenant Commerce Billing
Purpose:
- charge end customers for tenant products

Preferred long-term path:
- Stripe Connect

Possible later alternatives:
- Square
- external provider adapters

Expected business-level fields:
- payment provider type
- provider connection status
- tenant-owned account identifiers
- token metadata stored securely
- onboarding/health state

Do not reuse platform billing credentials here.

---

## Feature Gating Model

Plans should drive feature access and usage limits.

Examples:
- inventory_enabled
- crm_enabled
- fundraiser_enabled
- reporting_enabled
- automation_enabled
- custom_domain_enabled
- multi_user_enabled
- advanced_pricing_enabled

Examples of usage-limited features:
- max_users
- max_orders_per_month
- max_recipes
- max_active_fundraisers
- max_sms_per_month

Feature gating must exist in both:
- permission checks
- product logic

UI-only gating is not sufficient.

---

## Data Modeling Rules

### Required
- business/org scoping on tenant-owned entities
- consistent enum semantics
- explicit integration ownership
- explicit status fields where needed

### Avoid
- duplicate enum meanings with different casing
- hidden cross-tenant joins
- mixed use of platform and tenant payment references
- "temporary" status values that become permanent

---

## Webhooks

Webhooks are core infrastructure, not optional helpers.

### Platform billing webhook examples
- checkout.session.completed
- customer.subscription.updated
- invoice.payment_failed
- customer.subscription.deleted

### Tenant commerce webhook examples
- payment success
- refund
- dispute
- order sync event

Each webhook path must clearly belong to one domain only:
- platform billing
- tenant commerce
- social
- integration sync

---

## Integration Philosophy

An integration is not considered complete unless:
1. credentials/config exist in the intended environment
2. callback/auth flow is known
3. success path works
4. failure path is handled
5. data persistence or sync path is verified

Do not mark integrations as working from code existence alone.

---

## Current Stabilization Priorities

1. Normalize environment contract
2. Resolve Stripe environment/account truth
3. Fix R2 credentials/config truth
4. Clean schema inconsistencies like duplicate status semantics
5. Implement plan gating
6. Verify integrations one by one
7. Then continue feature expansion

---

## Architectural No-Go Areas Without Approval

Changes in these areas require explicit approval:
- auth model changes
- Prisma schema changes
- billing domain changes
- webhook behavior
- environment loading patterns
- multi-tenant domain routing
- payment provider ownership logic

---

## Decision Rule for AI Agents
If a requested change conflicts with:
- multi-tenant isolation
- billing separation
- env truth
- schema consistency
- plan gating
then the agent must stop and report the conflict before implementing.
