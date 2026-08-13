-- CreateEnum
CREATE TYPE "AutomationActionType" AS ENUM ('seasonal_rebooking_recommendation');

-- CreateEnum
CREATE TYPE "AutomationActionStatus" AS ENUM ('candidate', 'approved', 'dismissed', 'suppressed', 'expired');

-- CreateTable
CREATE TABLE "automation_policies" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "action_type" "AutomationActionType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_actions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "action_type" "AutomationActionType" NOT NULL,
    "status" "AutomationActionStatus" NOT NULL DEFAULT 'candidate',
    "seasonal_offering_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "evidence_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "approved_by_user_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "dismissed_by_user_id" TEXT,
    "dismissed_at" TIMESTAMP(3),
    "suppressed_at" TIMESTAMP(3),
    "suppressed_reason" TEXT,
    "expired_at" TIMESTAMP(3),
    "expired_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_policies_business_id_action_type_key" ON "automation_policies"("business_id", "action_type");

-- CreateIndex
CREATE INDEX "automation_actions_business_id_status_action_type_idx" ON "automation_actions"("business_id", "status", "action_type");

-- CreateIndex
CREATE INDEX "automation_actions_business_id_seasonal_offering_id_idx" ON "automation_actions"("business_id", "seasonal_offering_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_actions_one_per_org_per_offering" ON "automation_actions"("business_id", "action_type", "seasonal_offering_id", "customer_id");

-- AddForeignKey
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_offering_fkey" FOREIGN KEY ("business_id", "seasonal_offering_id") REFERENCES "seasonal_offerings"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

