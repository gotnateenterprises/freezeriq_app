-- FR-GOAL-CONFIG-1: the tenant-controlled weighted bundle goal now defaults
-- to 20, not 100. Every application code path already writes an explicit,
-- resolved value on create (lib/fundraiserMetrics.ts DEFAULT_BUNDLE_GOAL is
-- the one true authority) — this DB-level default is defense-in-depth only,
-- protecting any insert that omits the column outright.
--
-- Existing rows are untouched on purpose: a campaign already carrying a
-- stored goal (whether tenant-chosen or the old 100 default) keeps exactly
-- that number. Only the column's DEFAULT for future inserts changes.
ALTER TABLE "fundraiser_campaigns" ALTER COLUMN "bundle_goal" SET DEFAULT 20;
