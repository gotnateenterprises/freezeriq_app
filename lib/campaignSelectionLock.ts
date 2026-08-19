/**
 * FR-FLOW-3 — the shared synchronization boundary between a supporter's first
 * order and a coordinator's bundle reselection.
 *
 * WHY THIS IS NEEDED
 * Coordinator reselection is legal only while a campaign has no supporter
 * orders, so it is a check-then-write: count the orders, then replace the active
 * bundles. Public order creation is the write that invalidates that check. If
 * the two run concurrently, the count can be taken before an order exists and
 * the replacement committed after it does — the campaign ends up with an
 * accepted order that was placed against a bundle set the coordinator has since
 * replaced. That is the exact TOCTOU this module exists to remove.
 *
 * WHY NOT SERIALIZABLE ALONE
 * The coordinator transaction already runs at Serializable. That is not enough,
 * because PostgreSQL's Serializable Snapshot Isolation only detects conflicts
 * among transactions that are ALL running at SERIALIZABLE. Public order creation
 * runs at the connection default — READ COMMITTED — so it never joins the SSI
 * dependency graph, and neither transaction is aborted. Raising the order path
 * to Serializable instead would put every supporter checkout at risk of
 * 40001 retries for a conflict that concerns one rare coordinator action.
 *
 * WHY AN ADVISORY LOCK
 * `pg_advisory_xact_lock` is honoured identically at every isolation level, so
 * a READ COMMITTED order and a Serializable reselection genuinely queue behind
 * one another. It is also the primitive this codebase already chose for exactly
 * this class of problem — see lib/publicIdentity.ts, whose shape this follows
 * deliberately rather than inventing a second convention.
 *
 * TRANSACTION-scoped (`_xact_`), so COMMIT, ROLLBACK or a dead worker all
 * release it; there is no unlock call that can leak. The key text is hashed into
 * the advisory integer domain BY POSTGRES via md5 — hashing in JavaScript would
 * be unspecified across runtimes and could let the two paths take different
 * locks, which is the one failure this must not have. The key is bound as a
 * parameter and never interpolated. This is synchronization, not a credential:
 * a hash collision merely makes two unrelated campaigns queue briefly, while
 * identical key text always yields an identical integer, which is the property
 * that matters.
 */

/** Namespace, so an unrelated advisory lock can never share semantics with this one. */
export const CAMPAIGN_SELECTION_LOCK_NAMESPACE = 'freezeriq:campaign-bundle-selection';

/** Deterministic lock key for one campaign. */
export function campaignSelectionLockKey(campaignId: string): string {
    return `${CAMPAIGN_SELECTION_LOCK_NAMESPACE}:${campaignId}`;
}

/** SQL that takes the transaction-scoped lock. Identical shape to IDENTITY_LOCK_SQL. */
export const CAMPAIGN_SELECTION_LOCK_SQL =
    `SELECT pg_advisory_xact_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)`;

/**
 * Minimal surface a Prisma transaction client must expose for this to run.
 * Deliberately narrow so tests can supply a double without the whole client.
 */
export interface AdvisoryLockCapableTx {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * Take the campaign's selection lock inside an open transaction.
 *
 * MUST be the first statement in both participating transactions. Taken later,
 * it still serializes the two paths, but each would already be holding a
 * snapshot taken before the other committed — which is the bug, not the fix.
 */
export async function lockCampaignSelection(
    tx: AdvisoryLockCapableTx,
    campaignId: string
): Promise<void> {
    await tx.$executeRawUnsafe(CAMPAIGN_SELECTION_LOCK_SQL, campaignSelectionLockKey(campaignId));
}
