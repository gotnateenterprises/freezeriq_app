-- COORD-MANUAL-EMAIL-1B: optional supporter email captured on a
-- coordinator-entered manual order, frozen per order (sibling of the
-- existing `phone` column). Nullable, no default, no index, no unique
-- constraint, no foreign key. Historical rows stay NULL; no backfill.
ALTER TABLE "orders" ADD COLUMN "email" TEXT;
