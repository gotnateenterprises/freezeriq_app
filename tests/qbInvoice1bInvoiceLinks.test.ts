/**
 * QB-INVOICE-1B — the invoice-link FOUNDATION (lib/quickbooks/invoiceLinks.ts).
 *
 * Nothing in 1B calls these primitives from a route or the UI (see the scope suite);
 * these tests pin the guarantees QB-INVOICE-1C will rely on: tenant, generation and
 * company scoping, idempotent reservation, record-once, the LIFETIME rule (one
 * QuickBooks invoice link per FreezerIQ invoice, ever), accounting history that Forget
 * cannot erase — and that a link never reads or writes the invoice's money, status or
 * fulfilment.
 *
 * The owner's acceptance scenario is the "ACCEPTANCE" block, numbered 1–10 as specified.
 * The same database guarantees are proven on real Postgres in qbInvoice1bRealDb.
 */

import {
    getQuickBooksInvoiceLink,
    invoiceCreateRequestId,
    recordQuickBooksInvoiceId,
    reserveQuickBooksInvoiceLink,
} from '@/lib/quickbooks/invoiceLinks';
import { disconnectQuickBooks, forgetQuickBooksConnection, saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { getCustomerLinkStatus, linkExistingCustomer } from '@/lib/quickbooks/customerLinks';
import { fakeIntegrationDb, fakeIntuit, sandboxConfig, sandboxEnv } from './helpers/quickbooksFakes';
import { fakeLinkDb, fakeQuickBooksCustomers } from './helpers/quickbooksCustomerFakes';

const TENANT_A = 'biz-tenant-a';
const TENANT_B = 'biz-tenant-b';
const REALM_1 = '9130000000000001';
const REALM_2 = '9130000000000002';
const config = sandboxConfig();
const env = sandboxEnv();

const opened: Array<ReturnType<typeof fakeLinkDb>> = [];
afterEach(() => {
    // Reservations were made under the generation lock; no generation or link was updated
    // (beyond recording) or deleted; no invoice was written or read beyond its id.
    for (const db of opened.splice(0)) expect(db.violations).toEqual([]);
});

async function setup() {
    const store = fakeIntegrationDb();
    const linkDb = fakeLinkDb(store);
    opened.push(linkDb);
    const qbo = fakeQuickBooksCustomers();
    const intuit = fakeIntuit({ realmIds: [REALM_1, REALM_2], accounting: qbo.accounting });
    const deps = { db: linkDb.db, fetchImpl: intuit.fetchImpl, env, sleep: () => new Promise<void>((r) => setImmediate(r)) };
    // One QuickBooks company per tenant (V1 realm_in_use rule): tenant B uses the second company.
    const realmOf = (businessId: string) => (businessId === TENANT_B ? REALM_2 : REALM_1);
    /** Connects the tenant's company and returns the live generation, recorded the way the product records it: the first mapping status view. */
    const connect = async (businessId: string) => {
        const realmId = realmOf(businessId);
        intuit.consentTo(realmId);
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl);
        expect(await saveAuthorizedConnection({ businessId, realmId, tokens, config, authorizedByUserId: `admin-of-${businessId}` }, deps)).toBe('connected');
        const org = linkDb.seedOrganization(businessId, `Org of ${businessId}`);
        await getCustomerLinkStatus({ businessId, customerId: org, config }, deps);
        return linkDb.liveGeneration(businessId)!.id;
    };
    const forget = async (businessId: string) => {
        await disconnectQuickBooks({ businessId, config }, deps as any);
        expect(await forgetQuickBooksConnection({ businessId }, deps as any)).toBe('forgotten');
    };
    const reserve = (businessId: string, invoiceId: string, connectionId: string, realmId = realmOf(businessId)) =>
        reserveQuickBooksInvoiceLink({ businessId, invoiceId, connectionId, realmId, userId: `admin-of-${businessId}` }, { db: linkDb.db, env });
    const record = (businessId: string, linkId: string, connectionId: string, qboInvoiceId: string) =>
        recordQuickBooksInvoiceId({ businessId, linkId, connectionId, qboInvoiceId }, { db: linkDb.db, env });
    const read = (businessId: string, invoiceId: string) => getQuickBooksInvoiceLink({ businessId, invoiceId }, { db: linkDb.db, env });
    return { store, linkDb, qbo, intuit, deps, connect, forget, reserve, record, read, db: linkDb.db };
}

const snapshot = (inv: any) => JSON.stringify(inv);

/** A database write that bypasses the service entirely, inside a transaction holding the generation lock. */
const rawInvoiceLinkCreate = (t: Awaited<ReturnType<typeof setup>>, data: Record<string, unknown>) =>
    t.db.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT 1 FROM "integrations" WHERE "business_id" = ${data.business_id} AND "provider" = ${'quickbooks'} FOR SHARE`;
        return tx.quickBooksInvoiceLink.create({ data });
    }).then(() => 'ok', (e: any) => e?.code ?? String(e));

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · ACCEPTANCE: a FreezerIQ invoice has at most ONE QuickBooks invoice link in its lifetime', () => {
    /**
     * 1. Invoice A is linked in generation 1 (reserved, then recorded with the id "our own create" returned).
     * 2. Generation 1 is forgotten.
     * 3. Generation 2 is created — for the SAME QuickBooks company, the case where reuse is most tempting.
     */
    async function scenario() {
        const t = await setup();
        const org = t.linkDb.seedOrganization(TENANT_A, 'Lincoln PTA');
        const customer = t.qbo.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        const g1 = await t.connect(TENANT_A);
        const status: any = await getCustomerLinkStatus({ businessId: TENANT_A, customerId: org, config }, t.deps);
        const customerConfirmation = status.lookup.confirmation as string;
        expect((await linkExistingCustomer({ businessId: TENANT_A, customerId: org, confirmation: customerConfirmation, userId: 'admin-of-biz-tenant-a', config }, t.deps)).outcome).toBe('linked');

        const invoiceA = t.linkDb.seedInvoice(TENANT_A);
        const reserved: any = await t.reserve(TENANT_A, invoiceA.id, g1);
        expect(reserved.outcome).toBe('reserved');
        expect(await t.record(TENANT_A, reserved.link.id, g1, '1045')).toBe('recorded');
        const linkInGeneration1 = await t.read(TENANT_A, invoiceA.id);
        const customerLinksInGeneration1 = [...t.linkDb.links.values()].map((l) => ({ ...l }));

        await t.forget(TENANT_A);                // 2.
        const g2 = await t.connect(TENANT_A);   // 3.
        return { t, org, customer, customerConfirmation, g1, g2, invoiceA, linkInGeneration1: linkInGeneration1!, customerLinksInGeneration1 };
    }

    it('1. Invoice A is linked in generation 1', async () => {
        const { linkInGeneration1, g1, customerLinksInGeneration1 } = await scenario();
        expect(linkInGeneration1).toMatchObject({ connectionId: g1, qboInvoiceId: '1045', qboLinkedAt: expect.any(Date), generation: { live: true } });
        expect(customerLinksInGeneration1).toMatchObject([{ connection_id: g1 }]);
    });

    it('2. Forget ends generation 1 without erasing it', async () => {
        const { t, g1 } = await scenario();
        expect(t.linkDb.generations(TENANT_A).find((g) => g.id === g1)).toMatchObject({ live_business_id: null, live_provider: null, company_name: 'Sandbox Company 1' });
    });

    it('3. connecting again — to the same company — creates generation 2', async () => {
        const { t, g1, g2 } = await scenario();
        expect(g2).not.toBe(g1);
        expect(t.linkDb.liveGeneration(TENANT_A)!.id).toBe(g2);
        expect(t.linkDb.generations(TENANT_A).map((g) => g.id)).toEqual([g1, g2]);
    });

    it('4. re-reserving Invoice A under generation 2 is refused by the SERVICE — nothing is written', async () => {
        const { t, g1, g2, invoiceA, linkInGeneration1 } = await scenario();
        const again = await t.reserve(TENANT_A, invoiceA.id, g2);
        expect(again).toEqual({ outcome: 'already_linked', link: { ...linkInGeneration1, generation: { ...linkInGeneration1.generation, live: false } } });
        expect(t.linkDb.invoiceLinks.size).toBe(1);
        // Nor can the old link be written through the new generation.
        expect(await t.record(TENANT_A, linkInGeneration1.id, g2, '9')).toBe('not_found');
        // And concurrent attempts change nothing either.
        const racing = await Promise.all(Array.from({ length: 4 }, () => t.reserve(TENANT_A, invoiceA.id, g2)));
        expect(racing.map((r) => r.outcome)).toEqual(['already_linked', 'already_linked', 'already_linked', 'already_linked']);
        expect([...t.linkDb.invoiceLinks.values()]).toMatchObject([{ connection_id: g1, qbo_invoice_id: '1045' }]);
        // The service refused on its own: it never even attempted a write the database had to reject.
        expect(t.linkDb.rejectedWrites).toEqual([]);
    });

    it('4. re-linking Invoice A under generation 2 is refused by the DATABASE — UNIQUE (invoice_id)', async () => {
        const { t, g2, invoiceA } = await scenario();
        expect(await rawInvoiceLinkCreate(t, { business_id: TENANT_A, invoice_id: invoiceA.id, connection_id: g2, request_id: 'raw-bypass-1' })).toBe('P2002');
        expect(t.linkDb.rejectedWrites).toEqual(['quickbooks_invoice_links:P2002']);
        expect(t.linkDb.invoiceLinks.size).toBe(1);
    });

    it('5. the historical link still exists after Forget, unchanged', async () => {
        const { t, g1, invoiceA, linkInGeneration1 } = await scenario();
        expect([...t.linkDb.invoiceLinks.values()]).toEqual([{
            id: linkInGeneration1.id, business_id: TENANT_A, invoice_id: invoiceA.id, connection_id: g1,
            request_id: linkInGeneration1.requestId, qbo_invoice_id: '1045', qbo_linked_at: linkInGeneration1.qboLinkedAt,
            created_by: 'admin-of-biz-tenant-a', created_at: linkInGeneration1.createdAt,
        }]);
    });

    it('6. the link’s history is auditable: its generation and that generation’s evidence resolve after Forget', async () => {
        const { t, g1, invoiceA, linkInGeneration1 } = await scenario();
        const history = await t.read(TENANT_A, invoiceA.id);
        expect(history).toEqual({
            id: linkInGeneration1.id,
            connectionId: g1,
            requestId: linkInGeneration1.requestId,
            qboInvoiceId: '1045',
            qboLinkedAt: expect.any(Date),
            createdBy: 'admin-of-biz-tenant-a',
            createdAt: expect.any(Date),
            generation: {
                environment: 'sandbox',
                companyName: 'Sandbox Company 1',
                authorizedBy: 'admin-of-biz-tenant-a',
                authorizedAt: expect.any(Date),
                createdAt: expect.any(Date),
                live: false,
            },
        });
        expect(JSON.stringify(history)).not.toMatch(/9130000000000001|9130000000000002|ACCESSTOKEN|REFRESHTOKEN/);
    });

    it('7. generation 1’s customer mappings are gone', async () => {
        const { t, g1, customerLinksInGeneration1 } = await scenario();
        expect(customerLinksInGeneration1).toHaveLength(1);
        expect([...t.linkDb.links.values()].filter((l) => l.connection_id === g1)).toEqual([]);
        expect(t.linkDb.links.size).toBe(0);
    });

    it('8. generation 2 requires relinking: the old mapping is not reused and the old confirmation is stale', async () => {
        const { t, org, customer, customerConfirmation, g2 } = await scenario();
        const s: any = await getCustomerLinkStatus({ businessId: TENANT_A, customerId: org, config }, t.deps);
        expect(s).toMatchObject({ state: 'unlinked', lookup: { result: 'exact_match' } });
        expect((await linkExistingCustomer({ businessId: TENANT_A, customerId: org, confirmation: customerConfirmation, userId: 'u', config }, t.deps)).outcome).toBe('stale');
        expect(t.linkDb.links.size).toBe(0);
        expect((await linkExistingCustomer({ businessId: TENANT_A, customerId: org, confirmation: s.lookup.confirmation, userId: 'u', config }, t.deps)).outcome).toBe('linked');
        expect([...t.linkDb.links.values()]).toMatchObject([{ connection_id: g2, qbo_customer_id: customer.Id }]);
    });

    it('9. a different, unlinked invoice links normally under generation 2', async () => {
        const { t, g2 } = await scenario();
        const invoiceB = t.linkDb.seedInvoice(TENANT_A);
        const r: any = await t.reserve(TENANT_A, invoiceB.id, g2);
        expect(r).toMatchObject({ outcome: 'reserved', link: { connectionId: g2, qboInvoiceId: null, generation: { live: true } } });
        expect(await t.record(TENANT_A, r.link.id, g2, '1046')).toBe('recorded');
        expect(await t.read(TENANT_A, invoiceB.id)).toMatchObject({ connectionId: g2, qboInvoiceId: '1046' });
        expect(t.linkDb.invoiceLinks.size).toBe(2);
    });

    it('10. one QuickBooks invoice cannot attach to two FreezerIQ invoices in the same generation — service and database', async () => {
        const { t, g2 } = await scenario();
        const [c, d] = [t.linkDb.seedInvoice(TENANT_A), t.linkDb.seedInvoice(TENANT_A)];
        const rc: any = await t.reserve(TENANT_A, c.id, g2);
        const rd: any = await t.reserve(TENANT_A, d.id, g2);
        expect(await t.record(TENANT_A, rc.link.id, g2, '2000')).toBe('recorded');
        expect(await t.record(TENANT_A, rd.link.id, g2, '2000')).toBe('conflict');                 // service
        expect(await t.db.quickBooksInvoiceLink.updateMany({ where: { id: rd.link.id }, data: { qbo_invoice_id: '2000', qbo_linked_at: new Date() } })
            .then(() => 'ok', (e: any) => e.code)).toBe('P2002');                                        // database
        expect(t.linkDb.invoiceLinks.get(rd.link.id)!.qbo_invoice_id).toBeNull();
    });

    it('10. across generations there is deliberately NO company key: the database would accept the same QuickBooks id — the V1 recording contract is what rules it out', async () => {
        // Pinned so nobody mistakes this for a database guarantee. V1 records a QuickBooks
        // invoice id only from FreezerIQ's own create response (or its requestid replay), so
        // an id recorded under generation 1 can never be offered for recording under
        // generation 2. The scope suite proves no search or manual path to recording exists.
        const { t, g2 } = await scenario();
        const other = t.linkDb.seedInvoice(TENANT_A);
        const r: any = await t.reserve(TENANT_A, other.id, g2);
        expect(await t.record(TENANT_A, r.link.id, g2, '1045')).toBe('recorded');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · invoice links: scoping and idempotency', () => {
    it('reserves one link with its own idempotency key; a repeat returns the same reservation', async () => {
        const t = await setup();
        const connectionId = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        const first = await t.reserve(TENANT_A, inv.id, connectionId);
        expect(first).toMatchObject({ outcome: 'reserved', link: { connectionId, qboInvoiceId: null, qboLinkedAt: null, generation: { live: true } } });
        // QB-INVOICE-1C: the key is DERIVED from the invoice (the same for every attempt in its lifetime), within Intuit's 50 characters.
        expect((first as any).link.requestId).toBe(invoiceCreateRequestId(inv.id));
        expect((first as any).link.requestId).toMatch(/^qbinv-[0-9a-f]{40}$/);
        const again = await t.reserve(TENANT_A, inv.id, connectionId);
        expect(again).toEqual({ outcome: 'existing', link: (first as any).link });
        expect(t.linkDb.invoiceLinks.size).toBe(1);
        expect(t.linkDb.lockLog).toContain(`${TENANT_A}|quickbooks`);
    });

    it('concurrent reservations for one invoice produce ONE link', async () => {
        const t = await setup();
        const connectionId = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        const results = await Promise.all(Array.from({ length: 5 }, () => t.reserve(TENANT_A, inv.id, connectionId)));
        expect(t.linkDb.invoiceLinks.size).toBe(1);
        expect(new Set(results.map((r: any) => r.link?.id)).size).toBe(1);
    });

    it('another tenant’s invoice, a generation that is not the tenant’s live one, or another company’s token is refused', async () => {
        const t = await setup();
        const connA = await t.connect(TENANT_A);
        const connB = await t.connect(TENANT_B);
        const invOfB = t.linkDb.seedInvoice(TENANT_B);
        const invOfA = t.linkDb.seedInvoice(TENANT_A);
        expect(await t.reserve(TENANT_A, invOfB.id, connA)).toEqual({ outcome: 'invoice_not_found' });
        expect(await t.reserve(TENANT_A, invOfA.id, connB)).toEqual({ outcome: 'connection_not_current' });
        expect(await t.reserve(TENANT_A, invOfA.id, 'made-up')).toEqual({ outcome: 'connection_not_current' });
        // The live generation, but an access token for a company the tenant is not connected to.
        expect(await t.reserve(TENANT_A, invOfA.id, connA, REALM_2)).toEqual({ outcome: 'connection_not_current' });
        expect(t.linkDb.invoiceLinks.size).toBe(0);
    });

    it('nothing is reserved while the tenant is disconnected, or after Forget under the ended generation', async () => {
        const t = await setup();
        const g1 = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        await disconnectQuickBooks({ businessId: TENANT_A, config }, t.deps as any);
        expect(await t.reserve(TENANT_A, inv.id, g1)).toEqual({ outcome: 'connection_not_current' });
        expect(await forgetQuickBooksConnection({ businessId: TENANT_A }, t.deps as any)).toBe('forgotten');
        expect(await t.reserve(TENANT_A, inv.id, g1)).toEqual({ outcome: 'connection_not_current' });
        await t.connect(TENANT_A);
        expect(await t.reserve(TENANT_A, inv.id, g1)).toEqual({ outcome: 'connection_not_current' });
        expect(t.linkDb.invoiceLinks.size).toBe(0);
        expect(t.linkDb.rejectedWrites).toEqual([]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · invoice links: the QuickBooks id is recorded exactly once', () => {
    async function reserved() {
        const t = await setup();
        const connectionId = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        const r: any = await t.reserve(TENANT_A, inv.id, connectionId);
        return { t, connectionId, inv, link: r.link };
    }

    it('records once; the same id again is already_recorded; a different id is a conflict and changes nothing', async () => {
        const { t, connectionId, link } = await reserved();
        expect(await t.record(TENANT_A, link.id, connectionId, '1045')).toBe('recorded');
        expect(await t.record(TENANT_A, link.id, connectionId, '1045')).toBe('already_recorded');
        expect(await t.record(TENANT_A, link.id, connectionId, '2000')).toBe('conflict');
        expect(t.linkDb.invoiceLinks.get(link.id)).toMatchObject({ qbo_invoice_id: '1045', qbo_linked_at: expect.any(Date) });
    });

    it('wrong tenant, wrong generation, unknown link or a malformed id change nothing', async () => {
        const { t, connectionId, link } = await reserved();
        expect(await t.record(TENANT_B, link.id, connectionId, '1')).toBe('not_found');
        expect(await t.record(TENANT_A, link.id, 'other', '1')).toBe('not_found');
        expect(await t.record(TENANT_A, 'nope', connectionId, '1')).toBe('not_found');
        expect(await t.record(TENANT_A, link.id, connectionId, '1 OR 1=1')).toBe('conflict');
        expect(t.linkDb.invoiceLinks.get(link.id)!.qbo_invoice_id).toBeNull();
    });

    it('a create that was in flight when the tenant forgot the connection is still recorded — on its own generation, as history', async () => {
        const { t, connectionId, inv, link } = await reserved();
        await t.forget(TENANT_A);
        expect(await t.record(TENANT_A, link.id, connectionId, '1045')).toBe('recorded');
        expect(await t.read(TENANT_A, inv.id)).toMatchObject({ connectionId, qboInvoiceId: '1045', generation: { live: false } });
    });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('QB-INVOICE-1B · invoice links have NO financial, status or fulfilment behaviour', () => {
    it('reserving, recording and reading never write the invoice and read nothing but its id', async () => {
        const t = await setup();
        const connectionId = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        const before = snapshot(t.linkDb.invoices.get(inv.id));
        const r: any = await t.reserve(TENANT_A, inv.id, connectionId);
        await t.record(TENANT_A, r.link.id, connectionId, '1045');
        await t.read(TENANT_A, inv.id);

        expect(snapshot(t.linkDb.invoices.get(inv.id))).toBe(before); // status DRAFT, total 1234.56, paid_at null
        expect(t.linkDb.invoices.get(inv.id)).toMatchObject({ status: 'DRAFT', total_amount: '1234.56', paid_at: null });
        expect(t.linkDb.violations).toEqual([]); // no invoice write, no read beyond { id }
    });

    it('a link row holds identifiers and audit metadata only — no amount, tax, status or payment column', async () => {
        const t = await setup();
        const connectionId = await t.connect(TENANT_A);
        const inv = t.linkDb.seedInvoice(TENANT_A);
        const r: any = await t.reserve(TENANT_A, inv.id, connectionId);
        expect(Object.keys(t.linkDb.invoiceLinks.get(r.link.id)!).sort()).toEqual(
            ['business_id', 'connection_id', 'created_at', 'created_by', 'id', 'invoice_id', 'qbo_invoice_id', 'qbo_linked_at', 'request_id'],
        );
    });
});
