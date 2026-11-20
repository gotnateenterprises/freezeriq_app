/**
 * SUPPORTER-CONSENT-1 — what a supporter is asked, and how their answer is checked. Pure and
 * client-safe: the order page renders these exact sentences and the order route stores the exact
 * same sentences, so the disclosure on record is always the one that was on screen.
 *
 * The SERVER decides the wording and the version. The client sends only two booleans
 * ({ email: true|false, sms: true|false }); any other value is "not checked", and anything the
 * client says about wording or versions is ignored.
 *
 * Permission belongs to ONE organization (the fundraiser's), ONE channel and ONE destination: the
 * exact email address or mobile number typed on this order. It is never inferred from placing an
 * order, from an email or phone being present, or from past purchases — and an unchecked box on a
 * later order is not a withdrawal.
 */

import { normalizeSupporterEmail } from '@/lib/previousSupporters';

export const SUPPORTER_CONSENT_SOURCE_CHECKOUT = 'supporter_order_checkout';
export const SUPPORTER_EMAIL_CONSENT_VERSION = 'supporter-future-email-v1';
export const SUPPORTER_SMS_CONSENT_VERSION = 'supporter-future-sms-v1';

/** Under the two checkboxes. Owner-approved; makes no privacy promise the policy does not state. */
export const SUPPORTER_CONSENT_OPTIONAL_NOTE = 'These choices are optional and are not needed to place your order. You can opt out at any time.';

const organizationLabel = (name: unknown): string =>
    typeof name === 'string' && name.trim() ? name.replace(/\s+/g, ' ').trim() : 'this organization';

/** supporter-future-email-v1 — changing a word means a new version constant. */
export function supporterEmailConsentText(organizationName: unknown): string {
    return `Yes, I’d like to receive occasional email updates about future fundraisers from ${organizationLabel(organizationName)}. I can unsubscribe at any time.`;
}

/**
 * supporter-future-sms-v1 — changing a word means a new version constant.
 *
 * "Reply STOP to opt out" describes the mechanism FreezerIQ must honour BEFORE any marketing text
 * is ever sent. Today there is no SMS marketing sender and no inbound STOP processing, so consent is
 * only recorded; SMS marketing must stay off until replies of STOP are processed and recorded as
 * revocations (supporter_contact_consents action = revoked).
 */
export function supporterSmsConsentText(organizationName: unknown): string {
    return `Yes, I agree to receive occasional text messages about future fundraisers from ${organizationLabel(organizationName)} at the mobile number I provided. Consent is not required to make a purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.`;
}

/** The email destination as recorded: the same normalization Previous Supporters keys on. */
export function normalizeConsentEmail(raw: unknown): string | null {
    return typeof raw === 'string' ? normalizeSupporterEmail(raw) : null;
}

/**
 * A usable US mobile destination in E.164 (+1XXXXXXXXXX), or null. Accepts the usual ways people
 * type a number — (309) 555-1111, 309.555.1111, +1 309 555 1111 — and refuses letters, extensions,
 * non-US numbers and impossible North American numbers (area code or exchange starting 0 or 1).
 */
export function normalizeConsentPhone(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    if (!v || v.length > 32) return null;
    if (!/^\+?[0-9().\-\s]+$/.test(v)) return null;
    let digits = v.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length !== 10) return null;
    if (!/^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(digits)) return null;
    return `+1${digits}`;
}

export interface SupporterConsentIntent {
    email: boolean;
    sms: boolean;
}

/** Only a literal `true` is a checked box. */
export function readSupporterConsentIntent(raw: unknown): SupporterConsentIntent {
    const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return { email: o.email === true, sms: o.sms === true };
}

export type SupporterConsentPlan =
    | { ok: true; email: string | null; sms: string | null }
    | { ok: false; code: 'EMAIL_CONSENT_NEEDS_EMAIL' | 'SMS_CONSENT_NEEDS_PHONE'; error: string };

export const SMS_CONSENT_NEEDS_PHONE_MESSAGE = 'To get text messages, enter a valid 10-digit US mobile number, or uncheck the text message box.';
export const EMAIL_CONSENT_NEEDS_EMAIL_MESSAGE = 'To get email updates, enter a valid email address, or uncheck the email updates box.';

/**
 * Which destinations this order would record permission for. A checked box needs a usable
 * destination — otherwise the order is refused with a clear message rather than quietly recording
 * nothing. With neither box checked, nothing about the contact fields changes.
 */
export function planSupporterConsent(intent: SupporterConsentIntent, contact: { email: unknown; phone: unknown }): SupporterConsentPlan {
    let email: string | null = null;
    let sms: string | null = null;
    if (intent.email) {
        email = normalizeConsentEmail(contact.email);
        if (!email) return { ok: false, code: 'EMAIL_CONSENT_NEEDS_EMAIL', error: EMAIL_CONSENT_NEEDS_EMAIL_MESSAGE };
    }
    if (intent.sms) {
        sms = normalizeConsentPhone(contact.phone);
        if (!sms) return { ok: false, code: 'SMS_CONSENT_NEEDS_PHONE', error: SMS_CONSENT_NEEDS_PHONE_MESSAGE };
    }
    return { ok: true, email, sms };
}

export type SupporterConsentChannel = 'email' | 'sms';

/** One supporter_contact_consents row, exactly as written. */
export interface SupporterConsentRow {
    business_id: string;
    customer_id: string;
    campaign_id: string | null;
    order_id: string | null;
    supporter_customer_id: string | null;
    channel: SupporterConsentChannel;
    action: 'granted';
    destination: string;
    consent_version: string;
    disclosure_text: string;
    source: string;
}

/** The rows a successfully created order records — one per checked box, nothing otherwise. */
export function buildSupporterConsentRows(input: {
    businessId: string;
    organizationCustomerId: string;
    organizationName: unknown;
    campaignId: string | null;
    orderId: string | null;
    supporterCustomerId: string | null;
    plan: { email: string | null; sms: string | null };
}): SupporterConsentRow[] {
    const base = {
        business_id: input.businessId,
        customer_id: input.organizationCustomerId,
        campaign_id: input.campaignId,
        order_id: input.orderId,
        supporter_customer_id: input.supporterCustomerId,
        action: 'granted' as const,
        source: SUPPORTER_CONSENT_SOURCE_CHECKOUT,
    };
    const rows: SupporterConsentRow[] = [];
    if (input.plan.email) {
        rows.push({ ...base, channel: 'email', destination: input.plan.email, consent_version: SUPPORTER_EMAIL_CONSENT_VERSION, disclosure_text: supporterEmailConsentText(input.organizationName) });
    }
    if (input.plan.sms) {
        rows.push({ ...base, channel: 'sms', destination: input.plan.sms, consent_version: SUPPORTER_SMS_CONSENT_VERSION, disclosure_text: supporterSmsConsentText(input.organizationName) });
    }
    return rows;
}
