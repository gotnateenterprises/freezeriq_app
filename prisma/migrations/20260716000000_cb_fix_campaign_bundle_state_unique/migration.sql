-- CB constraint repair:
-- Allow candidate and active campaign bundle rows to coexist for the same
-- campaign and bundle, as required by UI_REDESIGN_SPEC.md §8.
--
-- This migration performs no row updates or backfill.
-- It creates the replacement unique index before dropping the stricter
-- two-column unique index.
--
-- Do not run Prisma migration commands against the currently parked
-- migration-history chain. This SQL is intended for manual owner review
-- and application, followed by later migration-history reconciliation.

CREATE UNIQUE INDEX IF NOT EXISTS
  "campaign_bundles_campaign_id_bundle_id_state_key"
ON "campaign_bundles" ("campaign_id", "bundle_id", "state");

DROP INDEX IF EXISTS
  "campaign_bundles_campaign_id_bundle_id_key";
