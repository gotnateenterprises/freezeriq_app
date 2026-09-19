/**
 * QB-INVOICE-1C — the tenant's QuickBooks invoice settings: which of the tenant's OWN QuickBooks items,
 * accounts and payment term FreezerIQ invoices use.
 *
 * OWNER-LOCKED RULES, enforced here and not in the UI:
 *   1. Only the tenant's own chart of accounts, items and terms. FreezerIQ never creates an account, and
 *      creates an item only after an explicit confirmation bound to the exact role, account and name shown.
 *   2. Choices are filtered by accounting purpose — and re-validated against QuickBooks on every save and
 *      before every send, because items and accounts are editable in QuickBooks at any time:
 *        sales item   Service/NonInventory item posting to an Income account of a SALES subtype;
 *        share item   Service/NonInventory item posting to Income › DiscountsRefundsGiven (contra-revenue).
 *                     That is the only organization-share treatment V1 supports: Intuit documents
 *                     DiscountsRefundsGiven for discounts, while an expense-mapped share item — accepted by
 *                     the sandbox but undocumented — is NOT offered as guaranteed functionality;
 *        tax item     Service/NonInventory item posting to an Other Current Liability account that is not a
 *                     QuickBooks system tax-agency payable (QuickBooks itself refuses those, Fault 6430);
 *        term         an active STANDARD term (QuickBooks derives DueDate = TxnDate + due days).
 *   3. Company settings that would break the send-safety or numbering rules block sending:
 *        a company-wide default CC or BCC (QuickBooks would copy it onto every invoice — an unreviewed
 *        recipient), custom transaction numbers (QuickBooks would leave DocNumber blank), a home currency
 *        other than USD, or a company outside the US (autosend rules are documented for US companies only).
 *   4. Online payment options may be chosen only when the company has online payments active, and are
 *      applied only after an invoice's financial read-back passed (lib/quickbooks/invoiceSend.ts).
 *   5. Settings are bound to the LIVE connection generation (a foreign key): Forget deletes them.
 *
 * The client never sees a raw QuickBooks id, the connection id, the realm or a token: every option carries
 * an opaque key derived from the live generation, which the server maps back by re-listing QuickBooks.
 */

import { createHash } from 'crypto';
import { prisma } from '@/lib/db';
import { QUICKBOOKS_PROVIDER, type QuickBooksConfig } from '@/lib/quickbooks/config';
import { QuickBooksConnectionError, type Deps } from '@/lib/quickbooks/connection';
import { withLiveConnection, type GenerationDb } from '@/lib/quickbooks/connectionGenerations';
import {
    createQuickBooksServiceItem,
    displayNameProblem,
    fetchCompanyInfo,
    IntuitError,
    listQuickBooksAccounts,
    listQuickBooksItems,
    listQuickBooksTerms,
    readQuickBooksAccount,
    readQuickBooksItem,
    readQuickBooksPreferences,
    readQuickBooksTerm,
    type QuickBooksAccountSummary,
    type QuickBooksItemSummary,
    type QuickBooksPaymentFlags,
    type QuickBooksSalesPreferences,
    type QuickBooksTermSummary,
} from '@/lib/quickbooks/intuitClient';
import type { InvoiceMapping } from '@/lib/quickbooks/invoicePayload';
import { normalizeCc } from '@/lib/quickbooks/invoiceRecipients';
import {
    ConnectionChangedError,
    connectionProblem,
    isConnectionProblem,
    liveConnection,
    withAccess,
    type ConnectionProblem,
    type LiveConnection,
    type LiveConnectionDeps,
} from '@/lib/quickbooks/liveConnection';

export type InvoiceSettingsDb = Pick<typeof prisma, 'integration' | '$transaction' | 'quickBooksConnection' | 'quickBooksInvoiceSettings'>;

export interface InvoiceSettingsDeps extends Omit<Deps, 'db'> {
    db?: InvoiceSettingsDb;
}

export type ItemRole = 'sales' | 'share' | 'tax';

// ── eligibility (pure) ──────────────────────────────────────────────────────

const SALES_SUBTYPES = ['SalesOfProductIncome', 'ServiceFeeIncome', 'OtherPrimaryIncome'];

export const isInvoiceItemType = (item: Pick<QuickBooksItemSummary, 'type' | 'active'>) =>
    item.active && (item.type === 'Service' || item.type === 'NonInventory');

export function isEligibleAccount(role: ItemRole, a: Pick<QuickBooksAccountSummary, 'accountType' | 'accountSubType' | 'active'>): boolean {
    if (!a.active) return false;
    if (role === 'sales') return a.accountType === 'Income' && SALES_SUBTYPES.indexOf(a.accountSubType ?? '') !== -1;
    if (role === 'share') return a.accountType === 'Income' && a.accountSubType === 'DiscountsRefundsGiven';
    return a.accountType === 'Other Current Liability' && a.accountSubType !== 'GlobalTaxPayable';
}

export const isEligibleTerm = (t: QuickBooksTermSummary) =>
    t.active && t.type === 'STANDARD' && t.dueDays !== null && Number.isInteger(t.dueDays) && t.dueDays >= 0 && t.dueDays <= 3650;

export type SettingsBlocker = 'not_us_company' | 'company_default_cc' | 'company_default_bcc' | 'custom_transaction_numbers' | 'currency_not_usd';
export type SettingsNotice = 'online_payments_not_enabled' | 'company_copy_emails' | 'keep_autosend_off';

export function preferenceFindings(prefs: QuickBooksSalesPreferences, country: string | null): { blockers: SettingsBlocker[]; notices: SettingsNotice[] } {
    const blockers: SettingsBlocker[] = [];
    const notices: SettingsNotice[] = ['keep_autosend_off'];
    if (country !== 'US') blockers.push('not_us_company');
    if (prefs.defaultCcPresent) blockers.push('company_default_cc');
    if (prefs.defaultBccPresent) blockers.push('company_default_bcc');
    if (prefs.customTxnNumbers) blockers.push('custom_transaction_numbers');
    if (prefs.multiCurrencyEnabled || (prefs.homeCurrency !== null && prefs.homeCurrency !== 'USD')) blockers.push('currency_not_usd');
    if (!prefs.onlinePaymentsEnabled) notices.push('online_payments_not_enabled');
    if (prefs.emailCopyToCompany) notices.push('company_copy_emails');
    return { blockers, notices };
}

// ── opaque keys ─────────────────────────────────────────────────────────────

const KEY = /^[a-f0-9]{32}$/;
const ATTEMPT_ID = /^[A-Za-z0-9-]{16,64}$/;
const digest = (label: string, parts: string[]) => createHash('sha256').update([label, ...parts].join('|')).digest('hex');
export const optionKey = (connectionId: string, kind: 'item' | 'account' | 'term', id: string) =>
    digest('freezeriq/quickbooks-invoice-option/v1', [connectionId, kind, id]).slice(0, 32);
const helperConfirmation = (connectionId: string, role: ItemRole, accountId: string, name: string) =>
    digest('freezeriq/quickbooks-helper-item/v1', [connectionId, role, accountId, name]).slice(0, 40);

export const DEFAULT_HELPER_ITEM_NAMES: Record<ItemRole, string> = {
    sales: 'FreezerIQ Fundraiser Sales',
    share: 'Organization Fundraiser Share',
    tax: 'Sales Tax Collected from Supporters',
};

// ── view ────────────────────────────────────────────────────────────────────

export interface ItemOption { key: string; name: string; accountName: string }
export interface AccountOption { key: string; name: string }
export interface TermOption { key: string; name: string; dueDays: number }

export type SettingsProblem =
    | 'sales_item_unavailable' | 'share_item_unavailable' | 'tax_item_unavailable'
    | 'sales_item_account_changed' | 'share_item_account_changed' | 'tax_item_account_changed'
    | 'term_unavailable' | 'term_changed' | 'payment_options_unavailable';

export type InvoiceSettingsView =
    | ConnectionProblem
    | {
        state: 'ready';
        companyName: string | null;
        blockers: SettingsBlocker[];
        notices: SettingsNotice[];
        onlinePaymentsEnabled: boolean;
        options: {
            items: Record<ItemRole, ItemOption[]>;
            accounts: Record<ItemRole, AccountOption[]>;
            terms: TermOption[];
        };
        saved: null | {
            salesItemKey: string; shareItemKey: string | null; taxItemKey: string | null; termKey: string;
            allowOnlineCard: boolean; allowOnlineAch: boolean;
            /** Optional address copied on every QuickBooks invoice email (prefilled in the review; editable there). */
            defaultCc: string | null;
            problems: SettingsProblem[];
        };
        /** True when invoices can be sent: saved, nothing changed underneath, and no blocker. */
        ready: boolean;
        helperItems: Record<ItemRole, { proposedName: string; accountConfirmations: Array<{ accountKey: string; confirmation: string }> }>;
    };

interface Resolved { db: InvoiceSettingsDb; fetchImpl: NonNullable<Deps['fetchImpl']>; env?: NodeJS.ProcessEnv; now: () => number; sleep?: Deps['sleep'] }
function resolve(deps: InvoiceSettingsDeps): Resolved {
    return { db: deps.db ?? (prisma as unknown as InvoiceSettingsDb), fetchImpl: deps.fetchImpl ?? fetch, env: deps.env, now: deps.now ?? Date.now, sleep: deps.sleep };
}
const liveDeps = (d: Resolved): LiveConnectionDeps => ({ db: d.db, fetchImpl: d.fetchImpl, env: d.env, now: d.now, sleep: d.sleep });

interface Catalog {
    live: LiveConnection;
    companyName: string | null;
    country: string | null;
    prefs: QuickBooksSalesPreferences;
    accounts: QuickBooksAccountSummary[];
    items: QuickBooksItemSummary[];
    terms: QuickBooksTermSummary[];
}

async function catalog(businessId: string, config: QuickBooksConfig, d: Resolved): Promise<Catalog | ConnectionProblem> {
    const live = await liveConnection(businessId, config, liveDeps(d));
    if (isConnectionProblem(live)) return live;
    const call = <T>(fn: (a: LiveConnection['access']) => Promise<T>) => withAccess(businessId, config, live, liveDeps(d), fn);
    const info = await call((a) => fetchCompanyInfo(config, a.accessToken, a.realmId, d.fetchImpl));
    const prefs = await call((a) => readQuickBooksPreferences(config, a.accessToken, a.realmId, d.fetchImpl));
    const accounts = await call((a) => listQuickBooksAccounts(config, a.accessToken, a.realmId, d.fetchImpl));
    const items = await call((a) => listQuickBooksItems(config, a.accessToken, a.realmId, d.fetchImpl));
    const terms = await call((a) => listQuickBooksTerms(config, a.accessToken, a.realmId, d.fetchImpl));
    return { live, companyName: info.companyName, country: info.country, prefs, accounts, items, terms };
}

function options(c: Catalog) {
    const byId = new Map(c.accounts.map((a) => [a.id, a]));
    const itemsFor = (role: ItemRole): ItemOption[] => c.items
        .filter((i) => isInvoiceItemType(i) && i.incomeAccountId && byId.has(i.incomeAccountId) && isEligibleAccount(role, byId.get(i.incomeAccountId)!))
        .map((i) => ({ key: optionKey(c.live.connectionId, 'item', i.id), name: i.name, accountName: byId.get(i.incomeAccountId!)!.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const accountsFor = (role: ItemRole): AccountOption[] => c.accounts
        .filter((a) => isEligibleAccount(role, a))
        .map((a) => ({ key: optionKey(c.live.connectionId, 'account', a.id), name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        items: { sales: itemsFor('sales'), share: itemsFor('share'), tax: itemsFor('tax') },
        accounts: { sales: accountsFor('sales'), share: accountsFor('share'), tax: accountsFor('tax') },
        terms: c.terms.filter(isEligibleTerm).map((t) => ({ key: optionKey(c.live.connectionId, 'term', t.id), name: t.name, dueDays: t.dueDays! }))
            .sort((a, b) => a.dueDays - b.dueDays || a.name.localeCompare(b.name)),
    };
}

type StoredSettings = NonNullable<Awaited<ReturnType<InvoiceSettingsDb['quickBooksInvoiceSettings']['findUnique']>>>;

function savedProblems(s: StoredSettings, c: Catalog): SettingsProblem[] {
    const problems: SettingsProblem[] = [];
    const accounts = new Map(c.accounts.map((a) => [a.id, a]));
    const checkItem = (role: ItemRole, itemId: string | null, accountId: string | null) => {
        if (!itemId) return;
        const item = c.items.find((i) => i.id === itemId);
        const account = item?.incomeAccountId ? accounts.get(item.incomeAccountId) : undefined;
        if (!item || !isInvoiceItemType(item) || !account) { problems.push(`${role}_item_unavailable` as SettingsProblem); return; }
        if (item.incomeAccountId !== accountId || !isEligibleAccount(role, account)) problems.push(`${role}_item_account_changed` as SettingsProblem);
    };
    checkItem('sales', s.sales_item_id, s.sales_account_id);
    checkItem('share', s.share_item_id, s.share_account_id);
    checkItem('tax', s.tax_item_id, s.tax_account_id);
    const term = c.terms.find((t) => t.id === s.term_id);
    if (!term || !isEligibleTerm(term)) problems.push('term_unavailable');
    else if (term.dueDays !== s.term_due_days) problems.push('term_changed');
    if ((s.allow_online_card || s.allow_online_ach) && !c.prefs.onlinePaymentsEnabled) problems.push('payment_options_unavailable');
    return problems;
}

async function readStored(businessId: string, connectionId: string, d: Resolved): Promise<StoredSettings | null> {
    const row = await d.db.quickBooksInvoiceSettings.findUnique({ where: { business_id: businessId } });
    return row && row.connection_id === connectionId ? row : null;
}

function unavailable(e: unknown): ConnectionProblem {
    if (e instanceof QuickBooksConnectionError) return connectionProblem(e);
    console.warn(`[quickbooks] invoice settings unavailable: ${e instanceof IntuitError ? e.kind : e instanceof ConnectionChangedError ? 'connection_changed' : 'unknown'}`);
    return { state: 'unavailable' };
}

const isKnownFailure = (e: unknown) => e instanceof IntuitError || e instanceof QuickBooksConnectionError || e instanceof ConnectionChangedError;

export async function getQuickBooksInvoiceSettingsView(
    input: { businessId: string; config: QuickBooksConfig }, deps: InvoiceSettingsDeps = {},
): Promise<InvoiceSettingsView> {
    const d = resolve(deps);
    let c: Catalog | ConnectionProblem;
    try {
        c = await catalog(input.businessId, input.config, d);
    } catch (e) {
        if (isKnownFailure(e)) return unavailable(e);
        throw e;
    }
    if ('state' in c) return c;
    const stored = await readStored(input.businessId, c.live.connectionId, d);
    const { blockers, notices } = preferenceFindings(c.prefs, c.country);
    const opts = options(c);
    const problems = stored ? savedProblems(stored, c) : [];
    const key = (kind: 'item' | 'account' | 'term', id: string | null) => (id ? optionKey(c.live.connectionId, kind, id) : null);
    const helper = (role: ItemRole) => ({
        proposedName: DEFAULT_HELPER_ITEM_NAMES[role],
        accountConfirmations: c.accounts.filter((a) => isEligibleAccount(role, a)).map((a) => ({
            accountKey: optionKey(c.live.connectionId, 'account', a.id),
            confirmation: helperConfirmation(c.live.connectionId, role, a.id, DEFAULT_HELPER_ITEM_NAMES[role]),
        })),
    });
    return {
        state: 'ready',
        companyName: c.companyName,
        blockers,
        notices,
        onlinePaymentsEnabled: c.prefs.onlinePaymentsEnabled,
        options: opts,
        saved: stored ? {
            salesItemKey: key('item', stored.sales_item_id)!,
            shareItemKey: key('item', stored.share_item_id),
            taxItemKey: key('item', stored.tax_item_id),
            termKey: key('term', stored.term_id)!,
            allowOnlineCard: stored.allow_online_card,
            allowOnlineAch: stored.allow_online_ach,
            defaultCc: stored.default_cc,
            problems,
        } : null,
        ready: !!stored && problems.length === 0 && blockers.length === 0,
        helperItems: { sales: helper('sales'), share: helper('share'), tax: helper('tax') },
    };
}

// ── save ────────────────────────────────────────────────────────────────────

export interface SettingsSelection {
    salesItemKey: string;
    shareItemKey: string | null;
    taxItemKey: string | null;
    termKey: string;
    allowOnlineCard: boolean;
    allowOnlineAch: boolean;
    defaultCc: string | null;
}

export type SaveSettingsResult =
    | { outcome: 'saved'; view: InvoiceSettingsView }
    | { outcome: 'invalid'; reason: 'unknown_option' | 'ineligible_item' | 'payment_options_unavailable' | 'default_cc' }
    | { outcome: 'unavailable'; view: ConnectionProblem }
    /** The connection changed while saving; nothing was written. */
    | { outcome: 'stale' };

export async function saveQuickBooksInvoiceSettings(
    input: { businessId: string; config: QuickBooksConfig; userId: string | null; selection: SettingsSelection },
    deps: InvoiceSettingsDeps = {},
): Promise<SaveSettingsResult> {
    const d = resolve(deps);
    const sel = input.selection;
    const keys = [sel.salesItemKey, sel.shareItemKey, sel.taxItemKey, sel.termKey].filter((k): k is string => k !== null);
    if (keys.some((k) => typeof k !== 'string' || !KEY.test(k)) || typeof sel.allowOnlineCard !== 'boolean' || typeof sel.allowOnlineAch !== 'boolean') {
        return { outcome: 'invalid', reason: 'unknown_option' };
    }
    const defaultCc = normalizeCc(sel.defaultCc);
    if (!defaultCc.ok) return { outcome: 'invalid', reason: 'default_cc' };
    let c: Catalog | ConnectionProblem;
    try {
        c = await catalog(input.businessId, input.config, d);
    } catch (e) {
        if (isKnownFailure(e)) return { outcome: 'unavailable', view: unavailable(e) };
        throw e;
    }
    if ('state' in c) return { outcome: 'unavailable', view: c };
    const cat = c;
    const accounts = new Map(cat.accounts.map((a) => [a.id, a]));
    const pickItem = (role: ItemRole, k: string | null): { item: QuickBooksItemSummary; accountId: string } | null | 'unknown' | 'ineligible' => {
        if (k === null) return null;
        const item = cat.items.find((i) => optionKey(cat.live.connectionId, 'item', i.id) === k);
        if (!item) return 'unknown';
        const account = item.incomeAccountId ? accounts.get(item.incomeAccountId) : undefined;
        if (!isInvoiceItemType(item) || !account || !isEligibleAccount(role, account)) return 'ineligible';
        return { item, accountId: account.id };
    };
    const sales = pickItem('sales', sel.salesItemKey);
    const share = pickItem('share', sel.shareItemKey);
    const tax = pickItem('tax', sel.taxItemKey);
    const term = cat.terms.find((t) => optionKey(cat.live.connectionId, 'term', t.id) === sel.termKey);
    if (sales === 'unknown' || share === 'unknown' || tax === 'unknown' || !term || sales === null) return { outcome: 'invalid', reason: 'unknown_option' };
    if (sales === 'ineligible' || share === 'ineligible' || tax === 'ineligible' || !isEligibleTerm(term)) return { outcome: 'invalid', reason: 'ineligible_item' };
    if ((sel.allowOnlineCard || sel.allowOnlineAch) && !cat.prefs.onlinePaymentsEnabled) return { outcome: 'invalid', reason: 'payment_options_unavailable' };

    const data = {
        connection_id: cat.live.connectionId,
        sales_item_id: sales.item.id, sales_account_id: sales.accountId,
        share_item_id: share ? share.item.id : null, share_account_id: share ? share.accountId : null,
        tax_item_id: tax ? tax.item.id : null, tax_account_id: tax ? tax.accountId : null,
        term_id: term.id, term_due_days: term.dueDays!,
        allow_online_card: sel.allowOnlineCard, allow_online_ach: sel.allowOnlineAch,
        default_cc: defaultCc.cc,
        updated_by: input.userId,
    };
    try {
        const written = await withLiveConnection({ businessId: input.businessId, realmId: cat.live.access.realmId }, { db: d.db as unknown as GenerationDb, env: d.env }, async (tx, live) => {
            if (live.generationId !== cat.live.connectionId) return false;
            await (tx as any).quickBooksInvoiceSettings.upsert({
                where: { business_id: input.businessId },
                create: { business_id: input.businessId, provider: QUICKBOOKS_PROVIDER, ...data },
                update: data,
            });
            return true;
        });
        if (!written.ok || !written.value) return { outcome: 'stale' };
    } catch (e: any) {
        if (e?.code === 'P2003') return { outcome: 'stale' };
        throw e;
    }
    return { outcome: 'saved', view: await getQuickBooksInvoiceSettingsView(input, deps) };
}

// ── helper item (explicit confirmation only) ────────────────────────────────

export type CreateHelperItemResult =
    | { outcome: 'created'; itemKey: string; view: InvoiceSettingsView }
    | { outcome: 'stale' }
    | { outcome: 'rejected'; reason: 'name_in_use' | 'invalid' }
    /** QuickBooks' answer was lost — the item may exist. Nothing was selected. */
    | { outcome: 'unknown' }
    | { outcome: 'unavailable'; view: ConnectionProblem };

export async function createQuickBooksHelperItem(
    input: { businessId: string; config: QuickBooksConfig; role: ItemRole; accountKey: string; name: string; confirmation: string; attemptId: string },
    deps: InvoiceSettingsDeps = {},
): Promise<CreateHelperItemResult> {
    const d = resolve(deps);
    if (['sales', 'share', 'tax'].indexOf(input.role) === -1 || !KEY.test(input.accountKey) || !/^[a-f0-9]{40}$/.test(input.confirmation)
        || !ATTEMPT_ID.test(input.attemptId) || input.name !== DEFAULT_HELPER_ITEM_NAMES[input.role] || displayNameProblem(input.name)) {
        return { outcome: 'stale' };
    }
    let c: Catalog | ConnectionProblem;
    try {
        c = await catalog(input.businessId, input.config, d);
    } catch (e) {
        if (isKnownFailure(e)) return { outcome: 'unavailable', view: unavailable(e) };
        throw e;
    }
    if ('state' in c) return { outcome: 'unavailable', view: c };
    const cat = c;
    const account = cat.accounts.find((a) => optionKey(cat.live.connectionId, 'account', a.id) === input.accountKey);
    if (!account || !isEligibleAccount(input.role, account)) return { outcome: 'stale' };
    if (helperConfirmation(cat.live.connectionId, input.role, account.id, input.name) !== input.confirmation) return { outcome: 'stale' };

    const requestId = digest('freezeriq/quickbooks-helper-item-request/v1', [input.confirmation, input.attemptId]).slice(0, 40);
    let item: QuickBooksItemSummary;
    try {
        item = await withAccess(input.businessId, input.config, cat.live, liveDeps(d),
            (a) => createQuickBooksServiceItem(input.config, a.accessToken, a.realmId, { name: input.name, incomeAccountId: account.id }, requestId, d.fetchImpl));
    } catch (e) {
        if (e instanceof IntuitError && e.kind === 'duplicate_name') return { outcome: 'rejected', reason: 'name_in_use' };
        if (e instanceof IntuitError && e.kind === 'rejected') return { outcome: 'rejected', reason: 'invalid' };
        if (e instanceof QuickBooksConnectionError) return { outcome: 'unavailable', view: connectionProblem(e) };
        if (e instanceof ConnectionChangedError) return { outcome: 'stale' };
        console.warn(`[quickbooks] helper item create outcome unknown: ${e instanceof IntuitError ? e.kind : 'unknown'}`);
        return { outcome: 'unknown' };
    }
    if (item.name !== input.name || item.incomeAccountId !== account.id || !isInvoiceItemType(item)) {
        console.warn('[quickbooks] helper item create returned an unexpected item; not selected');
        return { outcome: 'unknown' };
    }
    return { outcome: 'created', itemKey: optionKey(cat.live.connectionId, 'item', item.id), view: await getQuickBooksInvoiceSettingsView(input, deps) };
}

// ── for the send lifecycle: a mapping re-verified against QuickBooks ────────

export type MappingCheck =
    | { ok: true; prefs: QuickBooksSalesPreferences; country: string | null }
    | { ok: false; problem: SettingsProblem | SettingsBlocker };

/**
 * Re-reads, from QuickBooks, everything a mapping relies on: the company (US), its sales-form preferences (no
 * company-wide CC/BCC, QuickBooks numbering, USD), each item (still active, still posting to the mapped account),
 * each account (still eligible for its role) and the term (still STANDARD with the same due days). Used for the
 * tenant's current settings before a first send, and for a lifecycle's STORED mapping before resuming or re-sending.
 */
export async function verifyInvoiceMappingLive(
    input: { businessId: string; config: QuickBooksConfig; live: LiveConnection; mapping: InvoiceMapping; payment: QuickBooksPaymentFlags },
    deps: InvoiceSettingsDeps = {},
): Promise<MappingCheck> {
    const d = resolve(deps);
    const { mapping, payment } = input;
    const call = <T>(fn: (a: LiveConnection['access']) => Promise<T>) => withAccess(input.businessId, input.config, input.live, liveDeps(d), fn);
    const cfg = input.config;

    const info = await call((a) => fetchCompanyInfo(cfg, a.accessToken, a.realmId, d.fetchImpl));
    const prefs = await call((a) => readQuickBooksPreferences(cfg, a.accessToken, a.realmId, d.fetchImpl));
    const { blockers } = preferenceFindings(prefs, info.country);
    if (blockers.length) return { ok: false, problem: blockers[0] };

    const checkItem = async (role: ItemRole, itemId: string | null, accountId: string | null): Promise<SettingsProblem | null> => {
        if (!itemId) return null;
        const item = await call((a) => readQuickBooksItem(cfg, a.accessToken, a.realmId, itemId, d.fetchImpl));
        if (!item || !isInvoiceItemType(item)) return `${role}_item_unavailable` as SettingsProblem;
        if (!accountId || item.incomeAccountId !== accountId) return `${role}_item_account_changed` as SettingsProblem;
        const account = await call((a) => readQuickBooksAccount(cfg, a.accessToken, a.realmId, accountId, d.fetchImpl));
        if (!account || !isEligibleAccount(role, account)) return `${role}_item_account_changed` as SettingsProblem;
        return null;
    };
    for (const [role, itemId, accountId] of [
        ['sales', mapping.salesItemId, mapping.salesAccountId],
        ['share', mapping.shareItemId, mapping.shareAccountId],
        ['tax', mapping.taxItemId, mapping.taxAccountId],
    ] as Array<[ItemRole, string | null, string | null]>) {
        const p = await checkItem(role, itemId, accountId);
        if (p) return { ok: false, problem: p };
    }
    const term = await call((a) => readQuickBooksTerm(cfg, a.accessToken, a.realmId, mapping.termId, d.fetchImpl));
    if (!term || !isEligibleTerm(term)) return { ok: false, problem: 'term_unavailable' };
    if (term.dueDays !== mapping.termDueDays) return { ok: false, problem: 'term_changed' };
    if ((payment.card || payment.ach) && !prefs.onlinePaymentsEnabled) return { ok: false, problem: 'payment_options_unavailable' };
    return { ok: true, prefs, country: info.country };
}

export type VerifiedSettings =
    | { ok: true; mapping: InvoiceMapping; payment: QuickBooksPaymentFlags; defaultCc: string | null; prefs: QuickBooksSalesPreferences; country: string | null }
    | { ok: false; problem: 'settings_missing' | SettingsProblem | SettingsBlocker };

/**
 * The tenant's saved settings for the live generation, each item and the term re-read from QuickBooks
 * and re-checked (still active, still posting to the saved account, account still eligible). Preferences
 * are re-read too, so a company-wide CC added in QuickBooks since setup blocks the send.
 */
export async function loadVerifiedInvoiceSettings(
    input: { businessId: string; config: QuickBooksConfig; live: LiveConnection }, deps: InvoiceSettingsDeps = {},
): Promise<VerifiedSettings> {
    const d = resolve(deps);
    const stored = await readStored(input.businessId, input.live.connectionId, d);
    if (!stored) return { ok: false, problem: 'settings_missing' };
    const mapping: InvoiceMapping = {
        salesItemId: stored.sales_item_id, salesAccountId: stored.sales_account_id,
        shareItemId: stored.share_item_id, shareAccountId: stored.share_account_id,
        taxItemId: stored.tax_item_id, taxAccountId: stored.tax_account_id,
        termId: stored.term_id, termDueDays: stored.term_due_days,
    };
    // PayPal and Affirm are never enabled by FreezerIQ in V1.
    const payment: QuickBooksPaymentFlags = { card: stored.allow_online_card, ach: stored.allow_online_ach, paypal: false, affirm: false };
    const checked = await verifyInvoiceMappingLive({ ...input, mapping, payment }, deps);
    if (!checked.ok) return checked;
    const cc = normalizeCc(stored.default_cc);
    return { ok: true, mapping, payment, defaultCc: cc.ok ? cc.cc : null, prefs: checked.prefs, country: checked.country };
}
