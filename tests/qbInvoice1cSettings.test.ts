/**
 * QB-INVOICE-1C — the tenant's QuickBooks invoice settings (lib/quickbooks/invoiceSettings.ts).
 *
 * Owner rules proven here: only the tenant's OWN items, accounts and terms; filtered by accounting purpose (the
 * organization share only to Income › Discounts/Refunds Given — an expense mapping is not offered as supported —
 * supporter tax only to a non-system Other Current Liability, sales only to sales income, terms only STANDARD);
 * company settings that break send safety block; online payment options only when the company has them; nothing
 * created without an explicit confirmation naming exactly what; opaque keys instead of QuickBooks ids; settings
 * bound to the live connection (Forget removes them).
 */

import {
    createQuickBooksHelperItem,
    DEFAULT_HELPER_ITEM_NAMES,
    getQuickBooksInvoiceSettingsView,
    isEligibleAccount,
    isEligibleTerm,
    loadVerifiedInvoiceSettings,
    optionKey,
    preferenceFindings,
    saveQuickBooksInvoiceSettings,
} from '@/lib/quickbooks/invoiceSettings';
import { liveConnection } from '@/lib/quickbooks/liveConnection';
import { disconnectQuickBooks, forgetQuickBooksConnection } from '@/lib/quickbooks/connection';
import { ADMIN_USER, BIZ, invoiceWorld, type World } from './helpers/quickbooksInvoiceWorld';

const worlds: World[] = [];
afterEach(() => { for (const w of worlds.splice(0)) expect(w.store.violations).toEqual([]); });
const world = async (o: Parameters<typeof invoiceWorld>[0] = {}) => { const w = await invoiceWorld(o); worlds.push(w); return w; };
const view = async (w: World) => (await getQuickBooksInvoiceSettingsView({ businessId: BIZ, config: w.config }, w.deps)) as any;
const key = (w: World, kind: 'item' | 'account' | 'term', id: string) => optionKey(w.generationId, kind, id);

describe('QB-INVOICE-1C · eligibility rules (pure)', () => {
    it('sales → sales income; share → Discounts/Refunds Given only; tax → Other Current Liability except the system tax payable', () => {
        const a = (accountType: string, accountSubType: string | null, active = true) => ({ accountType, accountSubType, active });
        expect(isEligibleAccount('sales', a('Income', 'SalesOfProductIncome'))).toBe(true);
        expect(isEligibleAccount('sales', a('Income', 'ServiceFeeIncome'))).toBe(true);
        expect(isEligibleAccount('sales', a('Income', 'DiscountsRefundsGiven'))).toBe(false);
        expect(isEligibleAccount('sales', a('Other Current Liability', null))).toBe(false);
        expect(isEligibleAccount('share', a('Income', 'DiscountsRefundsGiven'))).toBe(true);
        expect(isEligibleAccount('share', a('Expense', 'OtherMiscellaneousServiceCost'))).toBe(false); // accepted by the sandbox, not offered
        expect(isEligibleAccount('share', a('Income', 'SalesOfProductIncome'))).toBe(false);
        expect(isEligibleAccount('tax', a('Other Current Liability', 'OtherCurrentLiabilities'))).toBe(true);
        expect(isEligibleAccount('tax', a('Other Current Liability', 'GlobalTaxPayable'))).toBe(false);
        expect(isEligibleAccount('tax', a('Other Current Liability', 'OtherCurrentLiabilities', false))).toBe(false);
        expect(isEligibleTerm({ id: '1', name: 'Net 15', type: 'STANDARD', dueDays: 15, active: true })).toBe(true);
        expect(isEligibleTerm({ id: '1', name: '15th', type: 'DATE_DRIVEN', dueDays: null, active: true })).toBe(false);
    });

    it('company settings that break send safety block; others are notices', () => {
        const prefs = { defaultCcPresent: false, defaultBccPresent: false, emailCopyToCompany: false, onlinePaymentsEnabled: true, customTxnNumbers: false, homeCurrency: 'USD', multiCurrencyEnabled: false };
        expect(preferenceFindings(prefs, 'US')).toEqual({ blockers: [], notices: ['keep_autosend_off'] });
        expect(preferenceFindings({ ...prefs, defaultCcPresent: true, defaultBccPresent: true, customTxnNumbers: true, multiCurrencyEnabled: true, onlinePaymentsEnabled: false, emailCopyToCompany: true }, 'CA')).toEqual({
            blockers: ['not_us_company', 'company_default_cc', 'company_default_bcc', 'custom_transaction_numbers', 'currency_not_usd'],
            notices: ['keep_autosend_off', 'online_payments_not_enabled', 'company_copy_emails'],
        });
    });
});

describe('QB-INVOICE-1C · the settings view', () => {
    it('offers only eligible items per role and STANDARD terms, under opaque keys — no QuickBooks id anywhere', async () => {
        const w = await world({ noSettings: true });
        const v = await view(w);
        expect(v).toMatchObject({ state: 'ready', blockers: [], saved: null, ready: false, onlinePaymentsEnabled: true });
        expect(v.options.items.sales.map((i: any) => i.name)).toEqual(['FreezerIQ Fundraiser Sales']); // not the inventory item
        expect(v.options.items.share.map((i: any) => i.name)).toEqual(['Organization Fundraiser Share']); // not the commission (expense) item
        expect(v.options.items.tax.map((i: any) => i.name)).toEqual(['Sales Tax Collected from Supporters']);
        expect(v.options.accounts.tax.map((a: any) => a.name)).toEqual(['Supporter Sales Tax Collected']); // not the system payable
        expect(v.options.terms).toEqual([{ key: key(w, 'term', w.terms.onReceipt.Id), name: 'Due on receipt', dueDays: 0 }, { key: key(w, 'term', w.terms.net15.Id), name: 'Net 15', dueDays: 15 }]);
        const text = JSON.stringify(v);
        for (const obj of [...Object.values(w.items), ...Object.values(w.accounts), ...Object.values(w.terms)]) expect(text).not.toContain(`"${obj.Id}"`);
        expect(text).not.toContain(w.generationId);
        expect(text).not.toMatch(/9130000000000001|ACCESSTOKEN/);
    });
});

describe('QB-INVOICE-1C · saving settings', () => {
    it('saves the chosen items with the accounts they post to, and the term with its days; the view then reads ready', async () => {
        const w = await world({ noSettings: true });
        const v = await view(w);
        const result: any = await saveQuickBooksInvoiceSettings({
            businessId: BIZ, config: w.config, userId: ADMIN_USER,
            selection: { salesItemKey: v.options.items.sales[0].key, shareItemKey: v.options.items.share[0].key, taxItemKey: v.options.items.tax[0].key, termKey: key(w, 'term', w.terms.net15.Id), allowOnlineCard: true, allowOnlineAch: false, defaultCc: ' Books@Freezer-Chef.example ' },
        }, w.deps);
        expect(result).toMatchObject({ outcome: 'saved', view: { ready: true, saved: { allowOnlineCard: true, allowOnlineAch: false, defaultCc: 'books@freezer-chef.example', problems: [] } } });
        expect(w.store.settings.get(BIZ)).toMatchObject({
            connection_id: w.generationId, sales_item_id: w.items.sales.Id, sales_account_id: w.accounts.sales.Id, share_item_id: w.items.share.Id, share_account_id: w.accounts.contra.Id,
            tax_item_id: w.items.tax.Id, tax_account_id: w.accounts.liability.Id, term_id: w.terms.net15.Id, term_due_days: 15, default_cc: 'books@freezer-chef.example', updated_by: ADMIN_USER,
        });
        expect(w.qbo.writes()).toEqual([]); // saving never writes QuickBooks
    });

    it('refuses unknown or forged keys, an ineligible item, a DATE_DRIVEN term, unavailable online payments and a bad CC — writing nothing', async () => {
        const w = await world({ noSettings: true });
        const v = await view(w);
        const base = { salesItemKey: v.options.items.sales[0].key, shareItemKey: null, taxItemKey: null, termKey: key(w, 'term', w.terms.net15.Id), allowOnlineCard: false, allowOnlineAch: false, defaultCc: null };
        const save = (over: Record<string, unknown>) => saveQuickBooksInvoiceSettings({ businessId: BIZ, config: w.config, userId: ADMIN_USER, selection: { ...base, ...over } as any }, w.deps);
        expect(await save({ salesItemKey: w.items.sales.Id })).toEqual({ outcome: 'invalid', reason: 'unknown_option' }); // a raw id is not a key
        expect(await save({ salesItemKey: 'f'.repeat(32) })).toEqual({ outcome: 'invalid', reason: 'unknown_option' });
        expect(await save({ salesItemKey: key(w, 'item', w.items.inventory.Id) })).toEqual({ outcome: 'invalid', reason: 'ineligible_item' });
        expect(await save({ shareItemKey: key(w, 'item', w.items.commission.Id) })).toEqual({ outcome: 'invalid', reason: 'ineligible_item' });
        expect(await save({ taxItemKey: key(w, 'item', w.items.sales.Id) })).toEqual({ outcome: 'invalid', reason: 'ineligible_item' });
        expect(await save({ termKey: key(w, 'term', w.terms.dateDriven.Id) })).toEqual({ outcome: 'invalid', reason: 'ineligible_item' });
        expect(await save({ defaultCc: 'a@example.invalid; b@example.invalid' })).toEqual({ outcome: 'invalid', reason: 'default_cc' });
        expect(await save({ defaultCc: `${'a'.repeat(60)}@example.invalid, ${'b'.repeat(40)}@example.invalid` })).toEqual({ outcome: 'invalid', reason: 'default_cc' });
        w.qbo.prefs.onlinePayments = false;
        expect(await save({ allowOnlineAch: true })).toEqual({ outcome: 'invalid', reason: 'payment_options_unavailable' });
        expect(w.store.settings.size).toBe(0);
    });

    it('a key from another connection generation is unknown here', async () => {
        const w = await world({ noSettings: true });
        const foreign = optionKey('another-generation', 'item', w.items.sales.Id);
        expect(await saveQuickBooksInvoiceSettings({ businessId: BIZ, config: w.config, userId: ADMIN_USER, selection: { salesItemKey: foreign, shareItemKey: null, taxItemKey: null, termKey: key(w, 'term', w.terms.net15.Id), allowOnlineCard: false, allowOnlineAch: false, defaultCc: null } }, w.deps))
            .toEqual({ outcome: 'invalid', reason: 'unknown_option' });
    });
});

describe('QB-INVOICE-1C · creating a helper item needs an explicit confirmation', () => {
    it('creates ONE non-taxable Service item on the confirmed account; a repeat with the same attempt creates nothing more', async () => {
        const w = await world({ noSettings: true });
        const v = await view(w);
        const accountKey = key(w, 'account', w.accounts.contra.Id);
        const confirmation = v.helperItems.share.accountConfirmations.find((c: any) => c.accountKey === accountKey).confirmation;
        const args = { businessId: BIZ, config: w.config, role: 'share' as const, accountKey, name: DEFAULT_HELPER_ITEM_NAMES.share, confirmation, attemptId: '0f8e1a52-2b6c-4d3e-9f10-3a4b5c6d7e8f' };
        // The name is taken by the seeded share item, so rename it in "QuickBooks" first.
        (w.qbo.item(w.items.share.Id) as any).Name = 'Old share item';
        const created: any = await createQuickBooksHelperItem(args, w.deps);
        expect(created).toMatchObject({ outcome: 'created', itemKey: expect.stringMatching(/^[a-f0-9]{32}$/) });
        const creates = w.qbo.calls.filter((c) => c.op === 'item_create');
        expect(creates.map((c) => c.body)).toEqual([{ Name: 'Organization Fundraiser Share', Type: 'Service', Taxable: false, IncomeAccountRef: { value: w.accounts.contra.Id } }]);
        await createQuickBooksHelperItem(args, w.deps); // same attempt: Intuit replays, nothing new
        expect(w.qbo.calls.filter((c) => c.op === 'item_create')).toHaveLength(2);
        expect(new Set(w.qbo.calls.filter((c) => c.op === 'item_create').map((c) => c.requestId)).size).toBe(1);
        expect(w.qbo.calls.filter((c) => c.method === 'POST' && !['item_create'].includes(c.op))).toEqual([]); // never an account
    });

    it('a wrong confirmation, name, role or account (an ineligible expense account for the share) creates nothing', async () => {
        const w = await world({ noSettings: true });
        const v = await view(w);
        const accountKey = key(w, 'account', w.accounts.contra.Id);
        const confirmation = v.helperItems.share.accountConfirmations.find((c: any) => c.accountKey === accountKey).confirmation;
        const base = { businessId: BIZ, config: w.config, role: 'share' as const, accountKey, name: DEFAULT_HELPER_ITEM_NAMES.share, confirmation, attemptId: '0f8e1a52-2b6c-4d3e-9f10-3a4b5c6d7e8f' };
        for (const over of [
            { confirmation: 'a'.repeat(40) },
            { name: 'Something else' },
            { role: 'tax' as const },
            { accountKey: key(w, 'account', w.accounts.expense.Id) },
            { attemptId: 'short' },
        ]) {
            expect(await createQuickBooksHelperItem({ ...base, ...over } as any, w.deps)).toEqual({ outcome: 'stale' });
        }
        expect(w.qbo.calls.filter((c) => c.op === 'item_create')).toEqual([]);
    });
});

describe('QB-INVOICE-1C · settings stay true to QuickBooks and to the connection', () => {
    it('before a send, items, accounts and the term are re-read: an item re-pointed or deactivated in QuickBooks is a problem', async () => {
        const w = await world();
        const live: any = await liveConnection(BIZ, w.config, { db: w.store.db, fetchImpl: w.intuit.fetchImpl, env: w.env, now: w.now });
        expect(await loadVerifiedInvoiceSettings({ businessId: BIZ, config: w.config, live }, w.deps)).toMatchObject({ ok: true, payment: { card: false, ach: false, paypal: false, affirm: false } });
        w.qbo.item(w.items.tax.Id)!.IncomeAccountRef = { value: w.accounts.agency.Id };
        expect(await loadVerifiedInvoiceSettings({ businessId: BIZ, config: w.config, live }, w.deps)).toEqual({ ok: false, problem: 'tax_item_account_changed' });
        w.qbo.item(w.items.tax.Id)!.IncomeAccountRef = { value: w.accounts.liability.Id };
        w.qbo.account(w.accounts.contra.Id)!.Active = false;
        expect(await loadVerifiedInvoiceSettings({ businessId: BIZ, config: w.config, live }, w.deps)).toEqual({ ok: false, problem: 'share_item_account_changed' });
        const v = await view(w);
        expect(v.saved.problems).toEqual(['share_item_unavailable']);
        expect(v.ready).toBe(false);
    });

    it('Forget removes the settings with the connection; a new connection starts unconfigured', async () => {
        const w = await world();
        expect(w.store.settings.has(BIZ)).toBe(true);
        await disconnectQuickBooks({ businessId: BIZ, config: w.config }, w.deps as any);
        expect(await forgetQuickBooksConnection({ businessId: BIZ }, w.deps as any)).toBe('forgotten');
        expect(await view(w)).toEqual({ state: 'not_connected' });
        // ON DELETE CASCADE from the integrations row (applied by the fake on the next read of the table).
        expect(await w.store.db.quickBooksInvoiceSettings.findUnique({ where: { business_id: BIZ } })).toBeNull();
        expect(w.store.settings.has(BIZ)).toBe(false);
    });
});
