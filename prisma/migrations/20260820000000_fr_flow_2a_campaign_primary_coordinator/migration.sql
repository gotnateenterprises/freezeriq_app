-- FR-FLOW-2A · Campaign primary coordinator
--
-- Additive only. One new table, one redundant-by-construction UNIQUE added to an
-- existing table purely so it can serve as a compound foreign-key target.
--
-- NOT TOUCHED by this migration: fundraiser_campaigns, fundraiser_contacts,
-- fundraiser_contact_points, customers, orders, invoices, campaign_bundles,
-- fundraiser_opportunities, fundraiser_inquiries. No column is added to, or
-- altered on, any existing table. No row is written, rewritten or deleted.
-- There is no backfill, and none is possible: a campaign that launched before
-- FR-FLOW-2 has no recorded coordinator, and inventing one would be a lie.

-- ── 1 · Compound FK target on the existing relationship table ────────────────
-- fundraiser_organization_contacts already has a PRIMARY KEY on (id), so (customer_id, id)
-- is unique for every row that exists or could ever exist. Adding this index
-- therefore CANNOT fail on live data and changes no semantics whatsoever. Its
-- only purpose is to give the coordinator table below something organization-safe
-- to point at — the same device fundraiser_campaigns_customer_id_id_key already
-- serves for fundraiser_opportunities.
CREATE UNIQUE INDEX IF NOT EXISTS "fundraiser_organization_contacts_customer_id_id_key"
  ON "fundraiser_organization_contacts" ("customer_id", "id");

-- ── 2 · The campaign's primary coordinator ───────────────────────────────────
-- campaign_id is the PRIMARY KEY. That is the whole of "exactly one primary
-- coordinator per campaign": a second row for a campaign is a key collision, not
-- a rule some writer has to remember. No is_primary boolean exists to contradict
-- it, and no partial index is needed to police one.
CREATE TABLE IF NOT EXISTS "fundraiser_campaign_coordinators" (
  "campaign_id"    TEXT NOT NULL,
  "customer_id"    TEXT NOT NULL,
  "org_contact_id" TEXT NOT NULL,
  "assigned_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fundraiser_campaign_coordinators_pkey" PRIMARY KEY ("campaign_id")
);

-- Required by Prisma on the defining side of the 1-1 relation. Implied by the
-- primary key above: a campaign has exactly one customer_id, so this pair cannot
-- be non-unique while campaign_id is unique. It adds no constraint in practice.
CREATE UNIQUE INDEX IF NOT EXISTS "fundraiser_campaign_coordinators_customer_id_campaign_id_key"
  ON "fundraiser_campaign_coordinators" ("customer_id", "campaign_id");

CREATE INDEX IF NOT EXISTS "fundraiser_campaign_coordinators_customer_id_org_contact_id_idx"
  ON "fundraiser_campaign_coordinators" ("customer_id", "org_contact_id");

-- ── 3 · Same-organization, enforced by Postgres rather than by remembering ───
-- Both foreign keys are keyed on the SAME customer_id column. The campaign must
-- belong to that organization; the coordinator relationship must belong to that
-- organization; therefore they belong to the same one. A cross-organization
-- assignment is not rejected at runtime — it cannot be written down. Tenant
-- isolation follows transitively, because fundraiser_organization_contacts is
-- already pinned to its tenant by its own compound keys onto
-- customers(business_id, id) and fundraiser_contacts(business_id, id).
--
-- RESTRICT on both edges, matching FR-RETENTION-1 and FR-FUNNEL-1: a campaign or
-- a relationship that a launched fundraiser points at must not be deletable out
-- from under the historical record.
ALTER TABLE "fundraiser_campaign_coordinators"
  ADD CONSTRAINT "fundraiser_campaign_coordinators_customer_id_campaign_id_fkey"
  FOREIGN KEY ("customer_id", "campaign_id")
  REFERENCES "fundraiser_campaigns"("customer_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fundraiser_campaign_coordinators"
  ADD CONSTRAINT "fundraiser_campaign_coordinators_customer_id_org_contact_fkey"
  FOREIGN KEY ("customer_id", "org_contact_id")
  REFERENCES "fundraiser_organization_contacts"("customer_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
