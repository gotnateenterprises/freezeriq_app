-- FR-SUPPORTER-CONTACT-1: distinct purchaser first/last name on orders.
--
-- Additive only. orders.customer_name is untouched and keeps being written
-- on every new order, so every existing reader (coordinator notification,
-- RecentOrders, the pickup sheet, the public scoreboard's masked display)
-- keeps working unmodified. Historical rows get NULL in the two new columns
-- and are never backfilled or reinterpreted from customer_name.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "first_name" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "last_name" TEXT;
