-- FR-FUNNEL-1 · Fundraiser acquisition funnel foundation
--
-- Hand-written, never generated. `prisma migrate dev` would sweep ~36 statements
-- of pre-existing drift between schema.prisma and the Production database into
-- this file; everything below is scoped to FR-FUNNEL-1 and nothing else.
--
-- STRICTLY ADDITIVE. Two new tables, two new enums, and ONE index on an existing
-- table. No column is added, altered, or dropped on any existing table. No row
-- is written, updated, or deleted. There is no backfill: legacy campaigns have
-- no recoverable inquiry date, source, or response time, and manufacturing them
-- would poison every funnel metric with fabricated history.
--
-- Rollback is a clean DROP — there is no prior state to restore.

-- ── Enums ────────────────────────────────────────────────────────────────────
-- Pre-campaign lifecycle only. Waiting-for-coordinator, live, completed and
-- rebooking are DERIVED from existing campaign/rebooking facts and deliberately
-- have no values here.
CREATE TYPE "FundraiserOpportunityStatus" AS ENUM ('new', 'in_conversation', 'date_confirmed', 'converted', 'lost');

CREATE TYPE "FundraiserLostReason" AS ENUM ('no_response', 'date_unavailable', 'not_interested', 'postponed', 'duplicate', 'not_a_fit', 'chose_other_fundraiser', 'other');

-- ── Tables ───────────────────────────────────────────────────────────────────
-- Opportunities first: fundraiser_inquiries carries a NOT NULL FK to it.
CREATE TABLE "fundraiser_opportunities" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" "FundraiserOpportunityStatus" NOT NULL DEFAULT 'new',
    "first_response_at" TIMESTAMP(3),
    -- All three are DELIVERY/PICKUP days, the date actually negotiated with the
    -- organization. NOT the campaign start and NOT the order deadline.
    "preferred_delivery_date" DATE,
    "alternate_delivery_date" DATE,
    "confirmed_delivery_date" DATE,
    "participant_estimate" INTEGER,
    "notes" TEXT,
    "lost_reason" "FundraiserLostReason",
    "lost_at" TIMESTAMP(3),
    "campaign_id" TEXT,
    "converted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fundraiser_opportunities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fundraiser_inquiries" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    -- NOT NULL by contract: an inquiry belonging to no opportunity is an orphan
    -- fact no CRM surface would ever show.
    "opportunity_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Controlled value from FUNDRAISER_SOURCE_CHANNELS in lib/fundraiserFunnel.ts.
    -- A TEXT column rather than an enum so new ad channels never require an
    -- ALTER TYPE migration.
    "source_channel" TEXT NOT NULL DEFAULT 'tenant_website',
    "source_detail" TEXT,
    "submission_key" TEXT,
    "submission_fingerprint" TEXT,
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT,
    "organization_name" TEXT NOT NULL,
    "context" TEXT,
    "storefront_slug" TEXT,

    CONSTRAINT "fundraiser_inquiries_pkey" PRIMARY KEY ("id")
);

-- ── Ordinary indexes ─────────────────────────────────────────────────────────
CREATE INDEX "fundraiser_opportunities_business_id_status_idx" ON "fundraiser_opportunities"("business_id", "status");
CREATE INDEX "fundraiser_opportunities_business_id_customer_id_idx" ON "fundraiser_opportunities"("business_id", "customer_id");
CREATE INDEX "fundraiser_inquiries_business_id_received_at_idx" ON "fundraiser_inquiries"("business_id", "received_at");
CREATE INDEX "fundraiser_inquiries_business_id_source_channel_idx" ON "fundraiser_inquiries"("business_id", "source_channel");
CREATE INDEX "fundraiser_inquiries_business_id_opportunity_id_idx" ON "fundraiser_inquiries"("business_id", "opportunity_id");

-- ── Compound tenant keys ─────────────────────────────────────────────────────
-- Lets tenant-scoped children reference (business_id, id) so Postgres, not
-- application code, rejects a cross-tenant attachment.
CREATE UNIQUE INDEX "fundraiser_opportunities_business_id_id_key" ON "fundraiser_opportunities"("business_id", "id");

-- ONE campaign -> AT MOST ONE opportunity. A second opportunity on the same
-- campaign is impossible: the compound FK below pins a given campaign_id to
-- exactly one customer_id (campaign.id is the primary key), so any twin would
-- collide on this pair. NULLs are distinct in Postgres, so any number of
-- un-converted opportunities coexist.
CREATE UNIQUE INDEX "fundraiser_opportunities_customer_id_campaign_id_key" ON "fundraiser_opportunities"("customer_id", "campaign_id");

-- Intentionally redundant with fundraiser_campaigns_pkey. FundraiserCampaign has
-- no business_id, so there is no (business_id, id) for a tenant-safe compound FK
-- to reference. This gives one to reference instead: an opportunity keyed on
-- (customer_id, campaign_id) can only resolve to a campaign owned by the SAME
-- Customer, and that Customer is already tenant-bound. Tenancy is therefore
-- enforced transitively by the database rather than by a code path someone might
-- forget to write. Cannot fail: (customer_id, id) is unique by virtue of the PK.
CREATE UNIQUE INDEX "fundraiser_campaigns_customer_id_id_key" ON "fundraiser_campaigns"("customer_id", "id");

-- ── Partial unique indexes (Prisma cannot express these) ─────────────────────

-- Submission idempotency, matching the established public-order contract in
-- lib/orderIdempotency.ts. Tenant-scoped, so the same key from two different
-- tenants is fine. Partial, so the many rows with no key do not collide.
-- THIS INDEX is what makes a double-click race-safe: the loser of the race gets
-- a unique violation and reads back the winner instead of inserting a twin.
CREATE UNIQUE INDEX "fundraiser_inquiries_business_id_submission_key_key"
    ON "fundraiser_inquiries" ("business_id", "submission_key")
    WHERE "submission_key" IS NOT NULL;

-- ONE OPEN OPPORTUNITY PER ORGANIZATION.
-- This is what removes any need for a time-window duplicate heuristic: a repeat
-- inquiry is recorded honestly as its own row and folded into the existing open
-- opportunity, because a second open one cannot exist. Terminal statuses
-- (converted, lost) are excluded from the predicate, so a returning organization
-- can legitimately start a fresh cycle next season.
CREATE UNIQUE INDEX "fundraiser_opportunities_one_open_per_org"
    ON "fundraiser_opportunities" ("business_id", "customer_id")
    WHERE "status" IN ('new', 'in_conversation', 'date_confirmed');

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- Cascade from Business (tenant offboarding removes tenant-owned funnel data).
-- Restrict everywhere else: funnel history must survive the ordinary CRM
-- lifecycle, the same reasoning that made FundraiserCampaign.customer Restrict
-- in FR-RETENTION-0R.
ALTER TABLE "fundraiser_opportunities" ADD CONSTRAINT "fundraiser_opportunities_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fundraiser_opportunities" ADD CONSTRAINT "fundraiser_opportunities_business_id_customer_id_fkey"
    FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The transitive tenant guarantee. MATCH SIMPLE (the default) means the
-- constraint is skipped while campaign_id IS NULL, which is exactly right for an
-- un-converted opportunity.
ALTER TABLE "fundraiser_opportunities" ADD CONSTRAINT "fundraiser_opportunities_customer_id_campaign_id_fkey"
    FOREIGN KEY ("customer_id", "campaign_id") REFERENCES "fundraiser_campaigns"("customer_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fundraiser_inquiries" ADD CONSTRAINT "fundraiser_inquiries_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fundraiser_inquiries" ADD CONSTRAINT "fundraiser_inquiries_business_id_customer_id_fkey"
    FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fundraiser_inquiries" ADD CONSTRAINT "fundraiser_inquiries_business_id_opportunity_id_fkey"
    FOREIGN KEY ("business_id", "opportunity_id") REFERENCES "fundraiser_opportunities"("business_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
