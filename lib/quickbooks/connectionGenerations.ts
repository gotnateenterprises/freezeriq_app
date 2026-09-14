/**
 * QB-INVOICE-1B — QuickBooks connection GENERATIONS.
 *
 * A generation is one lifetime of a tenant's integrations(business_id, 'quickbooks') row
 * (see QuickBooksConnection in prisma/schema.prisma). QuickBooks customer and invoice ids
 * are bound to a generation, never to a realm, and nothing realm-derived is stored.
 *
 *   · A generation is recorded the first time a CONNECTED tenant needs one, together with
 *     non-secret evidence: the environment, the company name QuickBooks reports, and
 *     QB-INVOICE-1A's record of who authorized the company and when.
 *   · Forget deletes the integrations row. Postgres then ends the generation (its live
 *     pair is set NULL) and keeps it; the next connect gets a new one. Nothing in the
 *     application updates or deletes a generation.
 *   · Anything bound to a generation is written inside `withLiveConnection`, which holds
 *     FOR SHARE on the tenant's integrations row — refresh, Disconnect, reconnect and
 *     Forget all write that row, so they wait — and re-reads the stored connection under
 *     that lock: it must still be connected to the SAME company as the caller's access
 *     token. Realm ids are compared in memory only.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { QUICKBOOKS_PROVIDER, type QuickBooksEnvironment } from '@/lib/quickbooks/config';
import { loadQuickBooksConnection, type ConnectionAudit, type QuickBooksDb } from '@/lib/quickbooks/connection';

export type GenerationDb = Pick<typeof prisma, 'integration' | '$transaction' | 'quickBooksConnection'>;

export interface GenerationDeps {
    db?: GenerationDb;
    env?: NodeJS.ProcessEnv;
}

type Tx = Prisma.TransactionClient;

/** The tenant's live generation id, or null. A plain read: writers re-check it under the lock. */
export async function findLiveGenerationId(businessId: string, deps: GenerationDeps = {}): Promise<string | null> {
    const db = deps.db ?? prisma;
    const row = await db.quickBooksConnection.findFirst({
        where: { live_business_id: businessId, live_provider: QUICKBOOKS_PROVIDER },
        select: { id: true },
    });
    return row?.id ?? null;
}

export interface LiveConnectionContext {
    /** The live generation, or null when this connection lifetime has none recorded yet. */
    generationId: string | null;
    /** Who authorized the connected company, and when (QB-INVOICE-1A). */
    audit: ConnectionAudit;
}

/**
 * Runs `fn` in a transaction holding FOR SHARE on the tenant's QuickBooks integrations
 * row, and only while that row is CONNECTED to the company `realmId` names — the realm of
 * the access token the caller is using. `{ ok: false }` otherwise, and `fn` never runs.
 */
export async function withLiveConnection<T>(
    input: { businessId: string; realmId: string },
    deps: GenerationDeps,
    fn: (tx: Tx, live: LiveConnectionContext) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
    const db = deps.db ?? prisma;
    return db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "integrations" WHERE "business_id" = ${input.businessId} AND "provider" = ${QUICKBOOKS_PROVIDER} FOR SHARE`;
        const stored = await loadQuickBooksConnection(input.businessId, { db: tx as unknown as QuickBooksDb, env: deps.env });
        if (stored.kind !== 'connected' || stored.realmId !== input.realmId) return { ok: false as const };
        const generationId = await findLiveGenerationId(input.businessId, { db: tx as unknown as GenerationDb });
        return { ok: true as const, value: await fn(tx, { generationId, audit: stored.audit }) };
    }, { maxWait: 10_000, timeout: 15_000 });
}

/**
 * The live generation for the company `realmId` names, recorded once — with its evidence —
 * if this connection lifetime has none yet. null when the tenant is no longer connected to
 * that company.
 *
 * `readCompanyName` is a QuickBooks request: it runs only when a generation must be
 * recorded, and never inside a transaction.
 */
export async function ensureLiveGeneration(
    input: {
        businessId: string;
        realmId: string;
        environment: QuickBooksEnvironment;
        readCompanyName: () => Promise<string | null>;
    },
    deps: GenerationDeps = {},
): Promise<string | null> {
    const current = await withLiveConnection(input, deps, async (_tx, live) => live.generationId);
    if (!current.ok) return null;
    if (current.value) return current.value;

    const companyName = await input.readCompanyName();
    try {
        const recorded = await withLiveConnection(input, deps, async (tx, live) => {
            if (live.generationId) return live.generationId;
            const row = await tx.quickBooksConnection.create({
                data: {
                    business_id: input.businessId,
                    live_business_id: input.businessId,
                    live_provider: QUICKBOOKS_PROVIDER,
                    environment: input.environment,
                    company_name: companyName,
                    authorized_by: live.audit.by,
                    authorized_at: live.audit.at,
                },
                select: { id: true },
            });
            return row.id;
        });
        return recorded.ok ? recorded.value : null;
    } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        // A concurrent request recorded it first (one live generation per tenant).
        const again = await withLiveConnection(input, deps, async (_tx, live) => live.generationId);
        return again.ok ? again.value : null;
    }
}
