/**
 * COORDINATOR-EMAIL-REOPEN-1 — Review & send the coordinator setup email after launch.
 *
 * The REAL CoordinatorSetupEmailCard is mounted with the no-DOM hook runtime, and its fetch()
 * is answered by the REAL GET/POST handlers in app/api/campaigns/[id]/coordinator-email/route.ts,
 * running against a small in-memory coordinator row that applies the route's own conditional
 * claim exactly as written (WHERE claimed_at IS NULL AND sent_at IS NULL). The email provider
 * is a counter. So "did a second email go out?" is answered by the provider count, not by
 * reading the card's labels.
 *
 * All names and addresses are fictional; the repository is public.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mountComponent, findAll, textOf, runtime } from './helpers/hookRuntime';
import { checkCoordinatorSetupReadiness } from '@/lib/campaignOperationalDetails';
import { coordinatorAccessPath } from '@/lib/fundraiserUrls';
import {
    statusFromPreviewResponse,
    outcomeFromSendResponse,
    coordinatorEmailCardView,
    formatEmailTimestamp,
    type CoordinatorEmailStatus,
} from '@/lib/coordinatorSetupEmailView';

// The shared hook runtime skips effects; this suite needs the card's mount-time check, so effects
// are collected while a mounted component renders and run explicitly by the test.
jest.mock('react', () => {
    const hr = require('./helpers/hookRuntime');
    const base = hr.createReactMock();
    const actual = jest.requireActual('react');
    return {
        ...base,
        useEffect: (fn: any, deps: any) => {
            if (hr.runtime.ctx) { ((global as any).__reopenEffects ||= []).push(fn); return undefined; }
            return actual.useEffect(fn, deps);
        },
    };
});
jest.mock('sonner', () => {
    const rec = (level: string) => (title: string, opts?: any) => ((global as any).__reopenToasts ||= []).push({ level, title, description: opts?.description });
    return { toast: { success: rec('success'), info: rec('info'), warning: rec('warning'), error: rec('error'), message: rec('message') } };
});
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__reopenDb.client; } }));
jest.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u-1', businessId: 'biz-fixture-a', role: 'OWNER' } }) }));
jest.mock('@/lib/email', () => ({
    getTenantSender: async () => ({ from: 'Example Kitchen via FreezerIQ <noreply@example.invalid>', replyTo: 'hello@example.invalid' }),
}));
jest.mock('@/lib/emailSafety', () => ({
    createResendClient: () => ({
        emails: {
            send: async (msg: any) => {
                const g = global as any;
                g.__reopenProvider.push(msg);
                if (g.__reopenProviderMode === 'throw') throw new Error('network reset');
                if (g.__reopenProviderMode === 'reject') return { data: null, error: { message: 'rejected' } };
                return { data: { id: `msg-${g.__reopenProvider.length}` }, error: null };
            },
        },
    }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CoordinatorSetupEmailCard } = require('@/components/crm2/CoordinatorSetupEmailCard');

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const TENANT = 'biz-fixture-a';
const CAMPAIGN = 'camp-fixture-0001';
const TOKEN = 'portal-token-fixture-abc123';
const COORD_EMAIL = 'pat.example@example.invalid';
const ROUTE = 'app/api/campaigns/[id]/coordinator-email/route.ts';

interface CoordRow {
    setup_email_claimed_at: Date | null;
    setup_email_sent_at: Date | null;
    org_contact: any;
}

/** One tenant, one campaign, one coordinator row — with the claim applied as the route writes it. */
function makeDb(opts: { deliveryDate?: Date | null; deliveryTime?: string | null; coord?: Partial<CoordRow> | null } = {}) {
    const campaign = {
        id: CAMPAIGN,
        portal_token: TOKEN,
        customer_id: 'org-fixture',
        delivery_date: opts.deliveryDate === undefined ? new Date('2026-12-12T00:00:00.000Z') : opts.deliveryDate,
        delivery_time: opts.deliveryTime === undefined ? '4:00 PM' : opts.deliveryTime,
        customer: { name: 'Riverbend Robotics Club' },
    };
    const coord: CoordRow | null = opts.coord === null ? null : {
        setup_email_claimed_at: null,
        setup_email_sent_at: null,
        org_contact: {
            ended_at: null,
            contact: { display_name: 'Pat Example', contact_points: [{ value: COORD_EMAIL, is_primary: true }] },
        },
        ...(opts.coord ?? {}),
    };
    const writes: any[] = [];
    const client = {
        fundraiserCampaign: {
            findFirst: async ({ where }: any) =>
                where?.id === CAMPAIGN && where?.customer?.business_id === TENANT ? { ...campaign } : null,
        },
        fundraiserCampaignCoordinator: {
            findUnique: async () => (coord ? { ...coord } : null),
            updateMany: async ({ where, data }: any) => {
                writes.push({ op: 'updateMany', where, data });
                if (!coord) return { count: 0 };
                const conditional = 'setup_email_claimed_at' in where || 'setup_email_sent_at' in where;
                if (conditional) {
                    const ok = (!('setup_email_claimed_at' in where) || coord.setup_email_claimed_at === where.setup_email_claimed_at)
                        && (!('setup_email_sent_at' in where) || coord.setup_email_sent_at === where.setup_email_sent_at);
                    if (!ok) return { count: 0 };
                }
                Object.assign(coord, data);
                return { count: 1 };
            },
            update: async ({ data }: any) => { writes.push({ op: 'update', data }); Object.assign(coord!, data); return coord; },
        },
        business: {
            findUnique: async () => ({ name: 'Example Kitchen', display_name: 'Example Kitchen', custom_domain: null, contact_email: 'hello@example.invalid', slug: 'example-kitchen' }),
        },
    };
    return { campaign, coord, writes, client };
}

/** fetch() for the card, answered by the real route handlers. Records every request. */
const requests: { url: string; method: string; body: unknown }[] = [];
async function routeFetch(url: string, init: any = {}) {
    const method = init.method ?? 'GET';
    requests.push({ url, method, body: init.body });
    const m = url.match(/^\/api\/campaigns\/([^/]+)\/coordinator-email$/);
    if (!m) throw new Error(`unexpected fetch ${url}`);
    const mod = await import('@/app/api/campaigns/[id]/coordinator-email/route');
    const req = new Request(`http://localhost${url}`, { method });
    const ctx = { params: Promise.resolve({ id: decodeURIComponent(m[1]) }) } as any;
    return method === 'POST' ? mod.POST(req, ctx) : mod.GET(req, ctx);
}

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const posts = () => requests.filter((r) => r.method === 'POST');
const provider = () => (global as any).__reopenProvider as any[];
const buttons = (tree: any, re: RegExp) => findAll(tree, (el) => el.type === 'button' && re.test(textOf(el.props.children)));
const allText = (tree: any) => textOf(tree);

/** Mount the real card and run its mount-time check (a GET). */
async function mountCard(props: Record<string, any> = {}) {
    (global as any).__reopenEffects = [];
    const onChanged = jest.fn();
    const m = mountComponent(CoordinatorSetupEmailCard, { campaignId: CAMPAIGN, portalToken: TOKEN, knownSentAt: null, onChanged, ...props });
    const fx = ((global as any).__reopenEffects as any[]).splice(0);
    fx.forEach((f) => f());
    await settle();
    m.render();
    return { m, onChanged };
}
async function click(m: any, btn: any) { await btn.props.onClick(); await settle(); m.render(); }

beforeAll(() => {
    // The route logs its own held-claim / rejection paths loudly by design; those are exercised on purpose here.
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});
beforeEach(() => {
    requests.length = 0;
    (global as any).__reopenProvider = [];
    (global as any).__reopenProviderMode = 'ok';
    (global as any).__reopenToasts = [];
    (global as any).fetch = routeFetch;
    process.env.RESEND_API_KEY = 'test-key-not-real';
    process.env.EMAIL_LIVE = 'true';
});
afterAll(() => { delete process.env.RESEND_API_KEY; delete process.env.EMAIL_LIVE; });

describe('A · an existing, never-sent invitation can be reopened and reviewed', () => {
    it('the card checks with a GET, says "not sent yet", and Review opens the email with Send', async () => {
        (global as any).__reopenDb = makeDb();
        const { m } = await mountCard();
        expect(requests).toEqual([{ url: `/api/campaigns/${CAMPAIGN}/coordinator-email`, method: 'GET', body: undefined }]);
        expect(allText(m.tree)).toContain('Coordinator setup email not sent yet');
        expect(allText(m.tree)).toContain(COORD_EMAIL);

        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        const dialog = findAll(m.tree, (el) => el.props?.role === 'dialog')[0];
        expect(dialog).toBeDefined();
        expect(textOf(dialog)).toContain(COORD_EMAIL);
        expect(textOf(dialog)).toContain('Riverbend Robotics Club');
        expect(buttons(dialog, /Send Coordinator Email/)).toHaveLength(1);

        // Opening and reviewing wrote nothing and sent nothing.
        expect(posts()).toHaveLength(0);
        expect(provider()).toHaveLength(0);
        expect((global as any).__reopenDb.writes).toHaveLength(0);
        expect((global as any).__reopenDb.coord.setup_email_claimed_at).toBeNull();
    });

    it('works with the launch dialog nowhere in sight: the card is a standalone component on the drawer', () => {
        const drawer = read('components/crm2/CampaignContextDrawer.tsx');
        expect(drawer).toMatch(/import \{ CoordinatorSetupEmailCard \} from '\.\/CoordinatorSetupEmailCard'/);
        expect(drawer).toMatch(/!c\.is_placeholder && sections\.lifecycle !== 'completed' && \(\s*<CoordinatorSetupEmailCard/);
        expect(drawer).toMatch(/campaignId=\{c\.id\}/);
        expect(drawer).toMatch(/portalToken=\{c\.portal_token \?\? null\}/);
        expect(drawer).toMatch(/knownSentAt=\{c\.coordinator_invite_sent_at \?\? null\}/);
        expect(read('app/fundraisers/page.tsx')).toMatch(/onCoordinatorEmailChanged=\{loadCampaigns\}/);
        expect(read('components/crm2/CoordinatorSetupEmailCard.tsx')).not.toMatch(/LaunchFundraiserDialog/);
    });

    it('the setup token is never shown as text; Copy Setup Link copies the same link the email carries', async () => {
        (global as any).__reopenDb = makeDb();
        const copied: string[] = [];
        Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } }, configurable: true });
        const { m } = await mountCard();
        expect(allText(m.tree)).not.toContain(TOKEN);
        await click(m, buttons(m.tree, /Copy Setup Link/)[0]);
        expect(copied).toHaveLength(1);
        expect(copied[0].endsWith(coordinatorAccessPath(TOKEN))).toBe(true);
        expect(copied[0]).toMatch(/^https?:\/\//);
        expect(posts()).toHaveLength(0);
    });
});

describe('B · Jasper/Clark shape: launched without a time, time added later, then sent', () => {
    it('blocked with the readiness message until Edit details adds the time, then the existing send path runs once', async () => {
        const db = makeDb({ deliveryTime: null });
        (global as any).__reopenDb = db;
        const { m, onChanged } = await mountCard();
        const expected = checkCoordinatorSetupReadiness({ delivery_date: db.campaign.delivery_date, delivery_time: null });
        expect(expected.ready).toBe(false);
        expect(allText(m.tree)).toContain((expected as any).error);
        expect(buttons(m.tree, /Review|Send/)).toHaveLength(0);
        expect(buttons(m.tree, /Copy Setup Link/)).toHaveLength(0);

        // The tenant adds the time through Edit details (the campaign row changes; no claim moves).
        db.campaign.delivery_time = '4:00 PM';
        await click(m, buttons(m.tree, /Check again/)[0]);
        expect(allText(m.tree)).toContain('Coordinator setup email not sent yet');

        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        await click(m, buttons(m.tree, /Send Coordinator Email/)[0]);

        // Exactly one POST, with no body (the route chooses the recipient), and one provider send.
        expect(posts()).toEqual([{ url: `/api/campaigns/${CAMPAIGN}/coordinator-email`, method: 'POST', body: undefined }]);
        expect(provider()).toHaveLength(1);
        expect(provider()[0].to).toEqual([COORD_EMAIL]);
        expect(db.coord!.setup_email_claimed_at).toBeInstanceOf(Date);
        expect(db.coord!.setup_email_sent_at).toBeInstanceOf(Date);
        expect(allText(m.tree)).toMatch(/Coordinator setup email sent [A-Z][a-z]{2} \d{1,2}, \d{4}/);
        expect(buttons(m.tree, /Send Coordinator Email/)).toHaveLength(0);
        expect(onChanged).toHaveBeenCalledTimes(1);
        expect((global as any).__reopenToasts).toEqual([{ level: 'success', title: 'Setup email sent to the coordinator.', description: undefined }]);
    });

    it('a double click on Send makes one request and one email', async () => {
        (global as any).__reopenDb = makeDb();
        const { m } = await mountCard();
        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        const send = buttons(m.tree, /Send Coordinator Email/)[0];
        await Promise.all([send.props.onClick(), send.props.onClick()]);
        await settle(); m.render();
        expect(posts()).toHaveLength(1);
        expect(provider()).toHaveLength(1);
    });
});

describe('C · a sent invitation shows its status and never sends again', () => {
    const SENT = new Date('2026-11-18T21:05:00.000Z');

    it('shows "sent <date/time>", Review shows the email with no Send, and no click posts', async () => {
        (global as any).__reopenDb = makeDb({ coord: { setup_email_claimed_at: SENT, setup_email_sent_at: SENT } });
        const { m } = await mountCard();
        expect(allText(m.tree)).toContain(`Coordinator setup email sent ${formatEmailTimestamp(SENT.toISOString())}`);
        expect(allText(m.tree)).toContain('use Copy Setup Link');
        expect(buttons(m.tree, /^Review coordinator email$/)).toHaveLength(0);

        await click(m, buttons(m.tree, /^Review email$/)[0]);
        const dialog = findAll(m.tree, (el) => el.props?.role === 'dialog')[0];
        expect(textOf(dialog)).toContain(COORD_EMAIL);
        expect(buttons(m.tree, /Send/)).toHaveLength(0);

        // Press everything on screen except Copy (clipboard) — nothing reaches the send path.
        for (const b of findAll(m.tree, (el) => el.type === 'button' && !/Copy/.test(textOf(el.props.children)))) {
            await b.props.onClick?.(); await settle(); m.render();
        }
        expect(posts()).toHaveLength(0);
        expect(provider()).toHaveLength(0);
    });

    it('sent from another tab between review and Send: the route refuses, the card shows sent, no second email', async () => {
        const db = makeDb();
        (global as any).__reopenDb = db;
        const { m } = await mountCard();
        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        db.coord!.setup_email_claimed_at = SENT; db.coord!.setup_email_sent_at = SENT; // the other tab
        await click(m, buttons(m.tree, /Send Coordinator Email/)[0]);
        expect(posts()).toHaveLength(1);
        expect(provider()).toHaveLength(0);
        expect(db.coord!.setup_email_sent_at).toBe(SENT);
        expect(allText(m.tree)).toContain(`Coordinator setup email sent ${formatEmailTimestamp(SENT.toISOString())}`);
        expect((global as any).__reopenToasts[0]).toMatchObject({ level: 'info', title: 'That invitation has already been sent.' });
        expect(buttons(m.tree, /Send Coordinator Email/)).toHaveLength(0);
    });

    it('a sent fundraiser whose details are no longer "ready" still says sent (from the list), never "not sent"', async () => {
        (global as any).__reopenDb = makeDb({ deliveryTime: null, coord: { setup_email_claimed_at: SENT, setup_email_sent_at: SENT } });
        const { m } = await mountCard({ knownSentAt: SENT.toISOString() });
        expect(allText(m.tree)).toContain('Coordinator setup email sent');
        expect(allText(m.tree)).not.toContain('not sent yet');
        expect(buttons(m.tree, /Send/)).toHaveLength(0);
        expect(buttons(m.tree, /Copy Setup Link/)).toHaveLength(1);
    });
});

describe('D · an unresolved claim never allows a blind duplicate send', () => {
    const CLAIMED = new Date('2026-11-18T20:00:00.000Z');

    it('claimed-but-not-sent reads as unresolved, offers no Send, and no click posts', async () => {
        const db = makeDb({ coord: { setup_email_claimed_at: CLAIMED, setup_email_sent_at: null } });
        (global as any).__reopenDb = db;
        const { m } = await mountCard();
        expect(allText(m.tree)).toContain('Delivery status unresolved');
        expect(allText(m.tree)).toContain('will not send again automatically');
        expect(allText(m.tree)).not.toMatch(/Coordinator setup email sent/);
        await click(m, buttons(m.tree, /^Review email$/)[0]);
        expect(buttons(m.tree, /Send/)).toHaveLength(0);
        for (const b of findAll(m.tree, (el) => el.type === 'button' && !/Copy/.test(textOf(el.props.children)))) {
            await b.props.onClick?.(); await settle(); m.render();
        }
        expect(posts()).toHaveLength(0);
        expect(provider()).toHaveLength(0);
        expect(db.coord!.setup_email_claimed_at).toBe(CLAIMED);
        expect(db.coord!.setup_email_sent_at).toBeNull();
    });

    it('a send whose outcome is unknown (provider threw) holds the claim and leaves no Send button', async () => {
        const db = makeDb();
        (global as any).__reopenDb = db;
        (global as any).__reopenProviderMode = 'throw';
        const { m } = await mountCard();
        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        await click(m, buttons(m.tree, /Send Coordinator Email/)[0]);
        expect(provider()).toHaveLength(1);
        expect(db.coord!.setup_email_claimed_at).toBeInstanceOf(Date);
        expect(db.coord!.setup_email_sent_at).toBeNull();
        expect(allText(m.tree)).toContain('Delivery status unresolved');
        expect(buttons(m.tree, /Send/)).toHaveLength(0);
        // A fresh check (another visit) still reads unresolved and still offers no Send.
        const again = await mountCard();
        expect(allText(again.m.tree)).toContain('Delivery status unresolved');
        expect(buttons(again.m.tree, /Send/)).toHaveLength(0);
        expect(posts()).toHaveLength(1);
        expect(provider()).toHaveLength(1);
    });

    it('an explicit provider rejection releases the claim, so the card stays ready and the tenant may retry', async () => {
        const db = makeDb();
        (global as any).__reopenDb = db;
        (global as any).__reopenProviderMode = 'reject';
        const { m } = await mountCard();
        await click(m, buttons(m.tree, /^Review coordinator email$/)[0]);
        await click(m, buttons(m.tree, /Send Coordinator Email/)[0]);
        expect(db.coord!.setup_email_claimed_at).toBeNull();
        expect(db.coord!.setup_email_sent_at).toBeNull();
        expect(allText(m.tree)).toContain('not sent yet');
        expect(buttons(m.tree, /Send Coordinator Email/)).toHaveLength(1); // dialog still open for a genuine retry
        expect((global as any).__reopenToasts[0].level).toBe('error');
    });
});

describe('E · missing details surface the route\'s own readiness message', () => {
    const cases: [string, Parameters<typeof makeDb>[0], () => string][] = [
        ['missing time', { deliveryTime: null }, () => (checkCoordinatorSetupReadiness({ delivery_date: '2026-12-12', delivery_time: null }) as any).error],
        ['missing date', { deliveryDate: null }, () => (checkCoordinatorSetupReadiness({ delivery_date: null, delivery_time: '4:00 PM' }) as any).error],
        ['missing date and time', { deliveryDate: null, deliveryTime: null }, () => (checkCoordinatorSetupReadiness({ delivery_date: null, delivery_time: null }) as any).error],
        ['blank time', { deliveryTime: '   ' }, () => (checkCoordinatorSetupReadiness({ delivery_date: '2026-12-12', delivery_time: null }) as any).error],
        ['coordinator has no email', { coord: { org_contact: { ended_at: null, contact: { display_name: 'Pat Example', contact_points: [] } } } }, () => 'The selected coordinator has no email address on file.'],
        ['no coordinator', { coord: null }, () => 'This fundraiser has no primary coordinator yet.'],
    ];
    it.each(cases)('%s', async (_label, dbOpts, expected) => {
        (global as any).__reopenDb = makeDb(dbOpts);
        const { m } = await mountCard();
        expect(allText(m.tree)).toContain('Not ready to send yet');
        expect(allText(m.tree)).toContain(expected());
        expect(allText(m.tree)).not.toMatch(/Something went wrong/);
        expect(buttons(m.tree, /Review|Send/)).toHaveLength(0);
        expect(posts()).toHaveLength(0);
    });
});

describe('F · one-send / claim semantics are unchanged', () => {
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: 'utf8' });
    const lf = (s: string) => s.replace(/\r\n/g, '\n');

    it('the coordinator-email route is byte-identical to Production 1885e17', () => {
        expect(lf(read(ROUTE))).toBe(lf(git(`show 1885e17:"${ROUTE}"`)));
    });

    it('the launch dialog, schema and migrations are untouched', () => {
        expect(lf(read('components/crm2/LaunchFundraiserDialog.tsx'))).toBe(lf(git('show 1885e17:"components/crm2/LaunchFundraiserDialog.tsx"')));
        // SUPERSEDED PIN (SUPPORTER-CONSENT-1, owner-approved 2026-11-19): a later release adds an
        // additive table, so the schema/migration guarantee is checked against THIS release's own
        // commit (c4e528b, on 1885e17): it changed nothing under prisma/.
        expect(git('diff --name-only 1885e17 c4e528b -- prisma').trim()).toBe('');
    });

    it('the card reaches only the existing route: one GET path, one body-less POST, no direct writes', () => {
        const src = read('components/crm2/CoordinatorSetupEmailCard.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        expect(src.match(/fetch\(/g)).toHaveLength(2);
        expect(src).toMatch(/const url = `\/api\/campaigns\/\$\{encodeURIComponent\(campaignId\)\}\/coordinator-email`;/);
        expect(src).toMatch(/fetch\(url, \{ method: 'POST', credentials: 'same-origin' \}\)/);
        expect(src).not.toMatch(/body:/);
        expect(src).not.toMatch(/setup_email_(claimed|sent)_at/);
        expect(src).not.toMatch(/\/api\/email\//);
        expect(read('lib/coordinatorSetupEmailView.ts')).not.toMatch(/fetch\(|prisma/);
    });

    it('a replayed POST after a successful send is refused by the route and sends nothing', async () => {
        const db = makeDb();
        (global as any).__reopenDb = db;
        const first = await routeFetch(`/api/campaigns/${CAMPAIGN}/coordinator-email`, { method: 'POST' });
        expect(first.status).toBe(200);
        const second = await routeFetch(`/api/campaigns/${CAMPAIGN}/coordinator-email`, { method: 'POST' });
        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject({ alreadySent: true });
        expect(provider()).toHaveLength(1);
    });
});

describe('the status helpers', () => {
    const preview = { to: COORD_EMAIL, subject: 'S', html: '<p>h</p>' };

    it('GET answers map to the route\'s three states, sent outranking a claim', () => {
        expect(statusFromPreviewResponse(true, 200, { ...preview, state: 'ready', alreadySentAt: null, claimedAt: null }).kind).toBe('ready');
        expect(statusFromPreviewResponse(true, 200, { ...preview, state: 'sent', alreadySentAt: '2026-11-18T00:00:00Z', claimedAt: '2026-11-18T00:00:00Z' }).kind).toBe('sent');
        expect(statusFromPreviewResponse(true, 200, { ...preview, state: 'unresolved', alreadySentAt: null, claimedAt: '2026-11-18T00:00:00Z' }).kind).toBe('unresolved');
        // Timestamps win even if `state` were missing.
        expect(statusFromPreviewResponse(true, 200, { ...preview, claimedAt: '2026-11-18T00:00:00Z' }).kind).toBe('unresolved');
        expect(statusFromPreviewResponse(false, 409, { error: 'Set a delivery/pickup time…' })).toEqual({ kind: 'blocked', message: 'Set a delivery/pickup time…', knownSentAt: null });
        expect(statusFromPreviewResponse(false, 404, { error: 'Campaign not found.' }).kind).toBe('blocked');
        expect(statusFromPreviewResponse(false, 500, { error: 'boom' }).kind).toBe('error');
        expect(statusFromPreviewResponse(false, 401, {}).kind).toBe('error');
        expect(statusFromPreviewResponse(true, 200, { state: 'ready' }).kind).toBe('error'); // no email to review
    });

    it('only `ready` ever offers Send', () => {
        const all: CoordinatorEmailStatus[] = [
            { kind: 'loading' },
            { kind: 'ready', preview },
            { kind: 'sent', sentAt: null, preview },
            { kind: 'unresolved', claimedAt: null, preview },
            { kind: 'blocked', message: 'x', knownSentAt: null },
            { kind: 'blocked', message: 'x', knownSentAt: '2026-11-18T00:00:00Z' },
            { kind: 'error', message: 'x' },
        ];
        expect(all.filter((s) => coordinatorEmailCardView(s).canSend).map((s) => s.kind)).toEqual(['ready']);
        expect(coordinatorEmailCardView({ kind: 'blocked', message: 'x', knownSentAt: null }).canCopyLink).toBe(false);
    });

    it('POST answers: every uncertain outcome becomes unresolved; failures and safety mode change nothing', () => {
        const now = new Date('2026-11-18T12:00:00Z');
        expect(outcomeFromSendResponse(true, 200, { success: true, recorded: true }, now).next?.kind).toBe('sent');
        expect(outcomeFromSendResponse(true, 200, { success: true, recorded: false }, now).next?.kind).toBe('unresolved');
        expect(outcomeFromSendResponse(true, 200, { success: true, mocked: true }, now)).toMatchObject({ kind: 'mocked', next: null });
        expect(outcomeFromSendResponse(false, 409, { alreadySent: true, sentAt: now }, now).next?.kind).toBe('sent');
        expect(outcomeFromSendResponse(false, 409, { unresolved: true, claimedAt: now }, now).next?.kind).toBe('unresolved');
        expect(outcomeFromSendResponse(false, 502, { uncertain: true, error: 'e' }, now).next?.kind).toBe('unresolved');
        expect(outcomeFromSendResponse(false, 409, { error: 'Set a time' }, now).next?.kind).toBe('blocked');
        expect(outcomeFromSendResponse(false, 500, { error: 'Something went wrong. Please try again.' }, now)).toMatchObject({ kind: 'failed', next: null });
    });
});

afterAll(() => { runtime.ctx = null; });
