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

*Amended by CALC-1 (2026-09-07) to match the storage convention certified from
Production data by KITCHEN-CALCULATION-VERIFY-1. The previous wording —
`Ingredient Qty × Servings per Recipe × Bundle Size Multiplier × Bundle Quantity`
— assumed ingredients were stored PER SERVING and multiplied up. They are not.
Following it literally understated every family order by 80% and every couple
order by 75%.*

### The storage convention

`RecipeItem.quantity` on a **menu recipe** is the full ingredient amount for
**ONE PHYSICAL MEAL PACKAGE at that recipe row's own tier**. A family row
labelled "5 servings" storing 1 lb of beef means one family meal needs 1 lb —
not 0.2 lb, and not 5 lb.

The serving tier is expressed by **which recipe row a BundleContent references**.
A couple bundle points at its own pre-halved "(Serves 2)" row. The tier is
therefore already in the data and MUST NOT be applied a second time at runtime.

### NORMAL MENU RECIPE

```
meals = OrderItem.quantity × BundleContent.quantity

ingredient demand += convertUnit(RecipeItem.quantity × meals,
                                 RecipeItem.unit → Ingredient.unit)
```

- NO `base_yield_qty` divide. For a menu row `base_yield_qty` is descriptive
  (cost per serving, the editor's batch calculator) — never a production divisor.
- NO serving-tier multiplier. `getServingMultiplier` may still be called to
  VALIDATE the sold tier and to record it for tracing, but its value must never
  scale ingredient demand.

### SUB-RECIPE (recipe-to-recipe link)

`base_yield_qty` **is** the correct divisor here, and only here:

```
childYieldNeeded = convertUnit(RecipeItem.quantity × meals,
                               RecipeItem.unit → childRecipe.base_yield_unit)
childBatches     = childYieldNeeded / childRecipe.base_yield_qty
```

Then recurse into the child with `childBatches`.

**Convert BEFORE dividing.** Dividing an amount expressed in the parent's unit
by a yield expressed in the child's unit (teaspoons against a tablespoon yield)
is a real, measured 3× error.

NEVER: Skip a multiplier, override a multiplier, or apply one partially.

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
  "orderQuantity": 5,
  "bundleContentQuantity": 1,
  "meals": 5,
  "recipe": "Pork Loin Meal",
  "ingredient": "Pork Loin",
  "perMeal": 2.5,
  "unit": "lb",
  "computed": 12.5
}
```

*Amended by CALC-1: the trace records `perMeal` (the stored quantity for one
physical package) and the meal count, because that is how the data is stored.
The engine additionally records the sold `serving_multiplier` for audit, but it
is not a factor in `computed`.*

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
