-- ═══════════════════════════════════════════════════════════════════════════
-- CANONICAL BASELINE — FreezerIQ production application structure, August 2026
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS
--   The single starting point of FreezerIQ's migration history. It represents
--   the CURRENT PRODUCTION APPLICATION STRUCTURE as captured on 2026-08-07,
--   BEFORE the FR-RETENTION contact foundation is applied.
--
-- WHY A BASELINE EXISTS AT ALL
--   Production had NO `_prisma_migrations` table. `prisma migrate deploy` had
--   never run against it. The production schema was built by `prisma db push`
--   plus a small number of owner-applied SQL statements — evidenced by the
--   fact that 62 of production's 65 indexes carry Prisma-generated names while
--   ZERO hand-written `idx_*` indexes from the historical chain are present.
--
--   The historical migration chain could not reproduce production and was
--   unreplayable from empty:
--     * 19 of production's 37 tables are created by no committed migration
--       (including businesses, customers, users, fundraiser_campaigns);
--     * 20260207202930_add_tenant_branding contains literal escaped newlines,
--       so the whole file parses as one SQL comment and executes as a no-op;
--     * 20260208200000_add_performance_indexes indexes
--       production_runs("production_date"), a column that has never existed
--       (the real column is `run_date`), making it permanently unrunnable.
--
--   Those files are preserved verbatim in prisma/migrations_archive/ as
--   historical evidence. They are NOT part of the active migration history.
--
-- PROVENANCE
--   Generated from the live production database via catalog introspection
--   (`prisma migrate diff --from-empty --to-url <production>`), NOT from the
--   working schema.prisma. Prisma's diff engine silently omits partial
--   indexes, so production's two partial indexes were captured separately via
--   pg_get_indexdef() and appended verbatim at the end of this file.
--
--   Verified: applying this file to an empty PostgreSQL database reproduces
--   production's structure exactly — 37 tables, 399 columns, 89 constraints
--   (53 FK / 36 PK), 65 indexes (2 partial), 16 enums, 1 sequence — with zero
--   unexplained differences.
--
-- DELIBERATELY EXCLUDED
--   * fundraiser_contacts / fundraiser_contact_points /
--     fundraiser_organization_contacts and their enums — these arrive in
--     20260806000000_fr_retention_contact_foundation, which follows this file.
--   * password_reset_tokens — the PasswordResetToken model is parked and
--     unimplemented. It does not exist in production and must not be created
--     here or by any FR-RETENTION migration.
--   * Supabase platform schemas (auth, storage, realtime, vault, graphql,
--     extensions) — these are managed by the platform, not by this repository.
--
-- PRODUCTION NOTE
--   Archiving the historical files changed NO production schema. Production
--   already lacked a migration ledger; this baseline gives it one. The only
--   production operation this baseline ever requires is a single
--   `prisma migrate resolve --applied 00000000000000_baseline`, which inserts
--   one ledger row and issues no DDL. That operation is NOT performed by this
--   file and requires separate explicit authorization.
--
-- Full forensic detail: prisma/migrations_archive/README.md
-- ═══════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "ContainerType" AS ENUM ('tray', 'bag');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('LEAD', 'SEND_INFO', 'FLYERS', 'ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('ingredient', 'recipe');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('square', 'qbo', 'manual', 'meta', 'storefront', 'fundraiser');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'production_ready', 'completed', 'delivered', 'PENDING', 'APPROVED', 'IN_PRODUCTION', 'COMPLETED', 'DELIVERED', 'fundraiser_hold', 'in_production', 'ready_to_ship');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('fundraiser_org', 'direct_customer', 'organization');

-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('prep', 'menu_item');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('VIDEO', 'SOP', 'FAQ');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'CHEF', 'DRIVER');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('planning', 'active', 'completed');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('FREE', 'BASE', 'PRO', 'ULTIMATE', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'canceled', 'unpaid', 'trialing');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'done');

-- CreateEnum
CREATE TYPE "VariantSize" AS ENUM ('serves_2', 'serves_5');

-- CreateTable
CREATE TABLE "_CategoryToRecipe" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'meta',
    "external_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_id" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'unread',
    "business_id" TEXT,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_feedback" (
    "id" TEXT NOT NULL,
    "recipe_name" TEXT NOT NULL,
    "recipe_json" JSONB NOT NULL,
    "rating" INTEGER NOT NULL,
    "feedback_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_contents" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "position" INTEGER,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1.0,

    CONSTRAINT "bundle_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" TEXT NOT NULL,
    "catalog_id" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT,
    "serving_tier" TEXT NOT NULL DEFAULT 'family',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "price" DECIMAL(10,2),
    "business_id" TEXT,
    "image_url" TEXT,
    "show_on_storefront" BOOLEAN NOT NULL DEFAULT false,
    "stock_on_hand" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "is_surplus" BOOLEAN NOT NULL DEFAULT false,
    "order_cutoff_date" DATE,
    "family_id" TEXT,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMP(3),
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'BASE',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "subscription_status" "SubscriptionStatus" NOT NULL DEFAULT 'trialing',
    "trial_ends_at" TIMESTAMP(3),
    "google_calendar_url" TEXT,
    "custom_domain" TEXT,
    "contact_email" TEXT,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_bundles" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "campaign_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "business_id" TEXT,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,
    "business_id" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coordinator_action_events" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "source" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coordinator_action_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "type" "OrgType" NOT NULL DEFAULT 'fundraiser_org',
    "delivery_address" TEXT,
    "notes" TEXT,
    "external_id" TEXT,
    "source" TEXT DEFAULT 'Manual',
    "status" "CustomerStatus" NOT NULL DEFAULT 'LEAD',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inactive_reason" TEXT,
    "fundraiser_info" JSONB,
    "loyalty_balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "secondary_phone" TEXT,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "storefront_config_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "max_radius_miles" DECIMAL(6,2) NOT NULL,
    "fee" DECIMAL(10,2) DEFAULT 0,
    "sort_order" INTEGER DEFAULT 0,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_codes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "is_percentage" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "business_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "customer_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "external_link" TEXT,
    "campaign_id" TEXT,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fundraiser_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Lead',
    "start_date" DATE,
    "end_date" DATE,
    "delivery_date" DATE,
    "pickup_location" TEXT,
    "checks_payable" TEXT,
    "goal_amount" DECIMAL(10,2),
    "total_sales" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "checklist" JSONB,
    "about_text" TEXT,
    "external_payment_link" TEXT,
    "mission_text" TEXT,
    "payment_instructions" TEXT,
    "portal_token" TEXT,
    "public_token" TEXT,
    "participant_label" TEXT NOT NULL DEFAULT 'Seller',
    "group_label" TEXT,
    "is_group_enabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_generation_count" INTEGER NOT NULL DEFAULT 0,
    "bundle_goal" INTEGER DEFAULT 100,
    "closed_at" TIMESTAMP(3),
    "closed_by" TEXT,
    "settlement_total" DECIMAL(10,2),
    "settlement_notes" TEXT,
    "bundle_selection_at" TIMESTAMP(3),
    "bundle_selection_status" TEXT NOT NULL DEFAULT 'not_required',
    "bundle_selection_limit" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "fundraiser_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingredients" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "cost_per_unit" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "stock_quantity" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "purchase_cost" DECIMAL(10,4),
    "purchase_quantity" DECIMAL(10,4) DEFAULT 1,
    "purchase_unit" TEXT,
    "business_id" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "provider" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "realm_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_id" TEXT NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("business_id","provider")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "bundle_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "payment_method" TEXT DEFAULT 'check',
    "total_amount" DECIMAL(10,2) NOT NULL,
    "tax_amount" DECIMAL(10,2) DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3),
    "fundraiser_profit_percent" DECIMAL(5,2) DEFAULT 0,
    "fundraiser_profit_amount" DECIMAL(10,2) DEFAULT 0,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "elements" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "business_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "label_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_points" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "points" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT,
    "bundle_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "variant_size" "VariantSize" NOT NULL DEFAULT 'serves_5',
    "item_name" TEXT,
    "unit_price" DECIMAL(10,2),
    "is_subscription" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" "OrderSource" NOT NULL,
    "customer_name" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "delivery_date" DATE,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "total_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "business_id" TEXT,
    "campaign_id" TEXT,
    "customer_id" TEXT,
    "invoice_id" TEXT,
    "delivery_address" TEXT,
    "delivery_sequence" INTEGER DEFAULT 0,
    "participant_name" TEXT,
    "phone" TEXT,
    "payment_processor" TEXT,
    "processor_payment_id" TEXT,
    "delivery_zone_name" TEXT,
    "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'PICKUP',
    "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "delivery_fee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "canceled_at" TIMESTAMPTZ(6),
    "canceled_by" TEXT,
    "submission_key" TEXT,
    "submission_fingerprint" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packaging_items" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reorderUrl" TEXT,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 10,
    "type" TEXT NOT NULL DEFAULT 'other',
    "defaultLabelId" TEXT,
    "business_id" TEXT,
    "cost_per_unit" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packaging_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "run_date" DATE NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'planning',
    "business_id" TEXT,

    CONSTRAINT "production_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_tasks" (
    "id" TEXT NOT NULL,
    "production_run_id" TEXT,
    "item_id" TEXT NOT NULL,
    "item_type" "ItemType" NOT NULL,
    "total_qty_needed" DECIMAL(10,2),
    "unit" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',

    CONSTRAINT "production_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" TEXT NOT NULL,
    "parent_recipe_id" TEXT NOT NULL,
    "child_recipe_id" TEXT,
    "child_ingredient_id" TEXT,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "is_sub_recipe" BOOLEAN NOT NULL DEFAULT false,
    "section_batch" DECIMAL(10,2) DEFAULT 1.0,
    "section_name" TEXT,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "RecipeType" NOT NULL,
    "base_yield_qty" DECIMAL(10,2) NOT NULL,
    "base_yield_unit" TEXT NOT NULL,
    "storage_instructions" TEXT,
    "shelf_life_days" INTEGER,
    "allergens" TEXT,
    "category_id" TEXT,
    "dcg_id" TEXT,
    "instructions" TEXT,
    "label_text" TEXT,
    "macros" TEXT,
    "sku" TEXT,
    "business_id" TEXT,
    "container_type" "ContainerType" NOT NULL DEFAULT 'tray',
    "image_url" TEXT,
    "description" TEXT,
    "cook_time" TEXT,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storefront_configs" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "hero_headline" TEXT NOT NULL DEFAULT 'Welcome to Our Shop',
    "hero_subheadline" TEXT NOT NULL DEFAULT 'Delicious meals made fresh for you.',
    "upsell_bundle_id" TEXT,
    "upsell_title" TEXT,
    "upsell_description" TEXT,
    "upsell_discount_percent" INTEGER NOT NULL DEFAULT 0,
    "manual_upsell_image" TEXT,
    "manual_upsell_name" TEXT,
    "manual_upsell_price" DECIMAL(10,2),
    "upsell_type" TEXT NOT NULL DEFAULT 'bundle',
    "our_story_content" TEXT,
    "our_story_headline" TEXT,
    "hero_image_url" TEXT,
    "how_it_works_content" TEXT,
    "footer_text" TEXT,
    "marketing_video_url" TEXT,
    "trust_badges" JSONB,
    "testimonials" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "payment_provider" TEXT NOT NULL DEFAULT 'stripe',
    "tax_percent" DECIMAL(5,2) DEFAULT 0,
    "delivery_fee" DECIMAL(10,2) DEFAULT 0,
    "is_delivery_enabled" BOOLEAN DEFAULT true,
    "is_pickup_enabled" BOOLEAN DEFAULT true,
    "origin_address" TEXT,
    "origin_lat" DECIMAL(10,7),
    "origin_lng" DECIMAL(10,7),

    CONSTRAINT "storefront_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_email" TEXT,
    "account_number" TEXT,
    "address" TEXT,
    "billing_address" TEXT,
    "logo_url" TEXT,
    "payment_terms" TEXT,
    "phone_number" TEXT,
    "salesperson_email" TEXT,
    "salesperson_name" TEXT,
    "salesperson_phone" TEXT,
    "website_url" TEXT,
    "business_id" TEXT,
    "is_global" BOOLEAN NOT NULL DEFAULT false,
    "portal_type" TEXT DEFAULT 'gfs_store',
    "search_url_pattern" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "business_id" TEXT,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "tenant_branding" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL DEFAULT 'Freezer Chef',
    "logo_url" TEXT,
    "primary_color" TEXT NOT NULL DEFAULT '#10b981',
    "secondary_color" TEXT NOT NULL DEFAULT '#6366f1',
    "accent_color" TEXT NOT NULL DEFAULT '#f59e0b',
    "tagline" TEXT,
    "review_qr_url" TEXT,
    "thank_you_note" TEXT,
    "review_prompt" TEXT,
    "sign_off" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_resources" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ResourceType" NOT NULL,
    "category" TEXT NOT NULL,
    "url" TEXT,
    "content" TEXT,
    "thumbnail" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "business_id" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "training_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_training_progress" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_training_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'CHEF',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "business_id" TEXT,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "_CategoryToRecipe_AB_unique" ON "_CategoryToRecipe"("A" ASC, "B" ASC);

-- CreateIndex
CREATE INDEX "_CategoryToRecipe_B_index" ON "_CategoryToRecipe"("B" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "activities_external_id_key" ON "activities"("external_id" ASC);

-- CreateIndex
CREATE INDEX "bundles_family_id_idx" ON "bundles"("family_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "bundles_sku_key" ON "bundles"("sku" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_custom_domain_key" ON "businesses"("custom_domain" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_slug_key" ON "businesses"("slug" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_stripe_customer_id_key" ON "businesses"("stripe_customer_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_stripe_subscription_id_key" ON "businesses"("stripe_subscription_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_bundles_campaign_id_bundle_id_state_key" ON "campaign_bundles"("campaign_id" ASC, "bundle_id" ASC, "state" ASC);

-- CreateIndex
CREATE INDEX "campaign_bundles_campaign_id_idx" ON "campaign_bundles"("campaign_id" ASC);

-- CreateIndex
CREATE INDEX "campaign_bundles_campaign_state_idx" ON "campaign_bundles"("campaign_id" ASC, "state" ASC);

-- CreateIndex
CREATE INDEX "coordinator_action_events_campaign_id_idx" ON "coordinator_action_events"("campaign_id" ASC);

-- CreateIndex
CREATE INDEX "coordinator_action_events_created_at_idx" ON "coordinator_action_events"("created_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "customers_external_id_key" ON "customers"("external_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "discount_codes_code_key" ON "discount_codes"("code" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "fundraiser_campaigns_portal_token_key" ON "fundraiser_campaigns"("portal_token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "fundraiser_campaigns_public_token_key" ON "fundraiser_campaigns"("public_token" ASC);

-- CreateIndex
CREATE INDEX "fundraiser_campaigns_selection_status_at_idx" ON "fundraiser_campaigns"("bundle_selection_status" ASC, "bundle_selection_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_id_key" ON "orders"("external_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_invoice_id_key" ON "orders"("invoice_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_dcg_id_key" ON "recipes"("dcg_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_sku_key" ON "recipes"("sku" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "storefront_configs_business_id_key" ON "storefront_configs"("business_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_branding_user_id_key" ON "tenant_branding"("user_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "user_training_progress_user_id_resource_id_key" ON "user_training_progress"("user_id" ASC, "resource_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email" ASC);

-- AddForeignKey
ALTER TABLE "_CategoryToRecipe" ADD CONSTRAINT "_CategoryToRecipe_A_fkey" FOREIGN KEY ("A") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToRecipe" ADD CONSTRAINT "_CategoryToRecipe_B_fkey" FOREIGN KEY ("B") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_contents" ADD CONSTRAINT "bundle_contents_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_contents" ADD CONSTRAINT "bundle_contents_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_bundles" ADD CONSTRAINT "campaign_bundles_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalogs" ADD CONSTRAINT "catalogs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coordinator_action_events" ADD CONSTRAINT "coordinator_action_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_storefront_config_id_fkey" FOREIGN KEY ("storefront_config_id") REFERENCES "storefront_configs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundraiser_campaigns" ADD CONSTRAINT "fundraiser_campaigns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_points" ADD CONSTRAINT "loyalty_points_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_items" ADD CONSTRAINT "packaging_items_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packaging_items" ADD CONSTRAINT "packaging_items_defaultLabelId_fkey" FOREIGN KEY ("defaultLabelId") REFERENCES "label_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_runs" ADD CONSTRAINT "production_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_production_run_id_fkey" FOREIGN KEY ("production_run_id") REFERENCES "production_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_child_ingredient_id_fkey" FOREIGN KEY ("child_ingredient_id") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_child_recipe_id_fkey" FOREIGN KEY ("child_recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_parent_recipe_id_fkey" FOREIGN KEY ("parent_recipe_id") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_configs" ADD CONSTRAINT "storefront_configs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storefront_configs" ADD CONSTRAINT "storefront_configs_upsell_bundle_id_fkey" FOREIGN KEY ("upsell_bundle_id") REFERENCES "bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_resources" ADD CONSTRAINT "training_resources_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_training_progress" ADD CONSTRAINT "user_training_progress_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "training_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_training_progress" ADD CONSTRAINT "user_training_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════════════════════════════
-- PARTIAL INDEXES — captured verbatim from production pg_get_indexdef().
-- Prisma cannot express these as @@unique attributes and its diff engine
-- omits them entirely, so they are reproduced here by hand. Both already
-- exist in production; they are part of the baseline, not new work.
-- ═══════════════════════════════════════════════════════════════════════════

-- CB-1: one active Serves-5/Serves-2 pair per bundle family, per tenant.
CREATE UNIQUE INDEX "bundles_business_family_tier_unique"
  ON "bundles" ("business_id", "family_id", "serving_tier")
  WHERE ("family_id" IS NOT NULL);

-- FR-1E: public fundraiser submission idempotency. Partial so that legacy
-- and coordinator-entered orders (submission_key IS NULL) are excluded.
CREATE UNIQUE INDEX "orders_business_id_submission_key_key"
  ON "orders" ("business_id", "submission_key")
  WHERE ("submission_key" IS NOT NULL);
