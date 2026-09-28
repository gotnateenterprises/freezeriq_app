/**
 * PREVIEW-DB-ISOLATION-1 — Vercel Preview gets its own database, and its
 * outbound side effects are fenced off from real people and Production media.
 *
 *   A. one deployment-tier authority (lib/deploymentTier.ts), re-exported by the
 *      QuickBooks config so its behaviour and callers are unchanged
 *   B. every Resend client is built by lib/emailSafety.ts: Preview/unknown sends
 *      go only to the Resend test sink; Production and local are untouched
 *   C. Preview media uploads are kept under preview/; Production keys unchanged
 *   D. the fixture seeder refuses anything but a fixture-only Preview database,
 *      and its fixtures are fake by construction
 *   E. the documentation carries the rule future agents must follow
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source without // and block comments, so a comment can never satisfy or break a check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
    }
    return out;
}
const APP_SOURCES = [...walk('app'), ...walk('lib'), ...walk('components')];

const RESEND_SITES = [
    'lib/email.ts',
    'lib/drift_alert.ts',
    'lib/inquiryAcknowledgement.ts',
    'lib/outreachProvider.ts',
    'app/api/campaigns/[id]/coordinator-email/route.ts',
    'app/api/documents/send/route.ts',
    'app/api/email/send/route.ts',
    'app/api/opportunities/[id]/respond/route.ts',
    'app/api/production/generate-po/route.ts',
    'app/api/tenant/invoices/[id]/send/route.ts',
];

const PREVIEW_ENV = { VERCEL: '1', VERCEL_ENV: 'preview', NODE_ENV: 'production' } as any;
const PRODUCTION_ENV = { VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production' } as any;
const LOCAL_ENV = { NODE_ENV: 'development' } as any;
const UNKNOWN_ENV = { VERCEL: '1', NODE_ENV: 'production' } as any;

// ── A. deployment tier ──────────────────────────────────────────────────────

describe('A. one deployment-tier authority', () => {
    const tier = require('@/lib/deploymentTier');

    it('the QuickBooks config re-exports the SAME function, so QuickBooks behaviour cannot drift', () => {
        expect(require('@/lib/quickbooks/config').deploymentTier).toBe(tier.deploymentTier);
    });

    it('classifies every runtime exactly as QB-INVOICE-1A did', () => {
        expect(tier.deploymentTier(PREVIEW_ENV)).toBe('preview');
        expect(tier.deploymentTier(PRODUCTION_ENV)).toBe('production');
        expect(tier.deploymentTier({ VERCEL_ENV: 'development' } as any)).toBe('local');
        expect(tier.deploymentTier(LOCAL_ENV)).toBe('local');
        expect(tier.deploymentTier({ NODE_ENV: 'test' } as any)).toBe('local');
        expect(tier.deploymentTier(UNKNOWN_ENV)).toBe('unknown');
        expect(tier.deploymentTier({ VERCEL_ENV: 'staging' } as any)).toBe('unknown');
        expect(tier.deploymentTier({ NODE_ENV: 'production' } as any)).toBe('unknown');
    });

    it('Preview safety rules apply to preview and unknown only — never Production or local', () => {
        expect(tier.isPreviewSafetyTier('preview')).toBe(true);
        expect(tier.isPreviewSafetyTier('unknown')).toBe(true);
        expect(tier.isPreviewSafetyTier('production')).toBe(false);
        expect(tier.isPreviewSafetyTier('local')).toBe(false);
    });

    it('QuickBooks is still disabled on Preview before any credential is read', () => {
        const { resolveQuickBooksConfig } = require('@/lib/quickbooks/config');
        expect(resolveQuickBooksConfig({ ...PREVIEW_ENV, QBO_ENVIRONMENT: 'production', QBO_PRODUCTION_ENABLED: 'true' })).toEqual({ enabled: false, reason: 'preview_deployment' });
    });

    it('nothing else in app/, lib/ or components/ reads VERCEL_ENV', () => {
        const readers = APP_SOURCES.filter((f) => /VERCEL_ENV/.test(code(f)));
        expect(readers).toEqual(['lib/deploymentTier.ts']);
    });
});

// ── B. email ────────────────────────────────────────────────────────────────

describe('B. Preview email goes only to the Resend test sink', () => {
    const {
        applyPreviewEmailPolicy, previewSubject, PREVIEW_EMAIL_SINK,
    } = require('@/lib/emailSafety');

    beforeAll(() => jest.spyOn(console, 'info').mockImplementation(() => undefined));
    afterAll(() => (console.info as jest.Mock).mockRestore?.());

    it('the sink is Resend\'s own test address', () => {
        expect(PREVIEW_EMAIL_SINK).toBe('delivered@resend.dev');
    });

    it('rewrites to/cc/bcc to the sink alone and keeps everything else', () => {
        const attachments = [{ filename: 'a.pdf', content: 'x' }];
        const original = {
            from: 'Freezer Chef <orders@example.com>', replyTo: 'owner@example.com',
            to: ['coordinator@example.org', 'second@example.org'], cc: 'cc@example.org', bcc: ['bcc@example.org'],
            subject: 'Your order', html: '<p>hi</p>', attachments,
        };
        const out = applyPreviewEmailPolicy(original);
        expect(out.to).toEqual(['delivered@resend.dev']);
        expect(out.cc).toBeUndefined();
        expect(out.bcc).toBeUndefined();
        expect(out.subject).toBe('[PREVIEW to: coordinator@example.org, second@example.org, cc@example.org +1 more] Your order');
        expect(out.from).toBe(original.from);
        expect(out.replyTo).toBe(original.replyTo);
        expect(out.html).toBe(original.html);
        expect(out.attachments).toBe(attachments);
        // The caller's object is not mutated.
        expect(original.to).toEqual(['coordinator@example.org', 'second@example.org']);
    });

    it('accepts a single string recipient and is idempotent', () => {
        const once = applyPreviewEmailPolicy({ from: 'a@x.com', to: 'person@example.com', subject: 'S', html: 'h' });
        expect(once.to).toEqual(['delivered@resend.dev']);
        expect(once.subject).toBe('[PREVIEW to: person@example.com] S');
        expect(applyPreviewEmailPolicy(once)).toBe(once);
    });

    it('leaves a non-string subject alone and still redirects', () => {
        const out = applyPreviewEmailPolicy({ to: 'x@example.com', template: { id: 't' } } as any);
        expect(out.to).toEqual(['delivered@resend.dev']);
        expect(out.subject).toBeUndefined();
        expect(previewSubject('Hi', [])).toBe('[PREVIEW] Hi');
    });

    describe('createResendClient', () => {
        // A stand-in with the real SDK's shape: send() delegates to create(), and
        // batch has the same pair — so the wrapper must not apply twice.
        const posted: any[] = [];
        class FakeEmails { async send(p: any, o?: any) { return this.create(p, o); } async create(p: any) { posted.push(p); return { data: { id: 'm' }, error: null }; } }
        class FakeBatch { async send(p: any, o?: any) { return this.create(p, o); } async create(p: any) { posted.push(...p); return { data: [], error: null }; } }
        class FakeResend { emails = new FakeEmails(); batch = new FakeBatch(); constructor(public key?: string) {} }

        let createResendClient: (key?: string, env?: any) => any;
        beforeAll(() => {
            jest.isolateModules(() => {
                jest.doMock('resend', () => ({ Resend: FakeResend }));
                createResendClient = require('@/lib/emailSafety').createResendClient;
            });
        });
        beforeEach(() => { posted.length = 0; });

        const payload = () => ({ from: 'a@x.com', to: ['real.person@example.com'], cc: 'c@example.com', subject: 'Hello', html: 'h' });

        it('Production: the exact payload object reaches the provider, unchanged', async () => {
            const p = payload();
            await createResendClient('k', PRODUCTION_ENV).emails.send(p);
            expect(posted).toEqual([p]);
            expect(posted[0]).toBe(p);
        });

        it('local development: unchanged too', async () => {
            const p = payload();
            await createResendClient('k', LOCAL_ENV).emails.send(p);
            expect(posted[0]).toBe(p);
        });

        it('Preview: send, create and batch.send all reach only the sink, tagged once', async () => {
            const client = createResendClient('k', PREVIEW_ENV);
            await client.emails.send(payload());
            await client.emails.create(payload());
            await client.batch.send([payload(), { ...payload(), to: 'other@example.com' }]);
            expect(posted).toHaveLength(4);
            for (const p of posted) {
                expect(p.to).toEqual(['delivered@resend.dev']);
                expect(p.cc).toBeUndefined();
                expect(p.subject.match(/\[PREVIEW/g)).toHaveLength(1);
            }
            expect(posted[3].subject).toBe('[PREVIEW to: other@example.com, c@example.com] Hello');
        });

        it('an unrecognised runtime fails toward the sink, not toward a live send', async () => {
            await createResendClient('k', UNKNOWN_ENV).emails.send(payload());
            expect(posted[0].to).toEqual(['delivered@resend.dev']);
        });
    });

    it('lib/email.ts on a Preview deployment sends to the sink (module built under VERCEL_ENV=preview)', async () => {
        const sent: any[] = [];
        const saved = { ...process.env };
        try {
            Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'preview', RESEND_API_KEY: 're_test_key' });
            let sendEmail: any;
            jest.isolateModules(() => {
                jest.doMock('resend', () => ({ Resend: class { emails = { send: async (p: any) => { sent.push(p); return { data: { id: 'x' }, error: null }; } }; } }));
                jest.doMock('@/lib/db', () => ({ prisma: {} }));
                sendEmail = require('@/lib/email').sendEmail;
            });
            jest.spyOn(console, 'log').mockImplementation(() => undefined);
            expect(await sendEmail({ to: 'real.customer@example.com', subject: 'Receipt', html: '<p>x</p>' })).toBe(true);
            expect(sent).toHaveLength(1);
            expect(sent[0].to).toEqual(['delivered@resend.dev']);
            expect(sent[0].subject).toBe('[PREVIEW to: real.customer@example.com] Receipt');
        } finally {
            process.env = saved;
            (console.log as jest.Mock).mockRestore?.();
        }
    });

    it('no code constructs a Resend client except lib/emailSafety.ts', () => {
        const constructs = APP_SOURCES.filter((f) => /new\s+Resend\s*\(/.test(code(f)));
        expect(constructs).toEqual(['lib/emailSafety.ts']);
        const importsSdk = APP_SOURCES.filter((f) => /from\s+['"]resend['"]|import\(\s*['"]resend['"]\s*\)/.test(code(f)));
        expect(importsSdk).toEqual(['lib/emailSafety.ts']);
    });

    it('every former construction site now uses createResendClient', () => {
        for (const f of RESEND_SITES) {
            expect({ f, uses: /createResendClient\(/.test(code(f)) }).toEqual({ f, uses: true });
        }
    });
});

// ── C. media ────────────────────────────────────────────────────────────────

describe('C. Preview media uploads stay under preview/', () => {
    async function uploadWith(env: Record<string, string>) {
        const puts: any[] = [];
        const saved = { ...process.env };
        try {
            for (const k of ['VERCEL', 'VERCEL_ENV']) delete process.env[k];
            Object.assign(process.env, { S3_BUCKET_NAME: 'bucket', S3_PUBLIC_DOMAIN: 'https://media.example.com' }, env);
            let upload: any;
            jest.isolateModules(() => {
                jest.doMock('@aws-sdk/client-s3', () => ({
                    S3Client: class { async send(cmd: any) { puts.push(cmd.input); return {}; } },
                    PutObjectCommand: class { constructor(public input: any) {} },
                }));
                upload = require('@/lib/s3').uploadToS3;
            });
            const url = await upload(Buffer.from('x'), 'photo.png', 'image/png');
            return { url, key: puts[0].Key as string };
        } finally {
            process.env = saved;
        }
    }

    it('Preview: the object key and the returned URL carry the prefix', async () => {
        const { url, key } = await uploadWith({ VERCEL: '1', VERCEL_ENV: 'preview' });
        expect(key).toMatch(/^preview\/\d+-photo\.png$/);
        expect(url).toBe(`https://media.example.com/${key}`);
    });

    it('Production: keys are exactly as before (timestamp-name, no prefix)', async () => {
        const { url, key } = await uploadWith({ VERCEL: '1', VERCEL_ENV: 'production' });
        expect(key).toMatch(/^\d+-photo\.png$/);
        expect(url).toBe(`https://media.example.com/${key}`);
    });
});

// ── D. fixtures and the seed guard ──────────────────────────────────────────

describe('D. the Preview fixture seeder', () => {
    const fx = require('@/lib/previewFixtures');
    const PREVIEW_URLS = {
        DATABASE_URL: 'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
        DIRECT_URL: 'postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres',
    };
    const PRODUCTION_HOST_URL = 'postgresql://u:p@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
    const ok = { env: PREVIEW_URLS, existingBusinessSlugs: [] as string[], existingUserEmails: [] as string[] };

    it('accepts an empty database and a fixture-only database', () => {
        expect(() => fx.assertPreviewSeedTarget(ok)).not.toThrow();
        expect(() => fx.assertPreviewSeedTarget({ ...ok, existingBusinessSlugs: ['preview-test-tenant'], existingUserEmails: ['delivered+preview-admin@resend.dev'] })).not.toThrow();
    });

    it('refuses missing URLs, the Production host, a real business, or a real user', () => {
        expect(() => fx.assertPreviewSeedTarget({ ...ok, env: { DATABASE_URL: PREVIEW_URLS.DATABASE_URL } })).toThrow(fx.PreviewSeedRefusedError);
        expect(() => fx.assertPreviewSeedTarget({ ...ok, env: { ...PREVIEW_URLS, DIRECT_URL: PRODUCTION_HOST_URL } })).toThrow(/Production database host/);
        expect(() => fx.assertPreviewSeedTarget({ ...ok, env: { ...PREVIEW_URLS, DATABASE_URL: PRODUCTION_HOST_URL } })).toThrow(/Production database host/);
        expect(() => fx.assertPreviewSeedTarget({ ...ok, existingBusinessSlugs: ['preview-test-tenant', 'freezer-chef'] })).toThrow(/not Preview fixtures/);
        expect(() => fx.assertPreviewSeedTarget({ ...ok, existingUserEmails: ['owner@gmail.com'] })).toThrow(/not Preview fixtures/);
    });

    it('seedPreviewFixtures writes NOTHING when the guard refuses', async () => {
        const writes: string[] = [];
        const trap = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_m, op: string) => (...a: any[]) => { writes.push(`${model}.${op}`); return op === 'findMany' ? Promise.resolve(model === 'business' ? [{ slug: 'freezer-chef' }] : []) : Promise.resolve(a); } }) });
        const prisma: any = new Proxy(trap, { get: (t: any, k: string) => (k === '$transaction' || k === '$executeRawUnsafe' || k === '$queryRawUnsafe') ? (...a: any[]) => { writes.push(k); return Promise.resolve(a); } : t[k] });
        await expect(fx.seedPreviewFixtures(prisma, { env: PREVIEW_URLS, today: new Date('2026-09-27T12:00:00Z'), reset: true, adminPassword: 'a-long-enough-password' })).rejects.toThrow(/not Preview fixtures/);
        expect(writes).toEqual(['business.findMany', 'user.findMany']);
    });

    it('an already-seeded database is refused without --reset', async () => {
        const prisma: any = {
            business: { findMany: async () => [{ slug: 'preview-test-tenant' }] },
            user: { findMany: async () => [{ email: 'delivered+preview-admin@resend.dev' }] },
            $transaction: jest.fn(),
        };
        await expect(fx.seedPreviewFixtures(prisma, { env: PREVIEW_URLS, today: new Date(), reset: false, adminPassword: 'a-long-enough-password' })).rejects.toThrow(/already seeded/);
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('every fixture is fake by construction', () => {
        const names = [...Object.values(fx.PREVIEW_NAMES), ...fx.PREVIEW_RECIPE_NAMES, ...fx.PREVIEW_BUNDLES.map((b: any) => b.name)] as string[];
        for (const n of names) expect(n).toMatch(/^Preview Test /);
        for (const o of fx.PREVIEW_ORDERS) {
            expect(o.email).toMatch(/^delivered\+preview-[a-z0-9-]+@resend\.dev$/);
            expect(o.phone).toMatch(/^555-01\d\d$/);
            expect(`${o.firstName} ${o.lastName}`).toMatch(/^Preview /);
        }
        for (const v of Object.values(fx.PREVIEW_IDS) as string[]) expect(v).toMatch(/^7e57[0-9a-f]{4}-0000-4000-8000-\d{12}$/);
        expect(fx.PREVIEW_TENANT_SLUG.startsWith(fx.PREVIEW_SLUG_PREFIX)).toBe(true);
        expect(fx.previewFixtureEmail('x')).toBe('delivered+x@resend.dev');
    });

    it('each bundle family is exactly one Serves 5 + one Serves 2, and the active goal progress is 4.0', () => {
        const families = new Map<string, string[]>();
        for (const b of fx.PREVIEW_BUNDLES) families.set(b.familyId, [...(families.get(b.familyId) ?? []), b.variantSize]);
        expect(families.size).toBe(2);
        for (const sizes of families.values()) expect(sizes.sort()).toEqual(['serves_2', 'serves_5']);
        const weight: Record<string, number> = { serves_5: 1, serves_2: 0.5 };
        const bundle = (id: string) => fx.PREVIEW_BUNDLES.find((b: any) => b.id === id);
        const progress = fx.PREVIEW_ORDERS.filter((o: any) => o.campaign === 'active')
            .flatMap((o: any) => o.lines).reduce((s: number, l: any) => s + l.quantity * weight[bundle(l.bundleId).variantSize], 0);
        expect(progress).toBe(4);
    });

    it('the active campaign is open and the closed one is past its deadline', () => {
        const today = new Date('2026-09-27T12:00:00Z');
        const d = fx.previewCampaignDates(today);
        expect(d.active.end.getTime()).toBeGreaterThan(today.getTime());
        expect(d.active.delivery.getTime()).toBeGreaterThan(d.active.end.getTime());
        expect(d.closed.end.getTime()).toBeLessThan(today.getTime());
        expect(d.closed.closedAt.getTime()).toBeGreaterThan(d.closed.end.getTime());
    });

    it('the credentials file carries paths and the password, never a connection string', () => {
        const { previewCredentialsText } = require('@/lib/previewDbSeedCli');
        const text: string = previewCredentialsText({
            businessId: 'b', slug: 'preview-test-tenant', adminEmail: 'delivered+preview-admin@resend.dev',
            activeCampaignId: 'A', closedCampaignId: 'C', activePortalToken: 'tokA', closedPortalToken: 'tokC',
            orderIds: {}, closedInvoiceId: 'i', closedSettlementTotal: 0,
        }, 'pw-123456789012', new Date('2026-09-27T00:00:00Z'));
        expect(text).toContain('/shop/preview-test-tenant/fundraiser/A');
        expect(text).toContain('/coordinator/tokA');
        expect(text).toContain('pw-123456789012');
        expect(text).not.toMatch(/postgres(ql)?:\/\//);
    });

    it('the CLI refuses to write credentials inside the repository', () => {
        expect(code('lib/previewDbSeedCli.ts')).toMatch(/outPath\.startsWith\(repoRoot \+ path\.sep\)/);
    });
});

// ── E. documentation and repository hygiene ─────────────────────────────────

describe('E. documentation', () => {
    const doc = read('docs/ai/PREVIEW_ENVIRONMENT.md');
    const envDoc = read('docs/ai/ENVIRONMENT.md');

    it('states the future-agent rule in the Preview doc and in the environment contract CLAUDE.md requires', () => {
        for (const d of [doc, envDoc]) {
            expect(d).toContain('FUTURE AGENT RULE');
            expect(d).toMatch(/NEVER assume Preview points to Production/);
        }
        expect(read('CLAUDE.md')).toContain('docs/ai/ENVIRONMENT.md');
    });

    it('the environment contract no longer claims Preview shares the Production database', () => {
        expect(envDoc).not.toMatch(/because Preview shares the Production database/);
        expect(envDoc).toContain('PREVIEW_ENVIRONMENT.md');
    });

    it('no connection string or credential is committed with this phase', () => {
        const files = ['docs/ai/PREVIEW_ENVIRONMENT.md', 'docs/ai/ENVIRONMENT.md', 'lib/previewFixtures.ts', 'lib/previewDbSeedCli.ts', 'lib/emailSafety.ts', 'lib/deploymentTier.ts'];
        for (const f of files) {
            expect({ f, url: /postgres(ql)?:\/\/[^\s'"`<]+:[^\s'"`<@]+@/.test(read(f)) }).toEqual({ f, url: false });
            expect({ f, token: /\b(sbp_|re_[A-Za-z0-9]{8,}|sk_live_)/.test(read(f)) }).toEqual({ f, token: false });
        }
    });
});
