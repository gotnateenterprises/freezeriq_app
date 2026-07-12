-- CB-1: Bundle Selection Storage Contracts
-- Additive migration — no drops, renames, or destructive changes.
-- Safe defaults preserve all existing behavior.
--
-- PREREQUISITES:
--   This migration must be applied AFTER the migration chain repair
--   (bridge migration for fundraiser_campaigns). It can be applied manually
--   via psql or through the approved deployment path once the chain is clean.
--
-- ROLLBACK: All columns can be safely dropped without data loss on existing fields.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Bundle.family_id — Structural sibling link
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE "bundles"
  ADD COLUMN IF NOT EXISTS "family_id" TEXT;

-- Fast lookup for family-pair resolution during pool build and activation
CREATE INDEX IF NOT EXISTS "bundles_family_id_idx"
  ON "bundles" ("family_id");

-- Partial unique index: at most one bundle per (business_id, family_id, serving_tier)
-- when family_id is not null. Prevents two "family" bundles or two "serves_2" bundles
-- from sharing the same family_id within a business.
-- This cannot be expressed as a portable Prisma @@unique due to the WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS "bundles_business_family_tier_unique"
  ON "bundles" ("business_id", "family_id", "serving_tier")
  WHERE "family_id" IS NOT NULL;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FundraiserCampaign — Bundle selection workflow fields
-- ═══════════════════════════════════════════════════════════════════════════════

-- Selection status: "not_required" | "pending" | "selected"
-- Default "not_required" preserves existing campaign behavior (no candidate pool).
ALTER TABLE "fundraiser_campaigns"
  ADD COLUMN IF NOT EXISTS "bundle_selection_status" TEXT NOT NULL DEFAULT 'not_required';

-- Timestamp of coordinator's selection submission. Null until selected.
ALTER TABLE "fundraiser_campaigns"
  ADD COLUMN IF NOT EXISTS "bundle_selection_at" TIMESTAMPTZ;

-- Number of families the coordinator must choose (default 2 per business rule).
ALTER TABLE "fundraiser_campaigns"
  ADD COLUMN IF NOT EXISTS "bundle_selection_limit" INTEGER NOT NULL DEFAULT 2;

-- Composite index for pending-stall queries (GE-3/GE-5: find campaigns where
-- bundle_selection_status = 'pending' AND bundle_selection_at is null or old).
CREATE INDEX IF NOT EXISTS "fundraiser_campaigns_selection_status_at_idx"
  ON "fundraiser_campaigns" ("bundle_selection_status", "bundle_selection_at");


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CampaignBundle.state — Candidate vs Active
-- ═══════════════════════════════════════════════════════════════════════════════

-- "candidate" = tenant's approved pool (not sellable)
-- "active"    = concrete sellable assignment (visible to all ordering surfaces)
-- Default "active" grandfathers all existing rows with zero backfill.
ALTER TABLE "campaign_bundles"
  ADD COLUMN IF NOT EXISTS "state" TEXT NOT NULL DEFAULT 'active';

-- Filtered reads: most consumers query state='active' only.
CREATE INDEX IF NOT EXISTS "campaign_bundles_campaign_state_idx"
  ON "campaign_bundles" ("campaign_id", "state");
