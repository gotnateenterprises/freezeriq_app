/**
 * OPS-5E — the ONE print-batch handoff authority.
 *
 * CONTRACT: docs/ai/FUNDRAISER_FULFILLMENT_CONTRACT.md §11 (reuse the
 * canonical authorities, never re-derive them).
 *
 * WHY THIS EXISTS
 *
 * The Manual Planner's "Batch Print All Labels" click did NOTHING on the
 * deployed OPS-5D preview: no navigation, no print page, no request. The
 * handler ended with
 *
 *     if (businessId) { localStorage.setItem(`${businessId}_printBatch`, ...);
 *                       router.push('/production/print-batch'); }
 *
 * and no else branch, so a falsy client `businessId` swallowed the whole
 * click in silence. OPS-5B and OPS-5C had already proven twice over that
 * `session.user.businessId` from useSession() is NOT reliably available in
 * this component -- OPS-5C removed that dependency from Bundle loading, but
 * the same dependency survived on the print-batch handoff, in FIVE separate
 * places that each re-derived the storage key:
 *
 *     ProductionCalculator "Batch Print All Labels"   (writer)
 *     ProductionCalculator "Print Batch (N)"          (writer)
 *     PrepList             handlePrintLabels          (writer)
 *     print-batch/page.tsx load / remove / rewrite    (reader)
 *
 * Even repairing the writers alone would have left the reader gated on the
 * same unreliable value, showing "Loading batch..." forever.
 *
 * THE KEY IS FIXED, NOT TENANT-DERIVED
 *
 * The storage key no longer depends on session state at all, so writer and
 * reader are guaranteed to agree by construction rather than by both
 * happening to resolve the same client value at the same moment.
 *
 * TENANT SAFETY WITHOUT GATING
 *
 * `businessId` is still recorded INSIDE the payload when it is known, and
 * the reader refuses a batch whose recorded tenant contradicts the current
 * session. That is a mismatch GUARD, never an authorization gate: a missing
 * businessId on either side never blocks the handoff, because localStorage
 * is per-browser and the operator reading the batch is the operator who
 * wrote it seconds earlier in the same tab. Nothing here authorizes
 * anything -- every tenant-scoped decision still happens server-side
 * (OPS-5C, app/api/bundles).
 *
 * FAILURE IS ALWAYS VISIBLE
 *
 * Both helpers return a discriminated result instead of throwing or
 * silently returning. A quota-exceeded write, a private-mode browser, a
 * serialization failure or a malformed payload all produce `{ ok: false,
 * reason }` so the caller can show the operator a real message. No click
 * may end in silence.
 */

/**
 * The single localStorage key for the transient print batch.
 *
 * Deliberately NOT namespaced by tenant: see the module doc. The batch is a
 * transient, per-browser handoff between two pages of the same session, not
 * durable storage.
 */
export const PRINT_BATCH_STORAGE_KEY = 'freezeriq_printBatch';

export interface PrintBatchItem {
    name: string;
    id: string;
    qty: number;
    unit: string;
    /** Discrete physical package count from the OPS-5A meal manifest. */
    copies: number;
    variantSize?: string | null;
    servingTier?: string | null;
}

export interface PrintBatchPayload {
    name: string;
    items: PrintBatchItem[];
    servingTier?: string | null;
    /**
     * The tenant this batch was built for, when the writer happened to know
     * it. Advisory only — used by the reader to refuse a contradicting
     * batch, never to authorize or to gate.
     */
    businessId?: string | null;
}

export type PrintBatchWriteResult =
    | { ok: true }
    | { ok: false; reason: string };

export type PrintBatchReadResult =
    | { ok: true; batch: PrintBatchPayload }
    | { ok: false; reason: string };

/**
 * Persists a print batch for the /production/print-batch page to pick up.
 *
 * Never throws and never depends on a client tenant id being present. A
 * caller that receives `{ ok: false }` MUST surface the reason rather than
 * navigating or silently doing nothing.
 */
export function writePrintBatch(payload: PrintBatchPayload): PrintBatchWriteResult {
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
        return { ok: false, reason: 'There are no meals in this batch to print.' };
    }

    let serialized: string;
    try {
        serialized = JSON.stringify(payload);
    } catch {
        return { ok: false, reason: 'This print batch could not be prepared (its data could not be saved).' };
    }

    try {
        localStorage.setItem(PRINT_BATCH_STORAGE_KEY, serialized);
    } catch {
        // Quota exceeded, private-mode browsers, or storage disabled.
        return { ok: false, reason: 'This print batch could not be saved in your browser. Check that storage is not full or disabled, then try again.' };
    }

    return { ok: true };
}

/**
 * Loads the print batch written by any of the planner/prep surfaces.
 *
 * `currentBusinessId` is optional and advisory: when BOTH it and the stored
 * batch carry a tenant id and they disagree, the batch is refused so one
 * tenant's meals can never be printed under another's session in a shared
 * browser. A missing id on either side is not an error and never blocks.
 */
export function readPrintBatch(currentBusinessId?: string | null): PrintBatchReadResult {
    let raw: string | null;
    try {
        raw = localStorage.getItem(PRINT_BATCH_STORAGE_KEY);
    } catch {
        return { ok: false, reason: 'This browser would not allow the print batch to be read. Check that storage is not disabled.' };
    }

    if (!raw) {
        return { ok: false, reason: 'No print batch is queued. Build one from the Manual Planner or the Kitchen Prep list.' };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'The queued print batch could not be read (its saved data is damaged). Please build the batch again.' };
    }

    if (!parsed || !Array.isArray(parsed.items)) {
        return { ok: false, reason: 'The queued print batch is missing its meal list. Please build the batch again.' };
    }

    if (currentBusinessId && parsed.businessId && parsed.businessId !== currentBusinessId) {
        return { ok: false, reason: 'The queued print batch belongs to a different account. Please build the batch again.' };
    }

    return { ok: true, batch: parsed as PrintBatchPayload };
}

/** Clears the queued batch. Never throws. */
export function clearPrintBatch(): void {
    try {
        localStorage.removeItem(PRINT_BATCH_STORAGE_KEY);
    } catch {
        // Nothing to do — an unclearable batch is harmless, it is overwritten
        // by the next write.
    }
}

/**
 * How many distinct serving tiers this recipe appears at in a manifest.
 *
 * OPS-5E / Part H: the per-recipe "Print Labels (N)" action routes into the
 * single-tier Label Designer, which can only claim ONE serving tier. When a
 * recipe appears at more than one tier in the same plan, summing its copies
 * into a single number would print (for S5 qty2 + S2 qty3) five labels all
 * claiming one tier — collapsing two tiers into an untrue one. Callers use
 * this to route mixed-tier recipes through the tier-aware batch surface
 * instead.
 */
export function distinctTierCount(manifestRows: Array<{ variantSize?: string | null }>): number {
    return new Set(manifestRows.map(row => row.variantSize ?? 'unknown')).size;
}
