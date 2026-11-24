-- FR-SUPPORTER-ADDON-UPSELL-1 — S3 (owner-approved 2026-11-24): the invoice line's fundraiser role.
--   * invoice_items.item_role   'main' (default — every existing line, and every manual invoice line) | 'addon'
-- Written by campaign closeout from the order lines' own item_role, so an invoice can describe the campaign
-- add-on's line as an add-on (never "Serves 5") on the invoice, its bundle summary and in QuickBooks, without
-- re-reading the bundle. Display and counting only; no amount is affected.
-- Additive only: one column with a constant default (no backfill, no table rewrite) and one CHECK. No existing
-- column, constraint or row is changed.
-- Generated with `prisma migrate diff` from the S2 schema; the CHECK at the end is hand-written.

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "item_role" TEXT NOT NULL DEFAULT 'main';

-- Hand-written: the same closed vocabulary as order_items.item_role.
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_item_role_check"
    CHECK ("item_role" IN ('main', 'addon'));
