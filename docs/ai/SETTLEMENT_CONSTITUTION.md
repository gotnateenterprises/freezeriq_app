# FreezerIQ — Fundraiser Settlement + Production Batch Engine Constitution

**Version:** 1.0  
**Status:** DRAFT — Requires owner approval before implementation  
**Author:** Principal Systems Architect  
**Date:** 2026-05-03  
**Parent Documents:** CONSTITUTION.md, ARCHITECTURE.md, INTEGRATIONS.md, WORKFLOWS.md

---

## Governing Principle

> Fundraiser orders are **commitments**, not production work.  
> A commitment becomes production work only after the organization pays its settlement invoice.  
> Until that moment, the kitchen does not see it, the production engine does not count it, and the fulfillment pipeline does not schedule it.

---

# SECTION 1 — SYSTEM PURPOSE

## 1.1 What This System Is

The Fundraiser Settlement + Production Batch Engine (FSPBE) is a subsystem of FreezerIQ that governs the lifecycle of fundraiser orders from intake through settlement, payment, production release, and fulfillment. It sits between the Coordinator Panel (order intake) and the Production Pipeline (kitchen operations).

## 1.2 What Problems It Solves

| Problem | Without FSPBE | With FSPBE |
|---------|---------------|------------|
| Premature production | Kitchen sees fundraiser orders immediately, starts cooking before campaign ends | Kitchen sees nothing until settlement invoice is paid |
| No financial settlement | No invoice is generated; no mechanism to collect from the organization | Auto-generated settlement invoice with fundraiser percentage deducted |
| Individual order chaos | 47 individual orders from one school flood the production dashboard | One grouped production batch: "Lincoln Elementary — 47 bundles" |
| Revenue leakage | Orders enter production without confirmed payment | Payment-gated production release ensures no unpaid work |
| Accounting mismatch | No reconciliation between campaign sales, invoices, and production | Campaign total = invoice total = production batch total (always) |

## 1.3 Why Fundraiser Orders Are Operationally Different

**Storefront orders** follow a direct commerce model:
- Customer pays → order is created → order enters production immediately
- Payment happens BEFORE the order exists in production
- Each order is independent

**Fundraiser orders** follow a batch-commitment model:
- Coordinator enters orders over days/weeks during a campaign
- Orders accumulate as commitments — they represent future demand, not paid work
- The organization owes the tenant a settlement amount (total minus fundraiser percentage)
- Only after the organization pays does the batch of orders become production work
- All orders for one campaign are fulfilled as ONE production batch

**The fundamental difference:** Storefront orders are pre-paid and individual. Fundraiser orders are post-paid and batched.

## 1.4 Core Concepts

- **Commitment:** A fundraiser order that has been entered but not yet settled. Visible to the coordinator. Invisible to production.
- **Settlement:** The financial resolution of a completed campaign. The tenant generates an invoice for the organization, deducting the fundraiser percentage.
- **Settlement Invoice:** A single invoice that covers ALL orders from a campaign. Amount = campaign total sales minus fundraiser profit.
- **Production Release:** The moment a paid settlement invoice causes all campaign orders to become visible to the production pipeline as one grouped batch.
- **Production Batch:** The kitchen-facing view of a settled campaign — one entry per campaign showing aggregate bundle counts.

---

# SECTION 2 — CORE LIFECYCLE STATES

## 2.1 Campaign Settlement Lifecycle

```
CAMPAIGN_ACTIVE → CAMPAIGN_ENDED → INVOICE_GENERATED → AWAITING_PAYMENT → PAYMENT_CONFIRMED → PRODUCTION_RELEASED → FULFILLED → ARCHIVED
```

## 2.2 State Definitions

### State: CAMPAIGN_ACTIVE
- **Trigger:** Campaign start_date is reached OR campaign is manually activated
- **Allowed actions:** Coordinator enters orders, edits orders, cancels orders, views progress
- **Blocked actions:** Invoice generation, production release, settlement payment
- **Visibility:** Coordinator sees all orders + progress. Admin sees campaign in pipeline. Production sees NOTHING.
- **Exit condition:** Campaign end_date passes OR admin manually ends the campaign

### State: CAMPAIGN_ENDED
- **Trigger:** `end_date < today` (server-side check) OR admin manually ends campaign
- **Allowed actions:** Admin reviews orders, admin generates settlement invoice, coordinator views final summary
- **Blocked actions:** Coordinator adding new orders (UI gate already exists), coordinator editing orders, production release
- **Visibility:** Coordinator sees final summary (read-only). Admin sees campaign ready for settlement. Production sees NOTHING.
- **Exit condition:** Admin generates settlement invoice

### State: INVOICE_GENERATED
- **Trigger:** Admin clicks "Generate Settlement Invoice" OR auto-generation via scheduled job
- **Allowed actions:** Admin reviews invoice, admin sends payment link to coordinator, admin edits invoice (with recalculation), admin cancels invoice
- **Blocked actions:** Coordinator editing orders, production release, new order entry
- **Visibility:** Admin sees invoice details. Coordinator sees "Invoice Pending" status. Production sees NOTHING.
- **Exit condition:** Payment is initiated (transitions to AWAITING_PAYMENT) OR admin cancels invoice (reverts to CAMPAIGN_ENDED)
- **LOCK BEHAVIOR:** Order quantities and totals FREEZE when invoice is generated. See Section 7.

### State: AWAITING_PAYMENT
- **Trigger:** Payment link sent to coordinator OR coordinator initiates payment
- **Allowed actions:** Coordinator pays via tenant's Stripe/Square, admin marks as "paid manually" (cash/check), admin cancels invoice
- **Blocked actions:** Order editing, production release
- **Visibility:** Admin sees "Awaiting Payment." Coordinator sees payment link/instructions. Production sees NOTHING.
- **Exit condition:** Payment confirmed (webhook or manual) OR admin cancels

### State: PAYMENT_CONFIRMED
- **Trigger:** Webhook confirms electronic payment OR admin marks manual payment
- **Allowed actions:** System auto-promotes all campaign orders to production_ready. Admin reviews.
- **Blocked actions:** Order editing, order cancellation, invoice modification
- **Visibility:** Admin sees "Settlement Paid." Coordinator sees "Paid — Preparing Your Order." Production sees the batch.
- **Exit condition:** Automatic — transitions immediately to PRODUCTION_RELEASED
- **Duration:** Transient state (seconds). Exists for audit trail only.

### State: PRODUCTION_RELEASED
- **Trigger:** Automatic upon PAYMENT_CONFIRMED
- **Allowed actions:** Kitchen views grouped batch, admin manages production, admin marks items as in-production/completed
- **Blocked actions:** Order editing, invoice modification, payment reversal (disputes handled separately)
- **Visibility:** Production sees ONE grouped batch per campaign. Admin sees production status. Coordinator sees "In Production."
- **Exit condition:** All orders in the batch are marked completed/delivered

### State: FULFILLED
- **Trigger:** All orders in the campaign batch are delivered/picked up
- **Allowed actions:** Admin archives campaign, admin generates reports
- **Blocked actions:** All mutations
- **Visibility:** Admin sees completed campaign. Coordinator sees "Complete."
- **Exit condition:** Admin archives

### State: ARCHIVED
- **Trigger:** Admin archives the campaign
- **Allowed actions:** View-only access for reporting
- **Blocked actions:** All mutations
- **Visibility:** Accessible via archive/history view only

---

# SECTION 3 — ORDER VISIBILITY RULES

## 3.1 Visibility Matrix

| Actor | CAMPAIGN_ACTIVE | CAMPAIGN_ENDED | INVOICE_GENERATED | AWAITING_PAYMENT | PAYMENT_CONFIRMED | PRODUCTION_RELEASED |
|-------|----------------|----------------|--------------------|--------------------|---------------------|----------------------|
| Coordinator | ✅ Full (add/edit/cancel) | ✅ Read-only summary | ✅ Invoice status | ✅ Payment link | ✅ "Preparing" | ✅ "In Production" |
| Tenant Admin | ✅ Full + campaign pipeline | ✅ Settlement-ready flag | ✅ Invoice details | ✅ Payment tracking | ✅ Auto-release log | ✅ Production view |
| Production/Kitchen | ❌ INVISIBLE | ❌ INVISIBLE | ❌ INVISIBLE | ❌ INVISIBLE | ❌ INVISIBLE* | ✅ Grouped batch |
| Supporters/Customers | ✅ Fundraiser storefront | ❌ Campaign closed | ❌ No visibility | ❌ No visibility | ❌ No visibility | ❌ No visibility |

*Production sees orders only AFTER the system batch-promotes them to `production_ready`. PAYMENT_CONFIRMED is a transient state.

## 3.2 The Cardinal Rule

> **Production MUST NOT see fundraiser orders before settlement payment is confirmed.**

This is enforced by:
1. Fundraiser orders are created with `status: fundraiser_hold` (not `pending`)
2. `fundraiser_hold` is excluded from ALL production queries
3. Only the settlement payment webhook/manual-pay handler can transition `fundraiser_hold` → `production_ready`
4. No admin override exists for this rule (admin can only mark payment as received, which triggers the same promotion)

## 3.3 Production Query Guard

Every production-facing query MUST include:
```
WHERE status NOT IN ('fundraiser_hold')
-- OR equivalently:
WHERE status IN ('production_ready', 'APPROVED', 'IN_PRODUCTION', ...)
```

Affected queries:
- `PrismaAdapter.getProductionOrders()`
- `Production Dashboard API (GET /api/production/dashboard)`
- `Production Runs API (POST /api/production/runs)`
- Any future production-facing endpoint

---

# SECTION 4 — SETTLEMENT RULES

## 4.1 Settlement Total Calculation

```
settlement_amount = campaign_total_sales - fundraiser_profit_amount
fundraiser_profit_amount = campaign_total_sales × (fundraiser_profit_percent / 100)
```

**Source data:**
- `campaign_total_sales` = SUM of all non-canceled order `total_amount` values for the campaign
- `fundraiser_profit_percent` = stored on the Invoice (copied from campaign configuration at generation time)

## 4.2 Fundraiser Percentage — Source of Truth

**Decision: Per-campaign configurable with a tenant-level default.**

- **Tenant default:** 20% (stored as a system setting or tenant config)
- **Campaign override:** The `FundraiserCampaign` model will store a `profit_percent` field (Decimal, default 20.00)
- **Invoice snapshot:** When the settlement invoice is generated, the percentage is COPIED to `Invoice.fundraiser_profit_percent` and FROZEN. Subsequent changes to the campaign's percentage do NOT retroactively change the invoice.

**Rationale:** Different organizations may negotiate different rates. A school doing $10K in sales may negotiate 25%. The default handles the common case.

## 4.3 Invoice Locking Behavior

**Rule: Once a settlement invoice is generated, the underlying orders are FROZEN.**

- No new orders can be added to the campaign
- No existing orders can be edited or canceled
- The invoice total is computed once at generation time
- If the admin needs to change the invoice, they must CANCEL the invoice (returning to CAMPAIGN_ENDED state), make order adjustments, then re-generate

**Why:** A settlement invoice is a financial commitment. If orders change after the invoice is generated, the amounts drift. The lock-then-regenerate pattern prevents silent discrepancies.

## 4.4 Recalculation Rules

Recalculation occurs ONLY when:
1. Admin cancels an existing settlement invoice
2. Campaign returns to CAMPAIGN_ENDED state
3. Admin adjusts orders (cancel, modify quantities)
4. Admin re-generates a new settlement invoice

The new invoice is a fresh calculation from current order state. The canceled invoice is retained in the database with `status: CANCELED` for audit trail.

## 4.5 Tax and Shipping Handling

- **Tax:** Fundraiser orders in the current system do not charge tax (fundraiser pages have no tax calculation). Settlement invoices inherit this — `tax_amount = 0` unless the tenant explicitly enables fundraiser tax.
- **Shipping/Delivery:** Fundraiser orders use pickup (coordinator pickup from tenant location). Delivery fees are $0 for fundraiser campaigns. If a tenant enables delivery for fundraisers in the future, delivery fees would be included in order totals and thus in the settlement amount.

## 4.6 Cancellation Handling

| Scenario | Allowed? | Effect |
|----------|----------|--------|
| Cancel order during CAMPAIGN_ACTIVE | ✅ Yes (coordinator) | Order soft-deleted (`canceled_at` set), excluded from settlement calculation |
| Cancel order during CAMPAIGN_ENDED | ✅ Yes (admin only) | Same as above |
| Cancel order after INVOICE_GENERATED | ❌ No | Must cancel invoice first, then cancel order, then re-generate |
| Cancel entire campaign | ✅ Yes (admin only) | All orders canceled, no invoice generated, campaign archived |
| Cancel settlement invoice | ✅ Yes (admin only) | Invoice status → CANCELED, campaign reverts to CAMPAIGN_ENDED |

## 4.7 Refund Implications

If a settlement invoice has been PAID and production has started:
- Individual order refunds are NOT supported through the settlement system
- The tenant handles refunds directly with the coordinator outside the platform
- If a full settlement refund is needed, admin must process it through the payment provider's dashboard
- The system records the refund event but does NOT automatically reverse production status

---

# SECTION 5 — PAYMENT ARCHITECTURE

## 5.1 Domain Classification

> **Settlement payments are TENANT COMMERCE per Constitution §9.**

Settlement payments flow FROM the coordinator (organization) TO the tenant business. They use the tenant's connected payment provider credentials — never the platform's Stripe account.

| Payment Type | Domain | Credentials | Webhook Path |
|-------------|--------|-------------|--------------|
| Platform SaaS subscription | Platform Billing | `STRIPE_SECRET_KEY` (platform) | `/api/webhooks/stripe` |
| Storefront customer checkout | Tenant Commerce | Tenant's Stripe Connect / Square OAuth | `/api/webhooks/stripe` or `/api/webhooks/square` |
| **Settlement invoice payment** | **Tenant Commerce** | **Tenant's Stripe Connect / Square OAuth** | **Existing webhook paths with new handler** |

## 5.2 Provider Resolution

Settlement payment uses the same provider resolution as storefront checkout:

1. Look up `StorefrontConfig.payment_provider` for the tenant
2. Resolve to `StripePaymentProvider` or `SquarePaymentProvider`
3. Use tenant's stored credentials from `Integration` table

The existing `getPaymentProvider(businessId)` function in `lib/payments/index.ts` is reused without modification.

## 5.3 Stripe Settlement Flow

1. Admin generates settlement invoice → system creates Stripe Checkout Session with `mode: 'payment'`
2. Checkout Session metadata includes: `{ type: 'settlement', invoiceId, campaignId, businessId }`
3. Payment link is emailed to coordinator via Resend
4. Coordinator clicks link → Stripe hosted checkout
5. Payment completes → `checkout.session.completed` webhook fires
6. Webhook handler checks `metadata.type === 'settlement'` → routes to settlement handler
7. Settlement handler: invoice → PAID, all campaign orders → `production_ready`

**Key:** The existing `/api/webhooks/stripe` route gains a new routing branch for `type === 'settlement'` in the `handleCheckoutCompleted` function. No new webhook endpoint needed.

## 5.4 Square Settlement Flow

1. Admin generates settlement invoice → system creates Square Payment Link via Square Checkout API
2. Payment link metadata includes invoice/campaign references
3. Link emailed to coordinator
4. Coordinator pays → `payment.completed` webhook fires
5. Webhook handler matches via `reference_id` pattern (prefixed with `settlement_` to distinguish from storefront orders)
6. Settlement handler promotes invoice and orders

**Key:** The existing `/api/webhooks/square` route gains a new routing branch in `handlePaymentCompleted` based on `reference_id` prefix.

## 5.5 Manual Payment (Cash/Check)

For coordinators who pay by check or cash:

1. Admin marks settlement invoice as "Paid — Manual" from the admin dashboard
2. Admin selects payment method: `check`, `cash`, `other`
3. System records `payment_method` on the invoice
4. System executes the SAME batch promotion logic as the webhook path
5. All campaign orders → `production_ready`

**Rule:** Manual payment triggers identical production release logic. There is no "partial manual" — it's all or nothing.

## 5.6 Payment Failure and Retry

| Scenario | Handling |
|----------|----------|
| Coordinator abandons checkout | Invoice stays in AWAITING_PAYMENT. Payment link remains valid. Admin can resend. |
| Payment declined | Coordinator sees Stripe/Square error. Invoice stays in AWAITING_PAYMENT. Coordinator retries. |
| Webhook delivery failure | Stripe/Square retry automatically (up to 72 hours). System is idempotent. |
| Duplicate webhook | Idempotency guard: if invoice is already PAID, skip silently. |
| Partial payment | Not supported. Stripe/Square Checkout enforces full amount. |

## 5.7 Provider Disconnection

If a tenant disconnects their Stripe or Square account mid-campaign:
- Existing settlement invoices in AWAITING_PAYMENT cannot be paid electronically
- Admin must reconnect the provider OR use manual payment
- The system does NOT auto-cancel settlement invoices on provider disconnect
- Settlement invoice generation is blocked if no active provider is connected (unless manual payment is explicitly selected)

---

# SECTION 6 — PRODUCTION BATCH ARCHITECTURE

## 6.1 Batch Formation

When a settlement invoice is paid, ALL non-canceled orders for that campaign are promoted to `production_ready` simultaneously. These orders share a `campaign_id` and constitute one production batch.

**There is no separate `ProductionBatch` model.** The batch is defined by the query:
```
Orders WHERE campaign_id = X AND status = 'production_ready'
```

**Rationale:** Adding a new `ProductionBatch` model introduces schema complexity without operational benefit. The `campaign_id` on each order already provides the grouping key. The production dashboard aggregates by `campaign_id` at query time.

## 6.2 Kitchen Visibility

The production dashboard displays settled fundraiser batches as ONE grouped entry:

```
┌─────────────────────────────────────────────────┐
│ 🏫 Washington PTO — Spring Fundraiser 2026      │
│ Campaign settled: May 3, 2026                   │
│ Pickup: May 10, 2026                            │
│─────────────────────────────────────────────────│
│ 52× Family Lasagna (serves 5)                   │
│ 31× Chicken Alfredo (serves 5)                  │
│ 18× Taco Bake (serves 5)                        │
│ 12× Family Lasagna (serves 2)                   │
│─────────────────────────────────────────────────│
│ Total: 113 items (89.0 weighted bundle units)    │
│ [View Individual Orders]  [Start Production]     │
└─────────────────────────────────────────────────┘
```

**Aggregation logic:**
- Group orders by `campaign_id`
- Within the group, aggregate `OrderItem` rows by `(bundle_id, variant_size)`
- Sum quantities per bundle/variant combination
- Display campaign name (from `FundraiserCampaign.name`) and customer name (organization)

**Individual order drill-down:** Available via "View Individual Orders" — shows per-supporter breakdown for pickup sheet generation. This is an admin/kitchen tool, not the default view.

## 6.3 Batch Labeling

Each production batch label includes:
- Organization name (Customer.name)
- Campaign name (FundraiserCampaign.name)
- Settlement date
- Pickup/delivery date (from campaign.delivery_date)
- Total bundle count
- Batch reference: `FSPBE-{campaignId-short}-{date}`

## 6.4 Delivery/Pickup Workflow

Fundraiser campaigns use **coordinator pickup** as the default:
- The coordinator picks up ALL items for the organization
- Individual supporters pick up from the coordinator (at the school, church, etc.)
- The tenant does NOT deliver to individual supporters

The production batch shows ONE pickup entry:
```
Pickup: Lincoln Elementary (Coordinator: Sarah Johnson)
Date: May 10, 2026
Location: [tenant location] OR [campaign.pickup_location]
```

## 6.5 Production Release Timing

- Settlement payment confirmation triggers IMMEDIATE production release
- There is no scheduled delay between payment and production visibility
- The admin may manually hold production by changing order status to `APPROVED` (existing workflow)
- The KitchenEngine processes settled batches the same as any `production_ready` orders — the grouping is a UI/dashboard concern, not an engine concern

---

# SECTION 7 — LOCKING & MUTATION RULES

## 7.1 Mutation Permission Matrix

| Action | CAMPAIGN_ACTIVE | CAMPAIGN_ENDED | INVOICE_GENERATED | AWAITING_PAYMENT | PAYMENT_CONFIRMED+ |
|--------|----------------|----------------|--------------------|--------------------|--------------------|
| Coordinator: Add order | ✅ | ❌ | ❌ | ❌ | ❌ |
| Coordinator: Edit order qty | ✅ | ❌ | ❌ | ❌ | ❌ |
| Coordinator: Cancel order | ✅ | ❌ | ❌ | ❌ | ❌ |
| Admin: Edit order | ✅ | ✅ | ❌ | ❌ | ❌ |
| Admin: Cancel order | ✅ | ✅ | ❌* | ❌* | ❌ |
| Admin: Generate invoice | ❌ | ✅ | ❌ | ❌ | ❌ |
| Admin: Cancel invoice | ❌ | ❌ | ✅ | ✅ | ❌ |
| Admin: Mark manual payment | ❌ | ❌ | ❌ | ✅ | ❌ |
| Admin: End campaign early | ✅ | ❌ | ❌ | ❌ | ❌ |

*Admin can cancel an order after INVOICE_GENERATED only by first canceling the invoice.

## 7.2 The Freeze Point

**Orders freeze when the settlement invoice is generated.** This is the single most important mutation rule.

Before freeze:
- Coordinator and admin can freely add, edit, and cancel orders
- Campaign total_sales is recalculated on every order mutation

After freeze:
- All orders are locked — no quantity changes, no cancellations
- The invoice total is the source of truth
- To modify, admin must: cancel invoice → make changes → re-generate invoice

## 7.3 Post-Payment Immutability

After settlement payment is confirmed, the entire campaign is **permanently immutable**:
- No order edits
- No order cancellations
- No invoice modifications
- No settlement amount changes

**Exception:** Admin can add notes/metadata to orders for operational purposes (e.g., "substituted chicken for beef per coordinator request"). This does not change financial data.

## 7.4 Admin Override Powers

Admins have exactly TWO override powers in the settlement lifecycle:

1. **Cancel settlement invoice** (before payment) — Returns campaign to CAMPAIGN_ENDED state, unlocking orders for modification
2. **Mark manual payment** — Manually confirms settlement as paid, triggering production release

Admins do NOT have power to:
- Force production release without payment
- Bypass the settlement invoice step
- Edit orders after payment confirmation
- Partially release orders from a campaign

---

# SECTION 8 — FAILURE & EDGE CASES

## 8.1 Partial Payment
**Not possible.** Stripe Checkout and Square Checkout enforce full payment. Manual payment is binary (paid/not paid). There is no partial settlement.

## 8.2 Failed Payment
Invoice remains in AWAITING_PAYMENT. Payment link remains valid for retry. Admin can resend the link. No state change occurs on failure.

## 8.3 Disputes / Chargebacks
If the coordinator disputes the settlement payment after it's confirmed:
- Production may already be in progress or complete
- The system does NOT auto-reverse production status
- Admin is notified via webhook (Stripe `charge.dispute.created` / Square equivalent)
- Resolution is handled outside the platform (tenant contacts coordinator directly)
- If chargeback succeeds, the tenant absorbs the loss — this is a business risk, not a system problem

## 8.4 Coordinator Abandonment
If the coordinator never pays the settlement invoice:
- Invoice remains in AWAITING_PAYMENT indefinitely
- Admin can set a due_date on the invoice
- Admin can send reminder emails manually
- After a configurable period, admin can cancel the invoice and archive the campaign
- Unpaid campaigns do NOT enter production — the gate holds

## 8.5 No end_date on Campaign
If a campaign has no end_date:
- Auto-settlement (cron) is impossible — cron only checks campaigns with an end_date
- Admin must manually end the campaign and generate the settlement invoice
- The coordinator UI shows no countdown and no "complete" phase
- This is an operational choice, not a bug

## 8.6 Multiple Simultaneous Campaigns
A single organization (Customer) can have multiple active campaigns:
- Each campaign has its own settlement lifecycle
- Settlement invoices are per-campaign, NOT per-organization
- Production batches are per-campaign
- There is no cross-campaign aggregation

## 8.7 Provider Disconnect Mid-Campaign
If the tenant disconnects their Stripe/Square during a campaign:
- Orders continue to be entered (coordinator panel doesn't use the payment provider)
- Settlement invoice CAN be generated (it's just a database record)
- Electronic payment link CANNOT be generated (no provider)
- Admin must either reconnect the provider OR use manual payment
- Error message: "Payment provider not connected. Reconnect or use manual payment."

## 8.8 Duplicate Invoice Generation
**Prevented by constraint:** Only ONE non-canceled settlement invoice can exist per campaign.
- Before generating, the system checks: `Invoice WHERE campaign_id = X AND status != CANCELED`
- If one exists, the generation is blocked with: "A settlement invoice already exists for this campaign."
- Admin must cancel the existing invoice before generating a new one

## 8.9 Settlement Mismatch
If `SUM(order.total_amount)` for a campaign doesn't match `campaign.total_sales`:
- This is a data integrity issue that should be detected at invoice generation time
- The system uses `SUM(order.total_amount)` as the source of truth (not `campaign.total_sales`)
- A warning is logged if the values differ by more than $0.01
- The invoice is generated from the order-level data, not the campaign-level cached total

## 8.10 Production Release Failure
If the batch promotion query (`UPDATE orders SET status = 'production_ready' WHERE campaign_id = X AND status = 'fundraiser_hold'`) fails:
- The settlement payment is already confirmed — the money is received
- The system retries the promotion in the same transaction
- If the transaction fails, the invoice is marked as PAID but orders remain in `fundraiser_hold`
- An error alert is sent to the admin
- Admin can trigger a manual "Release to Production" action that retries the promotion

## 8.11 Manual Override Safety
Admin manual actions are logged in `CoordinatorActionEvent` (or a new admin audit log):
- Manual payment marking records: who, when, method, amount
- Invoice cancellation records: who, when, reason
- Campaign end records: who, when

---

# SECTION 9 — DATA MODEL STRATEGY

## 9.1 The Central Question: `fundraiser_hold` vs Separate `production_state`

### Option A: Add `fundraiser_hold` to OrderStatus enum

```
enum OrderStatus {
  fundraiser_hold    // NEW — fundraiser commitment, invisible to production
  pending
  production_ready
  completed
  delivered
  ...existing values
}
```

**Pros:**
- Simple — one field controls visibility
- Existing production queries already filter by status
- Minimal schema change

**Cons:**
- OrderStatus enum already has semantic duplication (lowercase + uppercase variants)
- Mixing "business state" (fundraiser_hold) with "operational state" (production_ready) in one field
- Future order types may need their own hold states, polluting the enum

### Option B: Separate `production_state` field

```
model Order {
  status           OrderStatus    // Business state (pending, completed, delivered)
  production_state String?        // "held" | "released" | null (non-fundraiser orders)
}
```

**Pros:**
- Clean separation of concerns
- OrderStatus enum stays purely operational
- Production queries filter on `production_state != 'held'`
- Extensible for future hold reasons (quality hold, inventory hold, etc.)

**Cons:**
- Two fields to maintain
- Risk of inconsistency between status and production_state
- More complex queries

### RECOMMENDATION: Option A (`fundraiser_hold` in OrderStatus)

**Rationale:**
- The existing OrderStatus enum already mixes concerns (it has both `pending` and `PENDING`, both `completed` and `COMPLETED`)
- Adding one more value is low risk and the enum cleanup is a separate concern
- Production queries already filter by status — no query pattern changes needed
- A separate `production_state` field introduces state synchronization complexity that is not justified by current requirements
- If the enum needs cleanup in the future, the cleanup migration can address all values at once

## 9.2 Required Schema Changes

### OrderStatus Enum
```diff
 enum OrderStatus {
+  fundraiser_hold  @map("fundraiser_hold")
   pending          @map("pending")
   production_ready @map("production_ready")
   completed        @map("completed")
   delivered        @map("delivered")
   PENDING
   APPROVED
   IN_PRODUCTION
   COMPLETED
   DELIVERED
 }
```

### Order Model
```diff
 model Order {
-  invoice_id        String?             @unique
+  invoice_id        String?
   // ... all other fields unchanged
 }
```

**Critical:** Remove `@unique` from `invoice_id` to enable many-orders-to-one-invoice.

### FundraiserCampaign Model
```diff
 model FundraiserCampaign {
   // ... existing fields
+  profit_percent         Decimal?    @default(20.00) @db.Decimal(5, 2)
+  settlement_invoice_id  String?     @unique
+  settlement_status      String?     @default("pending")  // pending | invoiced | paid | canceled
+  settled_at             DateTime?
 }
```

### Invoice Model
```diff
 model Invoice {
   // ... existing fields
+  campaign_id     String?
+  invoice_type    String     @default("manual")    // "manual" | "settlement"
-  order           Order?
+  orders          Order[]
+  campaign        FundraiserCampaign? @relation(fields: [campaign_id], references: [id])
 }
```

### InvoiceStatus Enum — No Changes
The existing `PENDING | PAID | OVERDUE | CANCELED` covers all settlement states.

## 9.3 Migration Safety

1. Add `fundraiser_hold` to enum FIRST (additive — no data change)
2. Migrate existing fundraiser orders: `UPDATE orders SET status = 'fundraiser_hold' WHERE source = 'fundraiser' AND status = 'pending'` — but ONLY for orders whose campaign has NOT been fulfilled yet
3. Remove `@unique` from `Order.invoice_id` — requires dropping and re-creating the constraint
4. Add new fields to `FundraiserCampaign` and `Invoice` — all nullable with defaults, safe
5. Backfill `Invoice.invoice_type = 'manual'` for all existing invoices

---

# SECTION 10 — ZERO-DRIFT IMPLEMENTATION STRATEGY

## Phase A: Schema Foundation (Approval Required)

**Scope:** Database only. No application logic changes.

1. Add `fundraiser_hold` to `OrderStatus` enum
2. Add `profit_percent`, `settlement_invoice_id`, `settlement_status`, `settled_at` to `FundraiserCampaign`
3. Add `campaign_id`, `invoice_type` to `Invoice`
4. Remove `@unique` from `Order.invoice_id`
5. Add `Invoice.orders` relation (replaces `Invoice.order`)
6. Run migration
7. Backfill: existing invoices get `invoice_type = 'manual'`

**Validation:** `npx prisma generate` succeeds. Existing app builds. No runtime behavior change.

**Risk:** LOW — all changes are additive or constraint relaxation. No existing data is modified.

## Phase B: Order Intake Fix

**Scope:** Coordinator order creation only.

1. Change coordinator POST (`/api/coordinator/[token]`) to create orders with `status: 'fundraiser_hold'` instead of `pending`
2. Update `PrismaAdapter.getProductionOrders()` to exclude `fundraiser_hold`
3. Update Production Dashboard API to exclude `fundraiser_hold`
4. Update `PrismaAdapter.getOrders()` to include `fundraiser_hold` in the orders list (admin visibility)

**Validation:** Create a test fundraiser order → confirm it does NOT appear in production dashboard → confirm it DOES appear in coordinator panel and admin orders.

**Risk:** LOW — changes one status value at creation time and adds exclusion filters.

## Phase C: Settlement Invoice Generation

**Scope:** New API route + settlement calculation logic.

1. Create `lib/settlement.ts` — pure calculation functions
2. Create `POST /api/settlement/generate` — auth-gated to tenant admin
3. Logic: collect all non-canceled orders for campaign → calculate settlement total → create Invoice with `invoice_type: 'settlement'` → link all orders → set `campaign.settlement_status = 'invoiced'`
4. Create `POST /api/settlement/[invoiceId]/cancel` — cancels invoice, reverts campaign to `settlement_status: 'pending'`, unlocks orders

**Validation:** Generate settlement invoice for test campaign → verify invoice total matches order sum minus percentage → verify orders are frozen (edit API rejects changes).

**Risk:** MEDIUM — new financial calculation logic. Requires thorough arithmetic validation.

## Phase D: Payment Collection

**Scope:** Extend payment abstraction + webhook handling.

1. Add `createPaymentLink(req: PaymentLinkRequest)` to `PaymentProvider` interface
2. Implement for Stripe (Checkout Session with `mode: 'payment'`)
3. Implement for Square (Square Checkout API / Payment Link)
4. Create `POST /api/settlement/[invoiceId]/pay` — generates payment link, emails to coordinator
5. Add settlement routing branch to existing webhook handlers
6. Add `POST /api/settlement/[invoiceId]/mark-paid` — admin manual payment

**Validation:** End-to-end: generate invoice → create payment link → simulate webhook → verify all campaign orders promoted to `production_ready`.

**Risk:** HIGH — touches payment provider abstraction, webhook routing, and tenant commerce. Requires test mode validation with real Stripe/Square sandbox.

## Phase E: Production Batch Grouping

**Scope:** Production dashboard UI changes.

1. Update Production Dashboard API to group `production_ready` orders by `campaign_id`
2. Return campaign metadata (name, organization, pickup date) with grouped batches
3. Update dashboard UI to render grouped fundraiser batches as single entries
4. Add drill-down to view individual orders within a batch

**Validation:** Settle a test campaign → verify production dashboard shows one grouped entry → verify drill-down shows individual orders.

**Risk:** LOW — UI/query change only. No financial or state logic.

## Phase F: Campaign-End Automation (Optional)

**Scope:** Scheduled job for auto-settlement.

1. Create a Vercel Cron function or API route that runs daily
2. Query: campaigns WHERE `end_date < today` AND `settlement_status = 'pending'`
3. Auto-generate settlement invoice for each matched campaign
4. Send notification to admin (not auto-send payment link — admin reviews first)

**Validation:** Set a test campaign end_date to yesterday → run cron → verify invoice is generated.

**Risk:** LOW — additive automation. Does not change any existing behavior. Can be deferred.

---

# SECTION 11 — NON-NEGOTIABLE RULES

These are the hard operational laws of the Fundraiser Settlement + Production Batch Engine. Violation of any rule is a system defect.

### Rule 1: Production Invisibility
Production MUST NOT see fundraiser orders before settlement payment is confirmed. No exceptions. No admin override.

### Rule 2: Tenant Commerce Domain
Settlement payments ALWAYS use the tenant's connected payment provider (Stripe Connect or Square OAuth). NEVER the platform Stripe account. Per Constitution §9.

### Rule 3: Settlement Gate
No fundraiser order may transition to `production_ready` without a corresponding PAID settlement invoice. The transition path is: `fundraiser_hold` → (invoice paid) → `production_ready`. There is no shortcut.

### Rule 4: Invoice-Order Reconciliation
The settlement invoice total MUST equal `SUM(non-canceled order totals) × (1 - fundraiser_profit_percent/100)`. If these values diverge, the invoice is invalid.

### Rule 5: Batch Atomicity
When a settlement invoice is paid, ALL non-canceled orders for that campaign are promoted to `production_ready` in a SINGLE database transaction. Partial promotion is not allowed.

### Rule 6: Invoice Uniqueness
At most ONE non-canceled settlement invoice may exist per campaign at any time. Duplicate generation is blocked at the application layer.

### Rule 7: Freeze-on-Invoice
Order mutations (add, edit, cancel) are blocked from the moment a settlement invoice is generated until the invoice is canceled. The invoice locks the order set.

### Rule 8: Post-Payment Immutability
After settlement payment is confirmed, the campaign's orders, invoice, and financial data are permanently immutable. No edits, no cancellations, no recalculations.

### Rule 9: Percentage Snapshot
The fundraiser profit percentage is copied from the campaign to the invoice at generation time and FROZEN. Subsequent changes to the campaign's percentage do not retroactively affect the invoice.

### Rule 10: Source of Truth
The settlement amount is calculated from `SUM(Order.total_amount)`, NOT from `FundraiserCampaign.total_sales`. The campaign's `total_sales` is a cached display value. The orders are the financial source of truth.

### Rule 11: Single Pickup Entity
Production sees ONE pickup/delivery entry per campaign batch — the coordinator. Individual supporter names appear only in drill-down views and pickup sheets. The coordinator is the fulfillment counterparty.

### Rule 12: Status Integrity
The `FundraiserCampaign.settlement_status` field MUST stay synchronized with the settlement invoice status. `pending` ↔ no invoice. `invoiced` ↔ invoice exists (PENDING). `paid` ↔ invoice PAID. `canceled` ↔ invoice CANCELED and campaign abandoned.

### Rule 13: Idempotent Webhooks
Settlement payment webhook handlers MUST be idempotent. Receiving the same payment confirmation twice must NOT create duplicate production releases or invoice state changes.

### Rule 14: Audit Trail
Every settlement lifecycle transition (invoice generated, invoice canceled, payment confirmed, manual payment marked, production released) MUST be logged with actor, timestamp, and action type.

### Rule 15: Provider Agnostic
The settlement engine MUST work identically for Stripe and Square tenants. Provider-specific logic is encapsulated in the `PaymentProvider` implementations. Settlement logic never references a specific provider.

### Rule 16: No Silent Failures
If the batch promotion query fails after payment confirmation, the system MUST alert the admin and provide a manual "Release to Production" action. Orders must not remain in `fundraiser_hold` with a PAID invoice without notification.

### Rule 17: Backward Compatibility
Existing storefront orders, manual orders, and QBO orders are unaffected by this system. The `fundraiser_hold` status and settlement logic apply ONLY to orders with `source: 'fundraiser'`.

### Rule 18: Campaign Scoping
All settlement operations are scoped to a SINGLE campaign. There is no cross-campaign settlement, no organization-level settlement, and no multi-campaign invoice.

---

# APPENDIX A — Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fundraiser percentage | Per-campaign configurable, default 20% | Different orgs negotiate different rates |
| Settlement trigger | Hybrid: auto-generate at end_date, admin reviews before sending payment link | Balances automation with oversight |
| Order freeze | Lock on invoice generation | Prevents financial drift |
| Manual payment | Supported (cash/check) | Many school orgs pay by check |
| Production grouping | One batch per campaign, aggregate bundle counts | Kitchen needs totals, not individual supporter names |
| Batch model | No new model — group by campaign_id | Avoids schema complexity; campaign_id is sufficient |
| Status strategy | `fundraiser_hold` in OrderStatus enum | Simplest path given existing enum; cleanup is separate |
| Invoice cardinality | 1:many (one invoice, many orders) | Settlement invoice covers entire campaign |
| Webhook strategy | Extend existing handlers with routing branch | No new webhook endpoints needed |

---

*End of Constitution — FSPBE v1.0*
