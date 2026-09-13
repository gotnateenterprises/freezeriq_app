-- FR-SUPPORTER-PAYMENT-STATUS-1: the supporter -> coordinator payment, as the
-- coordinator recorded it. An event pair shaped exactly like canceled_at /
-- canceled_by and released_to_delivery_at / released_to_delivery_by.
--
-- Nullable, no default, no index, no unique constraint, no foreign key.
-- NULL means "not marked paid by the coordinator" -- NOT "unpaid". Every
-- existing row stays NULL: there is no evidence on any historical order that a
-- supporter paid, so nothing is backfilled or inferred.
--
-- Additive only. Adding a nullable column with no default is a metadata-only
-- change in PostgreSQL 11+, so it does not rewrite the table. Code that does not
-- know these columns is unaffected: Prisma always selects explicit column lists,
-- so this migration is safe to apply BEFORE the code that reads it is deployed
-- (and must be: the reading code selects these columns).
--
-- IF NOT EXISTS follows the OPS-6B precedent (released_to_delivery_at), so a
-- re-run after a partial apply is a no-op rather than an error. Types match
-- Prisma's own generated SQL for `DateTime?` / `String?` exactly.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paid_by" TEXT;
