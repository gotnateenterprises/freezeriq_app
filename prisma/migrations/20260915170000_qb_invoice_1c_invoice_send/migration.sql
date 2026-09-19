-- QB-INVOICE-1C — QuickBooks invoice settings and the "Send via QuickBooks" lifecycle.
-- Hand-authored from `prisma migrate diff` output (constraint and index names are Prisma's own, so the
-- schema and the migrations do not drift), plus the repository's re-run guards and the CHECK constraints
-- Prisma cannot express.
--
-- Scope, exactly:
--   · enum   "QuickBooksInvoiceSendStatus"
--   · table  quickbooks_invoice_settings  one row per tenant: the tenant's OWN items, accounts and term
--   · table  quickbooks_invoice_sends     one row per FreezerIQ invoice sent via QuickBooks (lifecycle)
--   · index  quickbooks_invoice_links_business_id_invoice_id_key  composite parent key for the lifecycle
--
-- ADDITIVE ONLY. No column is added to, dropped from or changed on any existing table; no row is inserted,
-- updated or deleted; nothing is backfilled. The one change to an existing table is a UNIQUE index on
-- quickbooks_invoice_links (business_id, invoice_id), which cannot fail — invoice_id is already unique —
-- and changes no query. Existing code never reads the new tables, so this migration is safe to apply
-- BEFORE the code that uses it is deployed (and must be: that code queries them).
--
-- Settings are bound to the LIVE connection generation exactly like QB-INVOICE-1B customer links: Forget
-- deletes the integrations row and with it the settings; a new generation must be set up again.
--
-- A send lifecycle never outlives its invoice's QuickBooks link (RESTRICT) and never holds money: amounts
-- stay on the FreezerIQ invoice. It stores the tenant's REVIEW — the QuickBooks object ids (mapping), the
-- invoice date, the recipients and the payment options — and review_hash binds it to the exact create body
-- and read-back expectation. An invoice with a lifecycle cannot be deleted on its own (NO ACTION),
-- mirroring the invoice link.
--
-- Re-run safety follows the FR-RETENTION / QB-INVOICE-1B precedent: IF NOT EXISTS on tables and indexes, a
-- DO block for the enum. Constraints are plain ADD CONSTRAINT, as there.

-- ── enum ──────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "QuickBooksInvoiceSendStatus" AS ENUM ('reserved', 'created', 'recipients_set', 'payment_options_set', 'sent', 'needs_review'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── quickbooks_invoice_settings ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quickbooks_invoice_settings" (
    "business_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'quickbooks',
    "connection_id" TEXT NOT NULL,
    "sales_item_id" TEXT NOT NULL,
    "sales_account_id" TEXT NOT NULL,
    "share_item_id" TEXT,
    "share_account_id" TEXT,
    "tax_item_id" TEXT,
    "tax_account_id" TEXT,
    "term_id" TEXT NOT NULL,
    "term_due_days" INTEGER NOT NULL,
    "allow_online_card" BOOLEAN NOT NULL DEFAULT false,
    "allow_online_ach" BOOLEAN NOT NULL DEFAULT false,
    "default_cc" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quickbooks_invoice_settings_pkey" PRIMARY KEY ("business_id"),
    -- QuickBooks' email fields hold at most 100 characters (addresses are validated in the application).
    CONSTRAINT "quickbooks_invoice_settings_default_cc_check" CHECK ("default_cc" IS NULL OR ("default_cc" <> '' AND length("default_cc") <= 100)),
    -- The provider column exists only to complete the composite FKs below.
    CONSTRAINT "quickbooks_invoice_settings_provider_check" CHECK ("provider" = 'quickbooks'),
    -- QuickBooks object ids are numeric strings.
    CONSTRAINT "quickbooks_invoice_settings_sales_check" CHECK ("sales_item_id" ~ '^[0-9]{1,32}$' AND "sales_account_id" ~ '^[0-9]{1,32}$'),
    CONSTRAINT "quickbooks_invoice_settings_term_check" CHECK ("term_id" ~ '^[0-9]{1,32}$' AND "term_due_days" BETWEEN 0 AND 3650),
    -- Item and account are set together, or not at all (NULL-safe: a half-set pair must be FALSE, not NULL).
    CONSTRAINT "quickbooks_invoice_settings_share_pair_check" CHECK (
        ("share_item_id" IS NULL AND "share_account_id" IS NULL)
        OR ("share_item_id" IS NOT NULL AND "share_account_id" IS NOT NULL
            AND "share_item_id" ~ '^[0-9]{1,32}$' AND "share_account_id" ~ '^[0-9]{1,32}$')
    ),
    CONSTRAINT "quickbooks_invoice_settings_tax_pair_check" CHECK (
        ("tax_item_id" IS NULL AND "tax_account_id" IS NULL)
        OR ("tax_item_id" IS NOT NULL AND "tax_account_id" IS NOT NULL
            AND "tax_item_id" ~ '^[0-9]{1,32}$' AND "tax_account_id" ~ '^[0-9]{1,32}$')
    )
);

-- Required by Prisma's one-to-one relation to integrations; business_id alone is already the key.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_settings_business_id_provider_key" ON "quickbooks_invoice_settings"("business_id", "provider");

-- ── quickbooks_invoice_sends ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quickbooks_invoice_sends" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "status" "QuickBooksInvoiceSendStatus" NOT NULL,
    "review_hash" TEXT NOT NULL,
    "recipient_to" TEXT NOT NULL,
    "recipient_cc" TEXT,
    "allow_online_card" BOOLEAN NOT NULL,
    "allow_online_ach" BOOLEAN NOT NULL,
    "txn_date" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "qbo_doc_number" TEXT,
    "qbo_sync_token" TEXT,
    "lease_id" TEXT,
    "lease_until" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "create_requested_at" TIMESTAMP(3),
    "created_verified_at" TIMESTAMP(3),
    "recipients_verified_at" TIMESTAMP(3),
    "payment_options_verified_at" TIMESTAMP(3),
    "send_requested_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "auto_sent" BOOLEAN NOT NULL DEFAULT false,
    "send_count" INTEGER NOT NULL DEFAULT 0,
    "delivery_error_type" TEXT,
    "delivery_checked_at" TIMESTAMP(3),
    "problem" TEXT,
    "problem_detail" TEXT,
    "problem_at" TIMESTAMP(3),
    "started_by" TEXT,
    "sent_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quickbooks_invoice_sends_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quickbooks_invoice_sends_review_hash_check" CHECK ("review_hash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "quickbooks_invoice_sends_txn_date_check" CHECK ("txn_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    -- The reviewed mapping is an object of QuickBooks ids (validated again whenever it is read).
    CONSTRAINT "quickbooks_invoice_sends_mapping_check" CHECK (jsonb_typeof("mapping") = 'object'),
    -- QuickBooks' email fields hold at most 100 characters; the CC may list several addresses.
    CONSTRAINT "quickbooks_invoice_sends_recipient_check" CHECK (
        "recipient_to" <> '' AND length("recipient_to") <= 100 AND "recipient_to" NOT LIKE '%,%'
        AND ("recipient_cc" IS NULL OR ("recipient_cc" <> '' AND length("recipient_cc") <= 100))
    ),
    -- A lease is an id and an expiry together (NULL-safe).
    CONSTRAINT "quickbooks_invoice_sends_lease_check" CHECK (
        ("lease_id" IS NULL AND "lease_until" IS NULL) OR ("lease_id" IS NOT NULL AND "lease_until" IS NOT NULL)
    ),
    CONSTRAINT "quickbooks_invoice_sends_counters_check" CHECK ("revision" >= 0 AND "send_count" >= 0),
    -- Past 'reserved', a verified QuickBooks invoice (with its number) exists.
    CONSTRAINT "quickbooks_invoice_sends_created_check" CHECK (
        "status" IN ('reserved', 'needs_review')
        OR ("qbo_doc_number" IS NOT NULL AND "qbo_doc_number" <> '' AND "qbo_sync_token" IS NOT NULL AND "created_verified_at" IS NOT NULL)
    ),
    -- 'sent' always carries QuickBooks' delivery time and at least one send.
    CONSTRAINT "quickbooks_invoice_sends_sent_check" CHECK (
        "status" <> 'sent' OR ("sent_at" IS NOT NULL AND "send_count" >= 1)
    )
);

-- LIFETIME: at most one send lifecycle per FreezerIQ invoice.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_sends_invoice_id_key" ON "quickbooks_invoice_sends"("invoice_id");
-- Required by Prisma's one-to-one relations; invoice_id alone is already unique.
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_sends_business_id_invoice_id_key" ON "quickbooks_invoice_sends"("business_id", "invoice_id");

-- ── quickbooks_invoice_links: composite parent key for the lifecycle ──────────
CREATE UNIQUE INDEX IF NOT EXISTS "quickbooks_invoice_links_business_id_invoice_id_key" ON "quickbooks_invoice_links"("business_id", "invoice_id");

-- ── foreign keys ──────────────────────────────────────────────────────────────
-- Settings belong to their tenant.
ALTER TABLE "quickbooks_invoice_settings" ADD CONSTRAINT "quickbooks_invoice_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Forget deletes the tenant's integrations row, and with it the settings.
ALTER TABLE "quickbooks_invoice_settings" ADD CONSTRAINT "quickbooks_invoice_settings_business_id_provider_fkey" FOREIGN KEY ("business_id", "provider") REFERENCES "integrations"("business_id", "provider") ON DELETE CASCADE ON UPDATE NO ACTION;

-- The LIVE generation of the same tenant, and only that (an ended generation's live pair is NULL).
ALTER TABLE "quickbooks_invoice_settings" ADD CONSTRAINT "quickbooks_invoice_settings_live_connection_fkey" FOREIGN KEY ("business_id", "provider", "connection_id") REFERENCES "quickbooks_connections"("live_business_id", "live_provider", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Lifecycles: tenant deletion cascades; nothing else deletes them.
ALTER TABLE "quickbooks_invoice_sends" ADD CONSTRAINT "quickbooks_invoice_sends_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- An invoice with a send lifecycle cannot be deleted on its own.
ALTER TABLE "quickbooks_invoice_sends" ADD CONSTRAINT "quickbooks_invoice_sends_invoice_fkey" FOREIGN KEY ("business_id", "invoice_id") REFERENCES "invoices"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The lifecycle belongs to the invoice's one QuickBooks link, same tenant.
ALTER TABLE "quickbooks_invoice_sends" ADD CONSTRAINT "quickbooks_invoice_sends_link_fkey" FOREIGN KEY ("business_id", "invoice_id") REFERENCES "quickbooks_invoice_links"("business_id", "invoice_id") ON DELETE RESTRICT ON UPDATE NO ACTION;
