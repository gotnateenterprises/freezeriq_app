-- FR-TAX-1 — organization tax status, exemption document, tenant default food
-- tax rate, and the per-campaign tax snapshot.
--
-- ADDITIVE ONLY. No existing row's tax behaviour changes:
--   * customers.tax_status backfills to UNKNOWN ("nobody has been asked yet"),
--     which lib/fundraiserTax.ts resolves to the tenant's TAXABLE treatment —
--     never to exempt.
--   * businesses.default_food_tax_percent backfills to 0.00, NOT 1.00. Illinois
--     eliminated its statewide 1% grocery tax on 2026-01-01; a municipality may
--     levy exactly 1% locally, but that is a per-tenant verified fact this
--     migration must not assume on the tenant's behalf.
--   * fundraiser_campaigns.tax_status / tax_rate_percent are left NULL on every
--     existing campaign. NULL means "launched before FR-TAX-1, no snapshot was
--     ever taken" — deliberately distinguishable from a snapshot of 0%.
--
-- Closeout's existing 1%-of-gross behaviour is NOT rewired by this migration or
-- by FR-TAX-1's application code: the authoritative taxable base (gross vs the
-- net actually charged to the organization) is an unresolved accounting
-- question. See lib/fundraiserTax.ts.

-- ── The organization tax posture vocabulary ─────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrgTaxStatus') THEN
        CREATE TYPE "OrgTaxStatus" AS ENUM ('UNKNOWN', 'TAXABLE', 'TAX_EXEMPT');
    END IF;
END$$;

-- ── Organization-level status + exemption number ───────────────────────────
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "tax_status" "OrgTaxStatus" NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "tax_exemption_number" TEXT;

-- ── Tenant default food/grocery tax rate, as a PERCENT (1.00 = 1%) ─────────
ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "default_food_tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- A rate outside 0-100 is never a real tax rate. Mirrors
-- fundraiser_campaigns_org_share_percent_check.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'businesses_default_food_tax_percent_check'
    ) THEN
        ALTER TABLE "businesses"
          ADD CONSTRAINT "businesses_default_food_tax_percent_check"
          CHECK ("default_food_tax_percent" >= 0.00 AND "default_food_tax_percent" <= 100.00);
    END IF;
END$$;

-- ── Per-campaign FROZEN tax snapshot ───────────────────────────────────────
ALTER TABLE "fundraiser_campaigns"
  ADD COLUMN IF NOT EXISTS "tax_status" "OrgTaxStatus";

ALTER TABLE "fundraiser_campaigns"
  ADD COLUMN IF NOT EXISTS "tax_rate_percent" DECIMAL(5,2);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fundraiser_campaigns_tax_rate_percent_check'
    ) THEN
        ALTER TABLE "fundraiser_campaigns"
          ADD CONSTRAINT "fundraiser_campaigns_tax_rate_percent_check"
          CHECK ("tax_rate_percent" IS NULL
                 OR ("tax_rate_percent" >= 0.00 AND "tax_rate_percent" <= 100.00));
    END IF;
END$$;

-- ── The organization's current tax-exemption paperwork ─────────────────────
-- Bytes live in Postgres, not in the existing S3 bucket, because that bucket is
-- public-by-construction (lib/s3.ts returns a public URL, keys carry no tenant
-- prefix, there is no presigner dependency, and the no-bucket dev fallback
-- writes into public/uploads/). Government/legal evidence may not sit behind a
-- guessable unauthenticated CDN URL. See the model docstring in schema.prisma.
--
-- customer_id UNIQUE = exactly one CURRENT document per organization; replacing
-- is an upsert.
CREATE TABLE IF NOT EXISTS "organization_tax_documents" (
    "id"           TEXT NOT NULL,
    "customer_id"  TEXT NOT NULL,
    "business_id"  TEXT NOT NULL,
    "filename"     TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes"   INTEGER NOT NULL,
    "data"         BYTEA NOT NULL,
    "uploaded_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by"  TEXT,

    CONSTRAINT "organization_tax_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_tax_documents_customer_id_key"
  ON "organization_tax_documents"("customer_id");

CREATE INDEX IF NOT EXISTS "organization_tax_documents_business_id_idx"
  ON "organization_tax_documents"("business_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'organization_tax_documents_customer_id_fkey'
    ) THEN
        ALTER TABLE "organization_tax_documents"
          ADD CONSTRAINT "organization_tax_documents_customer_id_fkey"
          FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'organization_tax_documents_business_id_fkey'
    ) THEN
        ALTER TABLE "organization_tax_documents"
          ADD CONSTRAINT "organization_tax_documents_business_id_fkey"
          FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END$$;
