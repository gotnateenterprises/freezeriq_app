/**
 * QB-INVOICE-1B — the database guarantees, against REAL Postgres.
 *
 * The other 1B suites prove the logic over faithful doubles. This one proves the
 * migration itself: the LIFETIME rule UNIQUE (invoice_id), retained connection
 * generations (Forget's SET NULL), the Forget cascade to customer links, the
 * live-generation foreign key, RESTRICT from invoice history to its generation, NO ACTION
 * on invoice deletion, composite same-tenant foreign keys, the CHECK constraints, the
 * FOR SHARE generation lock — and the service's real Prisma queries end to end.
 *
 * RUNNING IT (opt-in, exactly like tests/ops3RealDbMatrix.test.ts):
 *
 *   QB1B_DB_URL=postgresql://postgres:PASS@127.0.0.1:5432/freezeriq_qb1b_fresh \
 *     npx jest qbInvoice1bRealDb
 *
 * Point it ONLY at a disposable database migrated to this candidate. It creates and
 * deletes its own fixtures (ids prefixed qb1b-rdb-) and touches nothing else. Without
 * the variable the suite is SKIPPED, never silently green.
 */

import { PrismaClient } from '@prisma/client';
import { saveAuthorizedConnection, forgetQuickBooksConnection, disconnectQuickBooks } from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { createAndLinkCustomer, getCustomerLinkStatus, linkExistingCustomer } from '@/lib/quickbooks/customerLinks';
import { getQuickBooksInvoiceLink, recordQuickBooksInvoiceId, reserveQuickBooksInvoiceLink } from '@/lib/quickbooks/invoiceLinks';
import { fakeIntuit, sandboxConfig, sandboxEnv } from './helpers/quickbooksFakes';
import { fakeQuickBooksCustomers } from './helpers/quickbooksCustomerFakes';

const DB_URL = process.env.QB1B_DB_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

const P = 'qb1b-rdb-';
const BIZ_A = `${P}biz-a`;
const BIZ_B = `${P}biz-b`;
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const config = sandboxConfig();
const env = sandboxEnv();

let db: PrismaClient;

async function cleanup() {
    await db.quickBooksInvoiceLink.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksCustomerLink.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksConnection.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.invoice.deleteMany({ where: { OR: [{ business_id: { startsWith: P } }, { customer_id: { startsWith: P } }] } });
    await db.integration.deleteMany({ where: { business_id: { startsWith: P } } });
    // customers.business_id is ON DELETE SET NULL, so an organization can outlive its
    // fixture business: clean up by our own id prefix as well.
    await db.customer.deleteMany({ where: { OR: [{ business_id: { startsWith: P } }, { id: { startsWith: P } }] } });
    await db.business.deleteMany({ where: { id: { startsWith: P } } });
}

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.code ?? e?.meta?.code ?? String(e?.message ?? e).slice(0, 80); } };
/** The Postgres SQLSTATE behind a raw statement's failure (Prisma reports raw failures as P2010). */
const sqlState = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.meta?.code ?? e?.code ?? 'unknown'; } };

describeIfDb('QB-INVOICE-1B · real Postgres', () => {
    let qbo = fakeQuickBooksCustomers();
    let intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
    const deps = () => ({ db: db as any, fetchImpl: intuit.fetchImpl, env });
    const linkDeps = () => ({ db: db as any, env });

    async function connect(businessId: string, realmId: string) {
        intuit.consentTo(realmId);
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl);
        expect(await saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: `admin-${businessId}` }, deps())).toBe('connected');
    }
    async function forget(businessId: string) {
        await disconnectQuickBooks({ businessId, config }, deps());
        expect(await forgetQuickBooksConnection({ businessId }, deps())).toBe('forgotten');
    }
    async function liveGeneration(businessId: string) {
        return (await db.quickBooksConnection.findFirst({ where: { live_business_id: businessId, live_provider: 'quickbooks' } }))?.id ?? null;
    }
    const statusOf = (businessId: string, customerId: string) => getCustomerLinkStatus({ businessId, customerId, config }, deps()) as Promise<any>;

    beforeAll(async () => {
        db = new PrismaClient({ datasourceUrl: DB_URL });
        await cleanup();
    });
    beforeEach(async () => {
        await cleanup();
        qbo = fakeQuickBooksCustomers();
        intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
        await db.business.create({ data: { id: BIZ_A, name: 'QB1B RDB A', slug: `${P}a` } });
        await db.business.create({ data: { id: BIZ_B, name: 'QB1B RDB B', slug: `${P}b` } });
        await db.customer.create({ data: { id: `${P}org-a1`, business_id: BIZ_A, name: 'Lincoln PTA' } });
        await db.customer.create({ data: { id: `${P}org-a2`, business_id: BIZ_A, name: 'Band Boosters' } });
        await db.customer.create({ data: { id: `${P}org-b1`, business_id: BIZ_B, name: 'Lincoln PTA' } });
    });
    afterAll(async () => {
        if (db) { await cleanup(); await db.$disconnect(); }
    });

    it('the service works end to end on real Postgres: exact match → confirmed link; no match → confirmed create', async () => {
        await connect(BIZ_A, REALM_1);
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const s1 = await statusOf(BIZ_A, `${P}org-a1`);
        expect(s1).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } });
        expect((await linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: s1.lookup.confirmation, userId: 'u', config }, deps())).outcome).toBe('linked');

        const s2 = await statusOf(BIZ_A, `${P}org-a2`);
        expect(s2).toMatchObject({ lookup: { result: 'no_match' } });
        const created = await createAndLinkCustomer({ businessId: BIZ_A, customerId: `${P}org-a2`, confirmation: s2.lookup.confirmation, attemptId: '5b0d9a3e-1f2c-4b7d-8e9f-0a1b2c3d4e5f', userId: 'u', config }, deps());
        expect(created.outcome).toBe('linked');
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(2);
        expect(await statusOf(BIZ_A, `${P}org-a1`)).toMatchObject({ state: 'linked' });
        expect(await db.quickBooksConnection.findMany({ where: { business_id: BIZ_A } })).toEqual([{
            id: expect.any(String), business_id: BIZ_A, live_business_id: BIZ_A, live_provider: 'quickbooks', environment: 'sandbox',
            company_name: 'Sandbox Company 1', authorized_by: `admin-${BIZ_A}`, authorized_at: expect.any(Date), created_at: expect.any(Date),
        }]);
    });

    it('concurrent confirmations of one link leave exactly one row; concurrent first views record ONE generation', async () => {
        await connect(BIZ_A, REALM_1);
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const views = await Promise.all(Array.from({ length: 4 }, () => statusOf(BIZ_A, `${P}org-a1`)));
        expect(await db.quickBooksConnection.count({ where: { business_id: BIZ_A } })).toBe(1);
        expect(new Set(views.map((v) => v.lookup.confirmation)).size).toBe(1);
        const results = await Promise.all(Array.from({ length: 4 }, () =>
            linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: views[0].lookup.confirmation, userId: 'u', config }, deps())));
        expect(results.every((r) => r.outcome === 'linked')).toBe(true);
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(1);
    });

    it('unique indexes: one QuickBooks customer per organization, one organization per QuickBooks customer in a generation', async () => {
        await connect(BIZ_A, REALM_1);
        await statusOf(BIZ_A, `${P}org-a1`);
        const conn = (await liveGeneration(BIZ_A))!;
        const base = { business_id: BIZ_A, connection_id: conn, source: 'existing' as const };
        expect(await code(db.quickBooksCustomerLink.create({ data: { ...base, customer_id: `${P}org-a1`, qbo_customer_id: '58' } }))).toBe('ok');
        expect(await code(db.quickBooksCustomerLink.create({ data: { ...base, customer_id: `${P}org-a1`, qbo_customer_id: '59' } }))).toBe('P2002');
        expect(await code(db.quickBooksCustomerLink.create({ data: { ...base, customer_id: `${P}org-a2`, qbo_customer_id: '58' } }))).toBe('P2002');
        expect(await code(db.quickBooksCustomerLink.create({ data: { ...base, customer_id: `${P}org-a2`, qbo_customer_id: '' } }))).not.toBe('ok'); // CHECK
        expect(await code(db.quickBooksCustomerLink.create({ data: { ...base, customer_id: `${P}org-a2`, qbo_customer_id: '60', provider: 'qbo' } }))).not.toBe('ok'); // CHECK / FK
    });

    it('composite foreign keys and CHECKs: no link to another tenant’s organization or generation; generation rows are self-consistent', async () => {
        await connect(BIZ_A, REALM_1);
        await connect(BIZ_B, REALM_2);
        await statusOf(BIZ_A, `${P}org-a1`);
        await statusOf(BIZ_B, `${P}org-b1`);
        const [connA, connB] = [(await liveGeneration(BIZ_A))!, (await liveGeneration(BIZ_B))!];
        expect(await code(db.quickBooksCustomerLink.create({ data: { business_id: BIZ_A, customer_id: `${P}org-b1`, connection_id: connA, qbo_customer_id: '1', source: 'existing' } }))).toBe('P2003');
        expect(await code(db.quickBooksCustomerLink.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, connection_id: connB, qbo_customer_id: '1', source: 'existing' } }))).toBe('P2003');
        expect(await code(db.quickBooksConnection.create({ data: { business_id: `${P}biz-none`, environment: 'sandbox' } }))).toBe('P2003');
        // A second LIVE generation for a tenant is impossible.
        expect(await code(db.quickBooksConnection.create({ data: { business_id: BIZ_A, live_business_id: BIZ_A, live_provider: 'quickbooks', environment: 'sandbox' } }))).toBe('P2002');
        // CHECKs: a live pair naming another tenant, a half-set pair, an unknown environment.
        const insert = (id: string, live: string, provider: string, environment: string) =>
            sqlState(db.$executeRawUnsafe(`INSERT INTO quickbooks_connections (id, business_id, live_business_id, live_provider, environment) VALUES ('${P}${id}', '${BIZ_A}', ${live}, ${provider}, '${environment}')`));
        expect(await insert('x1', `'${BIZ_B}'`, `'quickbooks'`, 'sandbox')).toBe('23514');
        expect(await insert('x2', `'${BIZ_A}'`, 'NULL', 'sandbox')).toBe('23514');   // half-set pairs are refused (NULL-safe CHECK)
        expect(await insert('x3', 'NULL', `'quickbooks'`, 'sandbox')).toBe('23514');
        expect(await insert('x4', 'NULL', 'NULL', 'staging')).toBe('23514');
        expect(await insert('x5', `'${BIZ_A}'`, `'qbo'`, 'sandbox')).toBe('23514');
        expect(await insert('x6', 'NULL', 'NULL', 'production')).toBe('ok'); // an ENDED generation row is well-formed
    });

    it('ACCEPTANCE 1–9 on Postgres: Forget ends generation 1 but keeps it; Invoice A can never get a second link (service and UNIQUE); history resolves; customer links are gone; another invoice links under generation 2', async () => {
        // 1. Invoice A linked under generation 1.
        await connect(BIZ_A, REALM_1);
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const s = await statusOf(BIZ_A, `${P}org-a1`);
        expect((await linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: s.lookup.confirmation, userId: 'u', config }, deps())).outcome).toBe('linked');
        const g1 = (await liveGeneration(BIZ_A))!;
        const invA = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '1234.56', status: 'DRAFT' } });
        const r: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: invA.id, connectionId: g1, realmId: REALM_1, userId: 'u' }, linkDeps());
        expect(r.outcome).toBe('reserved');
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: r.link.id, connectionId: g1, qboInvoiceId: '1045' }, linkDeps())).toBe('recorded');
        const invoiceBefore = await db.invoice.findUnique({ where: { id: invA.id } });

        // 2. Forget generation 1: ended, kept; customer links deleted; the invoice link untouched.
        await forget(BIZ_A);
        expect(await db.quickBooksConnection.findUnique({ where: { id: g1 } })).toMatchObject({ live_business_id: null, live_provider: null, company_name: 'Sandbox Company 1', authorized_by: `admin-${BIZ_A}` });
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(0);                                   // 7.
        expect(await db.quickBooksInvoiceLink.findUnique({ where: { id: r.link.id } })).toMatchObject({ connection_id: g1, qbo_invoice_id: '1045' }); // 5.

        // 3. Generation 2 — the same company.
        await connect(BIZ_A, REALM_1);
        const s2 = await statusOf(BIZ_A, `${P}org-a1`);
        expect(s2).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } });                                             // 8.
        const g2 = (await liveGeneration(BIZ_A))!;
        expect(g2).not.toBe(g1);
        expect(await db.quickBooksConnection.count({ where: { business_id: BIZ_A } })).toBe(2);

        // 4. Service refuses; UNIQUE (invoice_id) refuses a direct write; the history is unchanged.
        expect(await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: invA.id, connectionId: g2, realmId: REALM_1, userId: 'u' }, linkDeps()))
            .toMatchObject({ outcome: 'already_linked', link: { connectionId: g1, qboInvoiceId: '1045' } });
        expect(await code(db.quickBooksInvoiceLink.create({ data: { business_id: BIZ_A, invoice_id: invA.id, connection_id: g2, request_id: `${P}second-link` } }))).toBe('P2002');
        expect(await sqlState(db.$executeRawUnsafe(`INSERT INTO quickbooks_invoice_links (id, business_id, invoice_id, connection_id, request_id) VALUES ('${P}raw', '${BIZ_A}', '${invA.id}', '${g2}', '${P}raw')`))).toBe('23505');
        expect(await db.quickBooksInvoiceLink.count({ where: { invoice_id: invA.id } })).toBe(1);

        // 6. Auditable after Forget: the link resolves to its generation and that generation's evidence.
        expect(await getQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: invA.id }, linkDeps())).toEqual({
            id: r.link.id, connectionId: g1, requestId: r.link.requestId, qboInvoiceId: '1045', qboLinkedAt: expect.any(Date),
            createdBy: 'u', createdAt: expect.any(Date),
            generation: { environment: 'sandbox', companyName: 'Sandbox Company 1', authorizedBy: `admin-${BIZ_A}`, authorizedAt: expect.any(Date), createdAt: expect.any(Date), live: false },
        });

        // Customer links: an ended generation can never be referenced again; relinking uses generation 2.
        expect(await code(db.quickBooksCustomerLink.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, connection_id: g1, qbo_customer_id: '58', source: 'existing' } }))).toBe('P2003');
        expect((await linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: s.lookup.confirmation, userId: 'u', config }, deps())).outcome).toBe('stale');
        expect((await linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: s2.lookup.confirmation, userId: 'u', config }, deps())).outcome).toBe('linked');
        expect(await db.quickBooksCustomerLink.findMany({ where: { business_id: BIZ_A }, select: { connection_id: true } })).toEqual([{ connection_id: g2 }]);

        // 9. A different, unlinked invoice links normally under generation 2.
        const invB = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '10.00', status: 'DRAFT' } });
        const rb: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: invB.id, connectionId: g2, realmId: REALM_1, userId: 'u' }, linkDeps());
        expect(rb).toMatchObject({ outcome: 'reserved', link: { connectionId: g2, generation: { live: true } } });
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: rb.link.id, connectionId: g2, qboInvoiceId: '1046' }, linkDeps())).toBe('recorded');

        // Protected history: while an invoice link references it, a generation cannot be deleted (RESTRICT).
        expect(await code(db.quickBooksConnection.delete({ where: { id: g1 } }))).toBe('P2003');
        expect(await db.quickBooksConnection.count({ where: { id: g1 } })).toBe(1);
        expect(await db.invoice.findUnique({ where: { id: invA.id } })).toEqual(invoiceBefore); // the invoice itself never changed
    });

    it('ACCEPTANCE 10 on Postgres: one QuickBooks invoice cannot attach to two FreezerIQ invoices inside a generation; across generations no key is claimed', async () => {
        await connect(BIZ_A, REALM_1);
        await statusOf(BIZ_A, `${P}org-a1`);
        const g1 = (await liveGeneration(BIZ_A))!;
        const [inv1, inv2, inv3] = await Promise.all(['1.00', '2.00', '3.00'].map((total_amount) =>
            db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount, status: 'DRAFT' } })));
        const a: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv1.id, connectionId: g1, realmId: REALM_1, userId: 'u' }, linkDeps());
        const b: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv2.id, connectionId: g1, realmId: REALM_1, userId: 'u' }, linkDeps());
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: a.link.id, connectionId: g1, qboInvoiceId: '77' }, linkDeps())).toBe('recorded');
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: b.link.id, connectionId: g1, qboInvoiceId: '77' }, linkDeps())).toBe('conflict');
        expect(await code(db.quickBooksInvoiceLink.update({ where: { id: b.link.id }, data: { qbo_invoice_id: '77', qbo_linked_at: new Date() } }))).toBe('P2002');

        // Across generations the id is deliberately not unique by key: the V1 recording contract
        // (FreezerIQ's own create response only) is what keeps this from ever happening.
        await forget(BIZ_A);
        await connect(BIZ_A, REALM_1);
        await statusOf(BIZ_A, `${P}org-a1`);
        const g2 = (await liveGeneration(BIZ_A))!;
        const c: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv3.id, connectionId: g2, realmId: REALM_1, userId: 'u' }, linkDeps());
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: c.link.id, connectionId: g2, qboInvoiceId: '77' }, linkDeps())).toBe('recorded');
    });

    it('invoice links: confirmation CHECK; invoice deletion blocked; tenant-scoped; the invoice row untouched', async () => {
        await connect(BIZ_A, REALM_1);
        await statusOf(BIZ_A, `${P}org-a1`);
        const conn = (await liveGeneration(BIZ_A))!;
        const inv1 = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '100.00', status: 'SENT' } });
        const inv2 = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '200.00', status: 'DRAFT' } });
        const before = await db.invoice.findUnique({ where: { id: inv1.id } });

        const a: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv1.id, connectionId: conn, realmId: REALM_1, userId: 'u' }, linkDeps());
        const b: any = await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv2.id, connectionId: conn, realmId: REALM_1, userId: 'u' }, linkDeps());
        expect(await code(db.quickBooksInvoiceLink.create({ data: { business_id: BIZ_A, invoice_id: inv1.id, connection_id: conn, request_id: `${P}dup` } }))).toBe('P2002');
        expect(await recordQuickBooksInvoiceId({ businessId: BIZ_A, linkId: a.link.id, connectionId: conn, qboInvoiceId: '77' }, linkDeps())).toBe('recorded');
        expect(await code(db.quickBooksInvoiceLink.update({ where: { id: b.link.id }, data: { qbo_invoice_id: '88' } }))).not.toBe('ok'); // CHECK: id without linked_at
        expect(await code(db.quickBooksInvoiceLink.update({ where: { id: b.link.id }, data: { qbo_linked_at: new Date() } }))).not.toBe('ok'); // CHECK: linked_at without id
        expect(await code(db.quickBooksInvoiceLink.update({ where: { id: b.link.id }, data: { qbo_invoice_id: '', qbo_linked_at: new Date() } }))).not.toBe('ok'); // CHECK: empty id
        expect(await code(db.invoice.delete({ where: { id: inv1.id } }))).toBe('P2003'); // NO ACTION: has a QuickBooks counterpart
        const inv3 = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '300.00' } });
        expect(await code(db.quickBooksInvoiceLink.create({ data: { business_id: BIZ_B, invoice_id: inv3.id, connection_id: conn, request_id: `${P}cross` } }))).toBe('P2003'); // tenant B cannot link tenant A's invoice or generation

        const after = await db.invoice.findUnique({ where: { id: inv1.id } });
        expect(after).toEqual(before); // status, total, paid_at, updated_at — all unchanged
    });

    it('the generation lock is real: a Forget arriving while a link transaction holds it waits, then removes what that transaction wrote', async () => {
        await connect(BIZ_A, REALM_1);
        await statusOf(BIZ_A, `${P}org-a1`);
        const g = (await liveGeneration(BIZ_A))!;
        await disconnectQuickBooks({ businessId: BIZ_A, config }, deps());

        let forgotAt = 0;
        let forgetting!: Promise<string>;
        let committedAt = 0;
        await db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT 1 FROM "integrations" WHERE "business_id" = ${BIZ_A} AND "provider" = ${'quickbooks'} FOR SHARE`;
            forgetting = forgetQuickBooksConnection({ businessId: BIZ_A }, deps()).then((r) => { forgotAt = Date.now(); return r; });
            await new Promise((r) => setTimeout(r, 750));
            expect(forgotAt).toBe(0); // still waiting for the lock
            await tx.quickBooksCustomerLink.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, connection_id: g, qbo_customer_id: '58', source: 'existing' } });
            committedAt = Date.now();
        }, { timeout: 15_000 });
        expect(await forgetting).toBe('forgotten');
        expect(forgotAt).toBeGreaterThanOrEqual(committedAt);
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(0);
        expect(await db.quickBooksConnection.findUnique({ where: { id: g } })).toMatchObject({ live_business_id: null, live_provider: null });
    });

    it('a hard tenant delete (not a product flow) is refused while a QuickBooks customer link exists; after Forget it removes the tenant’s generations, invoices and invoice links', async () => {
        await connect(BIZ_A, REALM_1);
        qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const st = await statusOf(BIZ_A, `${P}org-a1`);
        expect((await linkExistingCustomer({ businessId: BIZ_A, customerId: `${P}org-a1`, confirmation: st.lookup.confirmation, userId: 'u', config }, deps())).outcome).toBe('linked');
        const conn = (await liveGeneration(BIZ_A))!;
        const inv = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '100.00' } });
        await reserveQuickBooksInvoiceLink({ businessId: BIZ_A, invoiceId: inv.id, connectionId: conn, realmId: REALM_1, userId: 'u' }, linkDeps());

        // A link never follows its organization out of its tenant: the delete is refused and nothing changes.
        expect(await code(db.$executeRawUnsafe(`DELETE FROM businesses WHERE id = '${BIZ_A}'`))).toBe('P2010');
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(1);
        expect(await code(db.customer.update({ where: { id: `${P}org-a1` }, data: { business_id: BIZ_B } }))).not.toBe('ok');

        await forget(BIZ_A);
        expect(await code(db.$executeRawUnsafe(`DELETE FROM businesses WHERE id = '${BIZ_A}'`))).toBe('ok');
        expect(await db.quickBooksInvoiceLink.count({ where: { business_id: BIZ_A } })).toBe(0);
        expect(await db.quickBooksCustomerLink.count({ where: { business_id: BIZ_A } })).toBe(0);
        expect(await db.quickBooksConnection.count({ where: { business_id: BIZ_A } })).toBe(0);
        expect(await db.invoice.count({ where: { business_id: BIZ_A } })).toBe(0);
    });

    it('HOSTILE raw SQL: no cross-tenant generation, invoice-link or customer-link combination is representable — inserts and updates alike', async () => {
        await connect(BIZ_A, REALM_1);
        await connect(BIZ_B, REALM_2);
        await statusOf(BIZ_A, `${P}org-a1`);
        await statusOf(BIZ_B, `${P}org-b1`);
        const [genA, genB] = [(await liveGeneration(BIZ_A))!, (await liveGeneration(BIZ_B))!];
        const invA = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '10.00', status: 'DRAFT' } });
        const invA2 = await db.invoice.create({ data: { business_id: BIZ_A, customer_id: `${P}org-a1`, total_amount: '20.00', status: 'DRAFT' } });
        const invB = await db.invoice.create({ data: { business_id: BIZ_B, customer_id: `${P}org-b1`, total_amount: '30.00', status: 'DRAFT' } });
        const run = (statement: string) => sqlState(db.$executeRawUnsafe(statement));
        const invoiceLink = (id: string, business: string, invoice: string, generation: string) =>
            run(`INSERT INTO quickbooks_invoice_links (id, business_id, invoice_id, connection_id, request_id) VALUES ('${P}${id}', '${business}', '${invoice}', '${generation}', '${P}req-${id}')`);
        const customerLink = (id: string, business: string, organization: string, generation: string, qboId: string) =>
            run(`INSERT INTO quickbooks_customer_links (id, business_id, customer_id, connection_id, qbo_customer_id, source) VALUES ('${P}${id}', '${business}', '${P}${organization}', '${generation}', '${qboId}', 'existing')`);

        // The same raw shapes succeed for a consistent tenant, so every refusal below is the tenant rule.
        expect(await invoiceLink('il-a', BIZ_A, invA.id, genA)).toBe('ok');
        expect(await customerLink('cl-a', BIZ_A, 'org-a1', genA, '58')).toBe('ok');
        const snapshot = async () => JSON.stringify(await db.$queryRawUnsafe(
            `SELECT 'generation' AS t, id, business_id, live_business_id AS a, live_provider AS b FROM quickbooks_connections WHERE business_id LIKE '${P}%'
             UNION ALL SELECT 'invoice_link', id, business_id, invoice_id, connection_id FROM quickbooks_invoice_links WHERE business_id LIKE '${P}%'
             UNION ALL SELECT 'customer_link', id, business_id, customer_id, connection_id FROM quickbooks_customer_links WHERE business_id LIKE '${P}%'
             UNION ALL SELECT 'invoice', id, business_id, NULL, NULL FROM invoices WHERE business_id LIKE '${P}%'
             UNION ALL SELECT 'organization', id, business_id, NULL, NULL FROM customers WHERE id LIKE '${P}%'
             ORDER BY 1, 2`));
        const before = await snapshot();

        // 1. GENERATION: live_business_id is NULL or the generation's own business_id (CHECK quickbooks_connections_live_check),
        //    so a generation of tenant A can never point at tenant B's integrations row — nor at another provider's row.
        expect(await run(`INSERT INTO quickbooks_connections (id, business_id, live_business_id, live_provider, environment) VALUES ('${P}g-x1', '${BIZ_A}', '${BIZ_B}', 'quickbooks', 'sandbox')`)).toBe('23514');
        expect(await run(`INSERT INTO quickbooks_connections (id, business_id, live_business_id, live_provider, environment) VALUES ('${P}g-x2', '${BIZ_A}', '${BIZ_A}', 'quickbooks_oauth_attempt', 'sandbox')`)).toBe('23514');
        expect(await run(`UPDATE quickbooks_connections SET live_business_id = '${BIZ_B}' WHERE id = '${genA}'`)).toBe('23514');
        expect(await run(`UPDATE quickbooks_connections SET business_id = '${BIZ_B}' WHERE id = '${genA}'`)).toBe('23514');
        // ...and history cannot be re-homed to tenant B while a link references the generation (ON UPDATE NO ACTION).
        expect(await run(`UPDATE quickbooks_connections SET business_id = '${BIZ_B}', live_business_id = NULL, live_provider = NULL WHERE id = '${genA}'`)).toBe('23503');

        // 2. INVOICE LINK: one business_id column keys BOTH the invoice FK and the generation FK.
        expect(await invoiceLink('il-x1', BIZ_A, invA2.id, genB)).toBe('23503'); // A's invoice + B's generation
        expect(await invoiceLink('il-x2', BIZ_B, invA2.id, genB)).toBe('23503'); // relabelled as B: A's invoice is not B's
        expect(await invoiceLink('il-x3', BIZ_B, invB.id, genA)).toBe('23503');  // B's invoice + A's generation
        expect(await run(`UPDATE quickbooks_invoice_links SET connection_id = '${genB}' WHERE id = '${P}il-a'`)).toBe('23503');
        expect(await run(`UPDATE quickbooks_invoice_links SET invoice_id = '${invB.id}' WHERE id = '${P}il-a'`)).toBe('23503');
        expect(await run(`UPDATE quickbooks_invoice_links SET business_id = '${BIZ_B}' WHERE id = '${P}il-a'`)).toBe('23503');
        expect(await run(`UPDATE invoices SET business_id = '${BIZ_B}' WHERE id = '${invA.id}'`)).toBe('23503'); // the invoice cannot move away from its link

        // 3. CUSTOMER LINK: one business_id column keys the organization FK and the LIVE-generation FK.
        expect(await customerLink('cl-x1', BIZ_A, 'org-b1', genA, '61')).toBe('23503'); // B's organization + A's generation
        expect(await customerLink('cl-x2', BIZ_A, 'org-a2', genB, '62')).toBe('23503'); // A's organization + B's generation
        expect(await customerLink('cl-x3', BIZ_B, 'org-a2', genB, '63')).toBe('23503'); // relabelled as B: A's organization is not B's
        expect(await customerLink('cl-x4', BIZ_B, 'org-b1', genA, '64')).toBe('23503'); // B's organization + A's generation
        expect(await run(`UPDATE quickbooks_customer_links SET connection_id = '${genB}' WHERE id = '${P}cl-a'`)).toBe('23503');
        expect(await run(`UPDATE quickbooks_customer_links SET customer_id = '${P}org-b1' WHERE id = '${P}cl-a'`)).toBe('23503');
        expect(await run(`UPDATE quickbooks_customer_links SET business_id = '${BIZ_B}' WHERE id = '${P}cl-a'`)).toBe('23503');
        expect(await run(`UPDATE customers SET business_id = '${BIZ_B}' WHERE id = '${P}org-a1'`)).toBe('23503'); // the organization cannot move away from its link

        expect(await snapshot()).toBe(before); // every hostile statement changed nothing
    });
});
