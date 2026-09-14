/**
 * QB-INVOICE-1B — wording and available actions for the organization's QuickBooks
 * customer card, derived only from the server's status. Pure and directly testable.
 *
 * The card offers at most two actions, each behind an explicit confirmation that
 * quotes the exact name: link to an EXACT existing QuickBooks customer, or create one
 * named exactly like the organization. There is deliberately no invoice, send or
 * payment action here.
 */

import type { CustomerLinkStatus, CustomerLookup } from '@/lib/quickbooks/customerLinks';

export type CustomerLinkStatusPayload = CustomerLinkStatus | { state: 'disabled' } | { state: 'error' };

export interface CustomerLinkCardView {
    /** False: render nothing (QuickBooks is not available in this deployment). */
    visible: boolean;
    tone: 'neutral' | 'ok' | 'warn' | 'bad';
    label: string;
    detail: string | null;
    link: { confirmation: string; prompt: string } | null;
    create: { confirmation: string; displayName: string; prompt: string } | null;
    showRecheck: boolean;
}

const quote = (s: string) => `“${s}”`;

const RESOLUTION_DETAIL: Record<Extract<CustomerLookup, { result: 'resolution_required' }>['reason'], (name: string | null) => string> = {
    inactive_match: (n) => `QuickBooks has an inactive (deleted or merged) customer named ${quote(n ?? '')}. Reactivate or rename it in QuickBooks, then check again. FreezerIQ will not create a duplicate.`,
    sub_customer_match: (n) => `${quote(n ?? '')} is a sub-customer or project in QuickBooks, so it can't be linked as this organization. Resolve it in QuickBooks, then check again.`,
    case_variant: (n) => `QuickBooks has ${quote(n ?? '')}, which differs from this organization's name only in letter case. Names must match exactly — rename one of them, then check again.`,
    multiple_matches: () => 'QuickBooks returned more than one customer with this exact name. Resolve the duplicates in QuickBooks, then check again.',
    linked_to_other_organization: (n) => `The QuickBooks customer ${quote(n ?? '')} is already linked to another FreezerIQ organization.`,
};

const NAME_PROBLEM: Record<string, string> = {
    empty: 'This organization has no name to use in QuickBooks.',
    too_long: 'This organization’s name is too long for FreezerIQ to use as a QuickBooks customer name. Shorten it in FreezerIQ first.',
    surrounding_whitespace: 'This organization’s name starts or ends with a space. Fix the name in FreezerIQ first.',
    forbidden_character: 'This organization’s name contains a character QuickBooks does not allow in a customer name (for example “:”). Change it in FreezerIQ first.',
};

function lookupView(organizationName: string, lookup: CustomerLookup | null): Pick<CustomerLinkCardView, 'detail' | 'link' | 'create'> {
    if (!lookup) return { detail: null, link: null, create: null };
    switch (lookup.result) {
        case 'exact_match':
            return {
                detail: `QuickBooks has a customer named exactly ${quote(lookup.qboDisplayName)}. Confirm to link it.`,
                link: {
                    confirmation: lookup.confirmation,
                    prompt: `Link ${quote(organizationName)} to the existing QuickBooks customer ${quote(lookup.qboDisplayName)}?\n\nFreezerIQ will not change anything in QuickBooks.`,
                },
                create: null,
            };
        case 'no_match':
            return {
                detail: 'No QuickBooks customer has exactly this name.',
                link: null,
                create: {
                    confirmation: lookup.confirmation,
                    displayName: lookup.proposedDisplayName,
                    prompt: `Create a new QuickBooks customer with this exact display name?\n\n${quote(lookup.proposedDisplayName)}\n\nOnly the name is sent to QuickBooks — no email, phone, address or contact details.`,
                },
            };
        case 'resolution_required':
            return { detail: RESOLUTION_DETAIL[lookup.reason](lookup.qboDisplayName), link: null, create: null };
    }
}

const HIDDEN: CustomerLinkCardView = { visible: false, tone: 'neutral', label: '', detail: null, link: null, create: null, showRecheck: false };
const base = (tone: CustomerLinkCardView['tone'], label: string, detail: string | null, showRecheck = true): CustomerLinkCardView =>
    ({ visible: true, tone, label, detail, link: null, create: null, showRecheck });

export function customerLinkCardView(status: CustomerLinkStatusPayload | null): CustomerLinkCardView {
    if (status === null) return base('neutral', 'Checking QuickBooks…', null, false);
    switch (status.state) {
        case 'disabled':
            return HIDDEN;
        case 'not_connected':
            return base('neutral', 'QuickBooks not connected', 'Connect QuickBooks in Settings to link this organization to a QuickBooks customer.', false);
        case 'reconnect_required':
            return base('bad', 'QuickBooks needs attention', 'Open Settings to reconnect QuickBooks.', false);
        case 'unavailable':
        case 'error':
            return base('warn', 'QuickBooks couldn’t be checked', 'Try again in a moment.');
        case 'name_unusable':
            return base('warn', 'Not linked', NAME_PROBLEM[status.problem] ?? NAME_PROBLEM.forbidden_character);
        case 'linked':
            return base('ok', `Linked to QuickBooks customer ${quote(status.qboDisplayName)}`,
                status.qboDisplayName === status.organizationName ? null : 'The QuickBooks name differs from this organization’s name. FreezerIQ never renames QuickBooks customers.');
        case 'relink_required': {
            // TERMINAL in V1 (owner rule): a stored link to an unusable customer is never answered
            // with a Create or a Link — whatever a lookup might say — only information and Check again.
            const why = status.reason === 'missing'
                ? 'The linked QuickBooks customer no longer exists.'
                : status.reason === 'inactive'
                    ? `The linked QuickBooks customer ${quote(status.qboDisplayName ?? '')} is inactive (deleted or merged).`
                    : status.reason === 'sub_customer'
                        ? 'The linked QuickBooks customer is a sub-customer or project.'
                        : 'The link was made for a different QuickBooks connection.';
            return base('bad', 'Relink required', `${why} Resolve it in QuickBooks (for example, reactivate the customer), then check again. FreezerIQ will not create or link a replacement.`);
        }
        case 'unlinked': {
            const next = lookupView(status.organizationName, status.lookup);
            const tone = status.lookup.result === 'resolution_required' ? 'warn' : 'neutral';
            return { ...base(tone, 'Not linked to a QuickBooks customer', next.detail), link: next.link, create: next.create };
        }
    }
}
