-- ── MIGRATION 18 · outreach batch campaign ownership ────────────────────────
--
-- An OutreachBatch could only belong to a SeasonalOffering. FR-REBOOK-2 invites
-- a fundraiser's PREVIOUS SUPPORTERS, which belongs to a FundraiserCampaign, and
-- the entire hardened delivery chain — recipients, message, per-recipient
-- EmailDeliveryAttempt with its claim-before-send and duplicate protection —
-- hangs off the batch. Without a second owner kind there was nowhere to record a
-- campaign invitation without fabricating a seasonal lineup, which
-- fundraiser_campaign_coordinators already documents as unacceptable: the
-- rebooking surfaces would read that invented lineup as real.
--
-- This migration adds the second owner kind and nothing else.
--
-- NO DATA IS WRITTEN. No backfill, no defaults applied to existing rows, no
-- fabricated campaign, customer or offering. Every existing batch already has a
-- seasonal_offering_id and therefore already satisfies the new CHECK.
--
-- ── ROLLBACK BOUNDARY — READ BEFORE REVERTING ───────────────────────────────
--
-- This is reversible ONLY until the first campaign-owned batch exists.
--
--   BEFORE: drop the two new FKs, drop one_per_campaign, restore
--   one_per_offering to unconditional, drop the CHECK, drop the two columns,
--   restore seasonal_offering_id NOT NULL. Nothing is lost.
--
--   AFTER: restoring seasonal_offering_id NOT NULL FAILS, because campaign-owned
--   rows have it NULL. Those rows carry the delivery audit trail and must be
--   deleted or re-homed first — a data decision, not a schema one. Do not run
--   the inverse DDL in autocommit hoping it will stop safely: the column drops
--   succeed before the NOT NULL restore discovers the problem, so the ownership
--   data is already gone by the time it fails. Wrap any revert in a transaction.
--
-- Two further operational truths. A manual revert leaves _prisma_migrations
-- still claiming this migration is applied, so the ledger must be corrected too
-- or the next deploy will believe the schema is ahead of where it is. And a
-- FAILED deploy of this migration blocks every subsequent deploy with P3009
-- until the failed ledger row is resolved.
--
-- APPLICATION ROLLBACK IS SEPARATE AND TIGHTER. A Prisma client generated before
-- this migration types seasonal_offering_id as non-null, so it cannot
-- deserialize a campaign-owned row (P2032). Deploying this migration ahead of
-- the application code is safe — no such rows exist yet — but once FR-REBOOK-2
-- has written one, rolling the APPLICATION back past it is not.
--
-- ORDERING. Additive columns first, then the constraints, so the table is never
-- in a state that rejects a row that was valid a moment earlier:
--   1. add the nullable columns              (no existing row affected)
--   2. drop NOT NULL on seasonal_offering_id (widening; nothing can fail)
--   3. add the composite foreign keys        (only constrain the new columns,
--                                             which are NULL everywhere)
--   4. replace the unconditional unique index with its partial equivalent
--   5. add the campaign partial unique index
--   6. add the owner CHECK last, once every existing row provably satisfies it

-- ── 1. the fundraiser owner ─────────────────────────────────────────────────
ALTER TABLE "outreach_batches" ADD COLUMN IF NOT EXISTS "campaign_id" TEXT;
ALTER TABLE "outreach_batches" ADD COLUMN IF NOT EXISTS "customer_id" TEXT;

-- ── 2. the seasonal owner becomes optional ──────────────────────────────────
ALTER TABLE "outreach_batches" ALTER COLUMN "seasonal_offering_id" DROP NOT NULL;

-- ── 3. DB-ENFORCED TENANCY, in two links ────────────────────────────────────
--
-- Both targets already exist, so this migration creates no supporting index:
--   customers_business_id_id_key             (FR-RETENTION-1)
--   fundraiser_campaigns_customer_id_id_key  (FR-FUNNEL-1)
--
-- The chain is what matters. (business_id, customer_id) proves this tenant owns
-- the organization; (customer_id, campaign_id) proves that organization owns the
-- campaign. Because both keys ride on the SAME customer_id column, a batch whose
-- campaign belongs to a different organization — or whose organization belongs
-- to a different tenant — cannot be inserted at all, however deliberately the
-- ids are chosen. Same device as fundraiser_campaign_coordinators.
--
-- RESTRICT, matching the offering FK: a CAMPAIGN or ORGANIZATION that already
-- has a delivery audit trail cannot be deleted from underneath it.
--
-- Scope that claim honestly. Deleting the BUSINESS still removes the batches and
-- everything below them, because outreach_batches_business_id_fkey has been
-- ON DELETE CASCADE since FR-RETENTION-2 and this migration does not change it.
-- Tenant deletion is a deliberate whole-tenant erasure elsewhere in this schema;
-- what RESTRICT protects here is the ordinary case — an organization or a
-- campaign being tidied away while its outreach history still matters.
ALTER TABLE "outreach_batches"
  DROP CONSTRAINT IF EXISTS "outreach_batches_customer_fkey";
ALTER TABLE "outreach_batches"
  ADD CONSTRAINT "outreach_batches_customer_fkey"
  FOREIGN KEY ("business_id", "customer_id")
  REFERENCES "customers"("business_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "outreach_batches"
  DROP CONSTRAINT IF EXISTS "outreach_batches_campaign_fkey";
ALTER TABLE "outreach_batches"
  ADD CONSTRAINT "outreach_batches_campaign_fkey"
  FOREIGN KEY ("customer_id", "campaign_id")
  REFERENCES "fundraiser_campaigns"("customer_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. one batch per offering, preserved ────────────────────────────────────
--
-- HONEST NOTE ON WHY THIS IS PARTIAL. It is NOT because the unconditional index
-- would have broken. Postgres unique indexes treat NULLs as DISTINCT by default,
-- so many fundraiser batches (all with seasonal_offering_id NULL) would have
-- coexisted under the old index perfectly well — verified on this project's
-- Postgres 16. An earlier draft of this comment claimed otherwise and was wrong.
--
-- It is partial because that is what the constraint actually MEANS — "at most one
-- batch per lineup", said about lineups only — and because saying it explicitly
-- has three real benefits: the index stops carrying an entry for every
-- fundraiser batch, the intent survives someone later reading it cold, and it is
-- immune to the index ever being rebuilt with NULLS NOT DISTINCT, which would
-- silently cap the whole table at one fundraiser batch.
DROP INDEX IF EXISTS "outreach_batches_one_per_offering";
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_one_per_offering"
  ON "outreach_batches" ("seasonal_offering_id")
  WHERE "seasonal_offering_id" IS NOT NULL;

-- ── 5. one batch per campaign ───────────────────────────────────────────────
--
-- THE DURABLE IDENTITY FR-REBOOK-2 NEEDED. A second Invite Previous Supporters
-- for the same campaign resolves to this same batch rather than creating a
-- parallel one, so the existing per-recipient guard
-- (email_delivery_attempts_one_live_per_recipient) can do its job: already
-- accepted supporters are skipped, failed ones stay retryable.
--
-- Keyed on campaign_id, NOT customer_id — one organization runs many campaigns,
-- and each is its own invitation.
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_one_per_campaign"
  ON "outreach_batches" ("campaign_id")
  WHERE "campaign_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "outreach_batches_business_id_campaign_id_idx"
  ON "outreach_batches" ("business_id", "campaign_id");

-- ── 6. exactly one owner, as a WHOLE SHAPE ──────────────────────────────────
--
-- Deliberately not a two-column XOR. A plain
-- (seasonal_offering_id IS NOT NULL) <> (campaign_id IS NOT NULL)
-- would happily accept a campaign with no customer_id — which is precisely the
-- row that would slip past the tenancy chain above, because a composite foreign
-- key containing a NULL is not checked AT ALL under MATCH SIMPLE.
--
-- That is not a theoretical worry; it was verified directly on this project's
-- Postgres: a child row referencing a parent key that does not exist is accepted
-- without complaint as soon as one column of the composite key is NULL. So
-- (campaign_id = 'some other tenant''s campaign', customer_id = NULL) would be
-- stored happily by the foreign key, and only this CHECK stops it.
--
-- Both valid shapes are therefore spelled out in full, and everything else is
-- refused. This CHECK is load-bearing, not decorative.
ALTER TABLE "outreach_batches"
  DROP CONSTRAINT IF EXISTS "outreach_batches_exactly_one_owner";
ALTER TABLE "outreach_batches"
  ADD CONSTRAINT "outreach_batches_exactly_one_owner" CHECK (
    (
      "seasonal_offering_id" IS NOT NULL
      AND "campaign_id" IS NULL
      AND "customer_id" IS NULL
    )
    OR
    (
      "seasonal_offering_id" IS NULL
      AND "campaign_id" IS NOT NULL
      AND "customer_id" IS NOT NULL
    )
  );
