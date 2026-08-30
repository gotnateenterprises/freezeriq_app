/**
 * OPS-0 / DEV-BOOTSTRAP-1.
 *
 * A narrower, stricter sibling of lib/devEnvGuard.ts. devEnvGuard blocks only
 * KNOWN Production identifiers for `next dev` — by design, a DIFFERENT
 * (non-Production) remote host is deliberately NOT flagged there, because
 * `next dev` itself never does anything more destructive than serving pages.
 *
 * The commands this module guards are different in kind: `prisma migrate
 * resolve`, `prisma migrate deploy`, and any future scripted database write.
 * Those can alter schema and data, so this module uses an ALLOWLIST, not a
 * denylist — only `localhost` / `127.0.0.1` pass. It reuses devEnvGuard's
 * `findProductionTargets` as a second, independent check rather than
 * defining a second, possibly-conflicting notion of "Production."
 *
 * Identification is by HOST ONLY. A hostname is not a credential — this
 * module contains no secret, compares no full connection string, and never
 * logs a password or a complete DATABASE_URL.
 */
import { findProductionTargets } from '@/lib/devEnvGuard';

export interface DbWriteTargetResult {
    ok: boolean;
    host: string | null;
    port: string | null;
    database: string | null;
    reason?: string;
}

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Classifies a single DATABASE_URL for write-capable local tooling. Pure and
 * side-effect free — takes the URL string directly, not an env object, so it
 * is directly testable with synthetic values (see tests/dbSafety1.test.ts).
 *
 * Deliberately does NOT read ambient process.env beyond the one value the
 * caller passes in. This repo's own .env is known to mix a local
 * DATABASE_URL with real Production S3 values (S3_BUCKET_NAME=
 * freezer-iq-assets) — an earlier version of this function spread the
 * ambient env into findProductionTargets and that unrelated S3 value made a
 * genuinely-local database URL get refused. Passing only the two DB keys
 * keeps this classifier answering exactly one question: is THIS URL
 * Production.
 */
export function classifyDbWriteTarget(databaseUrl: string | undefined): DbWriteTargetResult {
    if (!databaseUrl || databaseUrl.trim() === '') {
        return { ok: false, host: null, port: null, database: null, reason: 'DATABASE_URL is not set' };
    }

    let url: URL;
    try {
        url = new URL(databaseUrl);
    } catch {
        return { ok: false, host: null, port: null, database: null, reason: 'DATABASE_URL is not a valid URL' };
    }

    const host = url.hostname;
    const port = url.port || null;
    const database = url.pathname.replace(/^\//, '') || null;

    // Defense in depth: ask devEnvGuard's own Production-identification
    // logic too, so "what counts as a Production DB host" is never defined
    // twice in this codebase.
    const prodHits = findProductionTargets(
        { DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl } as unknown as NodeJS.ProcessEnv,
    );
    if (prodHits.length > 0) {
        return { ok: false, host, port, database, reason: 'targets known Production infrastructure' };
    }

    if (!ALLOWED_HOSTS.has(host)) {
        return { ok: false, host, port, database, reason: 'host is not on the local allowlist (localhost / 127.0.0.1)' };
    }

    return { ok: true, host, port, database };
}
