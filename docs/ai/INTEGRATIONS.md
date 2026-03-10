# FreezerIQ Integrations
Last updated: 2026-03-09

## Purpose
This document defines integration ownership, intended behavior, and status language so agents do not overstate what is working.

---

## Status Vocabulary
Use only these labels:
- active
- configured-not-verified
- stubbed
- broken
- planned
- deprecated

Definitions:

### active
Verified end-to-end in intended environment.

### configured-not-verified
Credentials/config appear present, but end-to-end success has not been confirmed.

### stubbed
Code scaffolding exists, but production behavior is not complete.

### broken
Known failure, invalid config, or missing required setup prevents use.

### planned
Desired but not yet actually integrated.

### deprecated
Should not be used going forward.

---

## Integration Matrix

## 1. Supabase Postgres
Domain:
- core data layer

Purpose:
- persistent application database

Expected ownership:
- platform infrastructure

Current likely status:
- active

Verification criteria:
- app connects in intended environments
- Prisma queries succeed
- migrations/introspection path is known
- pooling/direct URLs are documented

---

## 2. NextAuth
Domain:
- authentication

Purpose:
- session and auth management

Expected ownership:
- platform infrastructure

Current likely status:
- active

Verification criteria:
- login works
- session contains required business/user fields
- role-sensitive access behaves correctly

Risks:
- session data may imply permissions that backend does not actually enforce

---

## 3. Resend
Domain:
- email delivery

Purpose:
- transactional email

Expected ownership:
- platform infrastructure

Current likely status:
- configured-not-verified

Verification criteria:
- API key present in target environment
- verified sender domain configured
- emails succeed from actual app flows
- bounce/failure path understood

Risks:
- fallback sender usage masking production misconfiguration

---

## 4. Cloudflare R2
Domain:
- storage

Purpose:
- asset/file uploads

Expected ownership:
- platform infrastructure

Current likely status:
- broken

Reason:
- credential/endpoint mismatch can break uploads

Verification criteria:
- valid access key and secret configured
- endpoint field correct
- upload succeeds
- retrieval/public access succeeds

---

## 5. Stripe Platform Billing
Domain:
- SaaS subscription billing

Purpose:
- charge tenants for FreezerIQ plans

Expected ownership:
- platform-owned Stripe account

Current likely status:
- broken or configured-not-verified depending on env

Key risk:
- multiple Stripe accounts mixed across environments

Verification criteria:
- one canonical test account documented
- one canonical live account documented
- keys match account and environment
- webhook secret matches same Stripe environment
- products/prices mapped to plans
- subscription flows verified

Important:
This integration is separate from tenant commerce.

---

## 6. Stripe Connect / Tenant Stripe
Domain:
- tenant commerce payment connection

Purpose:
- allow tenant customers to pay the tenant

Expected ownership:
- tenant-owned payment accounts, platform-mediated via Connect if adopted

Current likely status:
- planned or stubbed unless fully documented

Verification criteria:
- Connect strategy chosen
- client ID present if required
- tenant onboarding flow works
- tenant account references stored securely
- test purchase reaches intended tenant domain flow

Important:
Do not confuse with platform SaaS billing.

---

## 7. Square
Domain:
- tenant commerce / POS sync

Purpose:
- tenant payment/provider sync, catalog/order sync, or POS-linked operations

Expected ownership:
- tenant connection via OAuth and stored per-tenant tokens if designed that way

Current likely status:
- stubbed or configured-not-verified

Verification criteria:
- app credentials configured
- OAuth callback works
- tenant token persisted
- sync job succeeds
- reconciliation behavior known

Important:
Route existence or sync engine code does not equal live integration.

---

## 8. QuickBooks Online
Domain:
- accounting

Purpose:
- accounting sync/export

Expected ownership:
- platform app credentials plus tenant/company OAuth connection

Current likely status:
- broken

Verification criteria:
- Intuit app created
- client credentials present
- redirect URI configured
- OAuth flow succeeds
- token storage works
- sync target behavior known

---

## 9. Twilio
Domain:
- SMS

Purpose:
- order notifications, reminders, or other SMS features

Expected ownership:
- platform infrastructure unless future tenant-owned messaging is introduced

Current likely status:
- broken

Verification criteria:
- required credentials present
- chosen send path implemented
- test message works
- opt-out/compliance flow considered where relevant

---

## 10. OpenAI
Domain:
- AI features

Purpose:
- AI-assisted recipe or content features

Expected ownership:
- platform infrastructure

Current likely status:
- broken or planned

Verification criteria:
- API key present
- model usage path clear
- failure behavior clear
- cost and rate-limiting considerations understood

---

## 11. Google Calendar
Domain:
- calendar/scheduling

Purpose:
- event import/sync or calendar display

Expected ownership:
- platform or tenant-connected Google integration depending design

Current likely status:
- stubbed or configured-not-verified if URL-only iCal

Verification criteria:
- distinguish clearly between URL-based iCal ingestion and Google API OAuth integration
- do not call URL-based calendar import "full Google Calendar integration"

---

## 12. Meta / Instagram
Domain:
- social / marketing

Purpose:
- social auth, publishing, webhook sync, or messaging hooks

Expected ownership:
- platform app credentials and tenant-linked social accounts

Current likely status:
- stubbed or configured-not-verified

Verification criteria:
- app credentials configured
- redirect/callback registered correctly
- webhook verification works
- token persistence works
- intended action path verified

---

## Integration Ownership Rules

### Platform-owned integrations
- NextAuth
- Supabase/Postgres
- Resend
- R2
- platform Stripe billing
- OpenAI
- Twilio
- global OAuth apps

### Tenant-connected integrations
- tenant Stripe/Connect accounts
- Square tenant tokens
- QBO tenant company connections
- social accounts
- tenant-specific calendars if implemented that way

---

## Integration Claims Rule
An agent may not say:
- "working"
- "connected"
- "complete"
- "live"
unless the integration satisfies the verification criteria for that label.

Safer phrasing:
- "code exists but config is missing"
- "scaffolded but not verified"
- "broken due to invalid env value"
- "planned architecture, not yet implemented"

---

## Verification Checklist Template
For any integration review, report:

1. Integration name
2. Domain
3. Owner
4. Current status
5. Required env vars
6. Required DB tables/fields
7. Callback/webhook path
8. Current evidence
9. Missing pieces
10. Smallest next step

---

## Current Priority Order for Integrations
1. Stripe platform billing truth
2. R2 storage truth
3. Resend sender truth
4. Stripe Connect decision and client ID path
5. QBO app credentials
6. Twilio
7. OpenAI
8. Google/Meta verification

---

## AI Agent Rule
When touching integration code:
- classify the integration first
- identify its owner domain
- state current status using approved vocabulary
- do not silently "finish" a partial integration without documenting missing pieces
