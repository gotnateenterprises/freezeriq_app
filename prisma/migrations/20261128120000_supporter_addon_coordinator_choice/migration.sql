-- FR-ADDON-LAUNCH-FLOW-1 (1B, owner-approved 2026-11-25) — the coordinator's participation in a campaign add-on.
-- offer_mode is the TENANT's authorization: 'included' (the default — exactly how every existing row behaves)
-- or 'coordinator_choice' (the coordinator decides during setup). coordinator_decision is the COORDINATOR's
-- answer: NULL (none yet), 'accepted' or 'declined', with the moment it was given. Neither column touches
-- removed_at (B2: the tenant's removal), the share schedule, recorded earnings or tier positions.
-- Additive only: existing rows read 'included' and NULL, so nothing is rewritten and nothing changes for them.
ALTER TABLE "campaign_add_ons" ADD COLUMN "offer_mode" TEXT NOT NULL DEFAULT 'included';
ALTER TABLE "campaign_add_ons" ADD COLUMN "coordinator_decision" TEXT;
ALTER TABLE "campaign_add_ons" ADD COLUMN "coordinator_decided_at" TIMESTAMP(3);
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_offer_mode_check"
    CHECK ("offer_mode" IN ('included', 'coordinator_choice'));
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_coordinator_decision_check"
    CHECK ("coordinator_decision" IS NULL OR "coordinator_decision" IN ('accepted', 'declined'));
