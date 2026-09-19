/**
 * QB-INVOICE-1C — who a QuickBooks invoice email goes to. Validated and normalized here, once, for the tenant's
 * optional default CC (settings), the review dialog, and every recipient update FreezerIQ sends to QuickBooks.
 *
 * V1 rules:
 *   - one primary recipient (QuickBooks BillEmail) — suggested from the campaign's assigned coordinator, falling
 *     back to the organization contact (lib/campaignCoordinatorContact.ts), and always reviewed by the tenant;
 *   - optional CCs (BillEmailCc): up to five addresses, comma-separated. The 1C accounting spike proved QuickBooks
 *     keeps "a@x, b@y" exactly as sent, so the read-back contract can compare it byte for byte;
 *   - never a BCC;
 *   - QuickBooks holds at most 100 characters in each field;
 *   - addresses are trimmed and lower-cased before they are stored or sent, duplicates dropped.
 */

import { QUICKBOOKS_RECIPIENT } from '@/lib/quickbooks/intuitClient';

export const QUICKBOOKS_EMAIL_FIELD_MAX = 100;
export const QUICKBOOKS_CC_MAX_ADDRESSES = 5;

/** A usable address, normalized — or null. */
export function normalizeRecipient(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const address = value.trim().toLowerCase();
    return address.length > 0 && address.length <= QUICKBOOKS_EMAIL_FIELD_MAX && QUICKBOOKS_RECIPIENT.test(address) ? address : null;
}

/** Optional CCs: absent or blank means none; otherwise every comma-separated part must be a usable address. */
export function normalizeCc(value: unknown): { ok: true; cc: string | null } | { ok: false } {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { ok: true, cc: null };
    if (typeof value !== 'string') return { ok: false };
    const parts = value.split(',').map((p) => normalizeRecipient(p));
    if (parts.length > QUICKBOOKS_CC_MAX_ADDRESSES || parts.some((p) => p === null)) return { ok: false };
    const cc = Array.from(new Set(parts as string[])).join(', ');
    return cc.length <= QUICKBOOKS_EMAIL_FIELD_MAX ? { ok: true, cc } : { ok: false };
}

export type RecipientProblem = 'recipient' | 'cc';

export function normalizeRecipients(to: unknown, cc: unknown): { ok: true; to: string; cc: string | null } | { ok: false; reason: RecipientProblem } {
    const primary = normalizeRecipient(to);
    if (!primary) return { ok: false, reason: 'recipient' };
    const copy = normalizeCc(cc);
    if (!copy.ok || (copy.cc !== null && copy.cc.split(', ').includes(primary))) return { ok: false, reason: 'cc' };
    return { ok: true, to: primary, cc: copy.cc };
}
