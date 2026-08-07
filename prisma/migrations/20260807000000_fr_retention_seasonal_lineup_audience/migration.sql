-- FR-RETENTION-2 — Seasonal Lineup and audience. Hand-authored (NOT generated
-- by `prisma migrate dev`).
--
-- Scope, exactly:
--   · seasonal_offerings / seasonal_offering_families — the "Seasonal Lineup"
--   · outreach_batches / outreach_recipients / *_contacts / *_orgs — the
--     audience snapshot
--   · marketing_preferences (current state) + email_suppression_events
--     (append-only history)
--
-- Deliberately NOT included: the parked PasswordResetToken work. This migration
-- must never create `password_reset_tokens`. It also creates nothing belonging
-- to Checkpoint 3+ (no outreach_executions, outreach_messages,
-- email_delivery_attempts, email_provider_events, rebooking_submissions,
-- rebooking_opportunities, campaign_contacts).
--
-- Purely additive: no existing table, column, constraint, or row is modified.

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "SeasonalOfferingStatus" AS ENUM ('draft', 'ready', 'in_use', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "OutreachBatchStatus" AS ENUM ('draft', 'audience_ready'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RecipientEligibility" AS ENUM ('included', 'excluded', 'needs_review'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RecipientExclusionReason" AS ENUM ('unsubscribed', 'shared_address_unsubscribed', 'paused_until', 'not_interested_until', 'invalid_email', 'no_email', 'needs_review'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MarketingPreferenceScope" AS ENUM ('contact', 'email_address'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "MarketingPreferenceStatus" AS ENUM ('subscribed', 'unsubscribed', 'paused', 'not_interested'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PreferenceSource" AS ENUM ('tenant', 'contact_request', 'system', 'import'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SuppressionEventType" AS ENUM ('unsubscribe', 'resubscribe', 'invalid_address', 'hard_bounce', 'shared_address_suppression', 'tenant_pause', 'not_interested_until'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── seasonal_offerings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "seasonal_offerings" (
  "id"                       TEXT NOT NULL,
  "business_id"              TEXT NOT NULL,
  "name"                     TEXT NOT NULL,
  "starts_at"                TIMESTAMP(3) NOT NULL,
  "ends_at"                  TIMESTAMP(3) NOT NULL,
  "status"                   "SeasonalOfferingStatus" NOT NULL DEFAULT 'draft',
  "coordinator_bundle_limit" INTEGER NOT NULL DEFAULT 2,
  "subject_override"         TEXT,
  "sales_letter"             TEXT,
  "internal_notes"           TEXT,
  "created_by_user_id"       TEXT,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  "archived_at"              TIMESTAMP(3),
  CONSTRAINT "seasonal_offerings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "seasonal_offerings_business_id_id_key"
  ON "seasonal_offerings" ("business_id", "id");
CREATE INDEX IF NOT EXISTS "seasonal_offerings_business_id_status_idx"
  ON "seasonal_offerings" ("business_id", "status");

ALTER TABLE "seasonal_offerings"
  DROP CONSTRAINT IF EXISTS "seasonal_offerings_business_id_fkey";
ALTER TABLE "seasonal_offerings"
  ADD CONSTRAINT "seasonal_offerings_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A lineup cannot end before it starts.
ALTER TABLE "seasonal_offerings"
  DROP CONSTRAINT IF EXISTS "seasonal_offerings_dates_check";
ALTER TABLE "seasonal_offerings"
  ADD CONSTRAINT "seasonal_offerings_dates_check"
  CHECK ("ends_at" >= "starts_at");

-- Coordinators must be able to choose at least one bundle.
ALTER TABLE "seasonal_offerings"
  DROP CONSTRAINT IF EXISTS "seasonal_offerings_limit_check";
ALTER TABLE "seasonal_offerings"
  ADD CONSTRAINT "seasonal_offerings_limit_check"
  CHECK ("coordinator_bundle_limit" >= 1);

-- ── seasonal_offering_families ───────────────────────────────────────────────
-- family_id deliberately has NO foreign key: bundles.family_id is shared by the
-- Serves-5 and Serves-2 siblings and is therefore not unique in `bundles`.
-- Eligibility is enforced on write through the CB-4 resolver.
CREATE TABLE IF NOT EXISTS "seasonal_offering_families" (
  "id"                   TEXT NOT NULL,
  "business_id"          TEXT NOT NULL,
  "seasonal_offering_id" TEXT NOT NULL,
  "family_id"            TEXT NOT NULL,
  "position"             INTEGER NOT NULL DEFAULT 0,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seasonal_offering_families_pkey" PRIMARY KEY ("id")
);

-- One row per family per lineup — a family cannot be selected twice.
CREATE UNIQUE INDEX IF NOT EXISTS "seasonal_offering_families_offering_family_key"
  ON "seasonal_offering_families" ("seasonal_offering_id", "family_id");
CREATE INDEX IF NOT EXISTS "seasonal_offering_families_business_id_family_id_idx"
  ON "seasonal_offering_families" ("business_id", "family_id");

ALTER TABLE "seasonal_offering_families"
  DROP CONSTRAINT IF EXISTS "seasonal_offering_families_offering_fkey";
ALTER TABLE "seasonal_offering_families"
  ADD CONSTRAINT "seasonal_offering_families_offering_fkey"
  FOREIGN KEY ("business_id", "seasonal_offering_id")
  REFERENCES "seasonal_offerings"("business_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── outreach_batches ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "outreach_batches" (
  "id"                     TEXT NOT NULL,
  "business_id"            TEXT NOT NULL,
  "seasonal_offering_id"   TEXT NOT NULL,
  "status"                 "OutreachBatchStatus" NOT NULL DEFAULT 'draft',
  "audience_calculated_at" TIMESTAMP(3),
  "recipient_count"        INTEGER NOT NULL DEFAULT 0,
  "included_count"         INTEGER NOT NULL DEFAULT 0,
  "excluded_count"         INTEGER NOT NULL DEFAULT 0,
  "needs_review_count"     INTEGER NOT NULL DEFAULT 0,
  "created_by_user_id"     TEXT,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outreach_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_business_id_id_key"
  ON "outreach_batches" ("business_id", "id");
CREATE INDEX IF NOT EXISTS "outreach_batches_business_id_status_idx"
  ON "outreach_batches" ("business_id", "status");

-- One audience per Seasonal Lineup. This is the database-level guarantee that a
-- double-clicked "Continue" cannot produce two parallel audiences for the same
-- lineup; the API reuses the existing row rather than inserting a second.
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_batches_one_per_offering"
  ON "outreach_batches" ("seasonal_offering_id");

ALTER TABLE "outreach_batches"
  DROP CONSTRAINT IF EXISTS "outreach_batches_business_id_fkey";
ALTER TABLE "outreach_batches"
  ADD CONSTRAINT "outreach_batches_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict: a lineup that already has a reviewed audience must not vanish.
ALTER TABLE "outreach_batches"
  DROP CONSTRAINT IF EXISTS "outreach_batches_offering_fkey";
ALTER TABLE "outreach_batches"
  ADD CONSTRAINT "outreach_batches_offering_fkey"
  FOREIGN KEY ("business_id", "seasonal_offering_id")
  REFERENCES "seasonal_offerings"("business_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── outreach_recipients ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "outreach_recipients" (
  "id"                        TEXT NOT NULL,
  "business_id"               TEXT NOT NULL,
  "outreach_batch_id"         TEXT NOT NULL,
  "normalized_email"          TEXT,
  "display_name"              TEXT NOT NULL,
  "email_masked"              TEXT,
  "is_shared_inbox"           BOOLEAN NOT NULL DEFAULT false,
  "represented_contact_count" INTEGER NOT NULL DEFAULT 1,
  "represented_org_count"     INTEGER NOT NULL DEFAULT 0,
  "represented_org_names"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "eligibility"               "RecipientEligibility" NOT NULL,
  "exclusion_reason"          "RecipientExclusionReason",
  "exclusion_detail"          TEXT,
  "excluded_until"            TIMESTAMP(3),
  "is_selected"               BOOLEAN NOT NULL DEFAULT true,
  "snapshot_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outreach_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "outreach_recipients_business_id_id_key"
  ON "outreach_recipients" ("business_id", "id");
CREATE INDEX IF NOT EXISTS "outreach_recipients_batch_eligibility_idx"
  ON "outreach_recipients" ("business_id", "outreach_batch_id", "eligibility");

-- THE deduplication guarantee: at most one deliverable row per normalized
-- address per audience, so one Seasonal Update can never send twice to the
-- same inbox. Partial because "no email" recipients carry NULL and several of
-- those may legitimately coexist in one audience. Not expressible as a Prisma
-- @@unique for exactly that reason.
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_recipients_batch_one_email"
  ON "outreach_recipients" ("outreach_batch_id", "normalized_email")
  WHERE "normalized_email" IS NOT NULL;

ALTER TABLE "outreach_recipients"
  DROP CONSTRAINT IF EXISTS "outreach_recipients_batch_fkey";
ALTER TABLE "outreach_recipients"
  ADD CONSTRAINT "outreach_recipients_batch_fkey"
  FOREIGN KEY ("business_id", "outreach_batch_id")
  REFERENCES "outreach_batches"("business_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── outreach_recipient_contacts ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "outreach_recipient_contacts" (
  "id"                    TEXT NOT NULL,
  "business_id"           TEXT NOT NULL,
  "outreach_recipient_id" TEXT NOT NULL,
  "contact_id"            TEXT NOT NULL,
  "contact_display_name"  TEXT NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outreach_recipient_contacts_pkey" PRIMARY KEY ("id")
);

-- One link per (recipient, contact) — repeated audience finalization cannot
-- duplicate the people an address represents.
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_recipient_contacts_recipient_contact_key"
  ON "outreach_recipient_contacts" ("outreach_recipient_id", "contact_id");
CREATE INDEX IF NOT EXISTS "outreach_recipient_contacts_business_id_contact_id_idx"
  ON "outreach_recipient_contacts" ("business_id", "contact_id");

ALTER TABLE "outreach_recipient_contacts"
  DROP CONSTRAINT IF EXISTS "outreach_recipient_contacts_recipient_fkey";
ALTER TABLE "outreach_recipient_contacts"
  ADD CONSTRAINT "outreach_recipient_contacts_recipient_fkey"
  FOREIGN KEY ("business_id", "outreach_recipient_id")
  REFERENCES "outreach_recipients"("business_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict: audience history keeps the durable person reachable.
ALTER TABLE "outreach_recipient_contacts"
  DROP CONSTRAINT IF EXISTS "outreach_recipient_contacts_contact_fkey";
ALTER TABLE "outreach_recipient_contacts"
  ADD CONSTRAINT "outreach_recipient_contacts_contact_fkey"
  FOREIGN KEY ("business_id", "contact_id")
  REFERENCES "fundraiser_contacts"("business_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── outreach_recipient_orgs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "outreach_recipient_orgs" (
  "id"                    TEXT NOT NULL,
  "business_id"           TEXT NOT NULL,
  "outreach_recipient_id" TEXT NOT NULL,
  "customer_id"           TEXT NOT NULL,
  "organization_name"     TEXT NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outreach_recipient_orgs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "outreach_recipient_orgs_recipient_customer_key"
  ON "outreach_recipient_orgs" ("outreach_recipient_id", "customer_id");
CREATE INDEX IF NOT EXISTS "outreach_recipient_orgs_business_id_customer_id_idx"
  ON "outreach_recipient_orgs" ("business_id", "customer_id");

ALTER TABLE "outreach_recipient_orgs"
  DROP CONSTRAINT IF EXISTS "outreach_recipient_orgs_recipient_fkey";
ALTER TABLE "outreach_recipient_orgs"
  ADD CONSTRAINT "outreach_recipient_orgs_recipient_fkey"
  FOREIGN KEY ("business_id", "outreach_recipient_id")
  REFERENCES "outreach_recipients"("business_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "outreach_recipient_orgs"
  DROP CONSTRAINT IF EXISTS "outreach_recipient_orgs_customer_fkey";
ALTER TABLE "outreach_recipient_orgs"
  ADD CONSTRAINT "outreach_recipient_orgs_customer_fkey"
  FOREIGN KEY ("business_id", "customer_id")
  REFERENCES "customers"("business_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── marketing_preferences ────────────────────────────────────────────────────
-- Current preference state. History lives in email_suppression_events.
CREATE TABLE IF NOT EXISTS "marketing_preferences" (
  "id"                  TEXT NOT NULL,
  "business_id"         TEXT NOT NULL,
  "scope"               "MarketingPreferenceScope" NOT NULL,
  "contact_id"          TEXT,
  "normalized_email"    TEXT,
  "status"              "MarketingPreferenceStatus" NOT NULL,
  "reason"              TEXT,
  "effective_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effective_until"     TIMESTAMP(3),
  "source"              "PreferenceSource" NOT NULL DEFAULT 'tenant',
  "permission_note"     TEXT,
  "recorded_by_user_id" TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "marketing_preferences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "marketing_preferences_business_id_normalized_email_idx"
  ON "marketing_preferences" ("business_id", "normalized_email");
CREATE INDEX IF NOT EXISTS "marketing_preferences_business_id_contact_id_idx"
  ON "marketing_preferences" ("business_id", "contact_id");

-- Exactly one current preference per person, and one per address. Partial
-- because each scope uses a different column; not expressible as @@unique.
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_preferences_one_per_contact"
  ON "marketing_preferences" ("business_id", "contact_id")
  WHERE "scope" = 'contact' AND "contact_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_preferences_one_per_email"
  ON "marketing_preferences" ("business_id", "normalized_email")
  WHERE "scope" = 'email_address' AND "normalized_email" IS NOT NULL;

-- Each scope must actually carry its own subject.
ALTER TABLE "marketing_preferences"
  DROP CONSTRAINT IF EXISTS "marketing_preferences_scope_check";
ALTER TABLE "marketing_preferences"
  ADD CONSTRAINT "marketing_preferences_scope_check"
  CHECK (
    ("scope" = 'contact'       AND "contact_id"       IS NOT NULL) OR
    ("scope" = 'email_address' AND "normalized_email" IS NOT NULL)
  );

ALTER TABLE "marketing_preferences"
  DROP CONSTRAINT IF EXISTS "marketing_preferences_business_id_fkey";
ALTER TABLE "marketing_preferences"
  ADD CONSTRAINT "marketing_preferences_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "marketing_preferences"
  DROP CONSTRAINT IF EXISTS "marketing_preferences_contact_fkey";
ALTER TABLE "marketing_preferences"
  ADD CONSTRAINT "marketing_preferences_contact_fkey"
  FOREIGN KEY ("business_id", "contact_id")
  REFERENCES "fundraiser_contacts"("business_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── email_suppression_events ─────────────────────────────────────────────────
-- Append-only. No updated_at, and nothing in the application updates or
-- deletes these rows.
CREATE TABLE IF NOT EXISTS "email_suppression_events" (
  "id"                  TEXT NOT NULL,
  "business_id"         TEXT NOT NULL,
  "event_type"          "SuppressionEventType" NOT NULL,
  "contact_id"          TEXT,
  "normalized_email"    TEXT,
  "reason"              TEXT,
  "effective_until"     TIMESTAMP(3),
  "source"              "PreferenceSource" NOT NULL DEFAULT 'tenant',
  "permission_note"     TEXT,
  "recorded_by_user_id" TEXT,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_suppression_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "email_suppression_events_business_id_normalized_email_idx"
  ON "email_suppression_events" ("business_id", "normalized_email");
CREATE INDEX IF NOT EXISTS "email_suppression_events_business_id_contact_id_idx"
  ON "email_suppression_events" ("business_id", "contact_id");
CREATE INDEX IF NOT EXISTS "email_suppression_events_business_id_created_at_idx"
  ON "email_suppression_events" ("business_id", "created_at");

ALTER TABLE "email_suppression_events"
  DROP CONSTRAINT IF EXISTS "email_suppression_events_business_id_fkey";
ALTER TABLE "email_suppression_events"
  ADD CONSTRAINT "email_suppression_events_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
