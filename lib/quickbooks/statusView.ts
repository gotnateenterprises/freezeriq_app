/**
 * QB-INVOICE-1A — what the Settings card shows for each connection state.
 *
 * Kept free of React so the wording and, more importantly, which controls appear
 * in which state are unit-testable. The card never receives a token, realm id,
 * client id or integration id, so it cannot display one.
 *
 * Wording follows Intuit's naming guidelines: "QuickBooks" is always written in
 * full (never QB/QBO), the connect control reads "Connect to QuickBooks" and is
 * shown only while not connected, and once connected it is replaced by
 * "Disconnect from QuickBooks". Intuit's official button graphics are required
 * before production (see docs/ai/QUICKBOOKS_INTEGRATION.md); this sandbox
 * foundation uses plain text buttons.
 */

export type QuickBooksStatusPayload =
    | { state: 'disabled'; reason?: string }
    | { state: 'not_connected'; environment?: string }
    | { state: 'connected'; environment?: string; companyName?: string | null; verifiedAt?: string; connectedAt?: string | null }
    | { state: 'refresh_required'; environment?: string }
    | { state: 'reconnect_required'; environment?: string; cause?: string; canForget?: boolean }
    | { state: 'disconnected'; environment?: string; cause?: string; disconnectedAt?: string | null; canForget?: boolean }
    | { state: 'error'; environment?: string; cause?: string };

export interface QuickBooksCardView {
    tone: 'neutral' | 'ok' | 'warn' | 'bad';
    label: string;
    detail: string | null;
    showConnect: boolean;
    connectLabel: string;
    showDisconnect: boolean;
    showForget: boolean;
    showRetry: boolean;
    sandbox: boolean;
}

function formatDay(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const BASE: QuickBooksCardView = {
    tone: 'neutral', label: '', detail: null,
    showConnect: false, connectLabel: 'Connect to QuickBooks',
    showDisconnect: false, showForget: false, showRetry: false, sandbox: false,
};

export function quickBooksCardView(status: QuickBooksStatusPayload | null): QuickBooksCardView {
    if (!status) return { ...BASE, label: 'Checking connection…' };
    const sandbox = 'environment' in status && status.environment === 'sandbox';

    switch (status.state) {
        case 'disabled':
            return { ...BASE, label: 'Not available here', detail: 'QuickBooks can’t be connected from this environment.' };
        case 'not_connected':
            return { ...BASE, sandbox, label: 'Not connected', showConnect: true };
        case 'connected':
            return {
                ...BASE, sandbox, tone: 'ok', label: 'Connected',
                detail: [status.companyName, status.connectedAt ? `since ${formatDay(status.connectedAt)}` : null].filter(Boolean).join(' · ') || null,
                showDisconnect: true,
            };
        case 'refresh_required':
            return {
                ...BASE, sandbox, tone: 'warn', label: 'Connected — couldn’t verify right now',
                detail: 'QuickBooks didn’t respond to a token refresh. Try again in a few minutes.',
                showRetry: true, showDisconnect: true,
            };
        case 'error':
            return {
                ...BASE, sandbox, tone: 'warn', label: 'Couldn’t reach QuickBooks',
                detail: 'The connection is stored but could not be verified just now.',
                showRetry: true, showDisconnect: true,
            };
        case 'reconnect_required':
            if (status.cause === 'unreadable') {
                // The stored connection cannot be read, so it cannot be reconnected —
                // sending the admin to Intuit would only create a grant FreezerIQ refuses.
                return {
                    ...BASE, sandbox, tone: 'bad', label: 'Reconnection required',
                    detail: 'The saved QuickBooks connection can’t be read. Forget it, then connect again.',
                    showForget: true,
                };
            }
            return {
                ...BASE, sandbox, tone: 'bad', label: 'Reconnection required',
                detail: status.cause === 'no_company_access'
                    ? 'QuickBooks no longer allows access to this company. Disconnect, then connect again.'
                    : status.cause === 'refresh_expired'
                        ? 'The QuickBooks authorization has expired. Connect again to restore it.'
                        : 'QuickBooks access has ended. Connect again to restore it.',
                showConnect: status.canForget === true || status.cause !== 'no_company_access',
                connectLabel: 'Reconnect to QuickBooks',
                showDisconnect: status.cause === 'no_company_access',
                showForget: status.canForget === true,
            };
        case 'disconnected':
            return {
                ...BASE, sandbox, tone: 'neutral', label: 'Disconnected',
                detail: 'Reconnect to the same QuickBooks company (unless another FreezerIQ account now uses it), or forget it to connect a different one.',
                showConnect: true, connectLabel: 'Reconnect to QuickBooks',
                showForget: true,
            };
        default:
            return { ...BASE, tone: 'warn', label: 'Unknown status', showRetry: true };
    }
}

/** Messages for the `?quickbooks=` outcome the callback redirects with. */
export const QUICKBOOKS_CALLBACK_MESSAGES: Record<string, { ok: boolean; text: string }> = {
    connected: { ok: true, text: 'QuickBooks connected.' },
    denied: { ok: false, text: 'QuickBooks connection was cancelled.' },
    invalid_state: { ok: false, text: 'That QuickBooks connection attempt expired or was not started here. Please try again.' },
    invalid_callback: { ok: false, text: 'QuickBooks returned an incomplete response. Please try again.' },
    session_required: { ok: false, text: 'Please sign in, then connect QuickBooks again.' },
    forbidden: { ok: false, text: 'Only a tenant administrator can connect QuickBooks.' },
    realm_mismatch: { ok: false, text: 'You chose a different QuickBooks company than the one this account uses. Nothing was changed. To switch companies, disconnect and forget the current one first. (QuickBooks may still list FreezerIQ under the company you just chose; you can disconnect it there.)' },
    realm_unverified: { ok: false, text: 'QuickBooks did not confirm access to that company. Nothing was changed. Please try again.' },
    verification_failed: { ok: false, text: 'QuickBooks could not be reached to confirm the company. Nothing was changed. Please try again.' },
    realm_in_use: { ok: false, text: 'That QuickBooks company is already connected to another FreezerIQ account. Nothing was changed.' },
    reconnect_blocked: { ok: false, text: 'The previous QuickBooks connection can’t be read. Forget it, then connect again.' },
    conflict: { ok: false, text: 'The connection changed while connecting. Please try again.' },
    token_exchange_failed: { ok: false, text: 'QuickBooks did not complete the connection. Please try again.' },
    error: { ok: false, text: 'Something went wrong connecting QuickBooks. Please try again.' },
};
