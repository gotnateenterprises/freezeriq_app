/**
 * DOMAIN-ROUTING-1 — platform vs tenant host classification.
 *
 * Two failure modes matter here and they pull in opposite directions:
 *
 *   FALSE NEGATIVE — the real SaaS domain is not recognised, so the platform
 *   falls through to tenant resolution and 404s. This is what the old
 *   `includes('freezeriq.com')` test did to `freezeriqapp.com`.
 *
 *   FALSE POSITIVE — a lookalike host is treated as the platform. The old
 *   substring test did this to `freezeriq.com.evil.net`.
 *
 * Both directions are pinned below, along with the normalization that makes
 * case, port and trailing-dot variants of one host compare equal.
 */

import {
    isPlatformHost,
    isLocalHost,
    isVercelHost,
    normalizeHost,
    PLATFORM_ROOT_DOMAIN,
} from '@/lib/platformHosts';

describe('1. the authoritative SaaS domain', () => {
    it('recognises the platform apex and www with no configuration at all', () => {
        expect(isPlatformHost('freezeriqapp.com')).toBe(true);
        expect(isPlatformHost('www.freezeriqapp.com')).toBe(true);
    });

    it('exports the domain as the single source of truth', () => {
        expect(PLATFORM_ROOT_DOMAIN).toBe('freezeriqapp.com');
        expect(isPlatformHost(PLATFORM_ROOT_DOMAIN)).toBe(true);
    });

    it('REGRESSION: the old substring test rejected this exact host', () => {
        // `freezeriqapp.com`.includes('freezeriq.com') === false — the bug.
        expect('freezeriqapp.com'.includes('freezeriq.com')).toBe(false);
        expect(isPlatformHost('freezeriqapp.com')).toBe(true);
    });
});

describe('2. Vercel project, deployment and Preview hosts', () => {
    it('accepts the project alias and generated deployment hosts', () => {
        expect(isPlatformHost('freezeriq-app.vercel.app')).toBe(true);
        expect(isPlatformHost('freezeriq-app-gotnateenterprises-projects.vercel.app')).toBe(true);
        expect(isPlatformHost('freezeriq-app-git-example.vercel.app')).toBe(true);
        expect(isPlatformHost('freezeriq-2l2afmr14-gotnateenterprises-projects.vercel.app')).toBe(true);
    });

    it('accepts the bare apex too', () => {
        expect(isVercelHost('vercel.app')).toBe(true);
    });

    it('matches by suffix, so a lookalike parent domain is not ours', () => {
        expect(isVercelHost('vercel.app.evil.net')).toBe(false);
        expect(isVercelHost('notvercel.app')).toBe(false);
        expect(isVercelHost('myvercel.app')).toBe(false);
    });
});

describe('3. local development', () => {
    it('treats localhost as the platform, with or without a port', () => {
        expect(isPlatformHost('localhost')).toBe(true);
        expect(isPlatformHost('localhost:3000')).toBe(true);
        expect(isPlatformHost('localhost:4000')).toBe(true);
    });

    it('REGRESSION: bare localhost used to fall through to tenant routing', () => {
        // The old check was `hostname === 'localhost:3000'`, so port-80 local
        // development silently became tenant traffic.
        expect(isPlatformHost('localhost')).toBe(true);
    });

    it('accepts loopback addresses including bracketed IPv6', () => {
        expect(isLocalHost('127.0.0.1')).toBe(true);
        expect(isLocalHost('127.0.0.1:3000')).toBe(true);
        expect(isLocalHost('[::1]')).toBe(true);
        expect(isLocalHost('[::1]:3000')).toBe(true);
    });

    it('a SUBDOMAIN of localhost stays tenant traffic — that is how tenant domains are simulated', () => {
        expect(isPlatformHost('acme.localhost')).toBe(false);
        expect(isPlatformHost('acme.localhost:3000')).toBe(false);
    });
});

describe('4. tenant domains must never be classified as platform', () => {
    it('My Freezer Chef is a tenant on both apex and www', () => {
        expect(isPlatformHost('myfreezerchef.com')).toBe(false);
        expect(isPlatformHost('www.myfreezerchef.com')).toBe(false);
    });

    it('an unknown domain is not platform, so it falls through to tenant resolution', () => {
        expect(isPlatformHost('unknown.example.com')).toBe(false);
        expect(isPlatformHost('example.com')).toBe(false);
    });
});

describe('5. adversarial lookalikes', () => {
    const lookalikes = [
        'freezeriqapp.com.evil.net',
        'freezeriq.com.evil.net',
        'vercel.app.evil.net',
        'myfreezerchef.com.evil.net',
        'evilfreezeriqapp.com',
        'freezeriqapp.com.attacker.example',
        'freezeriqapp.com.co',
        'notfreezeriqapp.com',
        'freezeriqapp.evil.com',
    ];

    it.each(lookalikes)('%s is NOT the platform', (host) => {
        expect(isPlatformHost(host)).toBe(false);
    });

    it('REGRESSION: the old substring test accepted two of these', () => {
        expect('freezeriq.com.evil.net'.includes('freezeriq.com')).toBe(true);
        expect('vercel.app.evil.net'.includes('vercel.app')).toBe(true);
        expect(isPlatformHost('freezeriq.com.evil.net')).toBe(false);
        expect(isPlatformHost('vercel.app.evil.net')).toBe(false);
    });

    it('a subdomain of the platform domain is not automatically the platform', () => {
        // Nothing serves these today; they must be opted in deliberately.
        expect(isPlatformHost('api.freezeriqapp.com')).toBe(false);
        expect(isPlatformHost('tenant.freezeriqapp.com')).toBe(false);
    });
});

describe('6. normalization', () => {
    it('is case-insensitive, as Host headers are', () => {
        expect(isPlatformHost('FreezerIQApp.com')).toBe(true);
        expect(isPlatformHost('FREEZERIQAPP.COM')).toBe(true);
        expect(isPlatformHost('WWW.FreezerIQApp.COM')).toBe(true);
    });

    it('ignores the port', () => {
        expect(isPlatformHost('FREEZERIQAPP.COM:443')).toBe(true);
        expect(isPlatformHost('freezeriqapp.com:8080')).toBe(true);
        expect(normalizeHost('freezeriqapp.com:443')).toBe('freezeriqapp.com');
    });

    it('treats the absolute FQDN form as the same host', () => {
        expect(normalizeHost('freezeriqapp.com.')).toBe('freezeriqapp.com');
        expect(isPlatformHost('freezeriqapp.com.')).toBe(true);
    });

    it('trims surrounding whitespace', () => {
        expect(isPlatformHost('  freezeriqapp.com  ')).toBe(true);
    });

    it('handles a missing or empty host without throwing or defaulting to platform', () => {
        expect(isPlatformHost(null)).toBe(false);
        expect(isPlatformHost(undefined)).toBe(false);
        expect(isPlatformHost('')).toBe(false);
        expect(normalizeHost(null)).toBe('');
    });
});

describe('7. NEXT_PUBLIC_ROOT_DOMAIN override', () => {
    // Passed as an argument rather than read from process.env, so these cases
    // cannot leak configuration into other tests.
    it('adds the override domain and its www form', () => {
        expect(isPlatformHost('staging.example.com', 'staging.example.com')).toBe(true);
        expect(isPlatformHost('www.staging.example.com', 'staging.example.com')).toBe(true);
    });

    it('normalizes the override the same way as the host', () => {
        expect(isPlatformHost('staging.example.com', '  STAGING.EXAMPLE.COM  ')).toBe(true);
    });

    it('ADDS to the built-in domain and can never remove it', () => {
        // A mistyped override must not take the real SaaS domain offline.
        expect(isPlatformHost('freezeriqapp.com', 'something-else.example')).toBe(true);
        expect(isPlatformHost('freezeriqapp.com', '')).toBe(true);
        expect(isPlatformHost('freezeriqapp.com', null)).toBe(true);
    });

    it('does not turn tenant domains into platform traffic', () => {
        expect(isPlatformHost('myfreezerchef.com', 'staging.example.com')).toBe(false);
    });

    it('an override does not resurrect substring behaviour', () => {
        expect(isPlatformHost('staging.example.com.evil.net', 'staging.example.com')).toBe(false);
    });
});

describe('8. the stale default is gone', () => {
    it('freezeriq.com is no longer implicitly the platform', () => {
        // The old fallback was `freezeriq.com`. It is not attached to the Vercel
        // project and does not resolve to Vercel, so it cannot serve the app.
        expect(isPlatformHost('freezeriq.com')).toBe(false);
        expect(isPlatformHost('www.freezeriq.com')).toBe(false);
    });

    it('but it can still be opted in explicitly by configuration', () => {
        expect(isPlatformHost('freezeriq.com', 'freezeriq.com')).toBe(true);
    });
});
