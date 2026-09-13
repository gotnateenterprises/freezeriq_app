/**
 * QB-INVOICE-1A — a connect attempt can be completed exactly once, on any server.
 *
 * Why: Intuit's authorization code is single-use, and a SECOND exchange of the
 * same code is answered with invalid_grant and may revoke the tokens the first
 * exchange just issued. A doubled browser redirect, a reload while the callback
 * is pending, or a retried request can land on two serverless instances at once,
 * each still carrying the attempt cookie. An in-memory "seen" set cannot stop
 * that, so the attempt is recorded in the database and consumed atomically.
 *
 * Storage, with no migration: one row per tenant in `integrations` under the
 * separate provider key 'quickbooks_oauth_attempt'. It holds only a SHA-256
 * digest of the attempt nonce (never the nonce, never a token) and the attempt's
 * expiry. Starting a new attempt replaces the row; completing one deletes it.
 * No generic integration reader lists this provider (status and disconnect use
 * explicit provider names), and it is never treated as a connection.
 */

import { prisma } from '@/lib/db';

export const QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER = 'quickbooks_oauth_attempt';

type Db = Pick<typeof prisma, 'integration'>;

async function digest(nonce: string): Promise<string> {
    const bytes = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`freezeriq/quickbooks-oauth-attempt/v1|${nonce}`)),
    );
    return 'sha256:' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Records the tenant's current attempt, replacing any earlier one. */
export async function recordOAuthAttempt(
    input: { businessId: string; nonce: string; expiresAt: Date },
    deps: { db?: Db; now?: () => number } = {},
): Promise<void> {
    const db = deps.db ?? prisma;
    const now = new Date((deps.now ?? Date.now)());
    const data = { access_token: await digest(input.nonce), refresh_token: null, realm_id: null, expires_at: input.expiresAt, updated_at: now };
    await db.integration.upsert({
        where: { business_id_provider: { business_id: input.businessId, provider: QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER } },
        update: data,
        create: { business_id: input.businessId, provider: QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER, ...data },
    });
}

/**
 * Consumes the attempt. True for exactly one caller — the delete is conditional
 * on the digest AND an unexpired row, so a replay, a second concurrent callback,
 * an attempt superseded by a newer connect, or an expired attempt all get false.
 */
export async function consumeOAuthAttempt(
    input: { businessId: string; nonce: string },
    deps: { db?: Db; now?: () => number } = {},
): Promise<boolean> {
    const db = deps.db ?? prisma;
    const res = await db.integration.deleteMany({
        where: {
            business_id: input.businessId,
            provider: QUICKBOOKS_OAUTH_ATTEMPT_PROVIDER,
            access_token: await digest(input.nonce),
            expires_at: { gt: new Date((deps.now ?? Date.now)()) },
        },
    });
    return res.count === 1;
}
