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
 * Fetches the SERVER-AUTHENTICATED current tenant id.
 *
 * OPS-5F: the ownership check below is a security decision, so it must not
 * rest on `useSession().user.businessId` -- OPS-5B/5C/5E each traced a
 * production failure to that value being absent in these very components.
 * An absent client id would silently weaken the check to "no opinion".
 * This asks the server, which derives the tenant from the session cookie.
 *
 * Returns null on ANY failure (401, network, malformed). Callers must treat
 * null as "cannot verify" and refuse to render or write a batch -- never as
 * permission to proceed.
 */
export async function fetchAuthenticatedBusinessId(
    fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
    try {
        const res = await fetchImpl('/api/tenant/identity');
        if (!res.ok) return null;
        const data = await res.json();
        const id = data?.businessId;
        return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
        return null;
    }
}

/**
 * Loads the print batch written by any of the planner/prep surfaces.
 *
 * OPS-5F — STRICT TENANT OWNERSHIP. `currentBusinessId` must be the
 * server-authenticated id (see fetchAuthenticatedBusinessId). The batch is
 * refused unless BOTH sides are present AND identical:
 *
 *   - missing current tenant  -> refuse (cannot verify ownership)
 *   - missing stored owner    -> refuse (legacy/unsafe batch, pre-OPS-5F)
 *   - mismatch                -> refuse (stale batch from another tenant)
 *
 * OPS-5E made this comparison advisory so a missing id could never block the
 * handoff. That was the right trade while the only risk was a broken click;
 * it is the wrong one before multi-tenant launch, where a stale Tenant A
 * batch left in a shared browser must never render for Tenant B. Refusing is
 * now always safe because the WRITE path stamps every batch with the same
 * server-authenticated id, so a batch that cannot prove its owner is either
 * pre-OPS-5F or tampered with.
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

    // OPS-5F: ownership must be POSITIVELY proven, in this order, before any
    // label is rendered. Each branch refuses; none falls through to render.
    if (!currentBusinessId) {
        return { ok: false, reason: 'Your business could not be confirmed, so this label batch was not opened. Please reload and sign in again.' };
    }
    if (!parsed.businessId) {
        return { ok: false, reason: 'This label batch could not prove which business it belongs to. Please return to Production and prepare a new batch.' };
    }
    if (parsed.businessId !== currentBusinessId) {
        return { ok: false, reason: 'This label batch belongs to a different business. Please return to Production and prepare a new batch.' };
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

// ═════════════════════════════════════════════════════════════════════════════
// OPS-6 — the SUPPORTER OUTER-BOX label handoff.
//
// Same module on purpose: OPS-5E's ruling was that there must be ONE
// storage-key authority, and two modules each owning a localStorage key is how
// a writer and a reader drift apart. Distinct KEY on purpose too: a meal batch
// and a box batch are different payload shapes, and sharing one key would let
// queuing box labels silently destroy a queued meal batch.
//
// WHAT IS STORED: opaque Order IDs, and nothing else.
//
// The supporter's NAME is required printed content, but that does not put it in
// browser storage. The page stores ids, then asks the server for the label
// content over an authenticated request, so the transient client-side artifact
// carries no supporter identity at all — nothing to leak from a shared kiosk
// browser, nothing in a URL, nothing in a screenshot of the address bar.
// ═════════════════════════════════════════════════════════════════════════════

/** The single localStorage key for the transient outer-box label batch. */
export const BOX_LABEL_STORAGE_KEY = 'freezeriq_boxLabelBatch';

export interface BoxLabelBatchPayload {
    /** Opaque Order IDs. Never supporter data. */
    orderIds: string[];
    /**
     * The tenant this batch was queued by, from the SERVER-AUTHENTICATED
     * identity (fetchAuthenticatedBusinessId). Required — see readBoxLabelBatch.
     */
    businessId: string | null;
    /** Operator-facing batch name. Never a supporter name. */
    name?: string;
}

export type BoxLabelBatchReadResult =
    | { ok: true; batch: BoxLabelBatchPayload }
    | { ok: false; reason: string };

/**
 * Queues an outer-box label batch. Never throws.
 *
 * A caller that receives `{ ok: false }` MUST surface the reason rather than
 * navigating or silently doing nothing — the OPS-5E rule that a print click
 * may never end in silence applies here identically.
 */
export function writeBoxLabelBatch(payload: BoxLabelBatchPayload): PrintBatchWriteResult {
    if (!payload || !Array.isArray(payload.orderIds) || payload.orderIds.length === 0) {
        return { ok: false, reason: 'There are no orders in this batch to label.' };
    }
    if (!payload.businessId) {
        return { ok: false, reason: 'Your business could not be confirmed, so no label batch was prepared. Please reload and sign in again.' };
    }

    let serialized: string;
    try {
        serialized = JSON.stringify({
            orderIds: payload.orderIds,
            businessId: payload.businessId,
            name: payload.name,
        });
    } catch {
        return { ok: false, reason: 'This label batch could not be prepared (its data could not be saved).' };
    }

    try {
        localStorage.setItem(BOX_LABEL_STORAGE_KEY, serialized);
    } catch {
        return { ok: false, reason: 'This label batch could not be saved in your browser. Check that storage is not full or disabled, then try again.' };
    }

    return { ok: true };
}

/**
 * Loads the queued outer-box batch, refusing anything it cannot prove.
 *
 * STRICT TENANT OWNERSHIP, identical in shape and order to readPrintBatch's
 * OPS-5F rule, and for the same reason: localStorage is per-browser, so a
 * batch Tenant A left behind must never open for Tenant B after a
 * logout/login. `currentBusinessId` must be the SERVER-authenticated id.
 *
 * This is defence in depth, not the security boundary. Even a forged payload
 * only ever yields Order IDs, and the server route re-checks every one of them
 * against the authenticated tenant before returning a single field of label
 * content.
 */
export function readBoxLabelBatch(currentBusinessId?: string | null): BoxLabelBatchReadResult {
    let raw: string | null;
    try {
        raw = localStorage.getItem(BOX_LABEL_STORAGE_KEY);
    } catch {
        return { ok: false, reason: 'This browser would not allow the label batch to be read. Check that storage is not disabled.' };
    }

    if (!raw) {
        return { ok: false, reason: 'No box labels are queued. Choose orders from Packed & Ready in Production and select Box Labels.' };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'The queued label batch could not be read (its saved data is damaged). Please queue the labels again.' };
    }

    if (!parsed || !Array.isArray(parsed.orderIds) || parsed.orderIds.length === 0) {
        return { ok: false, reason: 'The queued label batch is missing its order list. Please queue the labels again.' };
    }

    if (!currentBusinessId) {
        return { ok: false, reason: 'Your business could not be confirmed, so this label batch was not opened. Please reload and sign in again.' };
    }
    if (!parsed.businessId) {
        return { ok: false, reason: 'This label batch could not prove which business it belongs to. Please return to Production and queue a new batch.' };
    }
    if (parsed.businessId !== currentBusinessId) {
        return { ok: false, reason: 'This label batch belongs to a different business. Please return to Production and queue a new batch.' };
    }

    return { ok: true, batch: parsed as BoxLabelBatchPayload };
}

/** Clears the queued outer-box batch. Never throws. */
export function clearBoxLabelBatch(): void {
    try {
        localStorage.removeItem(BOX_LABEL_STORAGE_KEY);
    } catch {
        // An unclearable batch is harmless; the next write overwrites it.
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
