-- FR-LAUNCH-1E: public fundraiser submission idempotency.
--
-- Additive only. No row updates, no backfill, no destructive operations.
-- Existing orders keep NULL submission_key and are ignored by the partial index.
--
-- The unique index is PARTIAL (WHERE submission_key IS NOT NULL) so that legacy,
-- coordinator-entered, and normal storefront orders — which never carry a
-- submission key — are excluded entirely. This mirrors the approach already used
-- for the Bundle.family_id partial unique index: nullable partial-index semantics
-- are not portably expressible as a Prisma @@unique attribute, so the constraint
-- is created here in raw SQL and documented on the model.
--
-- The index is the concurrency primitive for duplicate prevention: two
-- simultaneous submissions carrying the same (business_id, submission_key) cannot
-- both insert. The second blocks until the first commits or rolls back, then
-- either receives a unique violation (replay path) or proceeds normally.
--
-- Do not run Prisma migration commands against the currently parked
-- migration-history chain. This SQL is intended for manual owner review
-- and application, followed by later migration-history reconciliation.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submission_key" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submission_fingerprint" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
  "orders_business_id_submission_key_key"
ON "orders" ("business_id", "submission_key")
WHERE "submission_key" IS NOT NULL;

-- Rollback (manual, if ever required):
--   DROP INDEX IF EXISTS "orders_business_id_submission_key_key";
--   ALTER TABLE "orders" DROP COLUMN IF EXISTS "submission_fingerprint";
--   ALTER TABLE "orders" DROP COLUMN IF EXISTS "submission_key";
