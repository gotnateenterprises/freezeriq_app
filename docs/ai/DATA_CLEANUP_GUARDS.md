# DATA-CLEANUP-GUARDS-1 — stop creating bad history

This phase changes no existing row. It closes the code paths that kept producing
false starts, stale $0.00 drafts and duplicate setup records, and teaches every
fundraiser count to recognize the false starts that already exist.

## Creation and lifecycle map

| What | Path | Classification |
|---|---|---|
| Campaign | `POST /api/opportunities/[id]/launch` (opportunity → date confirmed → launch) | CANONICAL — one campaign per opportunity (conditional claim; loser rolls back and returns the winner) |
| Campaign | `POST /api/campaigns` + rebooking `opportunityId` | VALID ALTERNATE — claims its RebookingOpportunity in the same transaction |
| Campaign | `POST /api/campaigns` from Start-a-Fundraiser (and the People page's New Campaign) | VALID ALTERNATE — refused while the organization has an OPEN FundraiserOpportunity, unless the tenant explicitly names that plan as separate |
| Campaign | `POST /api/fundraisers/upload` | LEGACY import — writes `Lead` rows, which are not campaigns |
| Campaign, invoice, customer | `lib/previewFixtures.ts` | TEST/SEED ONLY |
| Invoice | `POST /api/campaigns/[id]/closeout` | CANONICAL — one DRAFT, now only when something was sold |
| Invoice | `POST /api/tenant/invoices` | VALID ALTERNATE — ordinary invoices; never campaign-linked |
| Withdraw a $0.00 draft | `POST /api/tenant/invoices/[id]/cancel-draft` | CANONICAL — keeps the row as CANCELED |
| Withdraw a QuickBooks-sent invoice | QuickBooks cancel (QB-INVOICE-CANCEL-1) | CANONICAL — voids QuickBooks' copy first |
| Delete an invoice | `DELETE /api/tenant/invoices` | Restricted to an ordinary invoice entered by mistake |
| Delete a customer | `DELETE /api/customers/[id]` | Refused while it has invoices (they would cascade) |
| Organization during setup | `POST /api/customers` from the wizard | VALID ALTERNATE — once per wizard session |

## The rules

- **Zero-sale closeout** (`closeoutRequiresInvoice`): the campaign is still claimed
  and its $0.00 settlement frozen; no invoice is written, and the response says
  `invoice_required: false`. Any active order — even a $0.00 one — still gets
  its draft, because held orders are released only when that invoice is PAID.
- **Draft cancel** (`evaluateDraftCancel`): DRAFT only, $0.00 and no tax, never
  paid, no QuickBooks link or send lifecycle, no active order on its fundraiser.
  ADMIN or super-admin. A draft that bills money is never canceled: the
  one-invoice-per-campaign index covers CANCELED rows, so the fundraiser could
  never be invoiced again, and its debt would disappear from every work list.
- **Hard delete** (`evaluateHardDelete`): ADMIN or super-admin; never a
  fundraiser invoice; only PENDING or CANCELED; no QuickBooks record; no recorded
  payment; its kitchen order not yet started. Everything else is canceled instead.
- **Open planning cycle**: `POST /api/campaigns` reads the organization's open
  FundraiserOpportunity inside its creation transaction. Nothing is matched by
  campaign name or date.
- **Wizard retry** (`createWizardSubmission`): the organization the wizard created
  is reused by every later submit, and submits are single-flight.
- **Setup attempt** (`isFundraiserSetupAttempt`, the ONE shared rule): ordering
  over, a FROZEN $0.00 settlement, not settled externally, no order at all
  (canceled included), and only never-paid $0.00 DRAFT/CANCELED invoices. Absent
  evidence keeps a campaign counted. Setup attempts stay listed but are left out of
  Campaigns Run, Last Fundraiser, the month pattern and invoice follow-ups.

## Legacy paid history (DATA-CLEANUP-GUARDS-1A.1)

A PAID invoice with no campaign link and an organization share recorded
(`isLegacyPaidFundraiserInvoice`) is proof a fundraiser happened. When an
organization has no fundraiser by campaign rows but has such an invoice, the
dashboard says "Legacy fundraiser history on file" / "Historical paid fundraiser
activity is also on file." instead of "No fundraisers yet", and the empty Last
Fundraiser row reads "Legacy record". The invoice changes words only: it is never a
campaign, never counted in Campaigns Run, never dated into the month pattern, and
never added to Lifetime Fundraiser Sales (which remain campaign sales — widening
them is DATA-CLEANUP-1B legacy-history work). DRAFT, CANCELED, SENT, PENDING and
OVERDUE invoices, and PAID ones with no share, are not this evidence.

## Known boundaries

- A campaign archived without closeout (NULL settlement) is not provably a false
  start, so it keeps counting. Several test and legacy rows have that shape.
- A lost response to the wizard's organization create (the request reached the
  server, the answer never came back) cannot be told apart from a failure on the
  client. Closing it would need a client-supplied idempotency key.
- A direct wizard create that commits after a launch has already converted the
  organization's open plan is not refused, because no open plan remains.
- No canceled_at / canceled_by exists on Invoice. CANCELED plus `updated_at`
  record the fact; who canceled is not durably recorded.
