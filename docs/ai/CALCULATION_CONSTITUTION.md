# FreezerIQ — Calculation Integrity Constitution
# Version 1.0 — 2026-05-04

ALL calculations (bundle → recipe → ingredient → shopping list) must be:

- **Deterministic**: Same inputs always produce the same outputs
- **Traceable**: Every result can be traced back to its source values
- **Reproducible**: Any step can be re-run in isolation and produce the same result
- **Reconcilable**: inputs = outputs, verifiable at every stage

No silent drift. Ever.

---

## LAW 1 — SINGLE SOURCE OF TRUTH

- Recipe ingredient quantities are the ONLY source of truth
- Bundle definitions must NOT contain derived math
- No duplicated logic across layers

## LAW 2 — MULTIPLIERS STACK, NEVER REPLACE

Final quantity MUST always be:

```
Ingredient Qty × Servings per Recipe × Bundle Size Multiplier × Bundle Quantity
```

NEVER: Skip a multiplier, override a multiplier, or apply partially.

## LAW 3 — NO EARLY ROUNDING

- All calculations must remain in full precision
- Rounding ONLY happens at final display layer

## LAW 4 — UNIT CONSISTENCY FIRST

- All ingredient math must occur in a BASE UNIT
- NEVER mix units mid-calculation or convert multiple times

## LAW 5 — AGGREGATION MUST ACCUMULATE

When combining ingredients:

- ALWAYS `total[pork] += value`
- NEVER `total[pork] = value`

## LAW 6 — KEYS MUST BE IMMUTABLE

Ingredient aggregation must use stable IDs (NOT names).

## LAW 7 — EVERY STEP MUST BE TRACEABLE

System must be able to output: Bundle → Recipe → Ingredient → Final Total

## LAW 8 — RECONCILIATION REQUIRED

Every calculation must pass: `Expected Total ≈ Computed Total`. If mismatch → FLAG ERROR.

## LAW 9 — NO HIDDEN LOGIC

- All math must live in ONE calculation layer
- UI must NOT calculate
- No duplicate formulas across services

## LAW 10 — EDGE CASE COVERAGE

System must handle: Mixed bundle sizes, multiple bundle types, large quantities, duplicate recipes across bundles, zero or missing ingredients.

---

## REQUIRED DEBUG MODE

System must support a DEBUG output trace per ingredient:

```json
{
  "bundle": "Q1 Hearty Family",
  "quantity": 5,
  "recipe": "Pork Loin Meal",
  "servings": 4,
  "ingredient": "Pork Loin",
  "perServing": 0.5,
  "unit": "lb",
  "computed": 10
}
```

## SAFETY CHECKS

1. **Assertion Checks** — Ensure all multipliers applied, no null/undefined values
2. **Unit Checks** — Ensure all ingredients normalized before math
3. **Aggregation Check** — Ensure no overwrite operations
4. **Final Reconciliation** — Compare expected vs computed totals

## FAILURE RULE

If ANY calculation fails validation: STOP output, RETURN error, LOG issue.
NEVER allow incorrect totals to pass silently.

## IMPLEMENTATION RULE

ALL future features MUST: Reference this constitution, pass validation before deployment, be audited using ZERO-DRIFT prompt.
