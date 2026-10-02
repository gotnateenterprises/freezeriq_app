# Organization mini-dashboard (FR-ORG-DASHBOARD-1A)

The fundraiser organization page, `app/fundraisers/[id]/page.tsx`, is a read-mostly command
center for ONE organization: who they are, how much fundraiser business they have done, who
supported them, what happened last time, what is in progress, and what to open next. It is not
a second place to set up or edit a fundraiser. Setup lives in the Leads funnel
(`/fundraisers?tab=leads`); campaign work lives in the Campaign Context drawer
(`/fundraisers?campaign=<id>` opens it).

## Reads

| Read | Route | Notes |
|---|---|---|
| Editable profile | `GET /api/customers/[id]` | Unchanged. Also used by the People page. Returns only the five newest campaigns, so the dashboard never counts or lists campaigns from it. |
| Dashboard | `GET /api/customers/[id]/fundraiser-dashboard` | Read only. Tenant-scoped by `{ id, business_id: session }` before anything else is read. No `take` on campaigns. |

Loader: `lib/organizationDashboardData.ts` (rows) → builder: `lib/organizationDashboard.ts` (pure).

## Every figure has one authority

| Figure | Authority |
|---|---|
| Lifetime fundraiser sales, campaigns run | `computeOrganizationImpact` (`lib/growth/impact.ts`) — the Organizations tab's authority, fed the same rows in the same shape. A campaign contributes its frozen `settlement_total`, else its live non-canceled order gross. `Lead`-status rows are not campaigns. |
| One campaign's sales | `campaignLifetimeContribution` — so the history rows add up to the lifetime figure. |
| Supporters on file, email-ready | `derivePreviousSupporters` over `loadPreviousSupporterAudienceInputs` (`lib/previousSupporterAudience.ts`) with `excludeCampaignId: null`. The coordinator's Previous Supporters route calls the SAME loader with its own campaign excluded. |
| Lifecycle, invoice wording | `classifyCampaignLifecycle`, `describeCampaignInvoice` (`lib/growth/campaignLifecycle.ts`). |
| Stage chip | `campaignDisplayStage` (via `StageChip`). |
| Physical bundles | Closed: the invoice's frozen lines (`bundleSummaryFromInvoiceItems`). Otherwise: the non-canceled orders' own lines (`bundleSummaryFromSupporterOrders`). Never the weighted goal measure. |
| Bundle family names | Closed: frozen invoice line descriptions, else order line `item_name`. Running: the campaign's active selection (what is on offer now). Never today's catalog for closed history. |
| Discard eligibility | `evaluateDraftDiscard` (`lib/opportunityDraftDiscard.ts`). |

### Supporters and email-ready

A supporter is a distinct person across this organization's campaigns, keyed by normalized
email, else normalized phone, else the order itself — never by name. Canceled orders never
count, and an organization is never its own supporter (an organization-linked order reads the
frozen `Order.email`, never the organization's inbox). Email-ready means a usable address that no
email-address-scoped preference currently suppresses (`evaluateSuppression`: an unsubscribe, or a
pause / not-interested that has not elapsed). The exclusions are exactly `no_email`,
`invalid_email` and `unsubscribed`. Contact-scope preferences, shared-inbox handling and
needs-review belong to the seasonal contact audience, not to supporters, and are not applied.
Whether an invitation can be SENT also needs a campaign ordering page and the unsubscribe
secret; those are send-time capabilities of one campaign (`resolveSendCapability`), not
properties of a supporter.

### Timing

"Historical pattern" is inferred from each real campaign's delivery date, else order deadline,
else start date. It needs at least two dated fundraisers and a repeating month; it is labelled as
history and is never called a preference. No preferred-season field exists in the schema.

### Marketing activity

Only rows FreezerIQ wrote: seasonal lineup sends that reached an address representing the
organization (`EmailDeliveryAttempt`, test sends excluded), Previous Supporters invitations for
its campaigns, and rebooking responses (`RebookingSubmissionRevisionOrg`, newest revision per
thread). There is no email-provider webhook, so no delivered / opened / clicked state exists or
is shown. Emails sent through `POST /api/email/send` (the retired intro / info / marketing-packet
emails and custom emails) were never recorded and cannot appear.

## Discard Draft

`POST /api/opportunities/[id]/discard-draft` with `{ "confirm": true }`. Not a generic delete:
`mark_lost` still keeps every real prospect. A hard delete is allowed only for an opportunity that
is status `new`, has no inquiry (the public form always creates one in the same transaction, so
zero inquiries proves the tenant opened it), no response, no dates, no campaign, no disposition,
and no notes or participant estimate. The delete's own `WHERE` re-asserts every fact
(`draftDiscardWhere`); a concurrent inquiry is refused by the `fundraiser_inquiries` foreign key.
Nothing else references an opportunity.

## What the page no longer renders

The CustomerStatus stepper and Relationship Stage panel, the legacy Next Steps card and its
intro / info / marketing-packet emails, Create Campaign, the Campaign Details form
(`FundraiserSetup`), manual bundle menus, flyer and tracker previews and their Save Changes, the
per-campaign editor tab (`FundraisersTab`), and the header's global Save. `FundraiserOverview`,
`PipelineStepper` and `CampaignCard` are no longer referenced by any page but remain in the
repository; `FundraisersTab`, `StatusPipeline`, `FundraiserSetup`, `DocumentsTab` and
`EmailComposeModal` are still used by the People page.
