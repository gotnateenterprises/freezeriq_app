/**
 * lib/orderStatus.ts
 *
 * FreezerIQ canonical order lifecycle constants, helpers, and compatibility
 * mappings. This file is SCHEMA-NEUTRAL — it does not import Prisma enum types
 * because the current OrderStatus enum is split-brain and does not yet contain
 * `in_production` or `ready_to_ship` as canonical lowercase values.
 *
 * Phase 5B — Added canonical constants, normalizeOrderStatus, helpers.
 * Phase 5D — Added CANONICAL_TO_DB_ORDER_STATUS and toDbSafeOrderStatus() for
 *             safe DB writes during the transitional period before migration.
 * Phase 5F — Added toDbOrderStatusReadCandidates() so GET routes and UI
 *             components can query both canonical and legacy DB values without
 *             passing raw ghost strings (READY_TO_SHIP, APPROVED, etc.) to Prisma.
 *
 * Canonical lifecycle (Phase 5A approved):
 *   fundraiser_hold → pending → production_ready → in_production
 *     → completed → ready_to_ship → delivered
 *
 * Cancellation is represented by the `canceled_at` timestamp on Order,
 * NOT by an OrderStatus enum value.
 */

// ─── 1. Canonical Status Constants ───────────────────────────────────────────

export const ORDER_STATUS = {
  FUNDRAISER_HOLD:  'fundraiser_hold',
  PENDING:          'pending',
  PRODUCTION_READY: 'production_ready',
  IN_PRODUCTION:    'in_production',
  COMPLETED:        'completed',
  READY_TO_SHIP:    'ready_to_ship',
  DELIVERED:        'delivered',
} as const;

// ─── 2. Canonical Status Type ─────────────────────────────────────────────────

export type CanonicalOrderStatus =
  typeof ORDER_STATUS[keyof typeof ORDER_STATUS];

// Exhaustive tuple used for runtime narrowing (type guard below).
const CANONICAL_VALUES: readonly CanonicalOrderStatus[] = [
  ORDER_STATUS.FUNDRAISER_HOLD,
  ORDER_STATUS.PENDING,
  ORDER_STATUS.PRODUCTION_READY,
  ORDER_STATUS.IN_PRODUCTION,
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.READY_TO_SHIP,
  ORDER_STATUS.DELIVERED,
] as const;

// ─── 3. Legacy / Current Split-Brain Mapping ─────────────────────────────────
//
// Maps every value that currently exists in the database or codebase to its
// canonical equivalent. Covers:
//   - Uppercase Prisma enum values that were added before the canonical set
//   - READY_TO_SHIP ghost value (written by InProductionArea.tsx but never
//     formally in the schema)
//   - Already-canonical lowercase values (identity mapping, safe to include)

export const LEGACY_STATUS_MAP: Record<string, CanonicalOrderStatus> = {
  // Uppercase → canonical
  PENDING:          ORDER_STATUS.PENDING,
  APPROVED:         ORDER_STATUS.PRODUCTION_READY,  // APPROVED collapses into production_ready
  IN_PRODUCTION:    ORDER_STATUS.IN_PRODUCTION,
  COMPLETED:        ORDER_STATUS.COMPLETED,
  DELIVERED:        ORDER_STATUS.DELIVERED,
  READY_TO_SHIP:    ORDER_STATUS.READY_TO_SHIP,     // ghost value formalized

  // Already canonical (identity mapping — safe to normalize idempotently)
  fundraiser_hold:  ORDER_STATUS.FUNDRAISER_HOLD,
  pending:          ORDER_STATUS.PENDING,
  production_ready: ORDER_STATUS.PRODUCTION_READY,
  in_production:    ORDER_STATUS.IN_PRODUCTION,
  completed:        ORDER_STATUS.COMPLETED,
  ready_to_ship:    ORDER_STATUS.READY_TO_SHIP,
  delivered:        ORDER_STATUS.DELIVERED,
};

// ─── 4. normalizeOrderStatus ──────────────────────────────────────────────────

/**
 * Normalize any status string (including legacy uppercase values, the ghost
 * READY_TO_SHIP, null, or undefined) to a canonical CanonicalOrderStatus.
 *
 * Returns `null` if the input cannot be mapped.
 * Never throws.
 */
export function normalizeOrderStatus(
  input: string | null | undefined,
): CanonicalOrderStatus | null {
  if (input == null) return null;
  const mapped = LEGACY_STATUS_MAP[input];
  return mapped ?? null;
}

// ─── 5. isCanonicalOrderStatus ────────────────────────────────────────────────

/**
 * Type guard. Returns true only if `input` is already a CanonicalOrderStatus.
 * Does NOT attempt normalization — use normalizeOrderStatus first if needed.
 */
export function isCanonicalOrderStatus(
  input: unknown,
): input is CanonicalOrderStatus {
  return typeof input === 'string' &&
    (CANONICAL_VALUES as readonly string[]).includes(input);
}

// ─── 6. getOrderStatusLabel ───────────────────────────────────────────────────

const STATUS_LABELS: Record<CanonicalOrderStatus, string> = {
  fundraiser_hold:  'Fundraiser Hold',
  pending:          'Pending Payment',
  production_ready: 'Ready for Production',
  in_production:    'In Production',
  completed:        'Completed',
  ready_to_ship:    'Ready for Delivery',
  delivered:        'Delivered',
};

/**
 * Return the tenant-friendly display label for a canonical order status.
 *
 * Accepts raw/legacy strings — normalizes internally before lookup.
 * Returns "Unknown" for any unrecognized input.
 */
export function getOrderStatusLabel(
  status: string | null | undefined,
): string {
  const canonical = normalizeOrderStatus(status);
  if (canonical == null) return 'Unknown';
  return STATUS_LABELS[canonical];
}

// ─── 7. getOrderStatusRank ────────────────────────────────────────────────────

const STATUS_RANK: Record<CanonicalOrderStatus, number> = {
  fundraiser_hold:  0,
  pending:          1,
  production_ready: 2,
  in_production:    3,
  completed:        4,
  ready_to_ship:    5,
  delivered:        6,
};

/**
 * Return the lifecycle position (0-based) for a given order status.
 *
 * Accepts raw/legacy strings — normalizes internally.
 * Returns -1 for unknown/null input.
 */
export function getOrderStatusRank(
  status: string | null | undefined,
): number {
  const canonical = normalizeOrderStatus(status);
  if (canonical == null) return -1;
  return STATUS_RANK[canonical];
}

// ─── 8. Compatibility Query Groups ───────────────────────────────────────────
//
// Pre-built arrays of values to pass directly into Prisma `{ in: [...] }` clauses
// during the transitional period where the DB may contain both old and new values.
//
// Phase 5E will replace these with clean single-value canonical queries after
// the Phase 5C SQL migration has run and the schema has been unified.
//
// Usage example (do NOT use these in routes until Phase 5E is approved):
//   status: { in: ORDER_STATUS_COMPAT.productionQueue as any }

export const ORDER_STATUS_COMPAT = {
  /** Orders visible in the kitchen holding area / production dashboard holding panel */
  productionQueue: [
    'pending',
    'production_ready',
    'APPROVED',
    'IN_PRODUCTION',
    'in_production',        // canonical (present after Phase 5C)
  ] as const,

  /** Orders that should appear in delivery hub, manifest, and packing slips */
  activeForDelivery: [
    'pending',
    'production_ready',
    'APPROVED',
    'IN_PRODUCTION',
    'in_production',        // canonical
    'completed',
    'COMPLETED',
    'ready_to_ship',
    'READY_TO_SHIP',
  ] as const,

  /** Both historical and canonical "cooking done" values */
  completedLike: [
    'completed',
    'COMPLETED',
  ] as const,

  /** Both historical and canonical "delivered to customer" values */
  deliveredLike: [
    'delivered',
    'DELIVERED',
  ] as const,
} as const;

// ─── 9. Temporary DB-Safe Write Mapper ───────────────────────────────────────
//
// Maps every CanonicalOrderStatus to the value that is currently safe to write
// to the database. This is TEMPORARY — it exists only because the Prisma
// OrderStatus enum has not yet been migrated to match the canonical set.
//
// Important invariants:
//   - `in_production` → 'IN_PRODUCTION': lowercase form is not in the DB enum yet.
//   - `ready_to_ship` → 'completed': neither ready_to_ship nor READY_TO_SHIP is
//     in the DB enum. 'completed' is the nearest safe prior step.
//     (InProductionArea.tsx currently writes the ghost value READY_TO_SHIP;
//      after this mapper is wired in Phase 5D it will write 'completed' instead.)
//
// This map must remain schema-neutral — do NOT import Prisma enum types here.
// Update this map (or remove it) when the Phase 5E SQL migration runs and adds
// `in_production` and `ready_to_ship` to the Prisma enum.

export const CANONICAL_TO_DB_ORDER_STATUS: Record<CanonicalOrderStatus, string> = {
  fundraiser_hold:  'fundraiser_hold',
  pending:          'pending',
  production_ready: 'production_ready',
  in_production:    'IN_PRODUCTION',   // lowercase not yet in DB enum — use uppercase form
  completed:        'completed',
  ready_to_ship:    'completed',       // neither form is in DB enum — fallback to completed
  delivered:        'delivered',
};

/**
 * Convert any status input (canonical, legacy uppercase, or unknown) to the
 * value that is currently safe to write to the database.
 *
 * Steps:
 *   1. Normalizes the input to a CanonicalOrderStatus via normalizeOrderStatus().
 *   2. Maps the canonical value to its current DB-safe form via CANONICAL_TO_DB_ORDER_STATUS.
 *   3. Returns null if the input is unrecognized — callers should return 400.
 *
 * Never throws.
 *
 * TEMPORARY: Remove or simplify after the Phase 5E SQL migration adds
 * `in_production` and `ready_to_ship` to the Prisma enum.
 *
 * Schema-neutral: does NOT import Prisma enum types.
 */
export function toDbSafeOrderStatus(
  input: string | null | undefined,
): string | null {
  const canonical = normalizeOrderStatus(input);
  if (canonical == null) return null;
  return CANONICAL_TO_DB_ORDER_STATUS[canonical];
}

// ─── 10. Temporary DB-Safe Read Candidates ───────────────────────────────────
//
// Returns all DB status values that a WHERE clause should match for a given
// canonical status during the transitional period (before enum migration and
// row backfill). Covers both canonical lowercase and legacy uppercase forms.
//
// TEMPORARY: Simplify to single-value arrays after Phase 5H backfill removes
// legacy uppercase rows from the DB.
//
// Schema-neutral: does NOT import Prisma enum types.
//
// Usage in Prisma query (single canonical):
//   status: { in: toDbOrderStatusReadCandidates('production_ready') as any }
//
// Usage when aggregating multiple canonicals (e.g. prep list query):
//   const candidates = ['production_ready', 'in_production']
//     .flatMap(toDbOrderStatusReadCandidates);
//   status: { in: [...new Set(candidates)] as any }

const CANONICAL_TO_DB_READ_CANDIDATES: Record<CanonicalOrderStatus, string[]> = {
  fundraiser_hold:  ['fundraiser_hold'],
  pending:          ['pending', 'PENDING'],
  production_ready: ['production_ready', 'APPROVED'],
  in_production:    ['IN_PRODUCTION'],
  // ready_to_ship is temporarily stored as 'completed' until the enum migration
  // adds a real ready_to_ship value. Reads for ready_to_ship match 'completed'.
  ready_to_ship:    ['completed'],
  completed:        ['completed', 'COMPLETED'],
  delivered:        ['delivered', 'DELIVERED'],
};

/**
 * Return all DB status values that should be included in a Prisma `{ in: [...] }`
 * WHERE clause when filtering for a given canonical order status.
 *
 * Steps:
 *   1. Normalizes the input to a CanonicalOrderStatus via normalizeOrderStatus().
 *   2. Returns the matching DB candidates (canonical + legacy forms) for that status.
 *   3. Returns [] if the input is unrecognized — callers should treat this as invalid.
 *
 * Never throws.
 *
 * TEMPORARY: Remove per-status legacy aliases after Phase 5H backfill aligns all
 * rows to canonical lowercase values.
 *
 * Schema-neutral: does NOT import Prisma enum types.
 */
export function toDbOrderStatusReadCandidates(
  input: string | null | undefined,
): string[] {
  const canonical = normalizeOrderStatus(input);
  if (canonical == null) return [];
  return CANONICAL_TO_DB_READ_CANDIDATES[canonical];
}

// ─── 11. Transition Map ───────────────────────────────────────────────────────
//
// Documents intended valid forward transitions in the order lifecycle.
// Not enforced by any route in Phase 5D — value validation only.
// Transition enforcement is deferred to Phase 5E after the enum migration.
//
// Notes:
//   - fundraiser_hold can advance to pending (coordinator approves)
//     OR directly to production_ready (coordinator marks as paid on release)
//   - production_ready can skip to completed (no formal in_production step used)
//   - completed can skip ready_to_ship and go straight to delivered
//     (for tenants who don't use the "staged" step)
//   - Cancellation is NOT modeled here — it is represented by canceled_at.

export const ORDER_STATUS_TRANSITIONS: Record<
  CanonicalOrderStatus,
  readonly CanonicalOrderStatus[]
> = {
  fundraiser_hold:  ['pending', 'production_ready'],
  pending:          ['production_ready'],
  production_ready: ['in_production', 'completed'],
  in_production:    ['completed'],
  completed:        ['ready_to_ship', 'delivered'],
  ready_to_ship:    ['delivered'],
  delivered:        [],
} as const;

// ─── 12. canTransitionOrderStatus ────────────────────────────────────────────

/**
 * Returns true if transitioning from `from` to `to` is a valid forward move
 * in the canonical order lifecycle.
 *
 * Both inputs are normalized before the check — legacy uppercase values and
 * the ghost READY_TO_SHIP are accepted transparently.
 *
 * Returns false if either status is unknown/null or if the transition is
 * not present in ORDER_STATUS_TRANSITIONS.
 *
 * Does NOT account for `canceled_at` — cancellation is a separate mechanism.
 */
export function canTransitionOrderStatus(
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  const fromCanonical = normalizeOrderStatus(from);
  const toCanonical   = normalizeOrderStatus(to);

  if (fromCanonical == null || toCanonical == null) return false;

  return (ORDER_STATUS_TRANSITIONS[fromCanonical] as readonly string[])
    .includes(toCanonical);
}
