/**
 * COORD-MANUAL-EMAIL-1D — the coordinator Preview → Production host escape.
 *
 * THE DEFECT
 *
 * An owner testing a Vercel Preview opened the CRM on the Preview host, clicked
 * "Coordinator portal", and silently landed on PRODUCTION
 * (https://www.freezeriqapp.com/coordinator/portal). Production is pinned to an
 * older release, so the modal they inspected genuinely has no Email field —
 * three phases of "the field is in the source" were all true and all irrelevant,
 * because the source they were running was not the source under test.
 *
 * The escape is one line of environment detection:
 *
 *     if (process.env.NODE_ENV === 'production') return CANONICAL_COORDINATOR_ORIGIN;
 *
 * NODE_ENV is 'production' for every production BUILD, and Vercel builds a
 * Preview deployment exactly the way it builds Production. So on a Preview,
 * that branch is taken and every coordinator link the CRM renders points at
 * the real production domain. The comment directly beneath it — "Dev/preview:
 * follow the caller so localhost and preview URLs work" — states the intent
 * the check defeats.
 *
 * THE FIX, AND WHY IT IS SHAPED THIS WAY
 *
 * The pin is deliberate and stays: coordinator links that get DISTRIBUTED
 * (the invitation email, outreach unsubscribe links) must never carry an
 * ephemeral, SSO-protected preview host, because those links outlive the
 * session that made them. lib/fundraiserUrls.ts documents that reasoning and
 * this phase does not touch it.
 *
 * What changes is only the link an ADMIN clicks to open a portal in the browser
 * they are already using. That link becomes host-relative, which is correct by
 * construction rather than by environment detection:
 *
 *   - the CRM (/fundraisers) is only reachable on a PLATFORM host — middleware
 *     rewrites every non-platform host into app/[domain] and /fundraisers is
 *     not in its bypass list;
 *   - isPlatformHost() counts exactly www.freezeriqapp.com, *.vercel.app and
 *     localhost — i.e. one platform host per environment;
 *   - the coordinator session cookie is `__Host-` prefixed and host-only, so
 *     it must live on the platform host the admin is actually using.
 *
 * A host-relative link therefore lands on the canonical domain in Production,
 * on the same Preview deployment in Preview, and on localhost in development —
 * with no NODE_ENV/VERCEL_ENV guessing and no server/client hydration mismatch,
 * and it matches every sibling link in those same components, which are all
 * already relative.
 */
import fs from 'fs';
import path from 'path';
import {
    buildCoordinatorAccessUrl,
    coordinatorAccessPath,
    resolveCoordinatorOrigin,
    resolveOutreachOrigin,
    CANONICAL_COORDINATOR_ORIGIN,
} from '@/lib/fundraiserUrls';
import { isPlatformHost } from '@/lib/platformHosts';

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';
const PREVIEW_ORIGIN = 'https://freezeriq-example-preview.vercel.app';
const PRODUCTION_ORIGIN = 'https://www.freezeriqapp.com';
const TENANT_DOMAIN = 'https://myfreezerchef.com';
const LOCALHOST_ORIGIN = 'http://localhost:3000';

/** The CRM page an admin clicks the coordinator link from. */
const CRM_PAGE_PATH = '/fundraisers';

/** Run `fn` with NODE_ENV forced, then restore it exactly. */
function withNodeEnv<T>(value: string, fn: () => T): T {
    const previous = process.env.NODE_ENV;
    try {
        (process.env as Record<string, string | undefined>).NODE_ENV = value;
        return fn();
    } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = previous;
    }
}

const CRM_CALL_SITES = [
    'components/crm2/CampaignCard.tsx',
    'components/crm2/CampaignPriorityList.tsx',
    'components/crm2/CampaignContextDrawer.tsx',
];

// ═════════════════════════════════════════════════════════════════════════════
// 1. The defect itself, proven behaviourally.
// ═════════════════════════════════════════════════════════════════════════════
describe('1. why a Preview admin escaped to Production', () => {
    it('a production BUILD ignores a preview origin entirely and returns the canonical production origin', () => {
        // This is what runs on a Vercel Preview: NODE_ENV === 'production'.
        const resolved = withNodeEnv('production', () => resolveCoordinatorOrigin(PREVIEW_ORIGIN));
        expect(resolved).toBe(CANONICAL_COORDINATOR_ORIGIN);
        expect(resolved).not.toBe(PREVIEW_ORIGIN);
    });

    it('so the absolute builder hands a Preview admin a Production link', () => {
        const url = withNodeEnv('production', () => buildCoordinatorAccessUrl(PREVIEW_ORIGIN, TOKEN));
        expect(new URL(url).origin).toBe(PRODUCTION_ORIGIN);
    });

    it('NODE_ENV cannot distinguish Preview from Production — both are production builds', () => {
        const onPreview = withNodeEnv('production', () => resolveCoordinatorOrigin(PREVIEW_ORIGIN));
        const onProduction = withNodeEnv('production', () => resolveCoordinatorOrigin(PRODUCTION_ORIGIN));
        expect(onPreview).toBe(onProduction);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Required behaviour — Part 5 cases A-F, tested as real URL resolution.
// ═════════════════════════════════════════════════════════════════════════════
describe('2. the admin coordinator link preserves whichever platform host is in use', () => {
    it('A. from a Preview host, the link stays on that exact Preview deployment', () => {
        const href = coordinatorAccessPath(TOKEN);
        const resolved = new URL(href, `${PREVIEW_ORIGIN}${CRM_PAGE_PATH}`);
        expect(resolved.origin).toBe(PREVIEW_ORIGIN);
        expect(resolved.pathname).toBe('/coordinator/access');
        expect(resolved.hash).toBe(`#${TOKEN}`);
    });

    it('B. from the production platform origin, the link stays on Production', () => {
        const resolved = new URL(coordinatorAccessPath(TOKEN), `${PRODUCTION_ORIGIN}${CRM_PAGE_PATH}`);
        expect(resolved.origin).toBe(PRODUCTION_ORIGIN);
        expect(resolved.pathname).toBe('/coordinator/access');
    });

    it('C. the pinned absolute builder is unchanged, so distribution links still go to the canonical domain', () => {
        const url = withNodeEnv('production', () => buildCoordinatorAccessUrl(null, TOKEN));
        expect(new URL(url).origin).toBe(CANONICAL_COORDINATOR_ORIGIN);
        // Even when the caller is sitting on a tenant custom domain.
        const fromTenant = withNodeEnv('production', () => buildCoordinatorAccessUrl(TENANT_DOMAIN, TOKEN));
        expect(new URL(fromTenant).origin).toBe(CANONICAL_COORDINATOR_ORIGIN);
    });

    it('D. from localhost, the link stays on localhost', () => {
        const resolved = new URL(coordinatorAccessPath(TOKEN), `${LOCALHOST_ORIGIN}${CRM_PAGE_PATH}`);
        expect(resolved.origin).toBe(LOCALHOST_ORIGIN);
    });

    it('E. the session exchange keeps the host: /coordinator/access -> /coordinator/portal is relative', () => {
        // Behavioural: relative navigation cannot change origin.
        const portal = new URL('/coordinator/portal', `${PREVIEW_ORIGIN}/coordinator/access`);
        expect(portal.origin).toBe(PREVIEW_ORIGIN);

        // And the page really does navigate relatively, with a relative fetch.
        const access = read('app/coordinator/access/page.tsx');
        expect(access).toContain("router.replace('/coordinator/portal')");
        expect(access).toContain("fetch('/api/coordinator/session'");
        expect(access).not.toContain(CANONICAL_COORDINATOR_ORIGIN);
    });

    it('F. no CRM call site can substitute a Production origin when rendered from Preview', () => {
        for (const file of CRM_CALL_SITES) {
            const src = read(file);
            // The pinned absolute builder must not be used for the admin's own
            // in-app navigation — that is what escaped to Production.
            expect(src).not.toMatch(/buildCoordinatorAccessUrl\s*\(\s*null/);
            expect(src).toContain('coordinatorAccessPath(');
            // And no hardcoded platform origin sneaks back in.
            expect(src).not.toContain(CANONICAL_COORDINATOR_ORIGIN);

            // The href must be the path ITSELF, never the path with something
            // glued in front of it. A prefix — a hardcoded domain, or any
            // value carried on the campaign row such as a custom_domain —
            // re-introduces exactly the escape this phase removed, and would
            // let data decide which host a credential is handed to.
            const occurrences = [...src.matchAll(/coordinatorAccessPath\s*\(/g)];
            expect(occurrences.length).toBeGreaterThan(0);
            for (const match of occurrences) {
                const before = src.slice(0, match.index).trimEnd();
                expect(before).toMatch(/(href=\{|href:)$/);
            }
        }
    });

    it('the relative path carries the credential in the fragment only, exactly as the absolute builder does', () => {
        const href = coordinatorAccessPath(TOKEN);
        const onTheWire = href.split('#')[0];
        expect(onTheWire).toBe('/coordinator/access');
        expect(onTheWire).not.toContain(TOKEN);
        expect(href).toBe(`/coordinator/access#${encodeURIComponent(TOKEN)}`);
        // Same shape the absolute builder produces.
        const absolute = withNodeEnv('production', () => buildCoordinatorAccessUrl(null, TOKEN));
        expect(absolute).toBe(`${CANONICAL_COORDINATOR_ORIGIN}${href}`);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Why host-relative is correct by construction, not by luck.
// ═════════════════════════════════════════════════════════════════════════════
describe('3. the CRM only ever renders on a platform host', () => {
    it('every environment the CRM runs on is a platform host', () => {
        expect(isPlatformHost('www.freezeriqapp.com')).toBe(true);
        expect(isPlatformHost('freezeriq-example-preview.vercel.app')).toBe(true);
        expect(isPlatformHost('localhost:3000')).toBe(true);
    });

    it('a tenant custom domain is NOT a platform host, and middleware rewrites it away from /fundraisers', () => {
        expect(isPlatformHost('myfreezerchef.com')).toBe(false);
        const mw = read('middleware.ts');
        // /fundraisers is not in the custom-domain bypass list, so on a tenant
        // domain it is rewritten into app/[domain] and never renders the CRM.
        const bypass = mw.slice(mw.indexOf('Bypass rewrite for known root paths'), mw.indexOf('Rewrite custom domain requests'));
        expect(bypass).not.toContain("'/fundraisers'");
        expect(bypass).not.toContain('/fundraisers');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Distribution links stay pinned — the safety property this must not break.
// ═════════════════════════════════════════════════════════════════════════════
describe('4. distributed coordinator links are still pinned to the canonical domain', () => {
    it('the coordinator invitation email route still uses the pinned absolute builder', () => {
        const src = read('app/api/campaigns/[id]/coordinator-email/route.ts');
        expect(src).toContain('buildCoordinatorAccessUrl(');
        expect(src).not.toContain('coordinatorAccessPath(');
    });

    it('outreach origin resolution is unchanged and still pins in production', () => {
        const resolved = withNodeEnv('production', () => resolveOutreachOrigin(PREVIEW_ORIGIN));
        expect(resolved).toBe(CANONICAL_COORDINATOR_ORIGIN);
    });
});
