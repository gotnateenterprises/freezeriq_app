/**
 * QB-INVOICE-1C — the database guarantees, against REAL Postgres.
 *
 * The other 1C suites prove the lifecycle over faithful doubles. This one proves the migration and the real Prisma
 * queries: the LIFETIME rule UNIQUE(invoice_id) on the lifecycle, its foreign keys to the invoice link (RESTRICT) and
 * the invoice (NO ACTION), every CHECK constraint, settings bound to the LIVE generation and removed by Forget's
 * cascade, the lease compare-and-set under real concurrency, the DRAFT → SENT transaction rolling back as a unit,
 * and the service end to end — including a double click — on real rows.
 *
 * RUNNING IT (opt-in, exactly like tests/qbInvoice1bRealDb.test.ts):
 *
 *   QB1C_DB_URL=postgresql://postgres:PASS@127.0.0.1:5432/<disposable database migrated to this candidate> \
 *     npx jest qbInvoice1cRealDb
 *
 * Point it ONLY at a disposable database. It creates and deletes its own fixtures (ids prefixed qb1c-rdb-) and
 * touches nothing else. Without the variable the suite is SKIPPED, never silently green. QuickBooks is a test double.
 */

import { PrismaClient } from '@prisma/client';
import { disconnectQuickBooks, forgetQuickBooksConnection, saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { liveConnection } from '@/lib/quickbooks/liveConnection';
import { invoiceCreateRequestId } from '@/lib/quickbooks/invoiceLinks';
import { getQuickBooksInvoiceSettingsView, saveQuickBooksInvoiceSettings } from '@/lib/quickbooks/invoiceSettings';
import { checkQuickBooksInvoiceDelivery, getQuickBooksInvoiceSendView, startQuickBooksInvoiceSend } from '@/lib/quickbooks/invoiceSend';
import { settleInvoiceInTransaction } from '@/lib/invoiceSettlementTransition';
import { SETTLEABLE_INVOICE_STATUSES } from '@/lib/invoiceSettlement';
import { fakeIntuit, sandboxConfig, sandboxEnv } from './helpers/quickbooksFakes';
import { fakeQuickBooksCustomers } from './helpers/quickbooksCustomerFakes';
import { fakeQuickBooksInvoicing } from './helpers/quickbooksInvoiceFakes';

const DB_URL = process.env.QB1C_DB_URL;
const describeIfDb = DB_URL ? describe : describe.skip;

const P = 'qb1c-rdb-';
const BIZ = `${P}biz-a`;
const ORG = `${P}org-a`;
const CAMPAIGN = `${P}camp-a`;
const REALM_1 = '9130000000000001';
const RECIPIENT = 'coordinator@lincoln-pta.example';
const HASH = 'a'.repeat(64);
const MAPPING = { salesItemId: '11', salesAccountId: '79', shareItemId: null, shareAccountId: null, taxItemId: null, taxAccountId: null, termId: '2', termDueDays: 15 };
const config = sandboxConfig();
const env = sandboxEnv();

let db: PrismaClient;

async function cleanup() {
    await db.quickBooksInvoiceSend.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksInvoiceSettings.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksInvoiceLink.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksCustomerLink.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.quickBooksConnection.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.invoiceItem.deleteMany({ where: { invoice: { business_id: { startsWith: P } } } });
    await db.invoice.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.fundraiserCampaign.deleteMany({ where: { id: { startsWith: P } } });
    await db.integration.deleteMany({ where: { business_id: { startsWith: P } } });
    await db.customer.deleteMany({ where: { OR: [{ business_id: { startsWith: P } }, { id: { startsWith: P } }] } });
    await db.business.deleteMany({ where: { id: { startsWith: P } } });
}

const code = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e: any) { return e?.code ?? e?.meta?.code ?? String(e?.message ?? e).slice(0, 120); } };

describeIfDb('QB-INVOICE-1C · real Postgres', () => {
    let qbo = fakeQuickBooksInvoicing();
    let customers = fakeQuickBooksCustomers();
    let intuit = fakeIntuit({ realmIds: [REALM_1], accounting: async (req) => (await qbo.accounting(req)) ?? customers.accounting(req) });
    const deps = () => ({ db: db as any, fetchImpl: intuit.fetchImpl, env });

    let generation = '';
    let invoiceSeq = 0;

    async function seedInvoice(over: Record<string, unknown> = {}) {
        const id = `${P}inv-${++invoiceSeq}`;
        const campaignId = `${CAMPAIGN}-${invoiceSeq}`;
        await db.fundraiserCampaign.create({ data: { id: campaignId, name: `QB1C RDB campaign ${invoiceSeq}`, customer_id: ORG } });
        await db.invoice.create({
            data: {
                id, business_id: BIZ, customer_id: ORG, campaign_id: campaignId, status: 'DRAFT' as any,
                total_amount: '451.59', tax_amount: '5.59', tax_rate_percent: '1.00', tax_status: 'TAXABLE' as any,
                fundraiser_profit_amount: '111.50', fundraiser_profit_percent: '20.00',
                items: {
                    create: [
                        { id: `${id}-a`, description: 'Family Friendly', variant_size: 'serves_5' as any, quantity: '7.00', unit_price: '62.50', total: '437.50' },
                        { id: `${id}-b`, description: 'Date Night (Serves 2)', variant_size: 'serves_2' as any, quantity: '2.00', unit_price: '60.00', total: '120.00' },
                    ],
                },
                ...over,
            },
        });
        return id;
    }

    /** A link (and thus a lifecycle) needs the invoice's reserved link row first. */
    const rawLink = (invoiceId: string) => db.quickBooksInvoiceLink.create({ data: { business_id: BIZ, invoice_id: invoiceId, connection_id: generation, request_id: invoiceCreateRequestId(invoiceId) } });
    const sendRow = (invoiceId: string, over: Record<string, unknown> = {}) => ({
        business_id: BIZ, invoice_id: invoiceId, status: 'reserved' as any, review_hash: HASH, recipient_to: RECIPIENT, recipient_cc: null,
        allow_online_card: false, allow_online_ach: false, txn_date: '2026-09-15', mapping: MAPPING, ...over,
    });

    beforeAll(async () => {
        db = new PrismaClient({ datasourceUrl: DB_URL });
        await cleanup();
    });
    beforeEach(async () => {
        await cleanup();
        invoiceSeq = 0;
        qbo = fakeQuickBooksInvoicing();
        customers = fakeQuickBooksCustomers();
        intuit = fakeIntuit({ realmIds: [REALM_1], accounting: async (req) => (await qbo.accounting(req)) ?? customers.accounting(req) });
        await db.business.create({ data: { id: BIZ, name: 'QB1C RDB A', slug: `${P}a`, timezone: 'America/Chicago' } });
        await db.customer.create({ data: { id: ORG, business_id: BIZ, name: 'Lincoln PTA', contact_email: RECIPIENT } });
        intuit.consentTo(REALM_1);
        const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl);
        expect(await saveAuthorizedConnection({ businessId: BIZ, realmId: REALM_1, tokens, config, authorizedByUserId: `admin-${BIZ}` }, deps())).toBe('connected');
        const live: any = await liveConnection(BIZ, config, { db: db as any, fetchImpl: intuit.fetchImpl, env, now: Date.now });
        generation = live.connectionId;
    });
    afterAll(async () => {
        if (db) { await cleanup(); await db.$disconnect(); }
    });

    async function configure() {
        const sales = qbo.seedAccount({ Name: 'Fundraiser Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' });
        const contra = qbo.seedAccount({ Name: 'Discounts given', AccountType: 'Income', AccountSubType: 'DiscountsRefundsGiven' });
        const liability = qbo.seedAccount({ Name: 'Supporter Sales Tax Collected', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' });
        qbo.seedItem({ Name: 'FreezerIQ Fundraiser Sales', IncomeAccountRef: { value: sales.Id } });
        qbo.seedItem({ Name: 'Organization Fundraiser Share', IncomeAccountRef: { value: contra.Id } });
        qbo.seedItem({ Name: 'Sales Tax Collected from Supporters', IncomeAccountRef: { value: liability.Id } });
        qbo.seedTerm({ Name: 'Net 15', DueDays: 15 });
        const qboCustomer = customers.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
        await db.quickBooksCustomerLink.create({ data: { business_id: BIZ, customer_id: ORG, connection_id: generation, qbo_customer_id: qboCustomer.Id, source: 'existing' } });
        const v: any = await getQuickBooksInvoiceSettingsView({ businessId: BIZ, config }, deps());
        const saved: any = await saveQuickBooksInvoiceSettings({
            businessId: BIZ, config, userId: `admin-${BIZ}`,
            selection: { salesItemKey: v.options.items.sales[0].key, shareItemKey: v.options.items.share[0].key, taxItemKey: v.options.items.tax[0].key, termKey: v.options.terms[0].key, allowOnlineCard: false, allowOnlineAch: false, defaultCc: null },
        }, deps());
        expect(saved.outcome).toBe('saved');
    }

    it('the service end to end on real rows: review → send → SENT in one transaction; the QuickBooks total equals FreezerIQ’s', async () => {
        await configure();
        const inv = await seedInvoice();
        const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: inv, config }, deps());
        expect(view).toMatchObject({ state: 'ready', preview: { totals: { total: 451.59, tax: 5.59, share: 111.5, bundles: 557.5 } } });
        const result = await startQuickBooksInvoiceSend({ businessId: BIZ, invoiceId: inv, config, userId: `admin-${BIZ}`, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, deps());
        expect(result.outcome).toBe('sent');
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('SENT');
        const row = await db.quickBooksInvoiceSend.findUnique({ where: { invoice_id: inv } });
        expect(row).toMatchObject({ status: 'sent', send_count: 1, lease_id: null, mapping: expect.objectContaining({ termDueDays: 15 }) });
        const link = await db.quickBooksInvoiceLink.findUnique({ where: { invoice_id: inv } });
        expect(link).toMatchObject({ request_id: invoiceCreateRequestId(inv), qbo_invoice_id: [...qbo.invoices.keys()][0] });
        expect([...qbo.invoices.values()][0].TotalAmt).toBe(451.59);
        expect(await checkQuickBooksInvoiceDelivery({ businessId: BIZ, invoiceId: inv, config }, deps())).toMatchObject({ outcome: 'checked' });
    });

    it('double click on real Postgres: concurrent sends create ONE QuickBooks invoice, one link, one lifecycle, one email', async () => {
        await configure();
        const inv = await seedInvoice();
        const view: any = await getQuickBooksInvoiceSendView({ businessId: BIZ, invoiceId: inv, config }, deps());
        const click = () => startQuickBooksInvoiceSend({ businessId: BIZ, invoiceId: inv, config, userId: `admin-${BIZ}`, reviewToken: view.reviewToken, recipientTo: RECIPIENT, recipientCc: null }, deps());
        const results = await Promise.all([click(), click(), click(), click()]);
        for (const r of results) expect(['sent', 'in_progress']).toContain(r.outcome);
        expect(qbo.invoices.size).toBe(1);
        expect(qbo.sent).toHaveLength(1);
        expect(await db.quickBooksInvoiceLink.count({ where: { invoice_id: inv } })).toBe(1);
        expect(await db.quickBooksInvoiceSend.count({ where: { invoice_id: inv } })).toBe(1);
    });

    it('LIFETIME: one lifecycle per invoice; a lifecycle needs the invoice’s link; neither the link nor the invoice can be deleted under it', async () => {
        const inv = await seedInvoice();
        expect(await code(db.quickBooksInvoiceSend.create({ data: sendRow(inv) }))).toBe('P2003'); // no link yet
        await rawLink(inv);
        expect(await code(db.quickBooksInvoiceSend.create({ data: sendRow(inv) }))).toBe('ok');
        expect(await code(db.quickBooksInvoiceSend.create({ data: sendRow(inv) }))).toBe('P2002');
        expect(await code(db.quickBooksInvoiceLink.delete({ where: { invoice_id: inv } }))).toBe('P2003');
        expect(await code(db.invoiceItem.deleteMany({ where: { invoice_id: inv } }))).toBe('ok');
        expect(await code(db.invoice.delete({ where: { id: inv } }))).toBe('P2003');
        const other = await seedInvoice();
        expect(await code(db.quickBooksInvoiceSend.create({ data: { ...sendRow(other), business_id: `${P}biz-b` } }))).not.toBe('ok'); // another tenant cannot attach
    });

    it('CHECK constraints: review hash, date, mapping, recipients (one CC, 100 chars), lease pair, counters, created and sent evidence', async () => {
        const inv = await seedInvoice();
        await rawLink(inv);
        const bad: Array<[string, Record<string, unknown>]> = [
            ['hash', { review_hash: 'not-hex' }],
            ['date', { txn_date: '09/15/2026' }],
            ['mapping array', { mapping: [1, 2] }],
            ['empty recipient', { recipient_to: '' }],
            ['long recipient', { recipient_to: `${'a'.repeat(95)}@x.example` }],
            ['two primary recipients', { recipient_to: 'a@example.invalid,b@example.invalid' }],
            ['long cc', { recipient_cc: `${'c'.repeat(95)}@x.example` }],
            ['half lease', { lease_id: 'x' }],
            ['negative revision', { revision: -1 }],
            ['created without evidence', { status: 'created' }],
            ['sent without evidence', { status: 'sent', qbo_doc_number: '1052', qbo_sync_token: '2', created_verified_at: new Date() }],
        ];
        for (const [name, over] of bad) expect({ name, result: await code(db.quickBooksInvoiceSend.create({ data: sendRow(inv, over) })) }).not.toEqual({ name, result: 'ok' });
        expect(await code(db.quickBooksInvoiceSend.create({ data: sendRow(inv, { status: 'needs_review' }) }))).toBe('ok');
        expect(await code(db.quickBooksInvoiceSend.update({ where: { invoice_id: inv }, data: { status: 'sent' } }))).not.toBe('ok');
        expect(await code(db.quickBooksInvoiceSend.update({ where: { invoice_id: inv }, data: { status: 'sent', sent_at: new Date(), send_count: 1, qbo_doc_number: '1052', qbo_sync_token: '2', created_verified_at: new Date() } }))).toBe('ok');
    });

    it('settings: only the LIVE generation, CHECKed pairs and CC, and Forget’s cascade removes them', async () => {
        const base = { business_id: BIZ, connection_id: generation, sales_item_id: '11', sales_account_id: '79', term_id: '2', term_due_days: 15 };
        expect(await code(db.quickBooksInvoiceSettings.create({ data: { ...base, share_item_id: '12' } }))).not.toBe('ok'); // half pair
        expect(await code(db.quickBooksInvoiceSettings.create({ data: { ...base, default_cc: '' } }))).not.toBe('ok');
        expect(await code(db.quickBooksInvoiceSettings.create({ data: { ...base, sales_item_id: 'abc' } }))).not.toBe('ok');
        expect(await code(db.quickBooksInvoiceSettings.create({ data: { ...base, connection_id: `${P}not-a-generation` } }))).toBe('P2003');
        expect(await code(db.quickBooksInvoiceSettings.create({ data: base }))).toBe('ok');
        await disconnectQuickBooks({ businessId: BIZ, config }, deps());
        expect(await forgetQuickBooksConnection({ businessId: BIZ }, deps())).toBe('forgotten');
        expect(await db.quickBooksInvoiceSettings.count({ where: { business_id: BIZ } })).toBe(0);
        expect(await db.quickBooksConnection.count({ where: { business_id: BIZ } })).toBe(1); // the generation is kept, ended
    });

    it('the lease is a real compare-and-set: of many concurrent claims exactly one wins; an expired lease can be taken', async () => {
        const inv = await seedInvoice();
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({ data: sendRow(inv) });
        const now = new Date();
        const claim = (id: string) => db.quickBooksInvoiceSend.updateMany({
            where: { business_id: BIZ, invoice_id: inv, status: 'reserved' as any, OR: [{ lease_id: null }, { lease_until: { lt: now } }] },
            data: { lease_id: id, lease_until: new Date(now.getTime() + 120_000) },
        });
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`lease-${i}`)));
        expect(results.map((r) => r.count).reduce((a, b) => a + b, 0)).toBe(1);
        await db.quickBooksInvoiceSend.update({ where: { invoice_id: inv }, data: { lease_until: new Date(now.getTime() - 1000) } });
        expect((await claim('late')).count).toBe(1);
    });

    it('the SENT transaction is atomic: if the invoice is no longer DRAFT, the lifecycle is not marked sent either', async () => {
        const inv = await seedInvoice({ status: 'PAID' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({ data: sendRow(inv, { status: 'payment_options_set', qbo_doc_number: '1052', qbo_sync_token: '2', created_verified_at: new Date(), lease_id: 'mine', lease_until: new Date(Date.now() + 60_000) }) });
        await expect(db.$transaction(async (tx) => {
            const lifecycle = await tx.quickBooksInvoiceSend.updateMany({ where: { business_id: BIZ, invoice_id: inv, lease_id: 'mine' }, data: { status: 'sent', sent_at: new Date(), send_count: 1, lease_id: null, lease_until: null } });
            expect(lifecycle.count).toBe(1);
            const invoice = await tx.invoice.updateMany({ where: { id: inv, business_id: BIZ, status: 'DRAFT' }, data: { status: 'SENT' } });
            if (invoice.count !== 1) throw new Error('left draft');
        })).rejects.toThrow('left draft');
        expect(await db.quickBooksInvoiceSend.findUnique({ where: { invoice_id: inv } })).toMatchObject({ status: 'payment_options_set', lease_id: 'mine', send_count: 0 });
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('PAID');
    });
    /**
     * QB-INVOICE-CANCEL-1 — the shared settlement transition's new condition, against REAL Postgres. The doubles
     * cannot prove Prisma actually compiles the relation filter, and this is the money path: an invoice may not
     * become PAID while FreezerIQ holds a QuickBooks lease on it (a cancellation is mid-void), nor once its
     * QuickBooks copy is voided. An ordinary invoice, with no QuickBooks lifecycle at all, is unaffected.
     */
    it('the settlement transition refuses a leased or voided QuickBooks invoice, and never an ordinary one', async () => {
        const facts = { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' };
        const settle = async (invoiceId: string, campaignId: string | null) => db.$transaction((tx) => settleInvoiceInTransaction(tx, {
            invoice: { id: invoiceId, campaign_id: campaignId, customer_id: ORG, total_amount: '451.59', customer: { type: 'fundraiser_org' } },
            businessId: BIZ,
            facts,
            fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));

        // 1. an ordinary invoice — no QuickBooks lifecycle row — still settles exactly as before.
        const plain = await seedInvoice({ status: 'SENT' as any });
        const campaignOf = async (id: string) => (await db.invoice.findUnique({ where: { id }, select: { campaign_id: true } }))!.campaign_id;
        expect(await settle(plain, await campaignOf(plain))).toEqual({ count: 1 });
        expect((await db.invoice.findUnique({ where: { id: plain } }))!.status).toBe('PAID');

        // 2. an invoice whose QuickBooks lifecycle holds a LIVE lease — a cancellation inside its void — is refused.
        const leased = await seedInvoice({ status: 'SENT' as any });
        await rawLink(leased);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(leased, {
                status: 'sent' as any, qbo_doc_number: '1052', qbo_sync_token: '2', created_verified_at: new Date(), sent_at: new Date(), send_count: 1,
                lease_id: 'cancel-in-flight', lease_until: new Date(Date.now() + 60_000),
            }),
        });
        expect(await settle(leased, await campaignOf(leased))).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: leased } }))!.status).toBe('SENT');

        // 3. the same invoice once the lease has expired: settleable again.
        await db.quickBooksInvoiceSend.update({ where: { invoice_id: leased }, data: { lease_until: new Date(Date.now() - 1_000) } });
        expect(await settle(leased, await campaignOf(leased))).toEqual({ count: 1 });
        expect((await db.invoice.findUnique({ where: { id: leased } }))!.status).toBe('PAID');

        // 4. an invoice whose QuickBooks copy is VOIDED is refused for good, lease or no lease.
        const voided = await seedInvoice({ status: 'SENT' as any });
        await rawLink(voided);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(voided, {
                status: 'sent' as any, qbo_doc_number: '1053', qbo_sync_token: '3', created_verified_at: new Date(), sent_at: new Date(), send_count: 1,
                lease_id: null, lease_until: null, void_requested_at: new Date(), void_requested_by: `admin-${BIZ}`, voided_at: new Date(), voided_by: `admin-${BIZ}`,
            }),
        });
        expect(await settle(voided, await campaignOf(voided))).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: voided } }))!.status).toBe('SENT');
    });
    /**
     * QB-INVOICE-CANCEL-1 — the ORDERING, observed against real Postgres rather than argued from a snapshot model.
     *
     * The settlement transition locks this invoice's QuickBooks lifecycle row FOR UPDATE before it decides. A
     * cancellation's lease claim is an UPDATE of that same row, so while a settlement transaction is open the claim
     * CANNOT commit — it waits. That is what makes the dangerous interleaving impossible: a cancellation can only
     * hold its lease either before a settlement locked the row (the settlement then sees the lease and refuses) or
     * after that settlement committed (the cancellation's own post-lease re-read then sees PAID and never voids).
     */
    it('a settlement in flight BLOCKS the cancel lease claim until it commits, and the invoice is PAID by then', async () => {
        const inv = await seedInvoice({ status: 'SENT' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(inv, {
                status: 'sent' as any, qbo_doc_number: '1052', qbo_sync_token: '2', created_verified_at: new Date(),
                sent_at: new Date(), send_count: 1, lease_id: null, lease_until: null,
            }),
        });
        const campaignId = (await db.invoice.findUnique({ where: { id: inv }, select: { campaign_id: true } }))!.campaign_id;

        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => { locked = r; });
        let proceed!: () => void;
        const mayFinish = new Promise<void>((r) => { proceed = r; });

        // A settlement transaction: take the same lock the transition takes, hold it open, then settle.
        const settlement = db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "lease_until", "voided_at" FROM "quickbooks_invoice_sends" WHERE "invoice_id" = ${inv} FOR UPDATE`;
            locked();
            await mayFinish;
            return settleInvoiceInTransaction(tx, {
                invoice: { id: inv, campaign_id: campaignId, customer_id: ORG, total_amount: '451.59', customer: { type: 'fundraiser_org' } },
                businessId: BIZ,
                facts: { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' },
                fromStatuses: SETTLEABLE_INVOICE_STATUSES,
            });
        }, { timeout: 20_000, maxWait: 10_000 });
        await lockTaken;

        // The cancellation now tries to claim its lease — the very write that authorizes a QuickBooks void.
        const claim = db.quickBooksInvoiceSend.updateMany({
            where: { business_id: BIZ, invoice_id: inv, status: 'sent' as any, OR: [{ lease_id: null }, { lease_until: { lt: new Date() } }] },
            data: { lease_id: 'cancel-lease', lease_until: new Date(Date.now() + 120_000) },
        });
        const waited = await Promise.race([
            claim.then(() => 'claimed while the settlement was open'),
            new Promise((r) => setTimeout(() => r('blocked'), 750)),
        ]);
        expect(waited).toBe('blocked'); // OBSERVED: Postgres makes it wait for the settlement's row lock

        proceed();
        expect(await settlement).toEqual({ count: 1 });
        expect(await claim).toEqual({ count: 1 }); // it completes only now, AFTER the settlement committed

        // …and this is what the cancellation reads immediately after claiming: the settlement's own result.
        const afterClaim = await db.invoice.findUnique({ where: { id: inv }, select: { status: true, paid_at: true } });
        expect(afterClaim).toMatchObject({ status: 'PAID' });
        expect(afterClaim!.paid_at).not.toBeNull();
        // So the cancellation stands down here, and QuickBooks is never voided.
        await db.quickBooksInvoiceSend.updateMany({ where: { invoice_id: inv }, data: { lease_id: null, lease_until: null } });
    }, 60_000);

    it('a lease claimed FIRST makes the settlement refuse, with no PAID write and no release', async () => {
        const inv = await seedInvoice({ status: 'SENT' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(inv, {
                status: 'sent' as any, qbo_doc_number: '1054', qbo_sync_token: '2', created_verified_at: new Date(),
                sent_at: new Date(), send_count: 1, lease_id: 'cancel-lease', lease_until: new Date(Date.now() + 120_000),
            }),
        });
        const campaignId = (await db.invoice.findUnique({ where: { id: inv }, select: { campaign_id: true } }))!.campaign_id;

        const result = await db.$transaction((tx) => settleInvoiceInTransaction(tx, {
            invoice: { id: inv, campaign_id: campaignId, customer_id: ORG, total_amount: '451.59', customer: { type: 'fundraiser_org' } },
            businessId: BIZ,
            facts: { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' },
            fromStatuses: SETTLEABLE_INVOICE_STATUSES,
        }));

        expect(result).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('SENT');
    });

    /**
     * QB-INVOICE-CANCEL-1 — THE CRASH WINDOW, against real Postgres.
     *
     * The lease is what orders two live requests, and it expires. The DURABLE INTENT is what survives a killed
     * process, and it does not. These prove the three things the doubles cannot: that Prisma really compiles the
     * intent into both the locked read and the relation filter, that an expired lease with an unresolved intent
     * is still refused, and that clearing the intent genuinely returns the invoice to normal collection.
     */
    const settleReal = (invoiceId: string, campaignId: string | null) => db.$transaction((tx) => settleInvoiceInTransaction(tx, {
        invoice: { id: invoiceId, campaign_id: campaignId, customer_id: ORG, total_amount: '451.59', customer: { type: 'fundraiser_org' } },
        businessId: BIZ,
        facts: { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' },
        fromStatuses: SETTLEABLE_INVOICE_STATUSES,
    }));
    const campaignOfInvoice = async (id: string) => (await db.invoice.findUnique({ where: { id }, select: { campaign_id: true } }))!.campaign_id;

    it('an unresolved void intent outlives the lease: settlement is refused until it is proven unwritten', async () => {
        const inv = await seedInvoice({ status: 'SENT' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(inv, {
                status: 'sent' as any, qbo_doc_number: '1056', qbo_sync_token: '2', created_verified_at: new Date(),
                sent_at: new Date(), send_count: 1, lease_id: 'cancel-lease', lease_until: new Date(Date.now() + 120_000),
            }),
        });
        const campaignId = await campaignOfInvoice(inv);

        // The cancellation commits its decision — an ordinary UPDATE of the leased row — and is then killed.
        await db.quickBooksInvoiceSend.updateMany({
            where: { business_id: BIZ, invoice_id: inv, lease_id: 'cancel-lease' },
            data: { void_requested_at: new Date(), void_requested_by: `admin-${BIZ}` },
        });
        const stored = await db.quickBooksInvoiceSend.findUnique({ where: { invoice_id: inv } });
        expect(stored!.void_requested_at).toBeInstanceOf(Date);
        expect(stored!.voided_at).toBeNull();

        // Two minutes pass. The lease is worth nothing now — and that must change nothing.
        await db.quickBooksInvoiceSend.update({
            where: { invoice_id: inv }, data: { lease_id: 'cancel-lease', lease_until: new Date(Date.now() - 600_000) },
        });
        expect(await settleReal(inv, campaignId)).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('SENT');

        // With no lease at all, the intent alone still refuses it.
        await db.quickBooksInvoiceSend.update({ where: { invoice_id: inv }, data: { lease_id: null, lease_until: null } });
        expect(await settleReal(inv, campaignId)).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('SENT');

        // And the retry finishes it: the conditional transition Cancel uses moves it to CANCELED, once.
        const canceled = await db.invoice.updateMany({
            where: { id: inv, business_id: BIZ, status: { in: ['SENT', 'PENDING', 'OVERDUE'] as any[] } },
            data: { status: 'CANCELED' as any },
        });
        expect(canceled).toEqual({ count: 1 });
        await db.quickBooksInvoiceSend.update({ where: { invoice_id: inv }, data: { voided_at: new Date(), voided_by: `admin-${BIZ}` } });
        expect(await settleReal(inv, campaignId)).toEqual({ count: 0 });
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('CANCELED');
    });

    it('a definitively rejected void clears the intent, and the invoice collects normally again', async () => {
        const inv = await seedInvoice({ status: 'SENT' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(inv, {
                status: 'sent' as any, qbo_doc_number: '1057', qbo_sync_token: '2', created_verified_at: new Date(),
                sent_at: new Date(), send_count: 1, lease_id: 'cancel-lease', lease_until: new Date(Date.now() + 120_000),
                void_requested_at: new Date(), void_requested_by: `admin-${BIZ}`,
            }),
        });
        const campaignId = await campaignOfInvoice(inv);
        expect(await settleReal(inv, campaignId)).toEqual({ count: 0 });

        // Intuit refused the void outright, so FreezerIQ releases its decision and the lease together.
        await db.quickBooksInvoiceSend.updateMany({
            where: { business_id: BIZ, invoice_id: inv, lease_id: 'cancel-lease' },
            data: { void_requested_at: null, void_requested_by: null, problem: 'void_rejected', problem_at: new Date(), lease_id: null, lease_until: null },
        });

        expect(await settleReal(inv, campaignId)).toEqual({ count: 1 });
        const paid = await db.invoice.findUnique({ where: { id: inv } });
        expect(paid!.status).toBe('PAID');
        expect(paid!.paid_at).not.toBeNull();
    });

    // The lease is deliberately NOT held here: this isolates the decision write itself, proving that it is an
    // UPDATE of the locked row and so cannot slip past an open settlement — independently of the lease, which
    // would refuse that settlement on its own and hide the thing being measured.
    it('the intent write is ordered by the same row lock: a settlement in flight makes it wait', async () => {
        const inv = await seedInvoice({ status: 'SENT' as any });
        await rawLink(inv);
        await db.quickBooksInvoiceSend.create({
            data: sendRow(inv, {
                status: 'sent' as any, qbo_doc_number: '1058', qbo_sync_token: '2', created_verified_at: new Date(),
                sent_at: new Date(), send_count: 1, lease_id: null, lease_until: null,
            }),
        });
        const campaignId = await campaignOfInvoice(inv);

        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => { locked = r; });
        let proceed!: () => void;
        const mayFinish = new Promise<void>((r) => { proceed = r; });

        const settlement = db.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "lease_until", "voided_at", "void_requested_at" FROM "quickbooks_invoice_sends" WHERE "invoice_id" = ${inv} FOR UPDATE`;
            locked();
            await mayFinish;
            return settleInvoiceInTransaction(tx, {
                invoice: { id: inv, campaign_id: campaignId, customer_id: ORG, total_amount: '451.59', customer: { type: 'fundraiser_org' } },
                businessId: BIZ,
                facts: { method: 'check' as const, paidAt: new Date('2026-09-20T12:00:00.000Z'), reference: 'check 4021' },
                fromStatuses: SETTLEABLE_INVOICE_STATUSES,
            });
        }, { timeout: 20_000, maxWait: 10_000 });
        await lockTaken;

        // The cancellation's decision is a write to that same row, so it cannot slip past an open settlement.
        const intent = db.quickBooksInvoiceSend.updateMany({
            where: { business_id: BIZ, invoice_id: inv },
            data: { void_requested_at: new Date(), void_requested_by: `admin-${BIZ}` },
        });
        const waited = await Promise.race([
            intent.then(() => 'committed while the settlement was open'),
            new Promise((r) => setTimeout(() => r('blocked'), 750)),
        ]);
        expect(waited).toBe('blocked'); // OBSERVED: Postgres makes the decision wait for the settlement's lock

        proceed();
        expect(await settlement).toEqual({ count: 1 });
        expect(await intent).toEqual({ count: 1 }); // it lands only now, after the settlement committed

        // …which is exactly why the cancellation re-reads the invoice after claiming its lease: it is PAID, so
        // it stands down before this decision would ever authorize a QuickBooks void.
        expect((await db.invoice.findUnique({ where: { id: inv } }))!.status).toBe('PAID');
        await db.quickBooksInvoiceSend.updateMany({ where: { invoice_id: inv }, data: { lease_id: null, lease_until: null, void_requested_at: null, void_requested_by: null } });
    }, 60_000);
});
