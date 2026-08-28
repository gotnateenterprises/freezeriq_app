/**
 * DEV-ENV-SAFETY-1.
 *
 * `next dev` loads `.env.local` (highest precedence below
 * `.env.development.local`) alongside `.env`, and in this repository
 * `.env.local` holds Production Supabase and Production R2 credentials —
 * the same infrastructure Vercel Production uses. BUNDLE-MEDIA-1 discovered
 * this the hard way: a "local" browser test session silently uploaded two
 * files to the real Production media bucket before a local-only business
 * id's absence from the Production database caused an unrelated foreign-key
 * constraint to refuse the accompanying write.
 *
 * `.env.development.local` (gitignored, per-developer) is the primary fix —
 * see .env.development.local.example. This module is the second layer:
 * a fail-fast check, run once at server startup, that refuses to start
 * `next dev` at all if it has resolved credentials pointing at known
 * Production infrastructure, regardless of why.
 *
 * Identification is by HOST/BUCKET IDENTIFIER ONLY. A hostname or bucket
 * name is not a credential — this module contains no secret of its own,
 * compares no full connection string, and never logs a credential value.
 */

/** Known Production identifiers. Not secrets — see the module comment. */
const PRODUCTION_DB_HOST = 'aws-1-us-east-1.pooler.supabase.com';
const PRODUCTION_S3_BUCKET = 'freezer-iq-assets';
const PRODUCTION_S3_ENDPOINT_HOST = '7a46c36cadff283b108c6ae67906a39f.r2.cloudflarestorage.com';

function hostOf(value: string | undefined): string | null {
    if (!value) return null;
    try {
        return new URL(value).hostname;
    } catch {
        return null;
    }
}

export interface ProductionTargetHit {
    variable: string;
    reason: string;
}

/**
 * Scans the given env (defaults to process.env) for values that resolve to
 * known Production hosts/buckets. Pure and side-effect free — used both by
 * the fail-fast guard and directly by tests.
 */
export function findProductionTargets(env: NodeJS.ProcessEnv = process.env): ProductionTargetHit[] {
    const hits: ProductionTargetHit[] = [];

    for (const variable of ['DATABASE_URL', 'DIRECT_URL'] as const) {
        if (hostOf(env[variable]) === PRODUCTION_DB_HOST) {
            hits.push({ variable, reason: 'targets the Production database host' });
        }
    }

    if (env.S3_BUCKET_NAME && env.S3_BUCKET_NAME === PRODUCTION_S3_BUCKET) {
        hits.push({ variable: 'S3_BUCKET_NAME', reason: 'targets the Production media bucket' });
    }
    if (hostOf(env.S3_ENDPOINT) === PRODUCTION_S3_ENDPOINT_HOST) {
        hits.push({ variable: 'S3_ENDPOINT', reason: 'targets the Production storage account' });
    }

    return hits;
}

/**
 * Throws if this process is running local development (`NODE_ENV ===
 * 'development'`, i.e. `next dev`) AND has resolved Production
 * infrastructure. A no-op for every other NODE_ENV, so it can never block
 * `next build`, `next start`, or a Vercel Preview/Production deployment —
 * all of which intentionally target real infrastructure.
 */
export function assertNotDevelopmentAgainstProduction(env: NodeJS.ProcessEnv = process.env): void {
    if (env.NODE_ENV !== 'development') return;

    const hits = findProductionTargets(env);
    if (hits.length === 0) return;

    throw new Error(
        [
            'Local development is configured to use Production services. ' +
                'Refusing to start write-capable dev environment.',
            ...hits.map((h) => `  - ${h.variable} ${h.reason}`),
            '',
            'Fix: copy .env.development.local.example to .env.development.local ' +
                'and fill in your local values — see docs/DEV_ENVIRONMENT_SAFETY.md.',
        ].join('\n')
    );
}
