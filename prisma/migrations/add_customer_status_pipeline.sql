-- Add status pipeline fields to customers table
-- This migration adds the new CustomerStatus enum and updates the customers table

-- First, create the new enum type
CREATE TYPE "CustomerStatus" AS ENUM ('LEAD', 'SEND_INFO', 'FLYERS', 'ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE');

-- Add new columns
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

-- Update existing status values to match new enum values
-- Map old string values to new enum values
UPDATE "customers" SET "status" = 'LEAD' WHERE "status" IS NULL OR "status" = '' OR LOWER("status") = 'lead';
UPDATE "customers" SET "status" = 'ACTIVE' WHERE LOWER("status") = 'active';
UPDATE "customers" SET "status" = 'PRODUCTION' WHERE LOWER("status") = 'production';
UPDATE "customers" SET "status" = 'DELIVERY' WHERE LOWER("status") = 'delivery';
UPDATE "customers" SET "status" = 'COMPLETE' WHERE LOWER("status") = 'complete' OR LOWER("status") = 'completed';

-- For any other values, default to LEAD
UPDATE "customers" SET "status" = 'LEAD' WHERE "status" NOT IN ('LEAD', 'SEND_INFO', 'FLYERS', 'ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE');

-- Change the column type
ALTER TABLE "customers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "customers" ALTER COLUMN "status" TYPE "CustomerStatus" USING "status"::"CustomerStatus";
ALTER TABLE "customers" ALTER COLUMN "status" SET DEFAULT 'LEAD'::"CustomerStatus";
ALTER TABLE "customers" ALTER COLUMN "status" SET NOT NULL;
