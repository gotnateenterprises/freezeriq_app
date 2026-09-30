-- STOREFRONT-CUSTOMER-EXPERIENCE-1B — the tenant's control over which fundraisers the storefront advertises.
--
-- Scope, exactly:
--   · column  fundraiser_campaigns.listed_on_storefront   BOOLEAN NOT NULL DEFAULT false
--   · one UPDATE setting it TRUE on the campaigns the public storefront lists at the moment this runs
--
-- ADDITIVE. One column with a constant default; nothing is dropped, renamed or narrowed, no constraint or index
-- is touched, and the UPDATE writes this column only — no other column of any row changes.
--
-- WHAT IT MEANS. Only "is this fundraiser shown in the storefront's public Active Fundraisers section?" It is read
-- by that one discovery query and by the tenant's own CRM. It is NOT an ordering gate: the direct fundraiser link,
-- supporter ordering, the coordinator portal, the scoreboard, closeout, invoices and QuickBooks never read it.
--
-- THE BACKFILL keeps today's storefront as it is. It marks TRUE exactly the campaigns the discovery query in
-- app/api/public/tenant/[slug]/route.ts lists today, using that query's own predicate:
--   status = 'Active'
--   AND end_date >= today in the TENANT's calendar (Business.timezone)
--   AND bundle_selection_status <> 'pending'
-- together with closed_at IS NULL, which the new discovery query also requires. Closed, archived, expired and
-- pending campaigns stay FALSE, as does every campaign created after this (the column default).
--
-- A tenant whose timezone Postgres does not recognise is skipped rather than errored: the storefront lists nothing
-- for such a tenant today (isValidIanaTimeZone), so there is nothing to keep visible. The CASE guarantees
-- AT TIME ZONE is never evaluated with an unknown zone, which would abort the migration.
--
-- Deterministic and tenant-safe: each row is judged only by its own campaign, its own organization and its own
-- tenant's timezone. No id is named.

ALTER TABLE "fundraiser_campaigns" ADD COLUMN "listed_on_storefront" BOOLEAN NOT NULL DEFAULT false;

UPDATE "fundraiser_campaigns" AS fc
SET "listed_on_storefront" = true
FROM "customers" AS c
JOIN "businesses" AS b ON b."id" = c."business_id"
WHERE fc."customer_id" = c."id"
  AND fc."status" = 'Active'
  AND fc."closed_at" IS NULL
  AND fc."bundle_selection_status" <> 'pending'
  AND CASE
        WHEN b."timezone" IN (SELECT tz."name" FROM pg_timezone_names AS tz)
          THEN fc."end_date" >= (CURRENT_TIMESTAMP AT TIME ZONE b."timezone")::date
        ELSE false
      END;
