/**
 * SEC-TENANT-1 — tenant authority may never come from the client.
 *
 * THE VULNERABILITY THIS SUITE EXISTS FOR
 *
 * Auth.js v5 hands the client's `update()` payload straight to the jwt callback.
 * From the installed library, node_modules/@auth/core/lib/actions/session.js:28:
 *
 *     const token = await callbacks.jwt({
 *         ...
 *         ...(isUpdate && { trigger: "update" }),
 *         session: newSession,          // <- verbatim client input
 *
 * `newSession` is whatever the browser passed to `useSession().update(...)`. Any
 * authenticated user can call it with any object. So the jwt callback's `session`
 * argument is UNTRUSTED INPUT, exactly like a request body.
 *
 * The app's callback trusted it:
 *
 *     if (trigger === 'update' && session?.businessId) {
 *         token.businessId = session.businessId;
 *
 * No role check, no target validation. Since nearly every tenant-scoped route
 * derives its scope from `session.user.businessId` — see
 * app/api/opportunities/route.ts:26 — moving that value moves the tenant the
 * whole application acts as.
 *
 * These tests invoke the REAL exported callbacks.
 */

process.env.AUTH_SECRET = 'test-secret-sec-tenant-1';

import { authConfig } from '@/auth.config';
import { signViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } from '@/lib/auth/viewAsGrant';

const SECRET = process.env.AUTH_SECRET as string;
const TENANT_A = 'biz-aaaa-1111';
const TENANT_B = 'biz-bbbb-2222';
const TENANT_C = 'biz-cccc-3333';

const SUPER_ID = 'user-super';

/** A token as it exists after an ordinary (non-super-admin) tenant user signs in. */
const ordinaryToken = () => ({
    sub: 'user-ordinary',
    role: 'ADMIN',
    businessId: TENANT_A,
    plan: 'PRO',
    isSuperAdmin: false,
    businessName: 'Tenant A',
});

/**
 * A token as it exists after a platform super admin signs in.
 * Deliberately carries NO base* fields: applySignIn deletes them, so this is the
 * real post-sign-in shape and the capture path gets exercised for real.
 */
const superAdminToken = () => ({
    sub: SUPER_ID,
    role: 'ADMIN',
    businessId: TENANT_A,
    plan: 'ULTIMATE',
    subscriptionStatus: 'active',
    isSuperAdmin: true,
    businessName: 'Tenant A',
});

const jwt = (args: any) => (authConfig.callbacks as any).jwt(args);
const session = (args: any) => (authConfig.callbacks as any).session(args);

/** A grant exactly as POST /api/admin/switch-tenant would sign it. */
const grantFor = (bid: string, opts: any = {}) => signViewAsGrant({
    sub: opts.sub ?? SUPER_ID,
    bid,
    name: opts.name ?? 'Tenant ' + bid.slice(4, 5).toUpperCase(),
    plan: opts.plan ?? 'BASE',
    status: opts.status ?? 'active',
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + VIEW_AS_GRANT_TTL_SECONDS,
}, opts.secret ?? SECRET);

// ═══════════════════════════════════════════════════════════════════════════
// PART C — the ordinary-user exploit
// ═══════════════════════════════════════════════════════════════════════════

describe('an ordinary user cannot move their own session into another tenant', () => {
    it('a forged businessId in the update payload is IGNORED', async () => {
        // The exploit, verbatim: useSession().update({ businessId: TENANT_B })
        // from the browser console of any signed-in Tenant A user.
        const token = await jwt({
            token: ordinaryToken(),
            trigger: 'update',
            session: { businessId: TENANT_B },
        });

        expect(token.businessId).toBe(TENANT_A);
        expect(token.businessId).not.toBe(TENANT_B);
    });

    it('the exposed session still reports Tenant A', async () => {
        const token = await jwt({
            token: ordinaryToken(),
            trigger: 'update',
            session: { businessId: TENANT_B, businessName: 'Tenant B' },
        });
        const s = await session({ session: { user: {} }, token });

        expect((s.user as any).businessId).toBe(TENANT_A);
        expect((s.user as any).businessName).not.toBe('Tenant B');
    });

    it('an ordinary user cannot forge isSuperAdmin', async () => {
        const token = await jwt({
            token: ordinaryToken(),
            trigger: 'update',
            session: { isSuperAdmin: true, businessId: TENANT_B },
        });
        expect(token.isSuperAdmin).toBe(false);
        expect(token.businessId).toBe(TENANT_A);
    });

    it('an ordinary user cannot forge plan or role', async () => {
        const token = await jwt({
            token: ordinaryToken(),
            trigger: 'update',
            session: { plan: 'ULTIMATE', role: 'SUPER', businessId: TENANT_B },
        });
        expect(token.plan).toBe('PRO');
        expect(token.role).toBe('ADMIN');
        expect(token.businessId).toBe(TENANT_A);
    });

    it('repeated attempts cannot wear the guard down', async () => {
        let token: any = ordinaryToken();
        for (const target of [TENANT_B, TENANT_C, TENANT_B, '', null, undefined]) {
            token = await jwt({ token, trigger: 'update', session: { businessId: target } });
            expect(token.businessId).toBe(TENANT_A);
        }
    });

    it('a replayed tenant id observed earlier grants nothing', async () => {
        const token = await jwt({
            token: ordinaryToken(),
            trigger: 'update',
            session: { businessId: TENANT_B, baseBusinessId: TENANT_B, viewAsBusinessId: TENANT_B },
        });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.baseBusinessId).not.toBe(TENANT_B);
    });

    it('an ordinary user holding a VALID grant still cannot switch', async () => {
        // Privilege and target are checked independently: a grant is not a capability.
        const grant = await grantFor(TENANT_B, { sub: 'user-ordinary' });
        const token = await jwt({
            token: ordinaryToken(), trigger: 'update', session: { viewAsGrant: grant },
        });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.viewAsBusinessId).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART E — no input other than trusted server state may set tenant authority
// ═══════════════════════════════════════════════════════════════════════════

describe('tenant authority comes only from trusted server state', () => {
    it('sign-in populates the token from the database user, not from any request', async () => {
        const token = await jwt({
            token: {},
            user: {
                businessId: TENANT_A, plan: 'ULTIMATE', isSuperAdmin: false,
                role: 'ADMIN', permissions: null, businessName: 'Tenant A',
            },
        });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.isSuperAdmin).toBe(false);
    });

    it('an update with no recognised fields leaves the token untouched', async () => {
        const before = ordinaryToken();
        const token = await jwt({ token: { ...before }, trigger: 'update', session: { nonsense: true } });
        expect(token.businessId).toBe(before.businessId);
        expect(token.isSuperAdmin).toBe(before.isSuperAdmin);
        expect(token.plan).toBe(before.plan);
    });

    it('a malformed update payload is handled safely, never by widening scope', async () => {
        for (const bad of [null, undefined, 'string', 42, [], { businessId: {} }, { businessId: ['x'] }]) {
            const token = await jwt({ token: ordinaryToken(), trigger: 'update', session: bad });
            expect(token.businessId).toBe(TENANT_A);
        }
    });

    it('a missing businessId can never become global scope', async () => {
        const token = await jwt({
            token: { ...ordinaryToken(), businessId: undefined, baseBusinessId: undefined },
            trigger: 'update',
            session: { businessId: TENANT_B },
        });
        // Nothing was granted; still no tenant.
        expect(token.businessId).toBeUndefined();
        const s = await session({ session: { user: {} }, token });
        expect((s.user as any).businessId).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART F / J — super-admin View As, server-authorised only
// ═══════════════════════════════════════════════════════════════════════════

describe('super-admin View As', () => {
    it('a super admin CAN view as another tenant with a server-signed grant', async () => {
        const token = await jwt({
            token: superAdminToken(),
            trigger: 'update',
            session: { viewAsGrant: await grantFor(TENANT_B, { name: 'Tenant B', plan: 'BASE' }) },
        });
        expect(token.businessId).toBe(TENANT_B);
        expect(token.businessName).toBe('Tenant B');
        expect(token.plan).toBe('BASE');
        // The real identity is preserved, not overwritten.
        expect(token.baseBusinessId).toBe(TENANT_A);
        expect(token.basePlan).toBe('ULTIMATE');
        expect(token.isSuperAdmin).toBe(true);
    });

    it('a bare businessId stays inert EVEN for a super admin', async () => {
        // The original exploit string must keep failing regardless of who sends
        // it, so the vulnerable shape can never quietly come back to life.
        const token = await jwt({
            token: superAdminToken(), trigger: 'update', session: { businessId: TENANT_B },
        });
        expect(token.businessId).toBe(TENANT_A);
    });

    it('a bare viewAsBusinessId — no grant — is inert even for a super admin', async () => {
        const token = await jwt({
            token: superAdminToken(), trigger: 'update', session: { viewAsBusinessId: TENANT_B },
        });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.viewAsBusinessId).toBeUndefined();
    });

    it('B -> C switching remains possible for a super admin', async () => {
        let token: any = await jwt({
            token: superAdminToken(), trigger: 'update',
            session: { viewAsGrant: await grantFor(TENANT_B, { name: 'Tenant B' }) },
        });
        expect(token.businessId).toBe(TENANT_B);
        token = await jwt({
            token, trigger: 'update',
            session: { viewAsGrant: await grantFor(TENANT_C, { name: 'Tenant C' }) },
        });
        expect(token.businessId).toBe(TENANT_C);
        expect(token.baseBusinessId).toBe(TENANT_A);
    });

    it('exiting View As restores the base tenant', async () => {
        let token: any = await jwt({
            token: superAdminToken(), trigger: 'update',
            session: { viewAsGrant: await grantFor(TENANT_B, { name: 'Tenant B', plan: 'BASE' }) },
        });
        expect(token.businessId).toBe(TENANT_B);
        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.businessName).toBe('Tenant A');
        expect(token.plan).toBe('ULTIMATE');
        expect(token.viewAsBusinessId).toBeFalsy();
    });

    it('B -> C -> exit returns to A, not to B', async () => {
        let token: any = superAdminToken();
        token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grantFor(TENANT_B) } });
        token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grantFor(TENANT_C) } });
        expect(token.businessId).toBe(TENANT_C);
        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.businessId).not.toBe(TENANT_B);
    });

    it('a fresh sign-in never inherits a previous view-as target', async () => {
        // Sign-in rebuilds authority from the database user object.
        const token = await jwt({
            token: { businessId: TENANT_B, viewAsBusinessId: TENANT_B, baseBusinessId: TENANT_A },
            user: {
                businessId: TENANT_A, plan: 'ULTIMATE', isSuperAdmin: true,
                role: 'ADMIN', permissions: null, businessName: 'Tenant A',
            },
        });
        expect(token.businessId).toBe(TENANT_A);
        expect(token.viewAsBusinessId).toBeFalsy();
        expect(token.baseBusinessId).toBeFalsy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART G — View As must not destroy the admin's durable identity
// ═══════════════════════════════════════════════════════════════════════════

describe('View As is temporary context, not a durable rewrite', () => {
    // The endpoint's behaviour is proved by EXECUTING it — see
    // tests/secTenant1SwitchTenant.test.ts. What remains here is the one claim
    // that is genuinely about the repository rather than about a single call:
    // that no OTHER code path has quietly reintroduced the destructive write.
    it('no route writes users.business_id for view-as purposes', () => {
        const { execSync } = require('child_process');
        const hits = execSync(
            'git --literal-pathspecs grep -n "prisma.user.update" -- app/api || true',
            { cwd: process.cwd(), encoding: 'utf8' }
        );
        expect(hits).not.toMatch(/switch-tenant/);
        // Password and user-management writers are expected; a tenant switcher is not.
        for (const line of hits.split('\n').filter(Boolean)) {
            expect(line).toMatch(/password|users\/route|reset-password/);
        }
    });
});
