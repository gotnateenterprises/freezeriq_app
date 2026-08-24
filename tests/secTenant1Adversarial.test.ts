/**
 * SEC-TENANT-1 — ADVERSARIAL REVIEW SUITE.
 *
 * The implementation suite proves the fix does what it claims. This one tries to
 * break it. Everything here is an attack: forged grants, replayed grants,
 * cross-admin grants, expired grants, tampered metadata, prototype pollution,
 * rapid switching, and the original exploit reconstructed from scratch.
 *
 * PART B is deliberately self-contained: rather than mutating the source file,
 * it rebuilds the ORIGINAL vulnerable callback inline and demonstrates the leak,
 * then runs the same payload through the real one. That makes the regression
 * proof permanent and readable, instead of a mutation that only existed once in
 * a terminal.
 */

process.env.AUTH_SECRET = 'test-secret-sec-tenant-1';

import { authConfig } from '@/auth.config';
import { applySessionUpdate } from '@/lib/auth/sessionUpdate';
import { signViewAsGrant, verifyViewAsGrant, VIEW_AS_GRANT_TTL_SECONDS } from '@/lib/auth/viewAsGrant';

const SECRET = process.env.AUTH_SECRET as string;
const A = 'biz-aaaa-1111';
const B = 'biz-bbbb-2222';
const C = 'biz-cccc-3333';
const SUPER = 'user-super';
const OTHER_SUPER = 'user-super-2';

const jwt = (args: any) => (authConfig.callbacks as any).jwt(args);

// Post-sign-in shape: applySignIn deletes every base* field, so these carry none
// and the capture path is exercised for real rather than pre-seeded.
const ordinary = () => ({
    sub: 'user-ordinary', role: 'ADMIN', businessId: A,
    plan: 'PRO', isSuperAdmin: false, businessName: 'Tenant A',
});
const admin = () => ({
    sub: SUPER, role: 'ADMIN', businessId: A,
    plan: 'ULTIMATE', subscriptionStatus: 'active', isSuperAdmin: true, businessName: 'Tenant A',
});

const now = () => Math.floor(Date.now() / 1000);
const grant = (o: any = {}) => signViewAsGrant({
    sub: o.sub ?? SUPER,
    bid: o.bid ?? B,
    name: o.name ?? 'Tenant B',
    plan: o.plan ?? 'BASE',
    status: o.status ?? 'active',
    exp: o.exp ?? now() + VIEW_AS_GRANT_TTL_SECONDS,
}, o.secret ?? SECRET);

// ═══════════════════════════════════════════════════════════════════════════
// PART B — reproduce the ORIGINAL vulnerability, then prove it is closed
// ═══════════════════════════════════════════════════════════════════════════

/** The historical callback, reconstructed verbatim from git history. */
function vulnerableJwt(token: any, trigger: string, session: any) {
    if (trigger === 'update' && session?.businessId) {
        token.businessId = session.businessId;
        if (session.businessName) token.businessName = session.businessName;
        if (session.plan) token.plan = session.plan;
    }
    return token;
}

describe('PART B — the original vulnerability, reproduced and then closed', () => {
    const exploit = { businessId: B, businessName: 'Tenant B', plan: 'ULTIMATE' };

    it('the ORIGINAL implementation leaks: an ordinary user lands in Tenant B', () => {
        const leaked = vulnerableJwt(ordinary(), 'update', exploit);
        expect(leaked.businessId).toBe(B);          // <- the vulnerability
        expect(leaked.plan).toBe('ULTIMATE');       // <- and plan escalation with it
    });

    it('the CURRENT implementation blocks the identical payload', async () => {
        const token = await jwt({ token: ordinary(), trigger: 'update', session: exploit });
        expect(token.businessId).toBe(A);
        expect(token.plan).toBe('PRO');
    });

    it('the current implementation blocks it for a SUPER ADMIN too', async () => {
        const token = await jwt({ token: admin(), trigger: 'update', session: exploit });
        expect(token.businessId).toBe(A);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART D — direct View-As bypass attempts
// ═══════════════════════════════════════════════════════════════════════════

describe('PART D — a super admin cannot bypass the switch endpoint', () => {
    const BAD_TARGETS: any[] = [
        B, 'does-not-exist', '', '   ', null, undefined, 42, true, {}, [], { id: B },
        'x'.repeat(10000), 'biz\u0000null', '../../etc/passwd', "'; DROP TABLE users;--",
        '‮reversed', 'biz b with spaces',
    ];

    it.each(BAD_TARGETS.map((t, i) => [i, t]))(
        'unsigned viewAsBusinessId #%i is inert', async (_i, target) => {
            const token = await jwt({
                token: admin(), trigger: 'update', session: { viewAsBusinessId: target },
            });
            expect(token.businessId).toBe(A);
            expect(token.viewAsBusinessId).toBeUndefined();
        });

    it('an unsigned bundle of every field at once is inert', async () => {
        const token = await jwt({
            token: admin(), trigger: 'update',
            session: {
                businessId: B, viewAsBusinessId: B, baseBusinessId: B,
                viewAsBusinessName: 'Tenant B', viewAsPlan: 'ULTIMATE',
                viewAsSubscriptionStatus: 'active', isSuperAdmin: true, role: 'OWNER',
            },
        });
        expect(token.businessId).toBe(A);
        expect(token.plan).toBe('ULTIMATE');   // unchanged: their OWN real plan
        expect(token.businessName).toBe('Tenant A');
    });

    it('a nonexistent tenant cannot be reached, because it can never be signed', async () => {
        // The endpoint signs only after prisma.business.findUnique succeeds, so
        // there is no route by which a grant for a nonexistent id comes to exist.
        // Proving the boundary rejects the UNSIGNED form is what closes the gap.
        const token = await jwt({
            token: admin(), trigger: 'update', session: { viewAsBusinessId: 'ghost-tenant' },
        });
        expect(token.businessId).toBe(A);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART S / P — grant integrity and metadata tampering
// ═══════════════════════════════════════════════════════════════════════════

describe('PART S — grant signatures cannot be forged or tampered with', () => {
    it('a grant signed with the WRONG secret is rejected', async () => {
        const forged = await grant({ secret: 'attacker-secret' });
        const token = await jwt({ token: admin(), trigger: 'update', session: { viewAsGrant: forged } });
        expect(token.businessId).toBe(A);
    });

    it('a grant with a tampered BODY is rejected', async () => {
        const good = await grant({ bid: B });
        const [body, sig] = good.split('.');
        const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
        decoded.bid = C;                                  // retarget to Tenant C
        decoded.plan = 'ULTIMATE';                        // and escalate
        const tamperedBody = Buffer.from(JSON.stringify(decoded)).toString('base64url');
        const token = await jwt({
            token: admin(), trigger: 'update', session: { viewAsGrant: tamperedBody + '.' + sig },
        });
        expect(token.businessId).toBe(A);
    });

    it('a grant with a tampered SIGNATURE is rejected', async () => {
        const good = await grant();
        const [body] = good.split('.');
        for (const sig of ['', 'AAAA', body, 'x'.repeat(100)]) {
            const token = await jwt({
                token: admin(), trigger: 'update', session: { viewAsGrant: body + '.' + sig },
            });
            expect(token.businessId).toBe(A);
        }
    });

    it('malformed grant strings are rejected', async () => {
        for (const bad of ['', '.', 'a.', '.b', 'no-dot', 'a.b.c', 'x'.repeat(5000), null, 42, {}, []]) {
            const token = await jwt({ token: admin(), trigger: 'update', session: { viewAsGrant: bad } });
            expect(token.businessId).toBe(A);
        }
    });

    it('an EXPIRED grant is rejected', async () => {
        const stale = await grant({ exp: now() - 1 });
        const token = await jwt({ token: admin(), trigger: 'update', session: { viewAsGrant: stale } });
        expect(token.businessId).toBe(A);
    });

    it('a grant issued to ANOTHER super admin cannot be replayed', async () => {
        const notMine = await grant({ sub: OTHER_SUPER, bid: B });
        const token = await jwt({ token: admin(), trigger: 'update', session: { viewAsGrant: notMine } });
        expect(token.businessId).toBe(A);
    });

    it('verifyViewAsGrant itself fails closed on every malformed input', async () => {
        for (const bad of [null, undefined, '', 'x', 'a.b', 42, {}, []]) {
            expect(await verifyViewAsGrant(bad as any, SECRET)).toBeNull();
        }
        expect(await verifyViewAsGrant(await grant(), '')).toBeNull();
    });
});

describe('PART P / Q — tenant metadata and plan are server-authoritative', () => {
    it('metadata cannot be supplied alongside a grant to override it', async () => {
        // The grant says BASE; the payload also claims ULTIMATE. The grant wins.
        const g = await grant({ bid: B, name: 'Tenant B', plan: 'BASE' });
        const token = await jwt({
            token: admin(), trigger: 'update',
            session: {
                viewAsGrant: g,
                viewAsPlan: 'ULTIMATE', viewAsBusinessName: 'Tenant C',
                plan: 'ULTIMATE', businessName: 'Tenant C',
            },
        });
        expect(token.businessId).toBe(B);
        expect(token.plan).toBe('BASE');            // from the signed grant
        expect(token.businessName).toBe('Tenant B'); // from the signed grant
    });

    it('id, name and plan always come from ONE grant, so they cannot disagree', async () => {
        const g = await grant({ bid: C, name: 'Tenant C', plan: 'ENTERPRISE', status: 'past_due' });
        const token = await jwt({ token: admin(), trigger: 'update', session: { viewAsGrant: g } });
        expect(token.businessId).toBe(C);
        expect(token.businessName).toBe('Tenant C');
        expect(token.plan).toBe('ENTERPRISE');
        expect(token.subscriptionStatus).toBe('past_due');
    });

    it('a SUPER ADMIN cannot set plan, name, role or status with bare fields', async () => {
        // Being privileged enough to view another tenant is not permission to
        // invent that tenant's attributes. Only a signed grant moves these, and
        // only all together. (Mutation W5 lived here: an injected
        // `if (typeof u.plan === 'string') token.plan = u.plan` sits AFTER the
        // super-admin guard, so no ordinary-user test can reach it.)
        const token = await jwt({
            token: admin(),
            trigger: 'update',
            session: {
                plan: 'ENTERPRISE', businessName: 'Impostor Inc', role: 'OWNER',
                subscriptionStatus: 'past_due', permissions: ['*'], isSuperAdmin: true,
            },
        });
        expect(token.plan).toBe('ULTIMATE');
        expect(token.businessName).toBe('Tenant A');
        expect(token.role).toBe('ADMIN');
        expect(token.subscriptionStatus).toBe('active');
        expect(token.businessId).toBe(A);
    });

    it('bare fields stay inert even when a VALID grant is present', async () => {
        // The grant is authoritative; loose fields riding alongside it are not.
        const token = await jwt({
            token: admin(), trigger: 'update',
            session: {
                viewAsGrant: await grant({ bid: B, name: 'Tenant B', plan: 'BASE', status: 'active' }),
                plan: 'ENTERPRISE', businessName: 'Impostor Inc',
                subscriptionStatus: 'past_due', role: 'OWNER',
            },
        });
        expect(token.businessId).toBe(B);
        expect(token.plan).toBe('BASE');
        expect(token.businessName).toBe('Tenant B');
        expect(token.subscriptionStatus).toBe('active');
        expect(token.role).toBe('ADMIN');
    });

    it('an ordinary user cannot escalate plan by any route', async () => {
        for (const payload of [
            { plan: 'ULTIMATE' },
            { viewAsPlan: 'ULTIMATE' },
            { viewAsGrant: await grant({ sub: 'user-ordinary', plan: 'ULTIMATE' }) },
            { businessId: A, plan: 'ULTIMATE' },
        ]) {
            const token = await jwt({ token: ordinary(), trigger: 'update', session: payload });
            expect(token.plan).toBe('PRO');
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART F — base business authority
// ═══════════════════════════════════════════════════════════════════════════

describe('PART F — baseBusinessId originates from sign-in and is immutable', () => {
    it('sign-in derives base authority from the database user', async () => {
        let token: any = await jwt({
            token: {}, user: {
                businessId: A, plan: 'ULTIMATE', isSuperAdmin: true, role: 'ADMIN',
                permissions: null, businessName: 'Tenant A', subscriptionStatus: 'active',
            },
        });
        // Base is captured on the first privileged update, from trusted token state.
        token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grant({ bid: B }) } });
        expect(token.baseBusinessId).toBe(A);
    });

    it('the client cannot set baseBusinessId directly', async () => {
        const token = await jwt({
            token: admin(), trigger: 'update',
            session: { baseBusinessId: B, businessId: B, viewAsBusinessId: B },
        });
        expect(token.baseBusinessId).toBe(A);
        expect(token.businessId).toBe(A);
    });

    it('the client cannot corrupt base authority alongside a valid grant', async () => {
        const token = await jwt({
            token: admin(), trigger: 'update',
            session: { viewAsGrant: await grant({ bid: B }), baseBusinessId: B, basePlan: 'BASE' },
        });
        expect(token.businessId).toBe(B);
        expect(token.baseBusinessId).toBe(A);   // untouched
        expect(token.basePlan).toBe('ULTIMATE');
    });

    it('a super admin with NO home business never latches a view-as target as base', async () => {
        // REGRESSION. The capture used to key on `!token.baseBusinessId`. For an
        // admin whose businessId is undefined that condition stayed true forever,
        // so the SECOND hop captured the FIRST hop's target as "base" and exiting
        // stranded them inside another tenant. The explicit baseCaptured flag fixes it.
        let token: any = {
            sub: SUPER, isSuperAdmin: true, businessId: undefined,
            businessName: undefined, plan: undefined, role: 'ADMIN',
        };
        token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grant({ bid: B }) } });
        expect(token.businessId).toBe(B);
        token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grant({ bid: C }) } });
        expect(token.baseBusinessId).toBeUndefined();   // NOT B
        expect(token.baseBusinessId).not.toBe(B);

        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBeUndefined();       // fails closed, not into B
        expect(token.businessId).not.toBe(B);
        expect(token.businessId).not.toBe(C);
    });

    it('exit restores name and plan together, never a half-restored identity', async () => {
        let token: any = admin();
        token = await jwt({
            token, trigger: 'update',
            session: { viewAsGrant: await grant({ bid: B, name: 'Tenant B', plan: 'BASE' }) },
        });
        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBe(A);
        expect(token.businessName).toBe('Tenant A');
        expect(token.plan).toBe('ULTIMATE');
        expect(token.subscriptionStatus).toBe('active');
    });

    it('base survives many hops and still restores correctly', async () => {
        let token: any = admin();
        for (const bid of [B, C, B, C, B]) {
            token = await jwt({ token, trigger: 'update', session: { viewAsGrant: await grant({ bid }) } });
            expect(token.baseBusinessId).toBe(A);
        }
        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBe(A);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART O — rapid / concurrent switching
// ═══════════════════════════════════════════════════════════════════════════

describe('PART O — concurrent switches settle on ONE coherent tenant', () => {
    it('interleaved B and C updates never mix one tenant\'s id with another\'s metadata', async () => {
        const token: any = admin();
        const [gB, gC] = await Promise.all([
            grant({ bid: B, name: 'Tenant B', plan: 'BASE' }),
            grant({ bid: C, name: 'Tenant C', plan: 'ENTERPRISE' }),
        ]);

        // Fire both against the SAME token object, as two overlapping requests would.
        await Promise.all([
            jwt({ token, trigger: 'update', session: { viewAsGrant: gB } }),
            jwt({ token, trigger: 'update', session: { viewAsGrant: gC } }),
        ]);

        // Whichever won, the claims must all describe the SAME tenant.
        const coherent =
            (token.businessId === B && token.businessName === 'Tenant B' && token.plan === 'BASE') ||
            (token.businessId === C && token.businessName === 'Tenant C' && token.plan === 'ENTERPRISE');
        expect(coherent).toBe(true);
        expect(token.viewAsBusinessId).toBe(token.businessId);
    });

    it('50 rapid alternating switches always leave coherent state', async () => {
        let token: any = admin();
        for (let i = 0; i < 50; i++) {
            const bid = i % 2 ? C : B;
            const name = i % 2 ? 'Tenant C' : 'Tenant B';
            token = await jwt({
                token, trigger: 'update',
                session: { viewAsGrant: await grant({ bid, name, plan: i % 2 ? 'ENTERPRISE' : 'BASE' }) },
            });
            expect(token.businessId).toBe(bid);
            expect(token.businessName).toBe(name);
            expect(token.viewAsBusinessId).toBe(bid);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Structural attacks
// ═══════════════════════════════════════════════════════════════════════════

describe('structural attacks on the update payload', () => {
    it('prototype-pollution shapes cannot grant privilege', async () => {
        const polluted = JSON.parse('{"__proto__":{"isSuperAdmin":true},"businessId":"' + B + '"}');
        const token = await jwt({ token: ordinary(), trigger: 'update', session: polluted });
        expect(token.businessId).toBe(A);
        expect(token.isSuperAdmin).toBe(false);
        expect(({} as any).isSuperAdmin).toBeUndefined();   // global prototype intact
    });

    it('a constructor/prototype payload is inert', async () => {
        const token = await jwt({
            token: ordinary(), trigger: 'update',
            session: JSON.parse('{"constructor":{"prototype":{"isSuperAdmin":true}}}'),
        });
        expect(token.businessId).toBe(A);
        expect(token.isSuperAdmin).toBe(false);
    });

    it('getter-bearing payloads cannot smuggle values past the guard', async () => {
        const evil: any = {};
        Object.defineProperty(evil, 'viewAsGrant', { get() { return grant(); }, enumerable: true });
        const token = await jwt({ token: ordinary(), trigger: 'update', session: evil });
        expect(token.businessId).toBe(A);
    });

    it('exitViewAs only fires on exactly true', async () => {
        let token: any = await jwt({
            token: admin(), trigger: 'update', session: { viewAsGrant: await grant({ bid: B }) },
        });
        expect(token.businessId).toBe(B);
        for (const truthy of [1, 'true', 'yes', {}, []]) {
            token = await jwt({ token, trigger: 'update', session: { exitViewAs: truthy } });
            expect(token.businessId).toBe(B);   // still viewing; not an accidental exit
        }
        token = await jwt({ token, trigger: 'update', session: { exitViewAs: true } });
        expect(token.businessId).toBe(A);
    });

    it('exit works even if the admin never captured a base (defensive ordering)', async () => {
        // A super admin whose token predates this feature has no baseBusinessId.
        const token = await jwt({
            token: { sub: SUPER, isSuperAdmin: true, businessId: A, businessName: 'Tenant A', plan: 'ULTIMATE' },
            trigger: 'update',
            session: { exitViewAs: true },
        });
        expect(token.businessId).toBe(A);       // fail-safe, not undefined
    });

    it('applySessionUpdate is a no-op without a secret', async () => {
        const token = { sub: SUPER, isSuperAdmin: true, businessId: A };
        await applySessionUpdate(token, { viewAsGrant: await grant({ bid: B }) }, undefined);
        expect(token.businessId).toBe(A);
    });

    it('a null/!token input never throws', async () => {
        expect(await applySessionUpdate(null, { viewAsGrant: 'x' }, SECRET)).toBeNull();
        expect(await applySessionUpdate(undefined, {}, SECRET)).toBeUndefined();
    });
});
