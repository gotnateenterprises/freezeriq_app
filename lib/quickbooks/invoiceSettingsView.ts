/**
 * QB-INVOICE-1C — wording and view logic for the QuickBooks invoice settings card. Pure (and client-safe: types
 * only from the server module), so every sentence a tenant reads can be tested.
 *
 * The card never offers anything the owner has not accepted as supported: the organization share maps only to a
 * contra-revenue (Income › Discounts/Refunds Given) item, supporter tax only to a liability item, and payment terms
 * only to standard "due in N days" terms. Nothing is created without an explicit confirmation naming what.
 */

import type { InvoiceSettingsView, ItemRole, SettingsBlocker, SettingsNotice, SettingsProblem } from '@/lib/quickbooks/invoiceSettings';

export type InvoiceSettingsPayload = InvoiceSettingsView | { state: 'disabled' } | { state: 'error' };

export const ROLE_LABELS: Record<ItemRole, { title: string; help: string; required: boolean }> = {
    sales: {
        title: 'Fundraiser sales item',
        help: 'One item for every bundle line (each line still shows the bundle name and size). It must post to an Income account for sales.',
        required: true,
    },
    share: {
        title: 'Organization share item',
        help: 'The negative line for the organization’s fundraiser share. It must post to an Income account of type Discounts/Refunds Given. Required for invoices with a share.',
        required: false,
    },
    tax: {
        title: 'Supporter sales tax item',
        help: 'The line carrying the exact sales tax collected from supporters. It must post to an Other Current Liability account (not QuickBooks’ own sales tax payable). Required for invoices with tax.',
        required: false,
    },
};

export const SETTINGS_BLOCKER_TEXT: Record<SettingsBlocker, string> = {
    not_us_company: 'This QuickBooks company is not a US company. Sending invoices through QuickBooks is only supported for US companies.',
    company_default_cc: 'QuickBooks has a company-wide CC address for sales forms. It would be copied onto every invoice without review. Remove it in QuickBooks (Account and settings → Sales → Messages), then check again.',
    company_default_bcc: 'QuickBooks has a company-wide BCC address for sales forms. It would receive every invoice without review. Remove it in QuickBooks (Account and settings → Sales → Messages), then check again.',
    custom_transaction_numbers: 'QuickBooks is set to custom transaction numbers, so it would not number FreezerIQ’s invoices. Turn custom transaction numbers off in QuickBooks, then check again.',
    currency_not_usd: 'This QuickBooks company does not use US dollars only (multicurrency or another home currency). Sending invoices through QuickBooks requires USD.',
};

export const SETTINGS_NOTICE_TEXT: Record<SettingsNotice, string> = {
    keep_autosend_off: 'FreezerIQ creates every QuickBooks invoice unsent, checks every amount, and only then asks QuickBooks to email it.',
    online_payments_not_enabled: 'Online card and bank payments are not active in this QuickBooks company, so invoices are sent without online payment options.',
    company_copy_emails: 'QuickBooks is set to email your company a copy of every invoice it sends.',
};

export const SETTINGS_PROBLEM_TEXT: Record<SettingsProblem, string> = {
    sales_item_unavailable: 'The fundraiser sales item is no longer active in QuickBooks. Choose another.',
    share_item_unavailable: 'The organization share item is no longer active in QuickBooks. Choose another.',
    tax_item_unavailable: 'The supporter sales tax item is no longer active in QuickBooks. Choose another.',
    sales_item_account_changed: 'The fundraiser sales item now posts to a different or unsuitable account in QuickBooks. Review it, then save again.',
    share_item_account_changed: 'The organization share item now posts to a different or unsuitable account in QuickBooks. Review it, then save again.',
    tax_item_account_changed: 'The supporter sales tax item now posts to a different or unsuitable account in QuickBooks. Review it, then save again.',
    term_unavailable: 'The payment terms are no longer available in QuickBooks. Choose other terms.',
    term_changed: 'The payment terms were changed in QuickBooks. Review them, then save again.',
    payment_options_unavailable: 'Online payments are no longer active in QuickBooks. Turn the online payment options off, then save again.',
};

export const SAVE_OUTCOME_TEXT: Record<string, string> = {
    unknown_option: 'Those choices are no longer available in QuickBooks. Review the current options and save again.',
    ineligible_item: 'One of the chosen items does not post to a suitable account. Review the current options and save again.',
    payment_options_unavailable: 'Online payments are not active in this QuickBooks company.',
    default_cc: 'Enter valid CC addresses separated by commas (up to five, 100 characters in all), or leave it empty.',
    stale: 'The QuickBooks connection changed while saving. Nothing was saved — check again.',
    unavailable: 'QuickBooks could not be reached. Nothing was saved — try again in a moment.',
};

export const HELPER_OUTCOME_TEXT: Record<string, string> = {
    stale: 'QuickBooks changed since you looked. Nothing was created — review and try again.',
    name_in_use: 'QuickBooks already has something with that name. Choose that item instead, or rename it in QuickBooks.',
    invalid: 'QuickBooks refused to create the item. Nothing was created.',
    unknown: 'QuickBooks did not confirm the result. The item may have been created — check again before retrying.',
    unavailable: 'QuickBooks could not be reached. Nothing was created — try again in a moment.',
};

/** The exact confirmation the tenant accepts before FreezerIQ creates ONE item in their QuickBooks company. */
export function helperItemPrompt(role: ItemRole, name: string, accountName: string): string {
    return `Create a non-taxable Service item named “${name}” in your QuickBooks company, posting to “${accountName}”, `
        + `and use it as the ${ROLE_LABELS[role].title.toLowerCase()}? FreezerIQ creates nothing else and changes no account.`;
}

export interface SettingsCardSummary {
    visible: boolean;
    tone: 'neutral' | 'ok' | 'warn' | 'bad';
    label: string;
    detail: string | null;
    showRecheck: boolean;
}

export function settingsCardSummary(payload: InvoiceSettingsPayload | null): SettingsCardSummary {
    if (payload === null) return { visible: true, tone: 'neutral', label: 'Checking QuickBooks invoice settings…', detail: null, showRecheck: false };
    switch (payload.state) {
        case 'disabled': return { visible: false, tone: 'neutral', label: '', detail: null, showRecheck: false };
        case 'not_connected': return { visible: true, tone: 'neutral', label: 'Connect QuickBooks to set up invoices', detail: null, showRecheck: false };
        case 'reconnect_required': return { visible: true, tone: 'warn', label: 'Reconnect QuickBooks to set up invoices', detail: null, showRecheck: true };
        case 'unavailable': return { visible: true, tone: 'warn', label: 'QuickBooks could not be reached', detail: 'Try again in a moment.', showRecheck: true };
        case 'error': return { visible: true, tone: 'bad', label: 'Could not load the QuickBooks invoice settings', detail: null, showRecheck: true };
        case 'ready': {
            if (payload.blockers.length) return { visible: true, tone: 'bad', label: 'QuickBooks settings block sending invoices', detail: null, showRecheck: true };
            if (!payload.saved) return { visible: true, tone: 'warn', label: 'Not set up yet', detail: 'Choose the QuickBooks items and terms FreezerIQ invoices use.', showRecheck: true };
            if (payload.saved.problems.length) return { visible: true, tone: 'warn', label: 'Needs attention', detail: null, showRecheck: true };
            return { visible: true, tone: 'ok', label: 'Ready to send invoices through QuickBooks', detail: null, showRecheck: true };
        }
        default: return { visible: true, tone: 'bad', label: 'Could not load the QuickBooks invoice settings', detail: null, showRecheck: true };
    }
}
