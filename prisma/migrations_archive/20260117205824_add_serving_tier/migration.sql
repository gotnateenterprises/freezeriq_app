/*
  Warnings:

  - You are about to drop the column `mult_serves_2` on the `bundle_contents` table. All the data in the column will be lost.
  - You are about to drop the column `mult_serves_5` on the `bundle_contents` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "bundle_contents" DROP COLUMN "mult_serves_2",
DROP COLUMN "mult_serves_5";

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "serving_tier" TEXT NOT NULL DEFAULT 'family';
