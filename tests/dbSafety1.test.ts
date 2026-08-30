/**
 * OPS-0 / DEV-BOOTSTRAP-1 — the write-capable local-DB allowlist gate.
 *
 * This is a stricter, narrower sibling of tests/devEnvSafety1.test.ts:
 * devEnvGuard blocks only KNOWN Production identifiers (a denylist, correct
 * for `next dev`, which is never destructive); this module gates commands
 * that CAN alter schema and data (`prisma migrate deploy`/`resolve`), so it
 * uses an ALLOWLIST — only `localhost` / `127.0.0.1` pass. Both existing
 * DEV-ENV-SAFETY tests and these must stay green; see the last describe
 * block below.
 *
 * `classifyDbWriteTarget` takes injected values rather than reading
 * process.env/files, so these tests never touch the real (gitignored)
 * .env — only synthetic values are used here.
 */

import { classifyDbWriteTarget } from '@/lib/dbSafety';

const PROD_DB = 'postgresql://user:FAKE_SECRET_TOKEN_ABC123@aws-1-us-east-1.pooler.supabase.com:6543/postgres';
const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:5432/freezer_iq';
const LOCALHOST_DB = 'postgresql://postgres:postgres@localhost:5432/freezer_iq';

// ===========================================================================
describe('1-2. local hosts are accepted', () => {
    it('127.0.0.1 is accepted', () => {
        const r = classifyDbWriteTarget(LOCAL_DB);
        expect(r.ok).toBe(true);
        expect(r.host).toBe('127.0.0.1');
    });

    it('localhost is accepted', () => {
        const r = classifyDbWriteTarget(LOCALHOST_DB);
        expect(r.ok).toBe(true);
        expect(r.host).toBe('localhost');
    });
});

// ===========================================================================
describe('3. Supabase (Production) is refused', () => {
    it('the known Production Supabase pooler host is refused', () => {
        const r = classifyDbWriteTarget(PROD_DB);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/Production/);
    });
});

// ===========================================================================
describe('4. known Production host is refused (independent of Supabase-specific wording)', () => {
    it('refuses via the shared devEnvGuard Production identifier, not a second definition', () => {
        const r = classifyDbWriteTarget(PROD_DB);
        expect(r.ok).toBe(false);
        expect(r.host).toBe('aws-1-us-east-1.pooler.supabase.com');
    });
});

// ===========================================================================
describe('5. an unknown public host is refused (allowlist, not denylist)', () => {
    it('a host that is neither Production nor local is still refused', () => {
        // This is the deliberate divergence from devEnvGuard: that module
        // would NOT flag this host (see devEnvSafety1.test.ts "a DIFFERENT
        // (non-Production) remote host is NOT flagged"). This module must,
        // because it gates destructive commands, not just `next dev`.
        const r = classifyDbWriteTarget('postgresql://user:pw@some-other-staging-host.example.com:5432/db');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/allowlist/);
    });
});

// ===========================================================================
describe('6. malformed DATABASE_URL is refused', () => {
    it('an unparseable value is refused, not thrown', () => {
        const r = classifyDbWriteTarget('not a url at all');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/valid URL/);
    });
});

// ===========================================================================
describe('7. missing DATABASE_URL fails closed', () => {
    it('undefined is refused', () => {
        const r = classifyDbWriteTarget(undefined);
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/not set/);
    });

    it('an empty string is refused', () => {
        const r = classifyDbWriteTarget('');
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/not set/);
    });
});

// ===========================================================================
describe('8. credentials never appear in the result', () => {
    it('the result object never carries the password or the full URL', () => {
        const r = classifyDbWriteTarget(PROD_DB);
        const serialized = JSON.stringify(r);
        expect(serialized).not.toContain('FAKE_SECRET_TOKEN_ABC123');
        expect(serialized).not.toContain(PROD_DB);
        expect(serialized).not.toMatch(/:[^:@/]*@/); // no user:password@ pattern
    });

    it('a local URL with credentials also never leaks them', () => {
        const r = classifyDbWriteTarget(LOCAL_DB);
        const serialized = JSON.stringify(r);
        expect(serialized).not.toContain('postgres:postgres@');
    });
});

// ===========================================================================
describe('9. the db:target/db:status/db:setup commands resolve to the expected local target', () => {
    it('lib/dbSafetyCli.ts prints redacted fields only, never a raw URL', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'dbSafetyCli.ts'), 'utf8');
        expect(src).toContain('classifyDbWriteTarget');
        expect(src).toContain('DATABASE HOST:');
        expect(src).not.toMatch(/console\.(log|error)\([^)]*process\.env\.DATABASE_URL\)/);
    });

    it('lib/dbSafetyCli.ts lives in a tracked directory, not the gitignored /scripts', () => {
        const { execSync } = require('child_process');
        let ignored = false;
        try {
            execSync('git check-ignore lib/dbSafetyCli.ts', { cwd: process.cwd() });
            ignored = true;
        } catch {
            ignored = false; // non-zero exit = not ignored
        }
        expect(ignored).toBe(false);
    });

    it('lib/dbSafetyCli.ts loads only .env, never .env.local or .env.development.local', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'dbSafetyCli.ts'), 'utf8');
        expect(src).toContain("path.join(process.cwd(), '.env')");
        // The comments discuss .env.local / .env.development.local BY NAME to
        // explain why they are deliberately not read — so assert on the actual
        // load call, not on the string appearing anywhere in the file at all.
        expect(src).not.toMatch(/readFileSync\([^)]*\.env\.local/);
        expect(src).not.toMatch(/readFileSync\([^)]*\.env\.development\.local/);
        expect(src).not.toMatch(/path\.join\([^)]*['"]\.env\.local['"]\)/);
        expect(src).not.toMatch(/path\.join\([^)]*['"]\.env\.development\.local['"]\)/);
    });

    it('package.json wires db:target, db:status and db:setup through the safety gate', () => {
        const pkg = require(require('path').join(process.cwd(), 'package.json'));
        expect(pkg.scripts['db:target']).toContain('dbSafetyCli');
        expect(pkg.scripts['db:status']).toContain('dbSafetyCli');
        expect(pkg.scripts['db:status']).toContain('prisma migrate status');
        expect(pkg.scripts['db:setup']).toContain('dbSafetyCli');
        expect(pkg.scripts['db:setup']).toContain('prisma migrate deploy');
        // Explicitly not db push — the committed migration history is authoritative.
        expect(pkg.scripts['db:setup']).not.toContain('db push');
    });

    it('db:setup is not wired into dev/postinstall — a future session must ask for it deliberately', () => {
        const pkg = require(require('path').join(process.cwd(), 'package.json'));
        expect(pkg.scripts.dev).not.toContain('db:setup');
        expect(pkg.scripts.postinstall).not.toContain('db:setup');
    });
});

// ===========================================================================
describe('regression: ambient Production S3 values must not refuse a local DATABASE_URL', () => {
    it('this repo .env mixes a local DATABASE_URL with S3_BUCKET_NAME=freezer-iq-assets (the real Production bucket) — proven live by npm run db:target during OPS-0, which initially refused a genuinely-local database because of it', () => {
        const originalBucket = process.env.S3_BUCKET_NAME;
        const originalEndpoint = process.env.S3_ENDPOINT;
        try {
            process.env.S3_BUCKET_NAME = 'freezer-iq-assets';
            process.env.S3_ENDPOINT = 'https://7a46c36cadff283b108c6ae67906a39f.r2.cloudflarestorage.com';
            const r = classifyDbWriteTarget(LOCAL_DB);
            expect(r.ok).toBe(true);
            expect(r.host).toBe('127.0.0.1');
        } finally {
            process.env.S3_BUCKET_NAME = originalBucket;
            process.env.S3_ENDPOINT = originalEndpoint;
        }
    });
});

// ===========================================================================
describe('10. existing DEV-ENV-SAFETY tests are unaffected', () => {
    it('devEnvGuard is imported, not reimplemented — one definition of "Production"', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'lib', 'dbSafety.ts'), 'utf8');
        expect(src).toContain("from '@/lib/devEnvGuard'");
        expect(src).toContain('findProductionTargets');
        // This module must not REDECLARE the Production host/bucket as its own
        // constant. The bucket name legitimately appears once, in a doc
        // comment explaining a bug this file's history already hit — so
        // assert there is no `const ... = 'freezer-iq-assets'`-shaped
        // redeclaration, not that the string never appears in prose.
        expect(src).not.toContain('aws-1-us-east-1.pooler.supabase.com');
        expect(src).not.toMatch(/=\s*['"]freezer-iq-assets['"]/);
        expect(src).not.toMatch(/PRODUCTION_S3_BUCKET/);
    });
});
