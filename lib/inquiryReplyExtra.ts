/**
 * INQUIRY-REPLY-EXTRA-1 — the tenant's ONE optional section in the fundraiser inquiry reply.
 *
 * The inquiry reply (EMAIL_TEMPLATES.lead_intro) is a platform template shared by every tenant. It carries
 * rules a tenant must not be able to undo — no fixed fundraising percentage, the first-name greeting, the
 * tenant-brand signature, every value escaped. So this is deliberately NOT a template editor (owner decision
 * D8): a tenant may add one section of their own — a heading and plain-text paragraphs — which the template
 * places immediately before "Ready to get a date on the calendar?" (D9), rendered with the template's own
 * heading style and every character escaped (D10). No HTML, no scripts, no formatting markup.
 *
 * STORAGE: the existing tenant-scoped `system_settings` table — no migration. One row per tenant:
 *     key         = `fundraiser_inquiry_reply_extra:<businessId>`
 *     business_id = <businessId>
 *     value       = JSON { v: 1, enabled, heading, body }
 * A row is honoured only when its business_id is the tenant asking (the key alone is never trusted), and a
 * value that fails validation is treated as "no section" — the built-in email, unchanged.
 *
 * A tenant with no row, a disabled row, or an unreadable row receives the built-in email BYTE-FOR-BYTE as
 * before (pinned by tests/fundraiserInquiryAutoresponseCopy1.test.ts and tests/inquiryReplyExtra1.test.ts).
 *
 * This module has no imports, so its validation runs identically in the Settings card (client) and the API.
 */

export const INQUIRY_REPLY_EXTRA_KEY_PREFIX = 'fundraiser_inquiry_reply_extra:';
export const INQUIRY_REPLY_HEADING_MAX = 80;
export const INQUIRY_REPLY_BODY_MAX = 1200;
export const INQUIRY_REPLY_ADMIN_ONLY_MESSAGE =
    'Only an administrator can change the fundraiser inquiry reply.';

/** The section as the template renders it. Present only when enabled with a heading and a body. */
export interface InquiryReplyExtraSection {
    heading: string;
    body: string;
}

/** The stored setting (what the Settings card edits). */
export interface InquiryReplyExtraSetting {
    enabled: boolean;
    heading: string;
    body: string;
}

export const EMPTY_INQUIRY_REPLY_EXTRA: InquiryReplyExtraSetting = { enabled: false, heading: '', body: '' };

/** Fictional sample inquiry the Settings preview renders for — never a real person or organization. */
export const INQUIRY_REPLY_PREVIEW_SAMPLE = { contactName: 'Jordan Sample', organizationName: 'Maple Grove PTO' } as const;

export function inquiryReplyExtraKey(businessId: string): string {
    return `${INQUIRY_REPLY_EXTRA_KEY_PREFIX}${businessId}`;
}

/** Strict, same as lib/fundraiserOrgShare.mayManageFundraiserFinancialTerms: a lowercased role does not pass. */
export function mayManageInquiryReply(user: { role?: unknown; isSuperAdmin?: unknown } | null | undefined): boolean {
    if (!user) return false;
    if (user.isSuperAdmin === true) return true;
    return user.role === 'ADMIN';
}

// C0 controls except TAB (\u0009) and LF (\u000A), plus DEL. CR is normalised to LF before this runs.
const BODY_CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F]', 'g');
// A heading is one line: every C0 control (newlines included) and DEL.
const HEADING_CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]+', 'g');

function cleanHeading(value: string): string {
    return value.replace(HEADING_CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function cleanBody(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(BODY_CONTROL_CHARS, '')
        .replace(/[ \t]+\n/g, '\n')
        // At most one blank line between paragraphs.
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export type InquiryReplyExtraParse =
    | { ok: true; value: InquiryReplyExtraSetting }
    | { ok: false; status: 400; code: string; error: string };

/**
 * Validate what the Settings card (or anyone) submits. Text is cleaned, never interpreted: angle brackets,
 * ampersands and quotes are kept as typed and escaped at render time, so "<b>" reads as "<b>" in the email.
 */
export function parseInquiryReplyExtraInput(input: unknown): InquiryReplyExtraParse {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, status: 400, code: 'INVALID_BODY', error: 'Send enabled, heading and message.' };
    }
    const raw = input as Record<string, unknown>;
    if (typeof raw.enabled !== 'boolean') {
        return { ok: false, status: 400, code: 'INVALID_ENABLED', error: 'Choose whether the section is on or off.' };
    }
    if (raw.heading !== undefined && typeof raw.heading !== 'string') {
        return { ok: false, status: 400, code: 'INVALID_HEADING', error: 'The heading must be text.' };
    }
    if (raw.body !== undefined && typeof raw.body !== 'string') {
        return { ok: false, status: 400, code: 'INVALID_MESSAGE', error: 'The message must be text.' };
    }
    const heading = cleanHeading((raw.heading as string | undefined) ?? '');
    const body = cleanBody((raw.body as string | undefined) ?? '');
    if (heading.length > INQUIRY_REPLY_HEADING_MAX) {
        return {
            ok: false, status: 400, code: 'HEADING_TOO_LONG',
            error: `Keep the heading to ${INQUIRY_REPLY_HEADING_MAX} characters or fewer.`,
        };
    }
    if (body.length > INQUIRY_REPLY_BODY_MAX) {
        return {
            ok: false, status: 400, code: 'MESSAGE_TOO_LONG',
            error: `Keep the message to ${INQUIRY_REPLY_BODY_MAX} characters or fewer.`,
        };
    }
    if (raw.enabled === true && (!heading || !body)) {
        return {
            ok: false, status: 400, code: 'SECTION_INCOMPLETE',
            error: 'Add a heading and a message before turning the section on.',
        };
    }
    return { ok: true, value: { enabled: raw.enabled, heading, body } };
}

/** The section the email should carry for this setting, or null (built-in email unchanged). */
export function activeInquiryReplySection(
    setting: InquiryReplyExtraSetting | null | undefined,
): InquiryReplyExtraSection | null {
    if (!setting || setting.enabled !== true) return null;
    const heading = cleanHeading(String(setting.heading ?? ''));
    const body = cleanBody(String(setting.body ?? ''));
    if (!heading || !body) return null;
    if (heading.length > INQUIRY_REPLY_HEADING_MAX || body.length > INQUIRY_REPLY_BODY_MAX) return null;
    return { heading, body };
}

/** Decode a stored value. Anything unexpected is "no setting", never an exception. */
export function decodeInquiryReplyExtra(value: unknown): InquiryReplyExtraSetting | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as any).v !== 1) return null;
    const result = parseInquiryReplyExtraInput({
        enabled: (parsed as any).enabled,
        heading: (parsed as any).heading,
        body: (parsed as any).body,
    });
    return result.ok ? result.value : null;
}

export function encodeInquiryReplyExtra(setting: InquiryReplyExtraSetting): string {
    return JSON.stringify({ v: 1, enabled: setting.enabled, heading: setting.heading, body: setting.body });
}

interface SystemSettingReader {
    systemSetting: { findUnique(args: any): Promise<any> };
}

/**
 * The tenant's stored setting, or null. Tenant-checked: a row is honoured only when its business_id is the
 * tenant asking. Never throws — the inquiry reply must still go out if the setting cannot be read.
 */
export async function readInquiryReplyExtra(
    db: SystemSettingReader,
    businessId: string,
): Promise<InquiryReplyExtraSetting | null> {
    if (typeof businessId !== 'string' || businessId.length === 0) return null;
    try {
        const row = await db.systemSetting.findUnique({
            where: { key: inquiryReplyExtraKey(businessId) },
            select: { value: true, business_id: true },
        });
        if (!row || row.business_id !== businessId) return null;
        return decodeInquiryReplyExtra(row.value);
    } catch (err) {
        console.error('[INQUIRY_REPLY_EXTRA] could not read the tenant section; sending the built-in reply:', err);
        return null;
    }
}

export async function writeInquiryReplyExtra(
    db: { systemSetting: { upsert(args: any): Promise<any> } },
    businessId: string,
    setting: InquiryReplyExtraSetting,
): Promise<void> {
    const key = inquiryReplyExtraKey(businessId);
    const value = encodeInquiryReplyExtra(setting);
    await db.systemSetting.upsert({
        where: { key },
        update: { value, business_id: businessId, updated_at: new Date() },
        create: { key, value, business_id: businessId },
    });
}
