-- FR-SUPPORTER-ADDON-UPSELL-1 — B2 remediation (owner-approved 2026-11-25).
-- Removing a campaign's add-on now DISABLES it instead of deleting its record, so the campaign's add-on
-- share schedule (and its locked tiers) survives a removal and resumes when an add-on is offered again.
-- NULL = offered; a timestamp = removed at that moment. Additive and nullable: no default, no rewrite.
ALTER TABLE "campaign_add_ons" ADD COLUMN "removed_at" TIMESTAMP(3);