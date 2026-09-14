-- QB-INVOICE-1B — QuickBooks connection generations, customer links, invoice-link
-- foundation. Hand-authored from `prisma migrate diff` output (constraint and index
-- names are Prisma's own, so the schema and the migrations do not drift), plus the
-- repository's re-run guards and CHECK constraints Prisma cannot express.
--
-- Scope, exactly:
--   · enum   "QuickBooksCustomerLinkSource"
--   · table  quickbooks_connections     one row per connection GENERATION, kept as audit history
--   · table  quickbooks_customer_links  organization -> QuickBooks customer, live generation only
--   · table  quickbooks_invoice_links   FOUNDATION ONLY (QB-INVOICE-1C writes it; 1B never does)
--   · index  invoices_business_id_id_key  composite parent key for the invoice link
--
-- ADDITIVE ONLY. No column is added to, dropped from or changed on any existing
-- table; no row is inserted, updated or deleted; nothing is backfilled. The one
-- change to an existing table is a UNIQUE index on invoices (business_id, id),
-- which cannot fail — `id` is already the primary key — and changes no query.
-- Existing code never reads the new tables, so this migration is safe to apply
-- BEFORE the code that uses it is deployed (and must be: that code queries them).
--
-- Connection generations (owner rulings, 2026-09-13): links are bound to a random,
-- non-secret generation id — never to the realm, and no realm fingerprint is stored.
-- A generation is one lifetime of the tenant's integrations(business_id,'quickbooks')
-- row: refresh, disconnect and same-company reconnect update that row in place and
-- keep the generation. Forget deletes the row, and Postgres then
--   · ENDS the generation without erasing it (live_business_id/live_provider SET NULL),
--   · deletes every customer link (they must be re-established).
-- Connecting again — even to the same company — starts a new generation. Generation
-- rows carry non-secret evidence only (environment, company name, who authorized and
-- when); nothing here stores a token, the realm id, or anything derived from them.
--
-- Invoice links are accounting history:
--   · UNIQUE (invoice_id): a FreezerIQ invoice has at most ONE QuickBooks invoice link
--     in its lifetime — a later generation can never give it a second one;
--   · ON DELETE RESTRICT to their generation, which Forget never deletes, so a link and
--     the evidence of the connection it was made under stay referentially auditable;
--   · UNIQUE (connection_id, qbo_invoice_id) inside a generation. Across generations
--     there is deliberately no company key: V1 records a QuickBooks invoice id only from
--     FreezerIQ's own create response or its requestid replay (docs/ai/QUICKBOOKS_INTEGRATION.md §11.5).
--
-- Re-run safety follows the FR-RETENTION precedent: IF NOT EXISTS on tables and
-- indexes, a DO block for the enum. Constraints are plain ADD CONSTRAINT, as there.

-- ── enum ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "QuickBooksCustomerLinkSource" AS ENUM ('existing', 'created'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── quickbooks_connections (generations) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quickbooks_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "live_business_id" TEXT,
    "live_provider" TEXT,
    "environment" TEXT NOT NULL,
    "company_name" TEXT,
    "authorized_by" TEXT,
    "authorized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quickbooks_connections_pkey" PRIMARY KEY ("id"),
    -- Live: the pair names this generation's own tenant row. Ended: both NULL. (Written
    -- NULL-safe: a CHECK that evaluates to NULL passes, so a half-set pair must be FALSE.)
    CONSTRAINT "quickbooks_connections_live_check" CHECK (
        ("live_business_id" IS NULL AND "live_provider" IS NULL)
        OR ("live_business_id" IS NOT NULL AND "live_provider" IS NOT NULL
            AND "live_business_id" = "business_id" AND "live_provider" = 'quickbooks')
    ),
    CONSTRAINT "quickbooks_connections_environment_check" CHECK ("environment" IN ('sandbox', 'production'))
);

-- At most one LIVE generation per tenant (ended generations hold NULLs, which never clash).
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_live_business_id_live_provider_key" ON "quickbooks_connections"("live_business_id", "live_provider");
-- FK target for customer links: only a live generation has these three values.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_live_business_id_live_provider_id_key" ON "quickbooks_connections"("live_business_id", "live_provider", "id");
-- FK target for invoice links: a generation of the link's own tenant, live or ended.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_connections_business_id_id_key" ON "quickbooks_connections"("business_id", "id");

-- ── quickbooks_customer_links ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quickbooks_customer_links" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'quickbooks',
    "qbo_customer_id" TEXT NOT NULL,
    "source" "QuickBooksCustomerLinkSource" NOT NULL,
    "linked_by" TEXT,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quickbooks_customer_links_pkey" PRIMARY KEY ("id"),
    -- The provider column exists only to complete the composite FKs below.
    CONSTRAINT "quickbooks_customer_links_provider_check" CHECK ("provider" = 'quickbooks'),
    CONSTRAINT "quickbooks_customer_links_qbo_customer_id_check" CHECK ("qbo_customer_id" <> '')
);

-- One QuickBooks customer per organization; one organization per QuickBooks
-- customer inside a generation.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_customer_links_business_id_customer_id_key" ON "quickbooks_customer_links"("business_id", "customer_id");
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_customer_links_connection_id_qbo_customer_id_key" ON "quickbooks_customer_links"("connection_id", "qbo_customer_id");

-- ── quickbooks_invoice_links (foundation; no 1B code path inserts a row) ──────
CREATE TABLE IF NOT EXISTS "quickbooks_invoice_links" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "qbo_invoice_id" TEXT,
    "qbo_linked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quickbooks_invoice_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quickbooks_invoice_links_request_id_check" CHECK ("request_id" <> ''),
    -- The QuickBooks invoice id and the time it was confirmed are recorded together (NULL-safe).
    CONSTRAINT "quickbooks_invoice_links_confirmation_check" CHECK (
        ("qbo_invoice_id" IS NULL AND "qbo_linked_at" IS NULL)
        OR ("qbo_invoice_id" IS NOT NULL AND "qbo_invoice_id" <> '' AND "qbo_linked_at" IS NOT NULL)
    )
);

-- LIFETIME: at most one QuickBooks invoice link per FreezerIQ invoice, across every generation.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_invoice_id_key" ON "quickbooks_invoice_links"("invoice_id");
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_request_id_key" ON "quickbooks_invoice_links"("request_id");
-- One FreezerIQ invoice per QuickBooks invoice inside a generation (NULL = reserved, not unique).
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_connection_id_qbo_invoice_id_key" ON "quickbooks_invoice_links"("connection_id", "qbo_invoice_id");

-- ── invoices: composite parent key ────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_business_id_id_key" ON "invoices"("business_id", "id");

-- ── foreign keys ──────────────────────────────────────────────────────────────
-- A generation belongs to its tenant.
ALTER TABLE "quickbooks_connections" ADD CONSTRAINT "quickbooks_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Forget deletes integrations(business_id,'quickbooks'): the generation ENDS (SET NULL) and is kept.
ALTER TABLE "quickbooks_connections" ADD CONSTRAINT "quickbooks_connections_live_business_id_live_provider_fkey" FOREIGN KEY ("live_business_id", "live_provider") REFERENCES "integrations"("business_id", "provider") ON DELETE SET NULL ON UPDATE NO ACTION;

-- Same-tenant organization, enforced by the customers (business_id, id) parent key.
-- ON UPDATE NO ACTION, not CASCADE: a link must never follow its organization to
-- another tenant, or have NULL pushed into it. So while an organization has a QuickBooks
-- link, changing its business_id — including the SET NULL a hard tenant delete performs —
-- is refused. A hard tenant delete therefore needs the tenant's QuickBooks connection
-- forgotten first (which deletes the links). No product flow deletes a tenant, and
-- fundraiser_organization_contacts already makes the same class of delete fail
-- (verified on a disposable database, 2026-09-13).
ALTER TABLE "quickbooks_customer_links" ADD CONSTRAINT "quickbooks_customer_links_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Forget deletes the tenant's integrations row, and with it every customer link.
ALTER TABLE "quickbooks_customer_links" ADD CONSTRAINT "quickbooks_customer_links_business_id_provider_fkey" FOREIGN KEY ("business_id", "provider") REFERENCES "integrations"("business_id", "provider") ON DELETE CASCADE ON UPDATE NO ACTION;

-- The LIVE generation of the same tenant, and only that: an ended generation's live pair is
-- NULL, so a link can never reference it. (Forget's SET NULL passes this NO ACTION check at the
-- end of its statement because the same DELETE has already removed the links.)
ALTER TABLE "quickbooks_customer_links" ADD CONSTRAINT "quickbooks_customer_links_live_connection_fkey" FOREIGN KEY ("business_id", "provider", "connection_id") REFERENCES "quickbooks_connections"("live_business_id", "live_provider", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Invoice links: tenant deletion cascades; nothing else deletes or rewrites them.
ALTER TABLE "quickbooks_invoice_links" ADD CONSTRAINT "quickbooks_invoice_links_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- An invoice that has a QuickBooks counterpart cannot be deleted on its own.
ALTER TABLE "quickbooks_invoice_links" ADD CONSTRAINT "quickbooks_invoice_links_business_id_invoice_id_fkey" FOREIGN KEY ("business_id", "invoice_id") REFERENCES "invoices"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- HISTORY: the generation a link was made under, same tenant, never deletable while the link exists.
ALTER TABLE "quickbooks_invoice_links" ADD CONSTRAINT "quickbooks_invoice_links_business_id_connection_id_fkey" FOREIGN KEY ("business_id", "connection_id") REFERENCES "quickbooks_connections"("business_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
