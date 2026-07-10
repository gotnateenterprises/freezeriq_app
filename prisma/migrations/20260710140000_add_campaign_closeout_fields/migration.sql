-- Phase 7E-1: Add campaign closeout fields to fundraiser_campaigns
--
-- All four columns are nullable — no DEFAULT required and no existing rows are affected.
-- TIMESTAMP(3) matches Prisma's standard precision for DateTime fields across this schema.
-- DECIMAL(10,2) matches existing Decimal fields in FundraiserCampaign (goal_amount, total_sales).

-- AlterTable
ALTER TABLE "fundraiser_campaigns" ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "fundraiser_campaigns" ADD COLUMN "closed_by" TEXT;
ALTER TABLE "fundraiser_campaigns" ADD COLUMN "settlement_total" DECIMAL(10,2);
ALTER TABLE "fundraiser_campaigns" ADD COLUMN "settlement_notes" TEXT;
