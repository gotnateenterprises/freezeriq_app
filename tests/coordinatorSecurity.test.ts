/**
 * FR-COORD-SEC-1B — coordinator credential transport.
 *
 * The defect these tests exist to prevent: the coordinator credential travelled
 * in the URL path and query string, so Vercel's request log captured it on every
 * portal interaction. These assertions are mostly *source-level* on purpose —
 * the property being protected is "no credential ever reaches a URL", and that
 * is a property of the code that builds URLs, not of any single response.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import {
    mintCoordinatorSessionSecret,
    hashCoordinatorSessionSecret,
    digestsMatch,
    isSameOriginMutation,
    requiresSameOriginCheck,
    COORDINATOR_SESSION_SECRET_LENGTH,
    COORDINATOR_SESSION_TTL_MS,
    COORDINATOR_SESSION_COOKIE,
} from '@/lib/coordinatorSession';
import {
    buildCoordinatorAccessUrl,
    buildFundraiserUrls,
    CANONICAL_COORDINATOR_ORIGIN,
} from '@/lib/fundraiserUrls';
import { shouldSuppressAnalyticsUrl } from '@/components/analytics/SafeAnalytics';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every tracked runtime source file, so sweeps cannot miss a new offender. */
function walk(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name === '.next') continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, acc);
        else if (/\.(ts|tsx)$/.test(name)) acc.push(rel);
    }
    return acc;
}
const { execSync } = require('child_process');
/**
 * Files THIS phase owns: everything git tracks, plus the files it adds. Parked
 * untracked work (the password-reset branch) is deliberately excluded — it is
 * not part of this change set and must not be edited by it.
 */
const TRACKED = new Set(
    execSync('git ls-files app lib components', { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
);
const ADDED = [
    'lib/coordinatorSession.ts',
    'app/api/coordinator/session/route.ts',
    'app/coordinator/access/page.tsx',
    'app/coordinator/portal/page.tsx',
    'app/coordinator/portal/guide/page.tsx',
    'app/coordinator/[token]/page.tsx',
    'app/api/coordinator/route.ts',
    'app/api/coordinator/bundle-selection/route.ts',
    'app/api/coordinator/generate/route.ts',
    'app/api/coordinator-actions/summary/route.ts',
    'app/api/campaign-assets/route.ts',
    'app/api/promo-scripts/route.ts',
    'components/analytics/SafeAnalytics.tsx',
];
const RUNTIME = [...walk('app'), ...walk('lib'), ...walk('components')]
    .filter((f) => TRACKED.has(f) || ADDED.includes(f));
/** Comments describe the old defect on purpose; only code counts. */
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
        .split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

// ── Session secret ───────────────────────────────────────────────────────────

describe('coordinator session secret', () => {
    it('is 256 bits of base64url', () => {
        const s = mintCoordinatorSessionSecret();
        expect(s).toHaveLength(COORDINATOR_SESSION_SECRET_LENGTH);
        expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('never repeats across a large sample', () => {
        const seen = new Set(Array.from({ length: 2000 }, () => mintCoordinatorSessionSecret()));
        expect(seen.size).toBe(2000);
    });

    it('is stored only as a digest, and the digest does not contain the secret', () => {
        const secret = mintCoordinatorSessionSecret();
        const digest = hashCoordinatorSessionSecret(secret);
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
        expect(digest).not.toContain(secret);
        expect(hashCoordinatorSessionSecret(secret)).toBe(digest); // deterministic
        expect(hashCoordinatorSessionSecret(mintCoordinatorSessionSecret())).not.toBe(digest);
    });

    it('compares digests without leaking length or content', () => {
        const a = hashCoordinatorSessionSecret('a');
        expect(digestsMatch(a, a)).toBe(true);
        expect(digestsMatch(a, hashCoordinatorSessionSecret('b'))).toBe(false);
        expect(digestsMatch(a, 'short')).toBe(false);
    });

    it('uses a fixed 24-hour lifetime', () => {
        expect(COORDINATOR_SESSION_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('names the production cookie with the __Host- prefix', () => {
        // __Host- is browser-enforced: it REQUIRES Secure, Path=/ and no Domain.
        expect(COORDINATOR_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    });
});

// ── CSRF ─────────────────────────────────────────────────────────────────────

describe('same-origin defence for state-changing coordinator requests', () => {
    const req = (method: string, origin: string | null) =>
        new Request('https://www.freezeriqapp.com/api/coordinator', {
            method,
            ...(origin ? { headers: { origin } } : {}),
        });

    it('classifies mutations, and only mutations', () => {
        for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(requiresSameOriginCheck(m)).toBe(true);
        for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(requiresSameOriginCheck(m)).toBe(false);
    });

    it('accepts a same-origin mutation', () => {
        expect(isSameOriginMutation(req('POST', 'https://www.freezeriqapp.com'))).toBe(true);
    });

    it('rejects a cross-origin mutation', () => {
        expect(isSameOriginMutation(req('POST', 'https://evil.example.com'))).toBe(false);
    });

    it('rejects a mutation with no Origin header', () => {
        // A browser always sends Origin on POST/PUT/PATCH/DELETE, so its absence
        // is not a normal browser request.
        expect(isSameOriginMutation(req('POST', null))).toBe(false);
    });

    it('rejects a malformed Origin', () => {
        expect(isSameOriginMutation(req('POST', 'not-a-url'))).toBe(false);
    });

    it('is not fooled by a look-alike host', () => {
        expect(isSameOriginMutation(req('POST', 'https://www.freezeriqapp.com.evil.example')))
            .toBe(false);
    });
});

// ── Link format ──────────────────────────────────────────────────────────────

describe('the coordinator link', () => {
    const CRED = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

    it('puts the credential after the fragment marker and nowhere else', () => {
        const url = buildCoordinatorAccessUrl(null, CRED);
        const parsed = new URL(url);
        expect(parsed.pathname).toBe('/coordinator/access');
        expect(parsed.search).toBe('');
        expect(parsed.pathname).not.toContain(CRED);
        expect(parsed.search).not.toContain(CRED);
        expect(parsed.hash).toBe(`#${CRED}`);
    });

    it('is the ONLY part of the URL a server would receive', () => {
        // Everything before '#' is what goes on the wire.
        const url = buildCoordinatorAccessUrl(null, CRED);
        const onTheWire = url.split('#')[0];
        expect(onTheWire).not.toContain(CRED);
        // The origin varies by environment; what must never vary is that the
        // wire portion ends at /coordinator/access and carries no secret.
        expect(onTheWire.endsWith('/coordinator/access')).toBe(true);
        expect(CANONICAL_COORDINATOR_ORIGIN).toBe('https://www.freezeriqapp.com');
    });

    it('never produces the retired /coordinator/<token> shape', () => {
        const url = buildCoordinatorAccessUrl(null, CRED);
        expect(url).not.toMatch(/\/coordinator\/[^#]*abcdef/);
        expect(url).not.toContain(`?token=`);
    });

    it('routes buildFundraiserUrls through the same builder', () => {
        const urls = buildFundraiserUrls('https://example.test', { portalToken: CRED, publicToken: 'pub' });
        for (const u of [urls.coordinatorUrl, urls.coordinatorGuideUrl]) {
            expect(u!.split('#')[0]).not.toContain(CRED);
            expect(u).toContain('/coordinator/access#');
        }
        // The public scoreboard link is a different, deliberately public thing.
        expect(urls.publicUrl).toBe('https://example.test/fundraiser/pub');
    });
});

// ── Transport proof (PART W) ─────────────────────────────────────────────────

describe('no coordinator credential reaches any URL', () => {
    it('no runtime source builds /coordinator/<token>', () => {
        const bad = RUNTIME.filter((f) => /`[^`]*\/coordinator\/\$\{[^}]*(token|credential)[^}]*\}/.test(code(read(f))));
        expect(bad).toEqual([]);
    });

    it('no runtime source builds a ?token= query', () => {
        const bad = RUNTIME.filter((f) => /\?token=\$\{/.test(code(read(f))));
        expect(bad).toEqual([]);
    });

    it('no coordinator API path is built from a credential', () => {
        const bad = RUNTIME.filter((f) => /\/api\/coordinator[^`'"]*\$\{[^}]*token/.test(code(read(f))));
        expect(bad).toEqual([]);
    });

    it('the coordinator API surface takes no [token] path segment', () => {
        for (const p of [
            'app/api/coordinator/[token]',
            'app/api/coordinator-actions/[token]',
            'app/api/campaign-assets/[token]',
            'app/api/promo-scripts/[token]',
        ]) expect(existsSync(join(ROOT, p))).toBe(false);
    });

    it('the exchange endpoint accepts the credential only in the body', () => {
        const s = code(read('app/api/coordinator/session/route.ts'));
        expect(s).toContain('await req.json()');
        expect(s).toMatch(/body as any\)\.credential|\(body as any\)\.credential/);
        // Never from the URL or a header.
        expect(s).not.toMatch(/searchParams\.get\(\s*['"]credential/);
        expect(s).not.toMatch(/params.*credential/);
        expect(s).not.toMatch(/headers\.get\(\s*['"]authorization/i);
    });

    it('the exchange never echoes or logs the credential', () => {
        const s = code(read('app/api/coordinator/session/route.ts'));
        expect(s).not.toMatch(/console\.(log|info|debug|warn|error)\([^)]*credential/);
        expect(s).not.toMatch(/json\(\s*\{[^}]*credential/);
    });
});

// ── Client storage proof (PART X) ────────────────────────────────────────────

describe('the credential is never persisted or displayed client-side', () => {
    const access = code(read('app/coordinator/access/page.tsx'));

    it('writes nothing to localStorage or sessionStorage', () => {
        expect(access).not.toContain('localStorage');
        expect(access).not.toContain('sessionStorage');
    });

    it('never sets a cookie from client JavaScript', () => {
        expect(access).not.toContain('document.cookie');
    });

    it('never logs the credential', () => {
        expect(access).not.toMatch(/console\.\w+\([^)]*credential/);
    });

    it('strips the fragment with replaceState before the network call', () => {
        expect(access).toContain('history.replaceState');
        const strip = access.indexOf('history.replaceState');
        const post = access.indexOf("fetch('/api/coordinator/session'");
        expect(strip).toBeGreaterThanOrEqual(0);
        expect(post).toBeGreaterThanOrEqual(0);
        expect(strip).toBeLessThan(post);
    });

    it('sends the credential in a request body, never a URL', () => {
        expect(access).toMatch(/body: JSON\.stringify\(\{ credential \}\)/);
        expect(access).not.toMatch(/fetch\(`[^`]*\$\{credential\}/);
    });

    it('never renders the credential', () => {
        // JSX interpolation only — JSON.stringify({ credential }) is the body
        // of the exchange request, which is exactly where it belongs.
        expect(access).not.toMatch(/>\s*\{\s*credential\s*\}/);
        expect(access).not.toMatch(/value=\{\s*credential\s*\}/);
        expect(access).not.toMatch(/dangerouslySetInnerHTML/);
    });

    it('no coordinator source logs a credential or cookie', () => {
        const coordinator = RUNTIME.filter((f) => /coordinator/i.test(f));
        const bad = coordinator.filter((f) =>
            /console\.\w+\([^)]*\b(portal_token|portalToken|credential|downloadToken|session_hash)\b/.test(code(read(f))));
        expect(bad).toEqual([]);
    });
});

// ── Analytics (PART AB) ──────────────────────────────────────────────────────

describe('analytics cannot receive a coordinator credential', () => {
    it('suppresses the access page, fragment and all', () => {
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/coordinator/access#SECRET')).toBe(true);
    });

    it('suppresses the tokenless portal', () => {
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/coordinator/portal')).toBe(true);
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/coordinator/portal/guide')).toBe(true);
    });

    it('suppresses a legacy bookmarked /coordinator/<token>', () => {
        expect(shouldSuppressAnalyticsUrl('https://www.freezeriqapp.com/coordinator/LEGACY-TOKEN-VALUE')).toBe(true);
    });

    it('leaves the rest of the site measurable', () => {
        for (const u of [
            'https://www.freezeriqapp.com/',
            'https://www.freezeriqapp.com/shop/bob-test',
            'https://www.freezeriqapp.com/fundraisers',
            'https://www.freezeriqapp.com/coordinators-guide', // near-miss, not the prefix
        ]) expect(shouldSuppressAnalyticsUrl(u)).toBe(false);
    });

    it('fails closed on an unparseable url', () => {
        expect(shouldSuppressAnalyticsUrl('::::')).toBe(true);
    });

    it('is actually wired into the layout', () => {
        const layout = code(read('app/layout.tsx'));
        expect(layout).toContain('SafeAnalytics');
        // The raw component would report location.href, fragment included.
        expect(layout).not.toMatch(/<Analytics\s*\/>/);
    });
});

// ── Legacy retirement (PART Z) ───────────────────────────────────────────────

describe('the legacy bearer route is retired, not repaired', () => {
    const legacy = code(read('app/coordinator/[token]/page.tsx'));

    it('does not read the token', () => {
        expect(legacy).not.toContain('useParams');
        expect(legacy).not.toMatch(/params/);
    });

    it('does not query the credential', () => {
        expect(legacy).not.toContain('portal_token');
        expect(legacy).not.toContain('prisma');
    });

    it('does not exchange or redirect on the value', () => {
        expect(legacy).not.toContain('/api/coordinator/session');
        expect(legacy).not.toContain('redirect');
        expect(legacy).not.toContain('router');
    });

    it('is not an existence oracle — one message for everybody', () => {
        expect(legacy).toContain('no longer valid');
        expect(legacy).not.toMatch(/not found|unknown campaign|expired|revoked/i);
    });
});

// ── Failure UX (PART Q) ──────────────────────────────────────────────────────

describe('failure messaging is indistinguishable', () => {
    it('uses one message for invalid, rotated, revoked and expired', () => {
        const access = read('app/coordinator/access/page.tsx');
        const legacy = read('app/coordinator/[token]/page.tsx');
        for (const s of [access, legacy]) expect(s).toContain('no longer valid');
        // A connection failure is a genuinely different thing and says so.
        expect(access).toContain("couldn&apos;t connect");
    });

    it('the exchange returns one generic refusal', () => {
        const s = code(read('app/api/coordinator/session/route.ts'));
        const refusals = s.match(/status: 401/g) || [];
        expect(refusals.length).toBeGreaterThanOrEqual(1);
        expect(s).not.toMatch(/campaign not found|no such|unknown credential/i);
    });
});


// ── Portal-token generation contract (PART K) ────────────────────────────────

/**
 * FR-COORD-SEC-1C-R — this replaces a VACUOUS test.
 *
 * The earlier assertion read `information_schema.columns.column_default IS NULL`
 * for fundraiser_campaigns.portal_token and called that proof the weak generator
 * was retired. It proved nothing: Prisma's `@default(cuid())` is generated by
 * the CLIENT, never by PostgreSQL, so that column has always reported a NULL
 * database default — before this phase and after it. The assertion passed either
 * way, which is the definition of vacuous.
 *
 * The real protection lives in two places, and both are asserted here:
 *   1. the Prisma schema no longer declares a default on portal_token, so the
 *      client cannot mint one silently;
 *   2. every runtime create path passes mintCoordinatorPortalToken() explicitly.
 *
 * A NEGATIVE CONTROL proves the guard can actually fail: the same guard run
 * against a reconstructed insecure schema line must reject it.
 */
describe('portal_token generation contract', () => {
    /** Extract a model's field line, whitespace-normalised. */
    const fieldLine = (schema: string, model: string, field: string): string | null => {
        const m = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`, 'm'));
        if (!m) return null;
        for (const raw of m[1].split(/\r?\n/)) {
            const line = raw.replace(/\/\/.*$/, '').trim();
            if (new RegExp(`^${field}\\s`).test(line)) return line.replace(/\s+/g, ' ');
        }
        return null;
    };

    /** THE GUARD: a coordinator credential field must declare no default. */
    const declaresNoDefault = (line: string | null): boolean =>
        line !== null && !/@default\(/.test(line);

    const schema = read('prisma/schema.prisma');

    it('portal_token declares no @default in the released schema', () => {
        const line = fieldLine(schema, 'FundraiserCampaign', 'portal_token');
        expect(line).toBe('portal_token String? @unique');
        expect(declaresNoDefault(line)).toBe(true);
    });

    it('NEGATIVE CONTROL — the same guard rejects the pre-fix declaration', () => {
        // Exactly what the schema said before this phase. If the guard cannot
        // fail here, it cannot be trusted when it passes above.
        expect(declaresNoDefault('portal_token String? @unique @default(cuid())')).toBe(false);
        expect(declaresNoDefault('portal_token String? @unique @default(uuid())')).toBe(false);
        expect(declaresNoDefault(null)).toBe(false);
    });

    it('public_token is deliberately unchanged and still carries its default', () => {
        // Out of scope for this phase: it guards a deliberately public page.
        const line = fieldLine(schema, 'FundraiserCampaign', 'public_token');
        expect(line).toBe('public_token String? @unique @default(cuid())');
    });

    it('every runtime campaign-create path mints a strong credential explicitly', () => {
        const runtime = RUNTIME.filter((f) => /^app\/api\//.test(f));
        const creators = runtime.filter((f) => /fundraiserCampaign\.create\b/.test(code(read(f))));

        // Positive expectation first: this sweep must actually find the creators,
        // otherwise the per-file assertion below would pass by finding nothing.
        expect(creators.length).toBeGreaterThanOrEqual(2);
        expect(creators).toEqual(expect.arrayContaining([
            'app/api/campaigns/route.ts',
            'app/api/fundraisers/upload/route.ts',
        ]));

        for (const f of creators) {
            const src = code(read(f));
            const creates = (src.match(/fundraiserCampaign\.create\b/g) || []).length;
            const mints = (src.match(/portal_token: mintCoordinatorPortalToken\(\)/g) || []).length;
            // One explicit mint per create. Fewer would mean a path relying on a
            // default that no longer exists — a NULL coordinator credential.
            expect({ file: f, creates, mints }).toEqual({ file: f, creates, mints: creates });
        }
    });

    it('no runtime path inserts a campaign through raw SQL', () => {
        const bad = RUNTIME.filter((f) => /INSERT\s+INTO\s+"?fundraiser_campaigns/i.test(code(read(f))));
        expect(bad).toEqual([]);
    });

    it('the migration contains no portal_token SQL, because there is no DB default to drop', () => {
        const sql = read('prisma/migrations/20260818000000_fr_coord_sec_1b_coordinator_session/migration.sql')
            .split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
        expect(sql).not.toMatch(/portal_token/);
        expect(sql).not.toMatch(/DROP DEFAULT/);
        expect(sql).not.toMatch(/ALTER COLUMN/);
        // What it SHOULD contain.
        expect(sql).toMatch(/CREATE TABLE "coordinator_sessions"/);
    });
});

// ── Retired guide route (PART J) ─────────────────────────────────────────────

describe('the legacy guide route is retired the same way as the portal route', () => {
    const guide = code(read('app/coordinator/[token]/guide/page.tsx'));
    const portal = code(read('app/coordinator/[token]/page.tsx'));

    it('exists, so old bookmarks get the neutral page instead of a 404', () => {
        expect(existsSync(join(ROOT, 'app/coordinator/[token]/guide/page.tsx'))).toBe(true);
    });

    it('does not read the token', () => {
        expect(guide).not.toContain('useParams');
        expect(guide).not.toMatch(/params/);
    });

    it('does not query the credential or the database', () => {
        expect(guide).not.toContain('portal_token');
        expect(guide).not.toContain('prisma');
    });

    it('does not exchange or redirect on the value', () => {
        expect(guide).not.toContain('/api/coordinator/session');
        expect(guide).not.toContain('redirect');
        expect(guide).not.toContain('router');
    });

    it('is static, so no server code reads the path to render it', () => {
        expect(guide).toMatch(/force-static/);
    });

    it('shows the SAME neutral message as the retired portal route', () => {
        expect(guide).toContain('no longer valid');
        expect(portal).toContain('no longer valid');
        expect(guide).not.toMatch(/not found|unknown campaign|expired|revoked/i);
    });
});
