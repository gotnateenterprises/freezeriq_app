/*
  Warnings:

  - A unique constraint covering the columns `[external_id]` on the table `organizations` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[sku]` on the table `recipes` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[dcg_id]` on the table `recipes` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderSource" ADD VALUE 'manual';
ALTER TYPE "OrderSource" ADD VALUE 'meta';

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "price" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "ingredients" ADD COLUMN     "purchase_cost" DECIMAL(10,4),
ADD COLUMN     "purchase_quantity" DECIMAL(10,4) DEFAULT 1,
ADD COLUMN     "purchase_unit" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "total_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "inactive_reason" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "shipping_address" TEXT,
ADD COLUMN     "source" TEXT DEFAULT 'Manual',
ADD COLUMN     "status" TEXT DEFAULT 'Active',
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "recipes" ADD COLUMN     "allergens" TEXT,
ADD COLUMN     "category_id" TEXT,
ADD COLUMN     "dcg_id" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "label_text" TEXT,
ADD COLUMN     "macros" TEXT,
ADD COLUMN     "sku" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "account_number" TEXT,
ADD COLUMN     "address" TEXT,
ADD COLUMN     "billing_address" TEXT,
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "payment_terms" TEXT,
ADD COLUMN     "phone_number" TEXT,
ADD COLUMN     "salesperson_email" TEXT,
ADD COLUMN     "salesperson_name" TEXT,
ADD COLUMN     "salesperson_phone" TEXT,
ADD COLUMN     "website_url" TEXT;

-- CreateTable
CREATE TABLE "integrations" (
    "provider" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "realm_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" TEXT,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "_CategoryToRecipe" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "activities_external_id_key" ON "activities"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "_CategoryToRecipe_AB_unique" ON "_CategoryToRecipe"("A", "B");

-- CreateIndex
CREATE INDEX "_CategoryToRecipe_B_index" ON "_CategoryToRecipe"("B");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_external_id_key" ON "organizations"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_sku_key" ON "recipes"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_dcg_id_key" ON "recipes"("dcg_id");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToRecipe" ADD CONSTRAINT "_CategoryToRecipe_A_fkey" FOREIGN KEY ("A") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToRecipe" ADD CONSTRAINT "_CategoryToRecipe_B_fkey" FOREIGN KEY ("B") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
