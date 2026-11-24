-- FR-SUPPORTER-ADDON-UPSELL-1 — S1 (owner-approved 2026-11-23): the domain foundation for an optional
-- fundraiser supporter add-on (e.g. a Sides & Dessert Bundle).
--   * bundles.bundle_type       'meal' (default — every existing bundle) | 'addon'
--   * order_items.item_role     'main' (default — every existing line)   | 'addon'   (historical snapshot)
--   * campaign_add_ons          at most ONE assigned add-on per campaign, tenant-bound by composite keys
-- Additive only: two columns with constant defaults (no backfill, no table rewrite), one new table, one
-- new unique index on bundles. No existing column, constraint or row is changed. No campaign is assigned
-- an add-on by this migration.
-- Generated with `prisma migrate diff` from the previous schema; the three CHECK constraints at the end
-- are hand-written (Prisma cannot express them).

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "bundle_type" TEXT NOT NULL DEFAULT 'meal';

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "item_role" TEXT NOT NULL DEFAULT 'main';

-- CreateTable
CREATE TABLE "campaign_add_ons" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "campaign_add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_add_ons_bundle_id_idx" ON "campaign_add_ons"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_add_ons_one_per_campaign" ON "campaign_add_ons"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_business_id_id_key" ON "bundles"("business_id", "id");

-- AddForeignKey
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_customer_id_campaign_id_fkey" FOREIGN KEY ("customer_id", "campaign_id") REFERENCES "fundraiser_campaigns"("customer_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_add_ons" ADD CONSTRAINT "campaign_add_ons_business_id_bundle_id_fkey" FOREIGN KEY ("business_id", "bundle_id") REFERENCES "bundles"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: the two classifications are closed vocabularies, and an add-on bundle is never a member of
-- a Serves-5 / Serves-2 family (so it can never be counted as a selected main family).
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_bundle_type_check"
    CHECK ("bundle_type" IN ('meal', 'addon'));

ALTER TABLE "bundles" ADD CONSTRAINT "bundles_addon_has_no_family"
    CHECK ("bundle_type" = 'meal' OR "family_id" IS NULL);

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_item_role_check"
    CHECK ("item_role" IN ('main', 'addon'));
