-- FR-SUPPORTER-ADDON-UPSELL-1 — S2 (owner-approved 2026-11-24): the campaign add-on's organization share.
--   * campaign_add_on_share_tiers  a campaign-specific MARGINAL share schedule over the campaign's cumulative
--                                  add-on units sold (start 1 -> 10%, start 11 -> 15%). Belongs to the
--                                  campaign's add-on assignment, never to the Bundle.
--   * order_item_add_on_shares     the share EARNED by each add-on order line, frozen when the order is
--                                  written: one row per tier slice, so an order that crosses a threshold
--                                  records each part at its own rate. Closeout sums these rows.
--   * bundles_addon_not_on_storefront  an add-on bundle is never a storefront product, so no lineup that
--                                  lists storefront bundles can ever list one.
-- Additive only: two new tables, two indexes, two foreign keys, five CHECK constraints. No existing column,
-- constraint or row is changed, and nothing is backfilled (Production has no add-on rows at all).
-- Generated with `prisma migrate diff` from the S1 schema; the CHECK constraints at the end are hand-written
-- (Prisma cannot express them).

-- CreateTable
CREATE TABLE "campaign_add_on_share_tiers" (
    "id" TEXT NOT NULL,
    "campaign_add_on_id" TEXT NOT NULL,
    "starting_quantity" INTEGER NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_add_on_share_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_add_on_shares" (
    "id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "first_unit" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "share_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_add_on_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_add_on_share_tiers_one_per_start" ON "campaign_add_on_share_tiers"("campaign_add_on_id", "starting_quantity");

-- CreateIndex
CREATE UNIQUE INDEX "order_item_add_on_shares_one_per_slice" ON "order_item_add_on_shares"("order_item_id", "first_unit");

-- AddForeignKey
ALTER TABLE "campaign_add_on_share_tiers" ADD CONSTRAINT "campaign_add_on_share_tiers_campaign_add_on_id_fkey" FOREIGN KEY ("campaign_add_on_id") REFERENCES "campaign_add_ons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_add_on_shares" ADD CONSTRAINT "order_item_add_on_shares_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: closed ranges, matching fundraiser_campaigns.org_share_percent (a percent, 0–100).
ALTER TABLE "campaign_add_on_share_tiers" ADD CONSTRAINT "campaign_add_on_share_tiers_start_check"
    CHECK ("starting_quantity" >= 1);

ALTER TABLE "campaign_add_on_share_tiers" ADD CONSTRAINT "campaign_add_on_share_tiers_percent_check"
    CHECK ("percent" >= 0 AND "percent" <= 100);

ALTER TABLE "order_item_add_on_shares" ADD CONSTRAINT "order_item_add_on_shares_slice_check"
    CHECK ("first_unit" >= 1 AND "quantity" >= 1);

ALTER TABLE "order_item_add_on_shares" ADD CONSTRAINT "order_item_add_on_shares_money_check"
    CHECK ("percent" >= 0 AND "percent" <= 100 AND "unit_price" >= 0 AND "share_amount" >= 0);

-- Hand-written: an add-on is sold only beside a fundraiser meal order, never on a storefront.
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_addon_not_on_storefront"
    CHECK ("bundle_type" = 'meal' OR "show_on_storefront" = false);
