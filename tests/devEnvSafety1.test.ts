/**
 * DEV-ENV-SAFETY-1 — refuse to start `next dev` against Production.
 *
 * The defect this closes: `next dev` loads `.env.local` (Production
 * Supabase + Production R2) with higher precedence than `.env` (genuinely
 * local values), so an ordinary local dev session has always silently
 * resolved Production credentials. BUNDLE-MEDIA-1 hit this directly — two
 * test images reached the real Production media bucket before a database
 * foreign-key constraint, not anything in this repo, blocked the
 * accompanying write.
 *
 * `findProductionTargets`/`assertNotDevelopmentAgainstProduction` take an
 * injected env object specifically so these tests never read or depend on
 * the real (gitignored, per-developer) .env.development.local — only
 * synthetic values are used here.
 */

import { findProductionTargets, assertNotDevelopmentAgainstProduction, type ProductionTargetHit } from '@/lib/devEnvGuard';

const PROD_DB = 'postgresql://user:FAKE_SECRET_TOKEN_ABC123@aws-1-us-east-1.pooler.supabase.com:6543/postgres';
const PROD_S3_ENDPOINT = 'https://7a46c36cadff283b108c6ae67906a39f.r2.cloudflarestorage.com';
const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:5432/freezer_iq';

const safeEnv = (): NodeJS.ProcessEnv => ({
    NODE_ENV: 'development',
    DATABASE_URL: LOCAL_DB,
    DIRECT_URL: LOCAL_DB,
    S3_BUCKET_NAME: '',
    S3_ENDPOINT: '',
});

// ===========================================================================
describe('1. development + Production DB target is rejected', () => {
    it('DATABASE_URL pointing at the Production host throws', () => {
        const env = { ...safeEnv(), DATABASE_URL: PROD_DB };
        expect(() => assertNotDevelopmentAgainstProduction(env)).toThrow(/Production/);
    });

    it('DIRECT_URL pointing at the Production host throws, independent of DATABASE_URL', () => {
        const env = { ...safeEnv(), DIRECT_URL: PROD_DB };
        expect(() => assertNotDevelopmentAgainstProduction(env)).toThrow(/Production/);
    });

    it('findProductionTargets names the exact variable and reason', () => {
        const hits = findProductionTargets({ ...safeEnv(), DATABASE_URL: PROD_DB });
        expect(hits).toContainEqual<ProductionTargetHit>({
            variable: 'DATABASE_URL', reason: 'targets the Production database host',
        });
    });

    it('a DIFFERENT (non-Production) remote host is NOT flagged — this is not a blanket "no remote DB" rule', () => {
        const env = { ...safeEnv(), DATABASE_URL: 'postgresql://user:pw@some-other-staging-host.example.com:5432/db' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).not.toThrow();
    });
});

// ===========================================================================
describe('2. development + Production storage target is rejected', () => {
    it('S3_BUCKET_NAME matching the Production bucket name throws', () => {
        const env = { ...safeEnv(), S3_BUCKET_NAME: 'freezer-iq-assets' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).toThrow(/Production/);
    });

    it('S3_ENDPOINT matching the Production R2 account throws even with a different bucket name', () => {
        const env = { ...safeEnv(), S3_ENDPOINT: PROD_S3_ENDPOINT, S3_BUCKET_NAME: 'some-other-name' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).toThrow(/Production/);
    });

    it('an empty S3_BUCKET_NAME (the local-fallback signal) is NOT flagged', () => {
        const env = { ...safeEnv(), S3_BUCKET_NAME: '' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).not.toThrow();
    });

    it('a differently-named bucket at a different endpoint is NOT flagged', () => {
        const env = { ...safeEnv(), S3_BUCKET_NAME: 'my-dev-bucket', S3_ENDPOINT: 'https://dev.example-r2.com' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).not.toThrow();
    });
});

// ===========================================================================
describe('3. safe local/dev configuration is accepted', () => {
    it('the recommended local template shape passes cleanly', () => {
        expect(() => assertNotDevelopmentAgainstProduction(safeEnv())).not.toThrow();
        expect(findProductionTargets(safeEnv())).toEqual([]);
    });

    it('a config missing DATABASE_URL entirely does not throw (that is a different, unrelated failure mode)', () => {
        const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
        expect(() => assertNotDevelopmentAgainstProduction(env)).not.toThrow();
    });
});

// ===========================================================================
describe('4. Production build/runtime is never rejected', () => {
    it('NODE_ENV=production with Production hosts does not throw — must not break Vercel', () => {
        const env = { NODE_ENV: 'production', DATABASE_URL: PROD_DB, S3_BUCKET_NAME: 'freezer-iq-assets', S3_ENDPOINT: PROD_S3_ENDPOINT };
        expect(() => assertNotDevelopmentAgainstProduction(env)).not.toThrow();
    });

    it('the guard is a pure no-op for any NODE_ENV other than "development"', () => {
        for (const nodeEnv of ['production', 'test', undefined, 'staging']) {
            const env = { NODE_ENV: nodeEnv, DATABASE_URL: PROD_DB, S3_BUCKET_NAME: 'freezer-iq-assets' };
            expect(() => assertNotDevelopmentAgainstProduction(env as NodeJS.ProcessEnv)).not.toThrow();
        }
    });
});

// ===========================================================================
describe('5. Preview behavior is unaffected', () => {
    it('Vercel Preview runs with NODE_ENV=production, same as Production — already covered by (4)', () => {
        // Vercel sets NODE_ENV=production for `next start` regardless of the
        // Preview/Production distinction; the guard's gate is on NODE_ENV,
        // not on VERCEL_ENV, so Preview is provably unaffected by the same
        // no-op path proven above. This test documents that reasoning.
        const env = { NODE_ENV: 'production', VERCEL_ENV: 'preview', DATABASE_URL: PROD_DB };
        expect(() => assertNotDevelopmentAgainstProduction(env as NodeJS.ProcessEnv)).not.toThrow();
    });
});

// ===========================================================================
describe('6. no secret values appear in thrown errors or logs', () => {
    it('the thrown error never contains the actual connection string or embedded credential', () => {
        const env = { ...safeEnv(), DATABASE_URL: PROD_DB };
        let message = '';
        try {
            assertNotDevelopmentAgainstProduction(env);
        } catch (e: any) {
            message = e.message;
        }
        expect(message).not.toBe('');
        expect(message).not.toContain('FAKE_SECRET_TOKEN_ABC123');
        expect(message).not.toContain(PROD_DB);
    });

    it('the error names only the variable and a human reason, never a value', () => {
        const env = { ...safeEnv(), DATABASE_URL: PROD_DB, S3_BUCKET_NAME: 'freezer-iq-assets' };
        try {
            assertNotDevelopmentAgainstProduction(env);
            throw new Error('expected assertNotDevelopmentAgainstProduction to throw');
        } catch (e: any) {
            expect(e.message).toContain('DATABASE_URL');
            expect(e.message).toContain('S3_BUCKET_NAME');
            expect(e.message).not.toMatch(/postgresql:\/\//);
            expect(e.message).not.toMatch(/:[^:@/]*@/); // no user:password@ pattern
        }
    });

    it('findProductionTargets return values never carry a raw variable value, only variable name + reason', () => {
        const hits = findProductionTargets({ ...safeEnv(), DATABASE_URL: PROD_DB });
        for (const hit of hits) {
            expect(Object.keys(hit).sort()).toEqual(['reason', 'variable']);
            expect(hit.reason).not.toContain('FAKE_SECRET_TOKEN_ABC123');
        }
    });
});

// ===========================================================================
describe('wiring: instrumentation.ts calls the guard at startup', () => {
    it('instrumentation.ts imports and invokes assertNotDevelopmentAgainstProduction, gated to the nodejs runtime', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'instrumentation.ts'), 'utf8');
        expect(src).toContain('assertNotDevelopmentAgainstProduction');
        expect(src).toContain("NEXT_RUNTIME === 'nodejs'");
        expect(src).toContain('export async function register()');
    });

    it('instrumentation.ts calls the guard with NO argument, so it reads real process.env at runtime', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), 'instrumentation.ts'), 'utf8');
        expect(src).toMatch(/assertNotDevelopmentAgainstProduction\(\s*\)/);
    });
});

// ===========================================================================
describe('the committed template documents the fix without any real secret', () => {
    it('.env.development.local.example exists, uses placeholder local values, and leaves S3 blank', () => {
        const src = require('fs').readFileSync(
            require('path').join(process.cwd(), '.env.development.local.example'), 'utf8');
        expect(src).toContain('127.0.0.1');
        expect(src).not.toContain('aws-1-us-east-1.pooler.supabase.com');
        expect(src).not.toContain('7a46c36cadff283b108c6ae67906a39f');
        expect(src).toMatch(/^S3_BUCKET_NAME=\s*$/m);
    });

    it('the template is not itself gitignored (it must be committed to be useful)', () => {
        const { execSync } = require('child_process');
        let ignored = false;
        try {
            execSync('git check-ignore .env.development.local.example', { cwd: process.cwd() });
            ignored = true;
        } catch {
            ignored = false; // non-zero exit = not ignored
        }
        expect(ignored).toBe(false);
    });
});

// ===========================================================================
describe('integration: reads real process.env when called with no argument', () => {
    const ORIGINAL = { ...process.env };
    afterEach(() => { process.env = { ...ORIGINAL }; });

    it('honors process.env when no env is injected', () => {
        process.env.NODE_ENV = 'development';
        process.env.DATABASE_URL = LOCAL_DB;
        process.env.DIRECT_URL = LOCAL_DB;
        process.env.S3_BUCKET_NAME = '';
        expect(() => assertNotDevelopmentAgainstProduction()).not.toThrow();

        process.env.DATABASE_URL = PROD_DB;
        expect(() => assertNotDevelopmentAgainstProduction()).toThrow(/Production/);
    });
});
