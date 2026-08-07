-- CreateIndex: Add performance indexes for foreign keys and common query patterns
-- This migration adds database indexes to improve query performance

-- Foreign key indexes for faster joins (using actual PostgreSQL table names from @@map)
CREATE INDEX IF NOT EXISTS "idx_customer_business_id" ON "customers"("business_id");
CREATE INDEX IF NOT EXISTS "idx_order_business_id" ON "orders"("business_id");
CREATE INDEX IF NOT EXISTS "idx_order_customer_id" ON "orders"("customer_id");
CREATE INDEX IF NOT EXISTS "idx_recipe_business_id" ON "recipes"("business_id");
CREATE INDEX IF NOT EXISTS "idx_ingredient_business_id" ON "ingredients"("business_id");
CREATE INDEX IF NOT EXISTS "idx_ingredient_supplier_id" ON "ingredients"("supplier_id");
CREATE INDEX IF NOT EXISTS "idx_bundle_business_id" ON "bundles"("business_id");
CREATE INDEX IF NOT EXISTS "idx_bundle_catalog_id" ON "bundles"("catalog_id");
CREATE INDEX IF NOT EXISTS "idx_catalog_business_id" ON "catalogs"("business_id");
CREATE INDEX IF NOT EXISTS "idx_supplier_business_id" ON "suppliers"("business_id");
CREATE INDEX IF NOT EXISTS "idx_user_business_id" ON "users"("business_id");
CREATE INDEX IF NOT EXISTS "idx_production_run_business_id" ON "production_runs"("business_id");
CREATE INDEX IF NOT EXISTS "idx_activity_business_id" ON "activities"("business_id");
CREATE INDEX IF NOT EXISTS "idx_activity_customer_id" ON "activities"("customer_id");

-- Status filtering indexes for common queries
CREATE INDEX IF NOT EXISTS "idx_customer_status" ON "customers"("status");
CREATE INDEX IF NOT EXISTS "idx_order_status" ON "orders"("status");
CREATE INDEX IF NOT EXISTS "idx_customer_archived" ON "customers"("archived");

-- CreateIndex on customer status
CREATE INDEX IF NOT EXISTS "customer_status_idx" ON "customers"("status");

-- CreateIndex on customer type
CREATE INDEX IF NOT EXISTS "customer_type_idx" ON "customers"("type");

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS "idx_customer_business_status" ON "customers"("business_id", "status");
CREATE INDEX IF NOT EXISTS "idx_customer_business_archived" ON "customers"("business_id", "archived");
CREATE INDEX IF NOT EXISTS "idx_order_business_status" ON "orders"("business_id", "status");
CREATE INDEX IF NOT EXISTS "idx_order_customer_status" ON "orders"("customer_id", "status");

-- Recipe and ingredient lookup indexes
CREATE INDEX IF NOT EXISTS "idx_recipe_item_parent" ON "recipe_items"("parent_recipe_id");
CREATE INDEX IF NOT EXISTS "idx_recipe_item_child_recipe" ON "recipe_items"("child_recipe_id");
CREATE INDEX IF NOT EXISTS "idx_recipe_item_child_ingredient" ON "recipe_items"("child_ingredient_id");
CREATE INDEX IF NOT EXISTS "idx_bundle_content_bundle" ON "bundle_contents"("bundle_id");
CREATE INDEX IF NOT EXISTS "idx_bundle_content_recipe" ON "bundle_contents"("recipe_id");
CREATE INDEX IF NOT EXISTS "idx_order_item_order" ON "order_items"("order_id");
CREATE INDEX IF NOT EXISTS "idx_order_item_bundle" ON "order_items"("bundle_id");

-- Integration and external ID lookups
CREATE INDEX IF NOT EXISTS "idx_integration_business" ON "integrations"("business_id");
CREATE INDEX IF NOT EXISTS "idx_customer_external_id" ON "customers"("external_id") WHERE "external_id" IS NOT NULL;

-- Date-based queries for production and orders
CREATE INDEX IF NOT EXISTS "idx_production_run_date" ON "production_runs"("production_date");
CREATE INDEX IF NOT EXISTS "idx_order_delivery_date" ON "orders"("delivery_date");
CREATE INDEX IF NOT EXISTS "idx_order_created_at" ON "orders"("created_at");
