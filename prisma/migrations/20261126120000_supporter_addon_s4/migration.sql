-- FR-SUPPORTER-ADDON-UPSELL-1 — S4 (owner-approved 2026-11-24): the tenant's per-fundraiser choice to show the
-- add-on's organization share on the public supporter page.
--   * campaign_add_ons.show_share_percent   false (default — every existing assignment, every new one) | true
-- When true AND the add-on's share schedule has exactly one tier, the supporter card may say "Your purchase also
-- helps {Organization} earn 10% on this add-on." A tiered schedule never shows a percentage. Display only; no
-- amount, tier or earned share is affected.
-- Additive only: one column with a constant default (no backfill, no table rewrite). No existing column,
-- constraint or row is changed.

-- AlterTable
ALTER TABLE "campaign_add_ons" ADD COLUMN     "show_share_percent" BOOLEAN NOT NULL DEFAULT false;
