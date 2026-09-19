/**
 * QB-INVOICE-1B / 1C — a usable access token AND the live connection generation of the company it reaches.
 *
 * Moved unchanged from lib/quickbooks/customerLinks.ts (QB-INVOICE-1B) so the QB-INVOICE-1C invoice code
 * shares exactly the same rules:
 *   - the generation is read — or recorded, the first time — under the generation lock, which re-checks
 *     that the stored connection still reaches the token's company, so one generation can never be paired
 *     with another company;
 *   - an Accounting call refused with 401 is retried once with a refreshed token, and only if that token
 *     still reaches the SAME company (after a Forget and reconnect it would not, and the call is abandoned).
 *
 * Nothing here logs or returns a token, the realm id or a raw QuickBooks id.
 */

import { prisma } from '@/lib/db';
import type { QuickBooksConfig } from '@/lib/quickbooks/config';
import {
    getQuickBooksAccess,
    loadQuickBooksConnection,
    QuickBooksConnectionError,
    type Deps,
    type QuickBooksAccess,
} from '@/lib/quickbooks/connection';
import { ensureLiveGeneration, type GenerationDb, type GenerationDeps } from '@/lib/quickbooks/connectionGenerations';
import { fetchCompanyInfo, IntuitError, type FetchLike } from '@/lib/quickbooks/intuitClient';

export interface LiveConnectionDeps {
    db: Pick<typeof prisma, 'integration' | '$transaction' | 'quickBooksConnection'>;
    fetchImpl: FetchLike;
    env?: NodeJS.ProcessEnv;
    now: () => number;
    sleep?: (ms: number) => Promise<void>;
}

const connectorDeps = (d: LiveConnectionDeps): Deps => ({ db: d.db as any, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });
const generationDeps = (d: LiveConnectionDeps): GenerationDeps => ({ db: d.db as unknown as GenerationDb, env: d.env });

/** A refreshed access token reached a different company: a Forget and reconnect landed mid-request. */
export class ConnectionChangedError extends Error {
    constructor() {
        super('QuickBooks connection changed during the request');
        Object.setPrototypeOf(this, ConnectionChangedError.prototype); // ES5 target
        this.name = 'ConnectionChangedError';
    }
}

export interface LiveConnection {
    /** The live generation of the company `access` reaches. */
    connectionId: string;
    access: QuickBooksAccess;
}

export type ConnectionProblem = { state: 'not_connected' } | { state: 'reconnect_required' } | { state: 'unavailable' };

export const isConnectionProblem = (x: LiveConnection | ConnectionProblem): x is ConnectionProblem => 'state' in x;

export function connectionProblem(e: unknown): ConnectionProblem {
    if (e instanceof QuickBooksConnectionError) {
        if (e.kind === 'not_connected' || e.kind === 'disconnected') return { state: 'not_connected' };
        if (e.kind === 'refresh_failed' || e.kind === 'refresh_contended') return { state: 'unavailable' };
        return { state: 'reconnect_required' };
    }
    return { state: 'unavailable' };
}

/**
 * Runs an Accounting call, refreshing once if QuickBooks refuses a token it had not
 * expired. The refreshed token must reach the SAME company; after a Forget and a
 * reconnect it would not, and the call is abandoned.
 */
export async function withAccess<T>(
    businessId: string, config: QuickBooksConfig, holder: { access: QuickBooksAccess }, d: LiveConnectionDeps,
    call: (access: QuickBooksAccess) => Promise<T>,
): Promise<T> {
    try {
        return await call(holder.access);
    } catch (e) {
        if (!(e instanceof IntuitError) || e.kind !== 'unauthorized') throw e;
        const again = await getQuickBooksAccess({ businessId, config, rejectedAccessToken: holder.access.accessToken }, connectorDeps(d));
        if (again.realmId !== holder.access.realmId) throw new ConnectionChangedError();
        holder.access = again;
        return call(again);
    }
}

/**
 * A usable access token AND the live generation of the company it reaches, or why not.
 * The generation is read — or recorded, the first time — under the generation lock,
 * which re-checks that the stored connection still reaches the token's company, so one
 * generation can never be paired with another company.
 */
export async function liveConnection(businessId: string, config: QuickBooksConfig, d: LiveConnectionDeps): Promise<LiveConnection | ConnectionProblem> {
    const stored = await loadQuickBooksConnection(businessId, connectorDeps(d));
    if (stored.kind === 'none') return { state: 'not_connected' };
    if (stored.kind === 'unreadable') return { state: 'reconnect_required' };
    if (stored.kind === 'disconnected') return stored.reason === 'admin_disconnect' ? { state: 'not_connected' } : { state: 'reconnect_required' };

    let access: QuickBooksAccess;
    try {
        access = await getQuickBooksAccess({ businessId, config }, connectorDeps(d));
    } catch (e) {
        return connectionProblem(e);
    }
    const holder = { access };
    let connectionId: string | null;
    try {
        connectionId = await ensureLiveGeneration({
            businessId,
            realmId: access.realmId,
            environment: config.environment,
            readCompanyName: async () => (await withAccess(businessId, config, holder, d,
                (a) => fetchCompanyInfo(config, a.accessToken, a.realmId, d.fetchImpl))).companyName,
        }, generationDeps(d));
    } catch (e) {
        if (e instanceof QuickBooksConnectionError) return connectionProblem(e);
        if (e instanceof IntuitError || e instanceof ConnectionChangedError) {
            console.warn(`[quickbooks] connection generation unavailable: ${e instanceof IntuitError ? e.kind : 'connection_changed'}`);
            return { state: 'unavailable' };
        }
        throw e;
    }
    // null: no longer connected to that company (a Disconnect or Forget landed in between).
    if (!connectionId) return { state: 'unavailable' };
    return { connectionId, access: holder.access };
}
