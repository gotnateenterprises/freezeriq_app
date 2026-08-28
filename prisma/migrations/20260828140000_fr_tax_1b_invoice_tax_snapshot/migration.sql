-- FR-TAX-1B — freeze the tax contract onto the invoice itself.
--
-- ADDITIVE ONLY, and deliberately NOT backfilled. Every existing invoice keeps
-- NULL in all three columns, including the five historical ones that charged
-- 1% of GROSS under the basis the owner has now superseded. NULL honestly
-- means "this invoice predates the frozen tax contract", which is a different
-- and more truthful fact than any value that could be invented for it. Those
-- invoices are historical records of what was actually billed and settled and
-- are never recalculated.
--
-- Why these live on the invoice rather than being read through to the campaign:
-- Square will eventually collect exactly invoices.total_amount and must never
-- recompute it, so the invoice has to be reproducible from its own row. And
-- without a stored rate, a $0.00 tax_amount cannot distinguish "tax exempt"
-- from "0% rate" from "the owner switched the tax off at closeout".

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "tax_rate_percent" DECIMAL(5,2);

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "tax_status" "OrgTaxStatus";

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "taxable_base_amount" DECIMAL(10,2);

-- A rate outside 0-100 is never a real tax rate. Mirrors
-- fundraiser_campaigns_tax_rate_percent_check.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'invoices_tax_rate_percent_check'
    ) THEN
        ALTER TABLE "invoices"
          ADD CONSTRAINT "invoices_tax_rate_percent_check"
          CHECK ("tax_rate_percent" IS NULL
                 OR ("tax_rate_percent" >= 0.00 AND "tax_rate_percent" <= 100.00));
    END IF;
END$$;
