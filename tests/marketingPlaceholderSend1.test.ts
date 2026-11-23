/**
 * MARKETING-PLACEHOLDER-SEND-1 — the Marketing page and /api/marketing/send stop
 * pretending to deliver.
 *
 * Before: app/campaigns/page.tsx POSTed to /api/marketing/send, which handed the
 * message to an in-memory MockMarketingClient (lib/marketing_client.ts). The mock
 * console.logged it, waited 1.5 s and answered `status: 'sent'`; the page then
 * showed "Message Sent! 🚀". Nothing was ever emailed or texted. The GET returned
 * the mock's process-wide list (two invented demo campaigns with made-up stats,
 * plus whatever any tenant had "sent" since cold start), and the page showed
 * hard-coded 42% / 18% open and click rates.
 *
 * These tests execute the REAL route handlers and drive the REAL page component
 * (tests/helpers/hookRuntime.ts, no DOM), and prove:
 *   A. Both API methods refuse with 501 and `sent: false`, read no body, touch no
 *      database, log nothing, and keep no cross-tenant memory.
 *   B. The page says sending is unavailable, keeps Send disabled with a reason,
 *      never fetches the send route, never alerts "Message Sent", and shows no
 *      invented campaigns or stats.
 *   C. The mock sender is gone and nothing imports it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createPrismaMock, jsonRequest, readJson, type PrismaMock } from './helpers/routeHarness';
import { mountComponent, findAll, textOf } from './helpers/hookRuntime';

// The shared hook runtime skips effects; collect them while a mounted component
// renders so a test can run the page's mount effect explicitly.
jest.mock('react', () => {
    const hr = require('./helpers/hookRuntime');
    const base = hr.createReactMock();
    const actual = jest.requireActual('react');
    return {
        ...base,
        useEffect: (fn: any, deps: any) => {
            if (hr.runtime.ctx) { ((global as any).__mktEffects ||= []).push(fn); return undefined; }
            return actual.useEffect(fn, deps);
        },
    };
});
jest.mock('@/lib/db', () => ({ get prisma() { return (global as any).__mktPrisma; } }));
jest.mock('@/auth', () => ({ auth: jest.fn(async () => (global as any).__mktSession) }));
jest.mock('next-auth/react', () => ({
    useSession: () => (global as any).__mktClientSession,
}));
jest.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams((global as any).__mktQuery || ''),
}));
jest.mock('next/link', () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: any) => require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('@/components/UpgradeRequired', () => ({
    __esModule: true,
    default: ({ feature, description }: any) =>
        require('react').createElement('section', { 'data-upgrade': feature }, description),
}));

const ROOT = process.cwd();
const ROUTE = '@/app/api/marketing/send/route';

let prismaMock: PrismaMock;
const tenantSession = (businessId: string, plan = 'ENTERPRISE') => ({
    user: { id: 'u-1', businessId, plan, role: 'OWNER' },
});

beforeEach(() => {
    jest.clearAllMocks();
    prismaMock = createPrismaMock();
    (global as any).__mktPrisma = prismaMock.client;
    (global as any).__mktSession = null;
    (global as any).__mktEffects = [];
    (global as any).__mktQuery = '';
    (global as any).__mktClientSession = { data: tenantSession('biz-fixture-a'), status: 'authenticated' };
});

// ═════════════════════════════════════════════════════════════════════════════
// A. The API refuses instead of pretending
// ═════════════════════════════════════════════════════════════════════════════
describe('A. /api/marketing/send refuses with 501 and never claims delivery', () => {
    const CHANNELS = ['email', 'sms'] as const;
    const AUDIENCES = ['all', 'individual', 'organization', 'single'] as const;

    it('POST still refuses an anonymous caller with 401 and no database call', async () => {
        const { POST } = await import(ROUTE);
        const res = await POST(jsonRequest('http://localhost/api/marketing/send', { subject: 's', body: 'b' }));
        expect(res.status).toBe(401);
        expect(prismaMock.calls).toHaveLength(0);
    });

    it('POST refuses a session with no businessId with 401', async () => {
        (global as any).__mktSession = { user: { id: 'u-1' } };
        const { POST } = await import(ROUTE);
        const res = await POST(jsonRequest('http://localhost/api/marketing/send', { subject: 's', body: 'b' }));
        expect(res.status).toBe(401);
    });

    for (const channel of CHANNELS) {
        for (const audienceType of AUDIENCES) {
            it(`POST ${channel} to "${audienceType}" answers 501 sent:false, counts nobody and logs nothing`, async () => {
                (global as any).__mktSession = tenantSession('biz-fixture-a');
                const log = jest.spyOn(console, 'log').mockImplementation(() => {});
                const { POST } = await import(ROUTE);

                const started = Date.now();
                const res = await POST(jsonRequest('http://localhost/api/marketing/send', {
                    subject: 'Menu is open', body: 'Order now', channel, audienceType,
                    targetRecipient: audienceType === 'single' ? 'someone@example.test' : '',
                }));
                const elapsed = Date.now() - started;
                const { status, body } = await readJson(res);

                expect(status).toBe(501);
                expect(body.sent).toBe(false);
                expect(body.code).toBe('MARKETING_SEND_UNAVAILABLE');
                expect(body.error).toMatch(/not available/i);
                expect(body.error).toMatch(/nothing was emailed or texted/i);
                // The mock's success shape is gone.
                expect(body).not.toHaveProperty('id');
                expect(body).not.toHaveProperty('status');
                expect(JSON.stringify(body)).not.toMatch(/"status"\s*:\s*"sent"/);
                // No audience counting, no send log, no simulated network delay.
                expect(prismaMock.calls).toHaveLength(0);
                expect(log).not.toHaveBeenCalled();
                expect(elapsed).toBeLessThan(1000);
                log.mockRestore();
            });
        }
    }

    it('POST does not even read the request body', async () => {
        (global as any).__mktSession = tenantSession('biz-fixture-a');
        const json = jest.fn(async () => { throw new Error('body must not be read'); });
        const text = jest.fn(async () => { throw new Error('body must not be read'); });
        const { POST } = await import(ROUTE);
        const res = await POST({ json, text } as any);
        expect(res.status).toBe(501);
        expect(json).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
    });

    it('a plan without Marketing access also gets the refusal, never a send', async () => {
        (global as any).__mktSession = tenantSession('biz-fixture-a', 'STARTER');
        const { POST } = await import(ROUTE);
        const { status, body } = await readJson(await POST(jsonRequest('http://localhost/x', { subject: 's', body: 'b' })));
        expect(status).toBe(501);
        expect(body.sent).toBe(false);
    });

    it('GET refuses an anonymous caller with 401 and no database call', async () => {
        const { GET } = await import(ROUTE);
        const res = await GET();
        expect(res.status).toBe(401);
        expect(prismaMock.calls).toHaveLength(0);
    });

    it('GET answers 501 with no campaign list and none of the invented demo campaigns', async () => {
        (global as any).__mktSession = tenantSession('biz-fixture-a');
        const { GET } = await import(ROUTE);
        const { status, body } = await readJson(await GET());
        expect(status).toBe(501);
        expect(Array.isArray(body)).toBe(false);
        expect(body.sent).toBe(false);
        expect(body.code).toBe('MARKETING_SEND_UNAVAILABLE');
        expect(body.error).toMatch(/no campaigns have been sent/i);
        const raw = JSON.stringify(body);
        expect(raw).not.toMatch(/Founders Club|Flash Sale|camp_demo/);
        expect(raw).not.toMatch(/opened|clicked/i);
        expect(prismaMock.calls).toHaveLength(0);
    });

    it('keeps no cross-tenant memory: tenant B never sees what tenant A typed', async () => {
        const { POST, GET } = await import(ROUTE);
        (global as any).__mktSession = tenantSession('biz-fixture-a');
        await POST(jsonRequest('http://localhost/x', { subject: 'TENANT-A-PRIVATE-SUBJECT', body: 'TENANT-A-PRIVATE-BODY' }));

        (global as any).__mktSession = tenantSession('biz-fixture-b');
        const res = await GET();
        const text = await res.text();
        expect(text).not.toContain('TENANT-A-PRIVATE');
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// B. The page is truthful
// ═════════════════════════════════════════════════════════════════════════════
const loadContent = () => {
    const Page = require('@/app/campaigns/page').default;
    const suspense = Page();
    const content = suspense.props.children;
    expect(typeof content.type).toBe('function');
    return content.type;
};

const mountPage = () => {
    (global as any).__mktEffects = [];
    return mountComponent(loadContent(), {});
};

const sendButton = (tree: any) => {
    const hits = findAll(tree, (el) => el.type === 'button' && /Sending not available/.test(textOf(el)));
    expect(hits).toHaveLength(1);
    return hits[0];
};

const setInput = (tree: any, pred: (el: any) => boolean, value: string) => {
    const [el] = findAll(tree, pred);
    expect(el).toBeDefined();
    el.props.onChange({ target: { value } });
};

describe('B. the Marketing page says sending is unavailable and cannot fake a send', () => {
    let fetchSpy: jest.Mock;
    let alertSpy: jest.Mock;
    let confirmSpy: jest.Mock;

    beforeEach(() => {
        fetchSpy = jest.fn(async () => ({ ok: true, json: async () => ({ all: 12, individual: 9, organization: 3 }) }));
        alertSpy = jest.fn();
        confirmSpy = jest.fn(() => true);
        (global as any).fetch = fetchSpy;
        (global as any).alert = alertSpy;
        (global as any).confirm = confirmSpy;
    });

    afterEach(() => {
        delete (global as any).alert;
        delete (global as any).confirm;
    });

    it('shows a clear "sending isn\'t available" notice', () => {
        const m = mountPage();
        const text = textOf(m.tree);
        expect(text).toMatch(/Sending isn.t available yet/);
        expect(text).toMatch(/nothing is emailed, texted, or saved/);
        const [notice] = findAll(m.tree, (el) => el.props?.role === 'status');
        expect(textOf(notice)).toMatch(/can.t send campaign emails or text messages/);
    });

    it('Send is disabled, has no click handler, and points at a visible reason', () => {
        const m = mountPage();
        const btn = sendButton(m.tree);
        expect(btn.props.disabled).toBe(true);
        expect(btn.props['aria-disabled']).toBe('true');
        expect(btn.props.onClick).toBeUndefined();
        const reasonId = btn.props['aria-describedby'];
        const [reason] = findAll(m.tree, (el) => el.props?.id === reasonId);
        expect(textOf(reason)).toMatch(/Nothing on this page is emailed/);
    });

    it('stays disabled with a complete draft, for email, SMS and a single recipient', () => {
        const m = mountPage();
        setInput(m.tree, (el) => el.type === 'input' && el.props.type === 'text', 'Menu is open');
        m.render();
        setInput(m.tree, (el) => el.type === 'textarea', 'Order this week');
        m.render();
        setInput(m.tree, (el) => el.type === 'select', 'single');
        m.render();
        setInput(m.tree, (el) => el.type === 'input' && el.props.type === 'email', 'someone@example.test');
        m.render();
        expect(sendButton(m.tree).props.disabled).toBe(true);

        const [smsToggle] = findAll(m.tree, (el) => el.type === 'button' && textOf(el) === 'SMS');
        smsToggle.props.onClick();
        m.render();
        const btn = sendButton(m.tree);
        expect(btn.props.disabled).toBe(true);
        const [reason] = findAll(m.tree, (el) => el.props?.id === btn.props['aria-describedby']);
        expect(textOf(reason)).toMatch(/no text-message sender/);

        const text = textOf(m.tree);
        expect(text).not.toMatch(/Launch Campaign|Send to /);
    });

    it('no control on the page sends: every click handler runs without a POST, alert or confirm', async () => {
        const m = mountPage();
        setInput(m.tree, (el) => el.type === 'input' && el.props.type === 'text', 'Menu is open');
        m.render();
        setInput(m.tree, (el) => el.type === 'textarea', 'Order this week');
        m.render();
        for (const el of findAll(m.tree, (x) => typeof x.props?.onClick === 'function')) {
            await el.props.onClick({ preventDefault() {} });
            m.render();
        }
        const posts = fetchSpy.mock.calls.filter(([, init]: any[]) => init && String(init.method).toUpperCase() === 'POST');
        expect(posts).toHaveLength(0);
        expect(alertSpy).not.toHaveBeenCalled();
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(textOf(m.tree)).not.toMatch(/Message Sent/i);
    });

    it('the mount effect loads only audience counts, never the send route', async () => {
        mountPage();
        const effects: Array<() => any> = (global as any).__mktEffects;
        expect(effects.length).toBeGreaterThan(0);
        for (const fx of effects) await fx();
        await new Promise((r) => setImmediate(r));
        const urls = fetchSpy.mock.calls.map(([url]: any[]) => String(url));
        expect(urls).toEqual(['/api/marketing/audience']);
        expect(urls.some((u) => u.includes('/api/marketing/send'))).toBe(false);
    });

    it('shows no invented campaign history or performance numbers', () => {
        const m = mountPage();
        const text = textOf(m.tree);
        expect(text).toMatch(/No campaigns have been sent from FreezerIQ/);
        expect(text).not.toMatch(/Founders Club|Flash Sale/);
        expect(text).not.toMatch(/42%|18%/);
        expect(text).not.toMatch(/Open Rate|Click Rate|Avg\. Performance/);
        expect(text).not.toMatch(/Reachable via Email\/SMS/);
        expect(text).toMatch(/Not all have an email address, a phone number, or marketing consent/);
    });

    it('points to the email features that really work', () => {
        const m = mountPage();
        const [link] = findAll(m.tree, (el) => el.type === 'a' && /Seasonal lineup emails/.test(textOf(el)));
        expect(link.props.href).toBe('/fundraisers?tab=rebooking');
        expect(textOf(m.tree)).toMatch(/Previous Supporters invitations/);
    });

    it('a ?to= deep link pre-fills a draft but still cannot send', () => {
        (global as any).__mktQuery = 'to=someone%40example.test&name=Pat';
        const m = mountPage();
        // The query-param handling lives in the mount effect.
        for (const fx of (global as any).__mktEffects) fx();
        m.render();
        expect(textOf(m.tree)).toMatch(/Draft to Pat/);
        expect(sendButton(m.tree).props.disabled).toBe(true);
    });

    it('the upgrade screen no longer promises email or SMS sending', () => {
        (global as any).__mktClientSession = { data: tenantSession('biz-fixture-a', 'STARTER'), status: 'authenticated' };
        const m = mountPage();
        const [upgrade] = findAll(m.tree, (el) => el.type === 'section' && el.props['data-upgrade']);
        const text = textOf(upgrade);
        expect(text).toMatch(/not available/i);
        expect(text).not.toMatch(/Reach your customers via Email or SMS/);
        expect(text).not.toMatch(/track conversion rates|automated seasonal reminders/);
    });

    it('server-renders a disabled Send button and the notice (real React, no hook runtime)', () => {
        const { renderToStaticMarkup } = require('react-dom/server');
        const React = require('react');
        const Page = require('@/app/campaigns/page').default;
        const html: string = renderToStaticMarkup(React.createElement(Page));
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Sending not available<\/button>/);
        expect(html).toContain('Sending isn&#x27;t available yet');
        expect(html).not.toMatch(/Message Sent|Launch Campaign/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// C. The mock sender is gone
// ═════════════════════════════════════════════════════════════════════════════
describe('C. no mock sender remains', () => {
    const sourceFiles = (dir: string, out: string[] = []): string[] => {
        for (const name of readdirSync(dir)) {
            if (name === 'node_modules' || name.startsWith('.')) continue;
            const p = join(dir, name);
            const st = statSync(p);
            if (st.isDirectory()) sourceFiles(p, out);
            else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
        }
        return out;
    };

    it('lib/marketing_client.ts is deleted', () => {
        expect(existsSync(join(ROOT, 'lib', 'marketing_client.ts'))).toBe(false);
    });

    // Comments that explain the history may name the mock and quote its old
    // alert; these patterns match only code that imports, constructs or calls.
    it('no app, lib or component source imports or builds a marketing mock, or alerts "Message Sent"', () => {
        const offenders: string[] = [];
        for (const dir of ['app', 'lib', 'components']) {
            for (const file of sourceFiles(join(ROOT, dir))) {
                const src = readFileSync(file, 'utf8');
                if (/(from\s+|require\(\s*|import\(\s*)['"]@\/lib\/marketing_client['"]/.test(src)) offenders.push(`${file}: imports marketing_client`);
                if (/new\s+MockMarketingClient\b/.test(src)) offenders.push(`${file}: constructs MockMarketingClient`);
                if (/alert\(\s*['"`]Message Sent/i.test(src)) offenders.push(`${file}: alerts Message Sent`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('the Marketing page source never fetches the send route', () => {
        const src = readFileSync(join(ROOT, 'app', 'campaigns', 'page.tsx'), 'utf8');
        expect(src).not.toMatch(/fetch\(\s*['"`]\/api\/marketing\/send/);
    });

    it('the patterns above do catch the old code (guards fail closed)', () => {
        const oldPage = `const res = await fetch('/api/marketing/send', { method: 'POST' }); if (res.ok) { alert("Message Sent! 🚀"); }`;
        const oldRoute = `import { marketingClient } from '@/lib/marketing_client';\nexport const marketingClient = new MockMarketingClient();`;
        expect(oldPage).toMatch(/fetch\(\s*['"`]\/api\/marketing\/send/);
        expect(oldPage).toMatch(/alert\(\s*['"`]Message Sent/i);
        expect(oldRoute).toMatch(/(from\s+|require\(\s*|import\(\s*)['"]@\/lib\/marketing_client['"]/);
        expect(oldRoute).toMatch(/new\s+MockMarketingClient\b/);
    });
});
