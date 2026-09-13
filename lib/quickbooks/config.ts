/**
 * QB-INVOICE-1A — where a QuickBooks connection may exist, and with what.
 *
 * ── THE ENVIRONMENT PROBLEM THIS SOLVES ─────────────────────────────────────
 *
 * Vercel Preview deployments share the PRODUCTION database. A QuickBooks connect
 * completed on a Preview would therefore write a real tenant's accounting
 * credentials from an unreleased build — or, with sandbox keys, point a real
 * tenant's row at a sandbox company. And a developer machine running with
 * Production Intuit keys would reach real books from uncommitted code.
 *
 * So every QuickBooks entry point asks this module first, and it answers from
 * the DEPLOYMENT, not from anything in the request:
 *
 *     local dev   → sandbox keys only             (QBO_ENVIRONMENT=sandbox)
 *     Preview     → disabled, always              (before any credential is read)
 *     Production  → disabled unless BOTH QBO_ENVIRONMENT=production AND
 *                   QBO_PRODUCTION_ENABLED=true   (neither is set in this phase)
 *     anything else (a `next start` with no Vercel context, an unrecognised
 *                   VERCEL_ENV)                   → disabled
 *
 * A mismatch (sandbox keys on Production, production keys locally) is refused,
 * not "handled". Intuit client ids do not reveal which environment they belong
 * to, so QBO_ENVIRONMENT is the declaration and the deployment tier is the check.
 *
 * ── THE CALLBACK IS CONFIGURATION, NEVER THE REQUEST ────────────────────────
 *
 * The redirect URI is read from QBO_REDIRECT_URI and must be EXACTLY the one
 * callback path, on localhost for local development or on the canonical
 * Production host for Production. It is never built from the Host header or the
 * request origin, which a caller controls.
 *
 * Nothing here returns or logs a secret; a disabled result carries only a
 * reason code.
 */

import { findProductionTargets } from '@/lib/devEnvGuard';
import { integrationTokenKeyConfigured } from '@/lib/integrationTokenCrypto';

export const QUICKBOOKS_PROVIDER = 'quickbooks';

/** The ONLY scope requested. Payments, OpenID and profile scopes are not. */
export const QUICKBOOKS_SCOPE = 'com.intuit.quickbooks.accounting';

export const QUICKBOOKS_CALLBACK_PATH = '/api/integrations/quickbooks/callback';

/** Holds the state nonce for the browser that started the attempt. */
export const QUICKBOOKS_OAUTH_COOKIE = 'quickbooks_oauth_nonce';

/**
 * A QuickBooks consent screen is a sign-in and one click — unlike Stripe's
 * document-upload onboarding it has no reason to take an hour.
 */
export const QUICKBOOKS_STATE_TTL_SECONDS = 10 * 60;

export const INTUIT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const INTUIT_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export const QUICKBOOKS_API_BASE = {
    sandbox: 'https://sandbox-quickbooks.api.intuit.com',
    production: 'https://quickbooks.api.intuit.com',
} as const;

/** Intuit's current base minor version for the Accounting API. */
export const QUICKBOOKS_MINOR_VERSION = '75';

/** The only host a Production callback may use. Not a secret. */
const PRODUCTION_CALLBACK_HOSTS = ['www.freezeriqapp.com'];
const LOCAL_CALLBACK_HOSTS = ['localhost', '127.0.0.1'];

export type QuickBooksEnvironment = 'sandbox' | 'production';
export type DeploymentTier = 'local' | 'preview' | 'production' | 'unknown';

export type QuickBooksDisabledReason =
    | 'preview_deployment'
    | 'unknown_runtime'
    | 'production_not_enabled'
    | 'not_configured'
    | 'environment_mismatch'
    | 'local_against_production_database'
    | 'invalid_redirect_uri'
    | 'encryption_key_missing'
    | 'state_secret_missing';

export interface QuickBooksConfig {
    tier: Exclude<DeploymentTier, 'preview' | 'unknown'>;
    environment: QuickBooksEnvironment;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Origin of the configured callback — where the browser is sent back to. */
    appOrigin: string;
    apiBase: string;
    stateSecret: string;
}

export type QuickBooksConfigResult =
    | { enabled: true; config: QuickBooksConfig }
    | { enabled: false; reason: QuickBooksDisabledReason };

/**
 * Which deployment this process is. VERCEL_ENV is set by Vercel on every
 * deployment; its absence on a Vercel host is treated as unknown, not as local.
 */
export function deploymentTier(env: NodeJS.ProcessEnv = process.env): DeploymentTier {
    const vercelEnv = env.VERCEL_ENV;
    if (vercelEnv === 'preview') return 'preview';
    if (vercelEnv === 'production') return 'production';
    if (vercelEnv === 'development') return 'local'; // `vercel dev` on a developer machine
    if (vercelEnv) return 'unknown';
    if (env.VERCEL) return 'unknown';
    if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'local';
    return 'unknown';
}

/**
 * The exact redirect URI, or null. Exactness matters twice over: Intuit compares
 * it byte-for-byte with the registered value, and a normalised or host-derived
 * value is precisely what this check exists to rule out.
 */
export function validateRedirectUri(raw: string | undefined, tier: QuickBooksConfig['tier']): URL | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.href !== value) return null; // non-canonical spelling
    if (url.pathname !== QUICKBOOKS_CALLBACK_PATH) return null;
    if (url.search || url.hash || url.username || url.password) return null;

    if (tier === 'production') {
        if (url.protocol !== 'https:' || url.port || !PRODUCTION_CALLBACK_HOSTS.includes(url.hostname)) return null;
    } else {
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (!LOCAL_CALLBACK_HOSTS.includes(url.hostname)) return null;
    }
    return url;
}

export function resolveQuickBooksConfig(env: NodeJS.ProcessEnv = process.env): QuickBooksConfigResult {
    const off = (reason: QuickBooksDisabledReason): QuickBooksConfigResult => ({ enabled: false, reason });

    // Decided before a single credential is read.
    const tier = deploymentTier(env);
    if (tier === 'preview') return off('preview_deployment');
    if (tier === 'unknown') return off('unknown_runtime');
    if (tier === 'production' && env.QBO_PRODUCTION_ENABLED !== 'true') return off('production_not_enabled');

    const declared = (env.QBO_ENVIRONMENT ?? '').trim();
    if (!declared) return off('not_configured');
    if (tier === 'production' && declared !== 'production') return off('environment_mismatch');
    if (tier === 'local' && declared !== 'sandbox') return off('environment_mismatch');
    const environment: QuickBooksEnvironment = tier === 'production' ? 'production' : 'sandbox';

    // A local process pointed at the Production database would store sandbox
    // credentials onto real tenant rows. `next dev` already refuses to start in
    // that state (lib/devEnvGuard.ts); this covers every other local runner.
    if (tier === 'local' && findProductionTargets(env).length > 0) return off('local_against_production_database');

    const clientId = (env.QBO_CLIENT_ID ?? '').trim();
    const clientSecret = (env.QBO_CLIENT_SECRET ?? '').trim();
    if (!clientId || !clientSecret) return off('not_configured');

    const redirect = validateRedirectUri(env.QBO_REDIRECT_URI, tier);
    if (!redirect) return off(env.QBO_REDIRECT_URI ? 'invalid_redirect_uri' : 'not_configured');

    if (!integrationTokenKeyConfigured(env)) return off('encryption_key_missing');

    const stateSecret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET ?? '';
    if (!stateSecret) return off('state_secret_missing');

    return {
        enabled: true,
        config: {
            tier,
            environment,
            clientId,
            clientSecret,
            redirectUri: redirect.href,
            appOrigin: redirect.origin,
            apiBase: QUICKBOOKS_API_BASE[environment],
            stateSecret,
        },
    };
}
