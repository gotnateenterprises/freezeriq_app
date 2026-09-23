-- QB-INVOICE-CANCEL-1 — "Cancel invoice": the complete lifecycle schema the cancellation needs.
--
-- Scope, exactly:
--   · column  quickbooks_invoice_sends.void_requested_at   TIMESTAMP(3) NULL
--   · column  quickbooks_invoice_sends.void_requested_by   TEXT NULL
--   · column  quickbooks_invoice_sends.voided_at           TIMESTAMP(3) NULL
--   · column  quickbooks_invoice_sends.voided_by           TEXT NULL
--
-- ADDITIVE ONLY. Four nullable columns on one table; no enum value is added, no column is dropped or changed,
-- no constraint or index is touched, no default is set, nothing is backfilled, and no row is inserted, updated
-- or deleted. Existing code never reads them, so this migration is safe to apply BEFORE the code that writes
-- them is deployed (and MUST be: that code reads them on every settlement), and equally safe to leave in place
-- if the code is rolled back.
--
-- WHY TWO PAIRS.
--
-- `void_requested_at` / `void_requested_by` are the DURABLE INTENT: FreezerIQ's decision to void this invoice
-- in QuickBooks, committed BEFORE the irreversible QuickBooks write. From that moment no settlement may run —
-- not Record Payment, not the verified QuickBooks payment check — until the cancellation is reconciled. The
-- lease is still what orders two concurrent requests, but a lease EXPIRES; this does not. Without it, a process
-- that died between Intuit accepting the void and FreezerIQ recording it would leave an invoice that looks
-- ordinary again two minutes later, and a later payment could produce the one combination neither system can
-- explain: the QuickBooks invoice voided and the FreezerIQ invoice paid.
--
-- `voided_at` / `voided_by` are the OUTCOME: QuickBooks' own copy is void. That is irreversible, so it is
-- recorded whenever FreezerIQ can see it is true — including when the cancellation is otherwise refused.
--
-- Why columns rather than a new lifecycle status: `status` must keep saying `sent`, because the invoice WAS
-- sent and that history is part of the audit trail. Cancellation is a separate, later fact about the SAME
-- lifecycle, so it is recorded alongside the send, exactly as `sent_at`/`sent_by` record the send itself.
-- Nothing is overloaded: `problem` still means "stopped or waiting", and `needs_review` still means "a
-- read-back failed"; neither is used to carry a cancellation in progress.

ALTER TABLE "quickbooks_invoice_sends" ADD COLUMN IF NOT EXISTS "void_requested_at" TIMESTAMP(3);
ALTER TABLE "quickbooks_invoice_sends" ADD COLUMN IF NOT EXISTS "void_requested_by" TEXT;
ALTER TABLE "quickbooks_invoice_sends" ADD COLUMN IF NOT EXISTS "voided_at" TIMESTAMP(3);
ALTER TABLE "quickbooks_invoice_sends" ADD COLUMN IF NOT EXISTS "voided_by" TEXT;
