-- SUPPORTER-CONSENT-1 (owner-approved 2026-11-19): durable, per-organization supporter permission
-- for future fundraiser email and SMS, captured on a successfully placed supporter order.
-- One new append-only table and two enums. No existing table or column is changed.
-- Generated with `prisma migrate diff` from the previous schema; the two CHECK constraints at the
-- end are hand-written (Prisma cannot express them).

-- CreateEnum
CREATE TYPE "SupporterConsentChannel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "SupporterConsentAction" AS ENUM ('granted', 'revoked');

-- CreateTable
CREATE TABLE "supporter_contact_consents" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "order_id" TEXT,
    "supporter_customer_id" TEXT,
    "channel" "SupporterConsentChannel" NOT NULL,
    "action" "SupporterConsentAction" NOT NULL DEFAULT 'granted',
    "destination" TEXT NOT NULL,
    "consent_version" TEXT NOT NULL,
    "disclosure_text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supporter_contact_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supporter_contact_consents_lookup_idx" ON "supporter_contact_consents"("business_id", "customer_id", "channel", "destination", "created_at");

-- CreateIndex
CREATE INDEX "supporter_contact_consents_order_idx" ON "supporter_contact_consents"("order_id");

-- AddForeignKey
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_business_id_customer_id_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "fundraiser_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_supporter_customer_id_fkey" FOREIGN KEY ("supporter_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: each channel's destination has its normalized shape (a lowercase address with an
-- @, or a +1 North American mobile number), and the evidence columns are never empty.
ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_destination_check"
    CHECK (
        ("channel" = 'email' AND "destination" = lower("destination") AND position('@' in "destination") > 1)
        OR ("channel" = 'sms' AND "destination" ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
    );

ALTER TABLE "supporter_contact_consents" ADD CONSTRAINT "supporter_contact_consents_evidence_check"
    CHECK (length("consent_version") > 0 AND length("disclosure_text") > 0 AND length("source") > 0);
