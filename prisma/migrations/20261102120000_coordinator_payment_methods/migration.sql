-- COORDINATOR-PAYMENT-METHOD-UX-1 — how a fundraiser's supporters may pay their coordinator.
--
-- ADDITIVE ONLY. One nullable JSONB column on one table. No column is dropped or changed, no constraint, index or
-- default is added, nothing is backfilled, and no row is inserted, updated or deleted. Every existing campaign stays
-- valid with NULL, which means "payment methods never configured": its free-text payment_instructions and
-- external_payment_link keep rendering exactly as before, and nothing is parsed out of that prose.
--
-- Shape (validated by lib/supporterPaymentMethods.ts on write AND on read): { "v": 1, "methods": [ ... ] }.
-- It records what the coordinator TELLS supporters they accept. It is not a payment record: an order's paid state
-- remains orders.paid_at, written only by the coordinator's explicit mark.
--
-- ORDER OF RELEASE. Prisma's generated client selects every scalar column of fundraiser_campaigns on reads without an
-- explicit `select`, so this migration MUST be applied to a database BEFORE code built from the matching schema
-- serves it. Applying it early is harmless: existing code never reads this column.

-- AlterTable
ALTER TABLE "fundraiser_campaigns" ADD COLUMN     "payment_methods" JSONB;
