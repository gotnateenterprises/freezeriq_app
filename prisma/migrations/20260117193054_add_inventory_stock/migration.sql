-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('prep', 'menu_item');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('ingredient', 'recipe');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('fundraiser_org', 'direct_customer');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('square', 'qbo');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'production_ready', 'completed');

-- CreateEnum
CREATE TYPE "VariantSize" AS ENUM ('serves_2', 'serves_5');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('planning', 'active', 'completed');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'done');

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_email" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "ingredients_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" TEXT NOT NULL,
    "parent_recipe_id" TEXT NOT NULL,
    "child_recipe_id" TEXT,
    "child_ingredient_id" TEXT,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalogs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" TEXT NOT NULL,
    "catalog_id" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_contents" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "recipe_id" TEXT NOT NULL,
    "position" INTEGER,

    CONSTRAINT "bundle_contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "type" "OrgType" NOT NULL DEFAULT 'fundraiser_org',

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" "OrderSource" NOT NULL,
    "organization_id" TEXT,
    "customer_name" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "delivery_date" DATE,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT,
    "bundle_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "variant_size" "VariantSize" NOT NULL DEFAULT 'serves_5',

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_runs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "run_date" DATE NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'planning',

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

-- CreateIndex
CREATE UNIQUE INDEX "ingredients_sku_key" ON "ingredients"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_sku_key" ON "bundles"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "orders_external_id_key" ON "orders"("external_id");

-- AddForeignKey
ALTER TABLE "ingredients" ADD CONSTRAINT "ingredients_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_parent_recipe_id_fkey" FOREIGN KEY ("parent_recipe_id") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_child_recipe_id_fkey" FOREIGN KEY ("child_recipe_id") REFERENCES "recipes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_child_ingredient_id_fkey" FOREIGN KEY ("child_ingredient_id") REFERENCES "ingredients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "catalogs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_contents" ADD CONSTRAINT "bundle_contents_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_contents" ADD CONSTRAINT "bundle_contents_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "bundles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_tasks" ADD CONSTRAINT "production_tasks_production_run_id_fkey" FOREIGN KEY ("production_run_id") REFERENCES "production_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
