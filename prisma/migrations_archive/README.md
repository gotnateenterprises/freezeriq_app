# Archived migration history

These files are **historical evidence only**. They are not an active Prisma
migration chain, they are never executed, and Prisma does not read this
directory. Nothing here should be edited.

The canonical migration history now begins at
`prisma/migrations/00000000000000_baseline/`.

## Why this chain was archived

### Production had no Prisma migration ledger

Production has **no `_prisma_migrations` table** — not in `public`, not in any
schema. `prisma migrate deploy` had never run against it. There was no
divergent history to reconcile, because there was no history at all.

### Production structure came from `db push` and owner-applied SQL

Production's schema was built by `prisma db push` plus a small number of
hand-applied SQL statements. The evidence is in the index names: **62 of
production's 65 indexes carry Prisma-generated names** (`_key` / `_idx` /
`_pkey`), and production contains **zero** hand-written `idx_*` indexes.
`20260208200000_add_performance_indexes` declares 33 such indexes and **0 of
them exist in production**.

Migrations 11–13 in this archive say so in their own headers — for example
*"Do not run Prisma migration commands against the currently parked
migration-history chain. This SQL is intended for manual owner review and
application, followed by later migration-history reconciliation."* The
breakage was known and deliberately deferred from July 2026.

### The chain could not recreate production

Replayed from an empty database (with plain `psql`, so this is not a Prisma
artifact), migrations 1–5 apply and the chain then dies. It reaches **18
tables / 130 columns / 8 enums** against production's **37 / 399 / 16**.

**19 of production's 37 tables are created by no migration in this archive:**

```
business_leads   businesses   coordinator_action_events   customers
delivery_zones   discount_codes   document_templates   documents
fundraiser_campaigns   invoice_items   invoices   label_templates
loyalty_points   packaging_items   storefront_configs   tenant_branding
training_resources   user_training_progress   users
```

The chain also creates an `organizations` table that **production does not
have**. The application was rebuilt from single-tenant (`Organization`) to
multi-tenant (`Business` / `Customer` / `User` / `FundraiserCampaign`) between
commits `0fb961b` (2026-01-29, 27 models) and `12fa307` (2026-02-20, 47
models), and that transition was never captured as a migration.

### Two files are defective on their own terms

**`20260207202930_add_tenant_branding`** — the file is a single 879-byte line
containing literal `\n` escape sequences instead of newlines. Because it opens
with `--` and contains no real newline, the entire file parses as one SQL
comment and **executes as a no-op**. Verified: after running it,
`tenant_branding` does not exist.

**`20260208200000_add_performance_indexes`** — line 51 indexes
`production_runs("production_date")`. That column has never existed; the real
column is `run_date`. This migration is **permanently unrunnable**, and no
baseline can fix it.

## `loose_sql_never_active/add_customer_status_pipeline.sql`

This file was tracked in Git at `prisma/migrations/add_customer_status_pipeline.sql`
— loose in the migrations root rather than inside a timestamped directory.
**Prisma never treated it as a migration** and never executed it. It is
preserved here in a clearly separated subdirectory to record that it was
out-of-band schema work. Note that it creates `CustomerStatus` with 7 values
while production has 8 (`INACTIVE` was added later, also out of band).

## What archiving did *not* do

**Archiving these files changed no production schema.** Moving files on disk
has no effect on any database. Production's structure is exactly what it was
before; it simply now has a repository that can describe it.

## Verification performed before archiving

The replacement tree — `00000000000000_baseline` followed by
`20260806000000_fr_retention_contact_foundation` — was proven end-to-end
through `prisma migrate deploy` against a disposable localhost database
*before* any file here was moved. The result matched production plus exactly
the approved FR-RETENTION objects, with zero unexplained structural
differences.

Full forensic detail lives in the FR-MIGRATION-RECON-1 and RECON-2 reports.
