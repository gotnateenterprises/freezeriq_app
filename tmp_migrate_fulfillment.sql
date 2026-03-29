-- Add FulfillmentType enum and new order columns for delivery/pickup support
-- Run this against production Supabase SQL Editor

-- 1. Create the enum type (if not exists)
DO $$ BEGIN
    CREATE TYPE "FulfillmentType" AS ENUM ('PICKUP', 'DELIVERY');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Add the new columns to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type "FulfillmentType" NOT NULL DEFAULT 'PICKUP';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zone_name TEXT;
