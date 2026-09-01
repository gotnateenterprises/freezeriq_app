# FreezerIQ — Fundraiser Fulfillment Contract

**Version:** 1.0
**Status:** APPROVED — owner rulings, FULFILLMENT-CONTINUITY-1 (2026-08-31)
**Governing spec:** `docs/ai/UI_REDESIGN_SPEC.md` — spec wins on any conflict EXCEPT where this document states a fulfillment product ruling, which supersedes older text (see §14).
**Parent Documents:** CONSTITUTION.md, ARCHITECTURE.md, CALCULATION_CONSTITUTION.md
**Supersedes on fulfillment behaviour:** SETTLEMENT_CONSTITUTION.md (DRAFT, never implemented)

---

## Governing Principle

> A fundraiser is ONE campaign, cooked as ONE batch, handed off at ONE stop —
> without ever losing which supporter ordered what.

This document exists because the fulfillment chain was never built as a chain.
Each stage was implemented against its own local reading of the rules, so
"which orders may be cooked", "what size was sold", and "where does this go"
each have several answers. This is the single place those answers live.

**Read this before touching production, labels, packing, delivery, or the
coordinator portal.** Future implementation MUST reuse the shared authorities
named in §15 rather than re-deriving these decisions inline.

---

## HARD RULES

1. **NEVER release fundraiser food on anything but a paid invoice.** `Invoice.status = 'PAID'` is the sole release authority. Campaign closeout does NOT release. Individual supporter payment does NOT release.
2. **NEVER group fundraiser fulfillment by anything but `FundraiserCampaign.id`.** Not organization, not customer, not campaign name, not address.
3. **PRESERVE ordinary customer delivery.** Regular customers keep one delivery stop per order at their own address. Fundraiser grouping must never reach that path.
4. **NEVER let aggregation destroy supporter identity.** `FundraiserCampaign.id` → `Order.id` → `OrderItem.id` must remain reconstructable.
5. **NEVER trust a client-supplied serving tier over the tenant-scoped Bundle.**
6. **Delivered means fulfilled, not deleted.** No fulfillment stage removes orders, campaigns, invoices, supporter identity, or financial history.

---

# SECTION 1 — GROUPING AUTHORITY

## 1.1 The grouping key

`FundraiserCampaign.id` is the fundraiser fulfillment grouping key, end to end —
production batch, packing, handoff, and delivery stop.

It is NOT: the organization id, the organization name, `Order.customer_id`, the
campaign display name, or any address.

## 1.2 One organization may run several campaigns

Those campaigns are **separate production jobs and separate delivery stops**,
even when they run concurrently for the same organization.

## 1.3 Why `customer_id` is disqualified

The two fundraiser order paths disagree about it by design:

| Path | `Order.customer_id` points at |
|---|---|
| `app/api/public/order/route.ts` (supporter) | a per-supporter customer row |
| `app/api/coordinator/route.ts` (coordinator entry) | the ORGANIZATION |

Grouping on `customer_id` therefore yields N groups for supporters and 1 group
for coordinator entries **within the same campaign**.

## 1.4 Why `delivery_address` is disqualified

Fundraiser supporter orders leave it NULL, so grouping on it collapses every
unrelated fundraiser together for the wrong reason. See §3.3.

---

# SECTION 2 — SUPPORTER ORDERS

## 2.1 What a supporter order requires

Supporter/customer name · email · phone · participant (where applicable) ·
Bundle · serving tier · quantity · order/payment context.

## 2.2 What it does NOT require

**A supporter home address.** Normal fundraiser supporters are not individually
delivered to. They collect at the campaign's coordinated pickup location.

This is already true in code: the fundraiser buyer page collects only first
name, last name, email, phone and an optional participant name, and
`Order.delivery_address` resolves to NULL on that path. Do not add an address
field to it.

---

# SECTION 3 — DELIVERY

## 3.1 One campaign, one stop

One fundraiser campaign creates **one** delivery stop.

## 3.2 Fundraiser delivery location authority

`FundraiserCampaign.pickup_location`.

Do NOT derive it from `Order.delivery_address`, `Customer.delivery_address`,
supporter address, or organization name.

## 3.3 Why `Order.delivery_address` must never be the fundraiser location

That column holds three different things depending on who wrote it:

| Writer | Meaning |
|---|---|
| storefront checkout | a real postal address |
| coordinator "+ Add Order" | free-text NOTE — the field is labelled "Note / Address (Optional)" |
| fundraiser supporter | NULL |

A reader cannot tell them apart. Treating a note as a location would scatter one
campaign across several stops, or navigate a driver to a sentence.

## 3.4 Regular customer delivery is untouched

Regular customer orders remain individual delivery stops and may require an
individual delivery address. **Do not collapse customer delivery into campaign
grouping.** The two share one render path today and there is no discriminator in
it — which is why §15.3 exists.

---

# SECTION 4 — SERVING TIER

## 4.1 The two halves

> **THE MENU DEFINES WHAT WAS SOLD. THE ORDER ITEM RECEIPT PRESERVES WHAT WAS SOLD.**

- **At order-creation time, `Bundle.serving_tier` is authoritative.** The server
  derives the tier from the tenant-scoped Bundle row. A client cannot redefine it.
- **`OrderItem.variant_size` is the frozen historical snapshot** of the tier
  actually purchased. It is never re-derived afterwards.

## 4.2 Why the snapshot must not be re-derived

`Bundle.serving_tier` is a mutable, unvalidated free-text column. The schema
already records this position for the sibling invoice column: stored rather than
re-derived, because *editing a bundle must not retroactively change what a
historical line said*. Re-deriving tier at READ time would silently re-tier
historical orders and change how much food the kitchen cooks.

## 4.3 Normalize, do not reject

A client tier that conflicts with the bundle is **ignored**, not refused. Every
real client already echoes the bundle's own tier, so normalizing is a no-op for
them. Rejecting would invent an error code no client renders, and would fail an
honest stale-tab order whenever a tenant edits a tier mid-session.

## 4.4 There is no exception — including manual orders

**Every** order-creation path derives the tier from the tenant-scoped Bundle:
the public supporter route, the coordinator add-order route, the storefront
checkout route, and `app/api/orders/route.ts` (tenant manual order entry).

FC-1 initially exempted the manual route because `components/AddOrderModal.tsx`
renders a serving-size selector separate from the bundle selector, which looked
like a deliberate custom sale. FC-1A re-traced it and that reading was wrong:

1. **The selector has no price effect.** The line total comes purely from the
   Bundle's own price, so honouring a mismatch could only ever mean charging one
   tier's price while cooking another's. There is no custom-sale pricing
   mechanism behind it.
2. **The tier is invisible at the point of choice.** The bundle dropdown renders
   name and price only — never `serving_tier` — so a tenant cannot see what they
   would be overriding.
3. **Tier is a property of the Bundle row.** `/api/bundles` derives both cost and
   the price fallback from `serving_tier`, and CB-1 made Serves-2 and Serves-5
   separate Bundle rows paired by `family_id`. The bundle a tenant picks already
   *is* a tier.
4. **The selector predates that model.** It is present in the initial commit,
   from before tier became a per-Bundle-row property. It is a vestige.
5. **Nothing documents it.** No doc, comment or test describes a custom-size
   manual sale.

The selector is now inert server-side. Removing it from the UI is a separate,
optional cleanup — not required for correctness, and not authorized here.

> If a genuine custom-size sale is ever wanted, it needs its own price
> resolution and its own explicit product decision. It must not be reintroduced
> as an unpriced override of the menu.

## 4.5 Legacy and importer paths

Paths with no modern Bundle (`bundle_id` NULL manual upsell lines, the Square
and QBO importers) keep their existing compatibility behaviour. Do not invent
tier data for them.

---

# SECTION 5 — PRODUCTION RELEASE

## 5.1 The gate

```
supporter order        → Order.status = 'fundraiser_hold'
campaign closeout      → Invoice DRAFT → SENT
payment recorded       → Invoice.status = 'PAID'   [single writer]
PAID winner            → fundraiser_hold → production_ready   [exactly once]
```

The sole release writer is `app/api/tenant/invoices/[id]/settle/route.ts`.
Exactly-once is achieved twice over: the promotion sits inside the winner-only
branch of the conditional PAID transition, and `status: 'fundraiser_hold'` is
itself a durable claim — once promoted, the rows can never match again.

## 5.2 Do not reopen this gate

- Closeout MUST NOT release food again.
- Individual supporter payment MUST NOT release food.
- No new time-window or key-based idempotency is needed or wanted.

## 5.3 `fundraiser_hold` cannot enter the kitchen

A held order is a commitment, not production work. It is excluded from every
production-intake query. `ORDER_STATUS_TRANSITIONS` gives `fundraiser_hold` zero
legal targets, so no PATCH can move it either.

## 5.4 The hold is `status`, NEVER `source`

A **released** fundraiser order MUST reach the kitchen — that is the entire point
of the gate. `lib/prisma_adapter.ts` `getOrders()` carries
`source: { not: 'fundraiser' }`, but that is the Orders LIST deciding what to
*display*, not production deciding what to *cook*. **Copying it into a production
query would silently un-ship the paid-invoice release.**

---

# SECTION 6 — PRODUCTION AGGREGATION

## 6.1 Aggregation is allowed

The kitchen may aggregate fundraiser quantities for efficiency — e.g. 20 × Keto
Serves 5 and 7 × Keto Serves 2 as one batch.

## 6.2 Identity must survive it

Aggregation MUST NEVER destroy the ability to reconstruct:

```
supporter → Bundle → serving tier → quantity
```

`FundraiserCampaign.id`, `Order.id` and `OrderItem.id` relationships must
survive every aggregation step. `lib/fundraiserProductionBatch.ts` already does
this correctly: each batch carries `sourceOrderIds` and each line carries
`sourceOrderItemIds`. Keep them. They are the traceability contract, not
incidental payload.

---

# SECTION 7 — LABELS

Two distinct systems. Do not merge them.

| | MEAL / RECIPE LABELS | CUSTOMER OUTER-BOX LABELS |
|---|---|---|
| Owner | Production | Packing / delivery handoff |
| Grain | one per recipe per bundle unit | one per supporter box |
| Status | built and wired — reuse it | not built |
| Future content | recipe, allergens, instructions | supporter name, bundle name, serving tier, optional render-time Box N of M |

**No persisted box-number schema is authorized at this time.** Box numbering, if
built, is a render-time computation only.

---

# SECTION 8 — FULFILLMENT LIFECYCLE

```
supporter orders
  → fundraiser waiting (held)
  → invoice PAID
  → Production
  → meals produced
  → supporter boxes packed
  → fundraiser ready for Delivery
  → ONE campaign Delivery stop
  → Delivered
  → removed from active Production/Delivery work
```

**Delivered is fulfillment completion, NOT deletion.** Orders, campaign, invoice,
supporter identity and financial history are all retained.

---

# SECTION 9 — COORDINATOR VISIBILITY

For their OWN campaign, a coordinator should be able to access: supporter name ·
email · phone · participant · Bundle · serving tier · quantity · total ·
timestamp · truthful payment context.

**Supporter home address is NOT part of the coordinator dataset.**

Campaign isolation remains mandatory: a coordinator session is bound to exactly
one `campaign_id` at creation, and no handler may accept a campaign id from a
URL, query string or body.

> **Not yet implemented.** The portal currently strips email and phone. Widening
> it is a later phase and must revise the tests that pin the current exclusion —
> it must not be worked around. The shipped supporter privacy notice already
> covers name, email and phone, so no disclosure change is required for those
> three; adding address WOULD exceed it.

---

# SECTION 10 — HISTORICAL DATA RESTRICTIONS

**Do not mutate any of the following without a separate owner ruling.**

| Data | Rule |
|---|---|
| April/May Edgar County Farm Bureau orders | Real completed orders stranded at `ready_to_ship`. To be cleared later **through the repaired UI**, not by direct database remediation. |
| Coles County Farm Bureau orders | Same rule. |
| **October Edgar County campaign** | **REAL AND CURRENTLY IN MOTION. LEAVE COMPLETELY ALONE** — do not close, archive, invoice, settle, or change orders, statuses or dates. |
| Edgar historical $0.00 DRAFT invoice | Leave untouched; separate cleanup ruling pending. |
| The stranded test fundraiser orders | Owner will cancel as test data separately. Do not release, settle, invoice or cancel them. |

---

# SECTION 11 — CANONICAL AUTHORITIES

Do not re-derive these. Import them.

| Question | Canonical authority |
|---|---|
| May this order be cooked? | `lib/productionIntake.ts` — `PRODUCTION_ORDER_EXCLUSIONS`, `PRODUCTION_INTAKE_STATUSES`, `isProductionEligibleOrder` |
| What tier was sold? | `lib/orderItemTier.ts` — `resolveSoldVariantSize` |
| Tier string vocabulary | `lib/serving_multipliers.ts` — `resolveVariantSize` (sensitive core file; compose, never edit) |
| Is this fundraiser or customer delivery? | `lib/delivery/orderClassification.ts` |
| Order status + legal transitions | `lib/orderStatus.ts` |
| Is the campaign closed? | `lib/campaignBundleSelection.ts` — `CLOSED_STATUSES`, `isCampaignClosed` |
| What price? | `lib/pricing.ts` — `buildBundlePriceMap` (sensitive core file) |
| Fundraiser production batch | `lib/fundraiserProductionBatch.ts` |

## 11.1 Known duplication, not yet consolidated

The closed-campaign predicate is duplicated in nine places. `CLOSED_STATUSES` /
`isCampaignClosed` in `lib/campaignBundleSelection.ts` is canonical — but it is
trapped behind a `prisma` import, which is the structural reason the duplicates
exist (client components cannot import it). **Any future consolidation must
first move it into a zero-import module** and re-export it for compatibility,
not simply point nine call sites at a Prisma-carrying module.

Two of those nine are narrower than canonical, not pure copies — the coordinator
route recognizes only `'Closed'`. Treat them as behaviour differences.

---

# SECTION 12 — NON-CONFORMING READERS

Known to disagree with §5. Recorded, deliberately NOT changed, because each
would alter a tenant-visible number and belongs in its own change with its own
tests.

| Reader | Missing |
|---|---|
| `app/api/dashboard/route.ts` Production Demand tile | `canceled_at`, and it uses raw status literals instead of the read-candidate mapping |
| `app/api/delivery/stats/route.ts` | `canceled_at`, storefront-pending exclusion |
| `lib/prisma_adapter.ts` `getOrders()` | `canceled_at` — but this is the Orders LIST, not production |

---

# SECTION 13 — NON-NEGOTIABLE RULES

Violation of any rule is a system defect.

### Rule 1: Production invisibility
An unpaid `fundraiser_hold` order must never appear in any kitchen, label, or
production surface.

### Rule 2: Release is payment-gated and exactly-once
Only the request that wins the PAID transition may promote, and only from
`fundraiser_hold`.

### Rule 3: The grouping key is the campaign
`FundraiserCampaign.id`. Never the organization, customer, name or address.

### Rule 4: Identity survives aggregation
Every aggregate must retain its source order and order-item ids.

### Rule 5: The menu owns the tier
`Bundle.serving_tier` at write time; `OrderItem.variant_size` frozen thereafter.

### Rule 6: Ordinary customer delivery is preserved
Per-order stops, own address, never campaign-grouped.

### Rule 7: Delivered retains everything
Fulfillment completion never deletes data.

### Rule 8: Reuse, do not re-derive
New fulfillment code imports the §11 authorities. A second inline copy of any of
these rules is a defect, regardless of whether it currently agrees.

---

# SECTION 14 — SUPERSEDED STATEMENTS

These remain in the repository and are WRONG on fulfillment behaviour. This
document supersedes them. They are listed rather than edited so the record of
what changed stays visible.

| Location | Stale claim | Correct position |
|---|---|---|
| `docs/ai/SETTLEMENT_CONSTITUTION.md` | An eight-state FSPBE engine with settlement payment links and webhook routing | Never implemented. Only the `fundraiser_hold` half exists; release is the paid-invoice gate of §5. |
| `SETTLEMENT_CONSTITUTION.md` Appendix A | "Kitchen needs totals, not individual supporter names" | Contradicted by §6.2 and by the document's own Rule 11. Identity must survive. |
| `docs/ai/CRM_REDESIGN_HANDOFF.md` | "Close a campaign to release orders to production" | False since the release moved to invoice settlement. |
| `app/api/public/order/route.ts` comment | Names campaign closeout as "the sole owner of fundraiser_hold → production_ready" | The owner is the settle route. |
| `lib/orderStatus.ts` §11 note | Same stale closeout attribution | Same correction. |
| `CLAUDE.md`, `docs/ai/UI_REDESIGN_SPEC.md` | Lock `app/api/coordinator/[token]/route.ts` and `app/coordinator/[token]/page.tsx` | Both were renamed away; the live surfaces are `app/api/coordinator/route.ts` and `app/coordinator/portal/page.tsx`. |
| `docs/FUNDRAISER_ARCHITECTURE.md` | Supporters pay externally then receive a magic link | Contradicts the shipped self-serve order path. |

---

# SECTION 15 — IMPLEMENTATION GUIDANCE FOR FUTURE PHASES

## 15.1 Reuse before building
Most of what the remaining repairs need already exists. The per-supporter
bundle/tier/quantity grain is already produced by the packing-slip and manifest
pages; the coordinator pickup sheet is already a live data export; the meal-label
bundle→recipe multiplication is built and wired.

## 15.2 No schema change is required
for coordinator contact visibility, box labels (without persisted numbering), a
printable pickup manifest, or campaign delivery grouping. Persisted box numbers,
`delivered_at`, proof-of-delivery, per-box packed state and production-run
attribution WOULD each require schema and are not authorized here.

## 15.3 The delivery repair must consume `lib/delivery/orderClassification.ts`
Fundraiser and ordinary delivery share one render path with no discriminator, so
a grouping change written directly in that path silently changes what a regular
customer's delivery looks like. The classification boundary exists so that
change has something safe to branch on. Its fixtures are the contract.

## 15.4 Beware brittle source-text assertions
Several suites assert on file SOURCE TEXT, including occurrence counts and
banned substrings. A doc comment containing the wrong word can fail a test with
no behavioural change. Check the blast radius before editing a guarded file.

---

*End of Fundraiser Fulfillment Contract — v1.0*
