/**
 * QB-INVOICE-1A — the pure foundations of the QuickBooks connector:
 * where a connection may exist (environment guard), who may manage it (role
 * gate), what exactly is requested from Intuit (scope/redirect), and how the
 * credentials are sealed at rest.
 */

import {
    deploymentTier,
    resolveQuickBooksConfig,
    validateRedirectUri,
    QUICKBOOKS_SCOPE,
    QUICKBOOKS_API_BASE,
} from '@/lib/quickbooks/config';
import { mayManageQuickBooks } from '@/lib/quickbooks/access';
import { buildAuthorizationUrl, isValidRealmId } from '@/lib/quickbooks/intuitClient';
import {
    integrationTokenKeys,
    openIntegrationSecret,
    sealIntegrationSecret,
    type SealContext,
} from '@/lib/integrationTokenCrypto';
import { signOAuthState, verifyOAuthState, oauthNonce } from '@/lib/auth/oauthState';
import { quickBooksCardView, QUICKBOOKS_CALLBACK_MESSAGES } from '@/lib/quickbooks/statusView';
import {
    LOCAL_REDIRECT, TEST_AUTH_SECRET, TEST_CLIENT_ID, TEST_TOKEN_KEY, sandboxConfig, sandboxEnv,
} from './helpers/quickbooksFakes';

const PROD_DB = 'postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:6543/postgres';

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · environment guard (Part 13)', () => {
    it('local development with sandbox keys is enabled, against the sandbox API', () => {
        const r = resolveQuickBooksConfig(sandboxEnv({ NODE_ENV: 'development' }));
        expect(r.enabled).toBe(true);
        if (!r.enabled) return;
        expect(r.config.environment).toBe('sandbox');
        expect(r.config.apiBase).toBe(QUICKBOOKS_API_BASE.sandbox);
        expect(r.config.redirectUri).toBe(LOCAL_REDIRECT);
        expect(r.config.appOrigin).toBe('http://localhost:3000');
    });

    it('Preview is ALWAYS disabled — even with every credential present and production declared', () => {
        for (const QBO_ENVIRONMENT of ['sandbox', 'production']) {
            const r = resolveQuickBooksConfig(sandboxEnv({
                VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production', QBO_ENVIRONMENT,
                QBO_PRODUCTION_ENABLED: 'true',
                QBO_REDIRECT_URI: 'https://www.freezeriqapp.com/api/integrations/quickbooks/callback',
            }));
            expect(r).toEqual({ enabled: false, reason: 'preview_deployment' });
        }
    });

    it('Preview is refused before any credential is even consulted', () => {
        const r = resolveQuickBooksConfig({ VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production' } as any);
        expect(r).toEqual({ enabled: false, reason: 'preview_deployment' });
    });

    it('Production is disabled in this phase unless explicitly enabled', () => {
        const prod = {
            VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production', QBO_ENVIRONMENT: 'production',
            QBO_REDIRECT_URI: 'https://www.freezeriqapp.com/api/integrations/quickbooks/callback',
        };
        expect(resolveQuickBooksConfig(sandboxEnv(prod))).toEqual({ enabled: false, reason: 'production_not_enabled' });
        expect(resolveQuickBooksConfig(sandboxEnv({ ...prod, QBO_PRODUCTION_ENABLED: 'TRUE' }))).toEqual({ enabled: false, reason: 'production_not_enabled' });
        expect(resolveQuickBooksConfig(sandboxEnv({ ...prod, QBO_PRODUCTION_ENABLED: '1' }))).toEqual({ enabled: false, reason: 'production_not_enabled' });
        // The future, deliberate configuration does resolve — to the production API.
        const on = resolveQuickBooksConfig(sandboxEnv({ ...prod, QBO_PRODUCTION_ENABLED: 'true' }));
        expect(on.enabled).toBe(true);
        if (on.enabled) expect(on.config.apiBase).toBe(QUICKBOOKS_API_BASE.production);
    });

    it('sandbox credentials can never be used by Production', () => {
        const r = resolveQuickBooksConfig(sandboxEnv({
            VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production', QBO_PRODUCTION_ENABLED: 'true',
            QBO_ENVIRONMENT: 'sandbox',
            QBO_REDIRECT_URI: 'https://www.freezeriqapp.com/api/integrations/quickbooks/callback',
        }));
        expect(r).toEqual({ enabled: false, reason: 'environment_mismatch' });
    });

    it('Production credentials are refused in local development', () => {
        const r = resolveQuickBooksConfig(sandboxEnv({ NODE_ENV: 'development', QBO_ENVIRONMENT: 'production' }));
        expect(r).toEqual({ enabled: false, reason: 'environment_mismatch' });
        const r2 = resolveQuickBooksConfig(sandboxEnv({ NODE_ENV: 'development', QBO_ENVIRONMENT: 'Sandbox' }));
        expect(r2).toEqual({ enabled: false, reason: 'environment_mismatch' });
    });

    it('a local process pointed at the Production database is refused', () => {
        const r = resolveQuickBooksConfig(sandboxEnv({ NODE_ENV: 'development', DATABASE_URL: PROD_DB }));
        expect(r).toEqual({ enabled: false, reason: 'local_against_production_database' });
    });

    it('an unrecognised runtime fails closed', () => {
        expect(deploymentTier({ NODE_ENV: 'production' } as any)).toBe('unknown'); // `next start` with no Vercel context
        expect(deploymentTier({ VERCEL: '1', NODE_ENV: 'production' } as any)).toBe('unknown');
        expect(deploymentTier({ VERCEL_ENV: 'staging' } as any)).toBe('unknown');
        expect(resolveQuickBooksConfig(sandboxEnv({ NODE_ENV: 'production' }))).toEqual({ enabled: false, reason: 'unknown_runtime' });
    });

    it('missing pieces disable it with a reason code, never a partial config', () => {
        expect(resolveQuickBooksConfig(sandboxEnv({ QBO_CLIENT_SECRET: undefined }))).toEqual({ enabled: false, reason: 'not_configured' });
        expect(resolveQuickBooksConfig(sandboxEnv({ QBO_ENVIRONMENT: undefined }))).toEqual({ enabled: false, reason: 'not_configured' });
        expect(resolveQuickBooksConfig(sandboxEnv({ INTEGRATION_TOKEN_KEY: 'too-short' }))).toEqual({ enabled: false, reason: 'encryption_key_missing' });
        expect(resolveQuickBooksConfig(sandboxEnv({ AUTH_SECRET: undefined }))).toEqual({ enabled: false, reason: 'state_secret_missing' });
    });

    it('a disabled result never carries a credential', () => {
        const r = resolveQuickBooksConfig(sandboxEnv({ VERCEL: '1', VERCEL_ENV: 'preview' }));
        expect(JSON.stringify(r)).not.toMatch(/TESTCLIENT|TESTTOKENKEY|TESTAUTHSECRET/);
    });
});

describe('QB-INVOICE-1A · the callback is configuration, never the request (Part 12)', () => {
    it('accepts exactly the local callback path on localhost', () => {
        expect(validateRedirectUri(LOCAL_REDIRECT, 'local')?.href).toBe(LOCAL_REDIRECT);
        expect(validateRedirectUri('http://127.0.0.1:3000/api/integrations/quickbooks/callback', 'local')).not.toBeNull();
    });

    it.each([
        ['another path', 'http://localhost:3000/api/auth/qbo/callback'],
        ['the MCP tooling callback', 'http://localhost:8000/callback'],
        ['a query string', `${LOCAL_REDIRECT}?x=1`],
        ['a fragment', `${LOCAL_REDIRECT}#x`],
        ['a trailing slash', `${LOCAL_REDIRECT}/`],
        ['a non-local host', 'http://evil.example/api/integrations/quickbooks/callback'],
        ['credentials in the URL', 'http://user:pw@localhost:3000/api/integrations/quickbooks/callback'],
        ['a non-http scheme', 'javascript://localhost/api/integrations/quickbooks/callback'],
        ['garbage', 'not a url'],
    ])('local rejects %s', (_label, value) => {
        expect(validateRedirectUri(value, 'local')).toBeNull();
    });

    it('Production requires https on the canonical host', () => {
        expect(validateRedirectUri('https://www.freezeriqapp.com/api/integrations/quickbooks/callback', 'production')).not.toBeNull();
        expect(validateRedirectUri('http://www.freezeriqapp.com/api/integrations/quickbooks/callback', 'production')).toBeNull();
        expect(validateRedirectUri('https://freezeriq-app.vercel.app/api/integrations/quickbooks/callback', 'production')).toBeNull();
        expect(validateRedirectUri(LOCAL_REDIRECT, 'production')).toBeNull();
        expect(validateRedirectUri('https://www.freezeriqapp.com:8443/api/integrations/quickbooks/callback', 'production')).toBeNull();
    });

    it('an invalid redirect disables the connector', () => {
        expect(resolveQuickBooksConfig(sandboxEnv({ QBO_REDIRECT_URI: 'http://localhost:8000/callback' })))
            .toEqual({ enabled: false, reason: 'invalid_redirect_uri' });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · least privilege: only the accounting scope (Part 11)', () => {
    const config = sandboxConfig();
    const url = new URL(buildAuthorizationUrl(config, 'STATE-VALUE'));

    it('targets Intuit’s authorization endpoint', () => {
        expect(`${url.origin}${url.pathname}`).toBe('https://appcenter.intuit.com/connect/oauth2');
    });

    it('requests exactly com.intuit.quickbooks.accounting — nothing else', () => {
        expect(url.searchParams.getAll('scope')).toEqual(['com.intuit.quickbooks.accounting']);
        expect(QUICKBOOKS_SCOPE).toBe('com.intuit.quickbooks.accounting');
        const scopes = url.searchParams.get('scope')!.split(/[\s+]+/);
        expect(scopes).toEqual(['com.intuit.quickbooks.accounting']);
        expect(url.toString()).not.toMatch(/quickbooks\.payment|openid|profile|email|phone|address/);
    });

    it('carries exactly five parameters: client_id, response_type, scope, redirect_uri, state', () => {
        expect([...url.searchParams.keys()].sort()).toEqual(['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('redirect_uri')).toBe(LOCAL_REDIRECT);
        expect(url.searchParams.get('client_id')).toBe(TEST_CLIENT_ID);
        expect(url.searchParams.get('state')).toBe('STATE-VALUE');
    });

    it('never puts the client secret or the encryption key in the URL', () => {
        expect(url.toString()).not.toMatch(/TESTCLIENTSECRET|TESTTOKENKEY|TESTAUTHSECRET/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · tenant ADMIN gate (Part 9)', () => {
    const admin = { id: 'u1', role: 'ADMIN', businessId: 'biz-1', baseBusinessId: 'biz-1', isViewingAsTenant: false };

    it('a tenant ADMIN acting as themselves may manage QuickBooks', () => {
        expect(mayManageQuickBooks(admin)).toBe(true);
    });

    it.each(['CHEF', 'DRIVER', 'STAFF', 'admin', 'Admin', '', undefined, null, true])('role %p is refused', (role) => {
        expect(mayManageQuickBooks({ ...admin, role })).toBe(false);
    });

    it('a super admin VIEWING AS another tenant is refused, even with role ADMIN', () => {
        expect(mayManageQuickBooks({ ...admin, isViewingAsTenant: true, businessId: 'biz-other', baseBusinessId: 'biz-1' })).toBe(false);
        expect(mayManageQuickBooks({ ...admin, businessId: 'biz-other', baseBusinessId: 'biz-1' })).toBe(false);
        expect(mayManageQuickBooks({ ...admin, isViewingAsTenant: 'yes' })).toBe(false);
    });

    it('super-admin status alone grants nothing', () => {
        expect(mayManageQuickBooks({ ...admin, role: 'CHEF', isSuperAdmin: true } as any)).toBe(false);
    });

    it('no user, no id, or no tenant is refused', () => {
        expect(mayManageQuickBooks(null)).toBe(false);
        expect(mayManageQuickBooks({ ...admin, id: undefined })).toBe(false);
        expect(mayManageQuickBooks({ ...admin, businessId: undefined, baseBusinessId: undefined })).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · OAuth state (Part 10)', () => {
    const secret = TEST_AUTH_SECRET;
    const base = () => ({ provider: 'quickbooks' as const, businessId: 'biz-1', userId: 'u1', nonce: oauthNonce(), exp: Math.floor(Date.now() / 1000) + 600 });

    it('round-trips and is bound to provider, tenant and user', async () => {
        const s = base();
        const token = await signOAuthState(s, secret);
        expect(await verifyOAuthState(token, secret, 'quickbooks')).toMatchObject({ businessId: 'biz-1', userId: 'u1', nonce: s.nonce });
    });

    it('a state minted for another provider is refused', async () => {
        const token = await signOAuthState({ ...base(), provider: 'stripe' }, secret);
        expect(await verifyOAuthState(token, secret, 'quickbooks')).toBeNull();
    });

    it('tampering with the payload is detected', async () => {
        const token = await signOAuthState(base(), secret);
        const [body, sig] = token.split('.');
        const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
        const forged = Buffer.from(JSON.stringify({ ...decoded, businessId: 'victim' })).toString('base64url');
        expect(await verifyOAuthState(`${forged}.${sig}`, secret, 'quickbooks')).toBeNull();
    });

    it('expired, malformed, missing and wrongly-signed states are refused', async () => {
        const expired = await signOAuthState({ ...base(), exp: Math.floor(Date.now() / 1000) - 1 }, secret);
        expect(await verifyOAuthState(expired, secret, 'quickbooks')).toBeNull();
        expect(await verifyOAuthState('garbage', secret, 'quickbooks')).toBeNull();
        expect(await verifyOAuthState(null, secret, 'quickbooks')).toBeNull();
        expect(await verifyOAuthState(await signOAuthState(base(), 'another-secret'), secret, 'quickbooks')).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · credential encryption at rest (Part 14)', () => {
    const env = sandboxEnv();
    const A: SealContext = { provider: 'quickbooks', businessId: 'biz-A', field: 'refresh_token' };

    it('seals with AES-GCM and opens only in the same context', async () => {
        const sealed = await sealIntegrationSecret('REFRESHTOKEN-SECRET-xyz', A, env);
        expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
        expect(sealed).not.toContain('REFRESHTOKEN');
        expect(await openIntegrationSecret(sealed, A, env)).toBe('REFRESHTOKEN-SECRET-xyz');
    });

    it('a ciphertext moved to ANOTHER TENANT does not open', async () => {
        const sealed = await sealIntegrationSecret('secret', A, env);
        expect(await openIntegrationSecret(sealed, { ...A, businessId: 'biz-B' }, env)).toBeNull();
    });

    it('a ciphertext moved to another column or provider does not open', async () => {
        const sealed = await sealIntegrationSecret('secret', A, env);
        expect(await openIntegrationSecret(sealed, { ...A, field: 'access_token' }, env)).toBeNull();
        expect(await openIntegrationSecret(sealed, { ...A, provider: 'square' }, env)).toBeNull();
    });

    it('every write uses a fresh IV (same input, different ciphertext)', async () => {
        const a = await sealIntegrationSecret('same', A, env);
        const b = await sealIntegrationSecret('same', A, env);
        expect(a).not.toBe(b);
    });

    it('any flipped character fails authentication', async () => {
        const sealed = (await sealIntegrationSecret('secret-value', A, env))!;
        const i = sealed.length - 5;
        const flipped = sealed.slice(0, i) + (sealed[i] === 'A' ? 'B' : 'A') + sealed.slice(i + 1);
        expect(await openIntegrationSecret(flipped, A, env)).toBeNull();
        expect(await openIntegrationSecret(sealed.replace(/^v1/, 'v2'), A, env)).toBeNull();
        expect(await openIntegrationSecret(sealed.slice(0, 20), A, env)).toBeNull();
    });

    it('the wrong key cannot open it; no key means nothing is sealed or opened', async () => {
        const sealed = await sealIntegrationSecret('secret', A, env);
        expect(await openIntegrationSecret(sealed, A, sandboxEnv({ INTEGRATION_TOKEN_KEY: 'X'.repeat(40) }))).toBeNull();
        expect(await sealIntegrationSecret('secret', A, sandboxEnv({ INTEGRATION_TOKEN_KEY: undefined }))).toBeNull();
        expect(await sealIntegrationSecret('secret', A, sandboxEnv({ INTEGRATION_TOKEN_KEY: 'short' }))).toBeNull();
        expect(await openIntegrationSecret(sealed, A, sandboxEnv({ INTEGRATION_TOKEN_KEY: undefined }))).toBeNull();
    });

    it('rotation: a value sealed under the previous key still opens after rotating', async () => {
        const oldKey = TEST_TOKEN_KEY;
        const sealed = await sealIntegrationSecret('secret', A, sandboxEnv({ INTEGRATION_TOKEN_KEY: oldKey }));
        const rotated = sandboxEnv({ INTEGRATION_TOKEN_KEY: 'N'.repeat(48), INTEGRATION_TOKEN_KEY_PREVIOUS: oldKey });
        expect(integrationTokenKeys(rotated)).toHaveLength(2);
        expect(await openIntegrationSecret(sealed, A, rotated)).toBe('secret');
        // New writes use the NEW key only.
        const fresh = await sealIntegrationSecret('secret', A, rotated);
        expect(await openIntegrationSecret(fresh, A, sandboxEnv({ INTEGRATION_TOKEN_KEY: oldKey }))).toBeNull();
    });
});

describe('QB-INVOICE-1A · realm ids', () => {
    it('only numeric realm ids are accepted', () => {
        expect(isValidRealmId('9130357864212345')).toBe(true);
        for (const bad of ['', 'abc', '123 ', '../1', '1/companyinfo/2', '1'.repeat(33), 123, null, undefined]) {
            expect(isValidRealmId(bad)).toBe(false);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1A · Settings card view (Part 22)', () => {
    it('shows Connect only when not connected, Disconnect only when connected', () => {
        expect(quickBooksCardView({ state: 'not_connected', environment: 'sandbox' })).toMatchObject({ label: 'Not connected', showConnect: true, showDisconnect: false, sandbox: true });
        expect(quickBooksCardView({ state: 'connected', environment: 'sandbox', companyName: 'Sandbox Co' })).toMatchObject({ label: 'Connected', showConnect: false, showDisconnect: true, detail: 'Sandbox Co' });
    });

    it('a disabled environment offers no controls', () => {
        const v = quickBooksCardView({ state: 'disabled', reason: 'preview_deployment' });
        expect(v.showConnect || v.showDisconnect || v.showForget).toBe(false);
    });

    it('unverified connections are never labelled plainly "Connected"', () => {
        expect(quickBooksCardView({ state: 'error' }).label).not.toBe('Connected');
        expect(quickBooksCardView({ state: 'refresh_required' }).label).not.toBe('Connected');
        expect(quickBooksCardView(null).label).toBe('Checking connection…');
    });

    it('disconnected and revoked connections offer reconnect and forget', () => {
        expect(quickBooksCardView({ state: 'disconnected', canForget: true })).toMatchObject({ showConnect: true, showForget: true, showDisconnect: false });
        expect(quickBooksCardView({ state: 'reconnect_required', cause: 'revoked', canForget: true })).toMatchObject({ showConnect: true, showForget: true });
        expect(quickBooksCardView({ state: 'reconnect_required', cause: 'no_company_access', canForget: false })).toMatchObject({ showConnect: false, showDisconnect: true, showForget: false });
    });

    it('an unreadable stored connection offers ONLY Forget (it can never be reconnected)', () => {
        expect(quickBooksCardView({ state: 'reconnect_required', cause: 'unreadable', canForget: true })).toMatchObject({ showConnect: false, showDisconnect: false, showForget: true });
    });

    it('the view model has nowhere to put a realm id, token, client id or integration id', () => {
        const v = quickBooksCardView({ state: 'connected', companyName: 'X', realmId: '9130', accessToken: 'ACCESS', id: 'int-1' } as any);
        expect(JSON.stringify(v)).not.toMatch(/9130|ACCESS|int-1/);
    });

    it('uses Intuit-compliant wording: full "QuickBooks", "Connect to" / "Disconnect from", no QB/QBO abbreviations', () => {
        expect(quickBooksCardView({ state: 'not_connected' }).connectLabel).toBe('Connect to QuickBooks');
        expect(quickBooksCardView({ state: 'disconnected', canForget: true }).connectLabel).toBe('Reconnect to QuickBooks');
        const card = require('fs').readFileSync(require('path').join(process.cwd(), 'components/settings/QuickBooksConnectionCard.tsx'), 'utf8');
        expect(card).toContain('Disconnect from QuickBooks');
        const visible = [
            ...['disabled', 'not_connected', 'connected', 'refresh_required', 'error', 'reconnect_required', 'disconnected']
                .map((state) => quickBooksCardView({ state } as any))
                .flatMap((v) => [v.label, v.detail ?? '', v.connectLabel]),
            ...Object.values(QUICKBOOKS_CALLBACK_MESSAGES).map((m) => m.text),
            ...(card.match(/>[^<>{}]+</g) ?? []),
        ].join(' | ');
        expect(visible).not.toMatch(/\bQBO?\b/);
    });

    it('a connected card says since when, without any identifier', () => {
        const v = quickBooksCardView({ state: 'connected', companyName: 'Sandbox Co', connectedAt: '2026-09-13T12:00:00.000Z' });
        expect(v.detail).toMatch(/^Sandbox Co · since Sep 1[23], 2026$/);
    });

    it('every callback outcome has a message, and none leaks detail', () => {
        for (const k of ['connected', 'denied', 'invalid_state', 'invalid_callback', 'session_required', 'forbidden', 'realm_mismatch', 'realm_in_use', 'reconnect_blocked', 'conflict', 'token_exchange_failed', 'error']) {
            expect(QUICKBOOKS_CALLBACK_MESSAGES[k]).toBeDefined();
        }
    });
});
