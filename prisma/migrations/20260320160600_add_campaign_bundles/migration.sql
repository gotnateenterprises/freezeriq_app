-- CreateTable
CREATE TABLE "campaign_bundles" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "campaign_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique constraint — prevents duplicate assignments)
CREATE UNIQUE INDEX "campaign_bundles_campaign_id_bundle_id_key" ON "campaign_bundles"("campaign_id", "bundle_id");

-- CreateIndex (lookup index — storefront queries filter by campaign_id alone)
CREATE INDEX "campaign_bundles_campaign_id_idx" ON "campaign_bundles"("campaign_id");

-- AddForeignKey
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
