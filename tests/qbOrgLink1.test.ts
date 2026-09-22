/**
 * QB-ORG-LINK-1 — the organization's QuickBooks customer card on the canonical organization profile.
 *
 * Customer CRM → Organizations opens /fundraisers/[id] (CRM-2/CRM-3), but QB-INVOICE-1B rendered its customer-link card
 * only on /customers/[id], which no Organizations row links to. Review & Send then blocked with "Link this organization
 * to its QuickBooks customer first (open the organization and use its QuickBooks card)" — an instruction that could not
 * be followed from the organization page. The fix renders the SAME component on the organization profile.
 *
 * Proven here:
 *   - placement and wiring on the organization profile (structural — this repo has no DOM renderer);
 *   - the component's own gate is unchanged: ADMIN only, never View As, hidden when the route refuses or QuickBooks is off;
 *   - the route the card calls keeps its contract (the REAL route over the invoice world's doubles);
 *   - linking the id this page passes is exactly what unblocks Review & Send for that organization's invoice;
 *   - there is still ONE customer-link implementation, and the People page keeps its card.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ADMIN_USER, BIZ, OTHER_BIZ, invoiceWorld, type World } from './helpers/quickbooksInvoiceWorld';
import { sandboxEnv } from './helpers/quickbooksFakes';
import { customerLinkCardView } from '@/lib/quickbooks/customerLinkView';
import { getQuickBooksInvoiceSendView } from '@/lib/quickbooks/invoiceSend';

let currentDb: any;
jest.mock('@/lib/db', () => ({ get prisma() { return currentDb; } }));
const mockAuth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => mockAuth() }));

import { GET, POST } from '@/app/api/integrations/quickbooks/customers/[customerId]/route';

const ROOT = process.cwd();
const R = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(join(ROOT, dir))) return out;
    for (const name of readdirSync(join(ROOT, dir))) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    }
    return out;
}

const ORG_PAGE = 'app/fundraisers/[id]/page.tsx';
const PEOPLE_PAGE = 'app/customers/[id]/page.tsx';
const CARD = 'components/crm/QuickBooksCustomerLinkCard.tsx';
const CARD_IMPORT = "import QuickBooksCustomerLinkCard from '@/components/crm/QuickBooksCustomerLinkCard';";
const CARD_ELEMENT = '<QuickBooksCustomerLinkCard customerId={customer.id} />';

// ── the real route, over the invoice world's doubles ──────────────────────────
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
function useEnv(overrides: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
    Object.assign(process.env, ORIGINAL_ENV);
    for (const k of ['VERCEL', 'VERCEL_ENV', 'DATABASE_URL', 'DIRECT_URL', 'QBO_PRODUCTION_ENABLED']) delete process.env[k];
    for (const [k, v] of Object.entries(sandboxEnv(overrides))) (process.env as any)[k] = v;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}
const session = (extra: any = {}, businessId = BIZ) => ({
    user: { id: ADMIN_USER, role: 'ADMIN', businessId, baseBusinessId: businessId, isViewingAsTenant: false, isSuperAdmin: false, ...extra },
});
const ctx = (customerId: string) => ({ params: Promise.resolve({ customerId }) });
const url = (customerId: string) => `http://localhost:3000/api/integrations/quickbooks/customers/${customerId}`;
const get = async (customerId: string, s: any = session()) => {
    mockAuth.mockResolvedValue(s);
    return GET(new Request(url(customerId)), ctx(customerId));
};
const post = async (customerId: string, body: unknown, s: any = session()) => {
    mockAuth.mockResolvedValue(s);
    return POST(new Request(url(customerId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(customerId));
};
/** What the card itself does with a response (components/crm/QuickBooksCustomerLinkCard.tsx `load`). */
const cardStateFrom = async (res: Response) => {
    const data = await res.json().catch(() => null);
    return res.ok && data?.state ? data : res.status === 403 || res.status === 404 ? { state: 'disabled' } : { state: 'error' };
};

/** The Production situation: the organization exists, its campaign invoice is a DRAFT, and it has NO customer link yet. */
async function unlinkedWorld(): Promise<World> {
    const w = await invoiceWorld();
    w.store.link.links.clear();
    currentDb = w.store.db;
    (global as any).fetch = w.intuit.fetchImpl;
    return w;
}

beforeEach(() => { mockAuth.mockReset(); useEnv(); });
afterAll(() => { (global as any).fetch = ORIGINAL_FETCH; process.env = ORIGINAL_ENV; });

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-ORG-LINK-1 · the organization profile renders the existing card (1, 4)', () => {
    const page = strip(R(ORG_PAGE));

    it('1. imports the ONE existing component and renders it in the Overview tab with the organization’s own id', () => {
        expect(R(ORG_PAGE)).toContain(CARD_IMPORT);
        expect(page.split(CARD_ELEMENT)).toHaveLength(2); // exactly once
        const overview = page.slice(page.indexOf("activeTab === 'overview' && ("), page.indexOf("activeTab === 'campaigns' && ("));
        expect(overview).toContain('<FundraiserOverview');
        expect(overview).toContain(CARD_ELEMENT);
        // The default tab is Overview, so the card is on screen when Customer CRM → Organizations opens the page.
        expect(page).toMatch(/useState\(searchParams\.get\('tab'\) \|\| 'overview'\)/);
    });

    it('4. the id it passes is the organization id that campaigns, their invoices and the link all carry', () => {
        // The page loads the organization by the route id, and uses the same customer.id for its campaigns.
        expect(page).toContain('fetch(`/api/customers/${id}`, { cache: \'no-store\' })');
        expect(page).toContain('customerId={customer.id}');
        // /api/customers/[id] answers an organization with its own id, only inside the session's tenant.
        const api = strip(R('app/api/customers/[id]/route.ts'));
        expect(api).toMatch(/if \(org && org\.business_id !== session\.user\.businessId\) \{\s*return NextResponse\.json\(\{ error: "Unauthorized" \}, \{ status: 403 \}\);/);
        expect(api).toMatch(/const response: any = \{\s*id: org\.id,/);
        // Closeout creates the campaign invoice for the campaign's organization …
        expect(strip(R('app/api/campaigns/[id]/closeout/route.ts'))).toContain('customer_id: campaign.customer.id,');
        // … and Review & Send requires the link for exactly that invoice.customer_id.
        expect(strip(R('lib/quickbooks/invoiceSend.ts'))).toMatch(/where: \{ business_id_customer_id: \{ business_id: input\.businessId, customer_id: invoice\.customer_id \} \}/);
        // Customer CRM → Organizations still opens this page with the organization's id.
        expect(strip(R('app/customers/page.tsx'))).toContain('window.location.href = isOrg ? `/fundraisers/${c.id}` : `/customers/${c.id}`;');
        expect(strip(R('app/api/customers/route.ts'))).toMatch(/customers\.push\(\{\s*id: org\.id,/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-ORG-LINK-1 · the card’s own gate, unchanged (2, 3)', () => {
    const card = strip(R(CARD));

    it('2/3. renders nothing and requests nothing unless the user is an ADMIN who is not viewing as the tenant', () => {
        expect(card).toContain("const isAdmin = session?.user?.role === 'ADMIN' && !(session?.user as any)?.isViewingAsTenant;");
        expect(card).toMatch(/useEffect\(\(\) => \{\s*if \(isAdmin\) load\(\);/);
        expect(card.indexOf('if (!isAdmin) return null;')).toBeGreaterThan(-1);
        expect(card.indexOf('if (!isAdmin) return null;')).toBeLessThan(card.indexOf('return (\n'));
        // A refusal from the route (403) or an unknown organization (404) becomes the hidden "disabled" state.
        expect(card).toContain("res.status === 403 || res.status === 404 ? { state: 'disabled' }");
        expect(customerLinkCardView({ state: 'disabled' } as any).visible).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-ORG-LINK-1 · the route the card calls — same contract, for this organization (2, 3, 7, 9)', () => {
    it('7. an eligible ADMIN sees "unlinked · exact match" and can link — the card shows a Link action', async () => {
        const w = await unlinkedWorld();
        const status = await cardStateFrom(await get(w.orgId));
        expect(status).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } });
        const view = customerLinkCardView(status);
        expect(view.visible).toBe(true);
        expect(view.link).not.toBeNull();
    });

    it('2/3. CHEF, DRIVER, View As and a switched tenant are refused (403) and no session is 401 — the card stays hidden; nothing is linked', async () => {
        const w = await unlinkedWorld();
        for (const s of [session({ role: 'CHEF' }), session({ role: 'DRIVER' }),
            session({ isViewingAsTenant: true, isSuperAdmin: true, baseBusinessId: 'platform-home' }),
            session({ baseBusinessId: 'platform-home' })]) {
            const res = await get(w.orgId, s);
            expect(res.status).toBe(403);
            expect(customerLinkCardView(await cardStateFrom(res)).visible).toBe(false);
            expect((await post(w.orgId, { action: 'link', confirmation: 'a'.repeat(40) }, s)).status).toBe(403);
        }
        expect((await get(w.orgId, null)).status).toBe(401);
        expect(w.store.link.links.size).toBe(0);
        expect(w.customers.creates()).toHaveLength(0);
    });

    it('tenant isolation: another tenant’s organization id is 404 (card hidden) and nothing is linked', async () => {
        const w = await unlinkedWorld();
        const foreign = w.store.seedOrganization(OTHER_BIZ, 'Lincoln PTA');
        const res = await get(foreign);
        expect(res.status).toBe(404);
        expect(customerLinkCardView(await cardStateFrom(res)).visible).toBe(false);
        expect((await post(foreign, { action: 'link', confirmation: 'a'.repeat(40) })).status).toBe(404);
        expect(w.store.link.links.size).toBe(0);
    });

    it('9. where QuickBooks is unavailable (e.g. Preview) the organization page is unchanged: the card is hidden and nothing is touched', async () => {
        const w = await unlinkedWorld();
        useEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
        const res = await get(w.orgId);
        expect(await cardStateFrom(res)).toEqual({ state: 'disabled' });
        expect(customerLinkCardView({ state: 'disabled' } as any).visible).toBe(false);
        expect(w.store.link.links.size).toBe(0);
        expect(w.customers.calls).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-ORG-LINK-1 · Review & Send for that organization (4, 8)', () => {
    it('8. blocked "customer_not_linked" until the organization page links THIS id — then the invoice is ready, with nothing sent or created', async () => {
        const w = await unlinkedWorld();
        const invoice = w.seedE2();
        expect(invoice.customer_id).toBe(w.orgId); // the invoice belongs to the organization the page shows
        const input = { businessId: BIZ, invoiceId: invoice.id, config: w.config };
        expect(await getQuickBooksInvoiceSendView(input, w.deps)).toEqual({ state: 'blocked', blockers: ['customer_not_linked'] });

        // What the card on the organization page does: GET the state, then POST the confirmed link for customer.id.
        const status = await (await get(w.orgId)).json();
        const res = await post(w.orgId, { action: 'link', confirmation: status.lookup.confirmation });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ outcome: 'linked', status: { state: 'linked' } });
        const [row] = [...w.store.link.links.values()];
        expect(row).toMatchObject({ business_id: BIZ, customer_id: w.orgId, connection_id: w.generationId, qbo_customer_id: w.qboCustomer.Id });

        const view: any = await getQuickBooksInvoiceSendView(input, w.deps);
        expect(view.state).toBe('ready');
        // Linking is not sending: no QuickBooks invoice write, no QuickBooks customer created, FreezerIQ invoice still DRAFT.
        expect(w.qbo.writes()).toHaveLength(0);
        expect(w.customers.creates()).toHaveLength(0);
        expect(w.store.invoices.get(invoice.id)!.status).toBe('DRAFT');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-ORG-LINK-1 · one implementation, and the People page keeps its card (5, 6, 9)', () => {
    const SOURCE = ['app', 'components', 'lib'].flatMap((d) => walk(d));

    it('6. ONE card component, ONE route, and the card is rendered on exactly the two profile pages', () => {
        expect(SOURCE.filter((f) => /export default function QuickBooksCustomerLinkCard\b/.test(R(f)))).toEqual([CARD]);
        expect(SOURCE.filter((f) => !f.startsWith('app/api/') && R(f).includes('/api/integrations/quickbooks/customers/'))).toEqual([CARD]);
        expect(SOURCE.filter((f) => /<QuickBooksCustomerLinkCard\b/.test(strip(R(f)))).sort()).toEqual([ORG_PAGE, PEOPLE_PAGE].sort());
        expect(walk('app/api/integrations/quickbooks/customers')).toEqual(['app/api/integrations/quickbooks/customers/[customerId]/route.ts']);
    });

    it('5. the People / customer page still renders the same card, once, in its Overview tab', () => {
        const people = strip(R(PEOPLE_PAGE));
        expect(R(PEOPLE_PAGE)).toContain(CARD_IMPORT);
        expect(people.split(CARD_ELEMENT)).toHaveLength(2);
        const overview = people.slice(people.indexOf("activeTab === 'overview' && ("), people.indexOf("activeTab === 'orders' && ("));
        expect(overview).toContain(CARD_ELEMENT);
    });

    it('9. the organization page’s own tabs and header are unchanged', () => {
        const page = strip(R(ORG_PAGE));
        expect(page).toMatch(/activeTab === 'campaigns' && \(\s*<FundraisersTab\s+customerId=\{customer\.id\}/);
        expect(page).toContain("{activeTab === 'documents' && <DocumentsTab customer={customer} />}");
        expect(page).toContain('<CampaignCard');
        expect(page).toContain("import { PipelineStepper } from '@/components/crm2/PipelineStepper';");
    });
});
