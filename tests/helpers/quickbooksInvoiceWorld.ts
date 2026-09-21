/**
 * QB-INVOICE-1C — one tenant, connected to one artificial QuickBooks company, with the accepted chart of items
 * already there and an organization linked to its QuickBooks customer. Everything is a test double
 * (./quickbooksFakes, ./quickbooksCustomerFakes, ./quickbooksInvoiceFakes); no value is a real id, token or address.
 *
 * The invoice fixture is the owner's rounding case from the 1C accounting spike (E2): 7 × $62.50 + 2 × $60.00 of
 * pre-tax bundles = $557.50, a 20% organization share of $111.50, and $5.59 of supporter tax frozen per order at 1%
 * — total $451.59.
 */

import { exchangeAuthorizationCode } from '@/lib/quickbooks/intuitClient';
import { saveAuthorizedConnection } from '@/lib/quickbooks/connection';
import { liveConnection } from '@/lib/quickbooks/liveConnection';
import { fakeIntuit, sandboxConfig, sandboxEnv } from './quickbooksFakes';
import { fakeQuickBooksCustomers } from './quickbooksCustomerFakes';
import { fakeInvoiceSendDb, fakeQuickBooksInvoicing, type FakeInvoice } from './quickbooksInvoiceFakes';

export const REALM_1 = '9130000000000001';
export const REALM_2 = '9130000000000002';
export const BIZ = 'biz-freezer-chef-test';
export const OTHER_BIZ = 'biz-other-tenant';
export const RECIPIENT = 'coordinator@lincoln-pta.example';
export const CC = 'treasurer@lincoln-pta.example';
export const ADMIN_USER = 'user-admin-1';

export const E2_ITEMS = [
    { id: 'item-family', description: 'Family Friendly', variant_size: 'serves_5', quantity: '7.00', unit_price: '62.50', total: '437.50' },
    { id: 'item-date-night', description: 'Date Night (Serves 2)', variant_size: 'serves_2', quantity: '2.00', unit_price: '60.00', total: '120.00' },
];

export const E2_INVOICE = {
    total_amount: '451.59', tax_amount: '5.59', tax_rate_percent: '1.00', tax_status: 'TAXABLE',
    fundraiser_profit_amount: '111.50', fundraiser_profit_percent: '20.00',
};

export interface WorldOptions {
    autoSend?: boolean;
    /** Card / ACH chosen in the tenant's settings (the company has online payments active). */
    online?: { card: boolean; ach: boolean };
    defaultCc?: string | null;
    /** Seed no settings row. */
    noSettings?: boolean;
    /** QB-INVOICE-1D: let the database double accept the shared settlement transition (and only it). */
    settlement?: boolean;
}

export async function invoiceWorld(options: WorldOptions = {}) {
    const clock = { offsetMs: 0 };
    const now = () => Date.now() + clock.offsetMs;
    const config = sandboxConfig();
    const env = sandboxEnv();
    const store = fakeInvoiceSendDb({ settlement: options.settlement });
    const customers = fakeQuickBooksCustomers();
    const qbo = fakeQuickBooksInvoicing({ autoSend: options.autoSend, now });
    const intuit = fakeIntuit({
        realmIds: [REALM_1, REALM_2],
        accounting: async (req) => (await qbo.accounting(req)) ?? customers.accounting(req),
    });
    const deps = { db: store.db, fetchImpl: intuit.fetchImpl, env, now, sleep: () => new Promise<void>((r) => setImmediate(r)) };

    // Connect the tenant and record its live generation, the way the product does on first use.
    intuit.consentTo(REALM_1);
    const tokens = await exchangeAuthorizationCode(config, 'AUTHCODE-1', intuit.fetchImpl);
    const saved = await saveAuthorizedConnection({ businessId: BIZ, realmId: REALM_1, tokens, config, authorizedByUserId: ADMIN_USER }, deps);
    if (saved !== 'connected') throw new Error(`world: connection not saved (${saved})`);
    const live = await liveConnection(BIZ, config, { db: store.db, fetchImpl: intuit.fetchImpl, env, now });
    if ('state' in live) throw new Error(`world: no live connection (${live.state})`);
    const generationId = live.connectionId;

    // The tenant's own QuickBooks chart (artificial).
    const accounts = {
        sales: qbo.seedAccount({ Name: 'Fundraiser Sales', AccountType: 'Income', AccountSubType: 'SalesOfProductIncome' }),
        contra: qbo.seedAccount({ Name: 'Discounts given', AccountType: 'Income', AccountSubType: 'DiscountsRefundsGiven' }),
        liability: qbo.seedAccount({ Name: 'Supporter Sales Tax Collected', AccountType: 'Other Current Liability', AccountSubType: 'OtherCurrentLiabilities' }),
        agency: qbo.seedAccount({ Name: 'Board of Equalization Payable', AccountType: 'Other Current Liability', AccountSubType: 'GlobalTaxPayable' }),
        expense: qbo.seedAccount({ Name: 'Commissions & fees', AccountType: 'Expense', AccountSubType: 'OtherMiscellaneousServiceCost' }),
        services: qbo.seedAccount({ Name: 'Services', AccountType: 'Income', AccountSubType: 'ServiceFeeIncome' }),
    };
    const items = {
        sales: qbo.seedItem({ Name: 'FreezerIQ Fundraiser Sales', IncomeAccountRef: { value: accounts.sales.Id } }),
        share: qbo.seedItem({ Name: 'Organization Fundraiser Share', IncomeAccountRef: { value: accounts.contra.Id } }),
        tax: qbo.seedItem({ Name: 'Sales Tax Collected from Supporters', IncomeAccountRef: { value: accounts.liability.Id } }),
        commission: qbo.seedItem({ Name: 'Commission (expense)', IncomeAccountRef: { value: accounts.expense.Id } }),
        inventory: qbo.seedItem({ Name: 'Freezer meals (inventory)', Type: 'Inventory', IncomeAccountRef: { value: accounts.sales.Id } }),
    };
    const terms = {
        net15: qbo.seedTerm({ Name: 'Net 15', DueDays: 15 }),
        onReceipt: qbo.seedTerm({ Name: 'Due on receipt', DueDays: 0 }),
        dateDriven: qbo.seedTerm({ Name: '15th of month', Type: 'DATE_DRIVEN' }),
    };

    // The organization, its QuickBooks customer, and the 1B customer link.
    const orgId = store.seedOrganization(BIZ, 'Lincoln PTA', RECIPIENT);
    const qboCustomer = customers.seed(REALM_1, { DisplayName: 'Lincoln PTA' });
    store.link.links.set('customer-link-1', {
        id: 'customer-link-1', business_id: BIZ, customer_id: orgId, connection_id: generationId, provider: 'quickbooks',
        qbo_customer_id: qboCustomer.Id, source: 'existing', linked_by: ADMIN_USER, linked_at: new Date(),
    });

    const online = options.online ?? { card: false, ach: false };
    if (!options.noSettings) {
        store.settings.set(BIZ, {
            business_id: BIZ, provider: 'quickbooks', connection_id: generationId,
            sales_item_id: items.sales.Id, sales_account_id: accounts.sales.Id,
            share_item_id: items.share.Id, share_account_id: accounts.contra.Id,
            tax_item_id: items.tax.Id, tax_account_id: accounts.liability.Id,
            term_id: terms.net15.Id, term_due_days: 15,
            allow_online_card: online.card, allow_online_ach: online.ach, default_cc: options.defaultCc ?? null,
            updated_by: ADMIN_USER, created_at: new Date(), updated_at: new Date(),
        });
    }

    const seedE2 = (over: Partial<FakeInvoice> = {}) => store.seedInvoice({
        business_id: BIZ, customer_id: orgId, ...E2_INVOICE, items: E2_ITEMS.map((i) => ({ ...i })), ...over,
    });

    return { clock, now, config, env, store, customers, qbo, intuit, deps, generationId, accounts, items, terms, orgId, qboCustomer, seedE2 };
}

export type World = Awaited<ReturnType<typeof invoiceWorld>>;
