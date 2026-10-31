-- PREVIOUS-SUPPORTER-EMAIL-2.0B — the organization's mailing address (owner-approved schema change).
--
-- Scope, exactly:
--   · column  customers.mailing_address_line1   TEXT NULL
--   · column  customers.mailing_address_line2   TEXT NULL
--   · column  customers.mailing_city            TEXT NULL
--   · column  customers.mailing_state           TEXT NULL
--   · column  customers.mailing_postal_code     TEXT NULL
--
-- ADDITIVE ONLY. Five nullable columns on one table; no column is dropped or changed, no constraint, index or
-- default is added, nothing is backfilled, and no row is inserted, updated or deleted. Every existing organization
-- stays valid with all five NULL, which simply means "no mailing address recorded": prepared fundraiser email for
-- that organization stays unavailable until a tenant records one in the CRM.
--
-- WHY NEW COLUMNS RATHER THAN delivery_address. The organization is the designated sender of a fundraiser
-- re-engagement email, so its footer carries the ORGANIZATION's physical mailing address. `delivery_address` is
-- where meals are delivered (free text, routing), a campaign's `pickup_location` is where supporters collect them,
-- and the tenant's storefront origin belongs to the kitchen — three different facts about three different things.
-- None of them is repurposed, copied or read in its place.
--
-- ORDER OF RELEASE. Prisma's generated client selects every scalar column of `customers` on reads without an
-- explicit `select`, so this migration MUST be applied to a database BEFORE code built from the matching schema
-- serves it. Applying it early is harmless: existing code never reads these columns.

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "mailing_address_line1" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "mailing_address_line2" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "mailing_city" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "mailing_state" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "mailing_postal_code" TEXT;
