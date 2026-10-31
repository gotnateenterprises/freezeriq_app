/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0A / 2.0B — the two facts that must be PROVEN before a
 * previous supporter may be sent a prepared fundraiser email.
 *
 *   previous supporter + usable email + not opted out
 *     + the organization's mailing address                   → may be emailed PERSONALLY
 *                                                              ("Open in my email" — the
 *                                                              coordinator's own mailbox)
 *   … + explicit future-email permission                      → may ALSO be sent
 *                                                              automatically by FreezerIQ
 *
 * Today the address can be recorded (2.0B) and the permission cannot, so FreezerIQ's
 * own sending stays closed for everyone, by design.
 *
 * ── 1. EXPLICIT FUTURE-EMAIL PERMISSION ─────────────────────────────────────
 *
 * Audited 2026-10-31: no record anywhere says a supporter asked for future
 * fundraiser email. An order's email address is how the order is fulfilled, not
 * permission to market. MarketingPreference rows record OPT-OUTS (and a tenant's
 * undoing of one, with a note) for the seasonal rebooking audience; a `subscribed`
 * row means "no longer suppressed", not "opted in", and Production holds none.
 * So the authority below returns an empty set, and nothing — no import, no
 * backfill, no inference from purchase history — may fill it. When the supporter
 * order page starts collecting a separate, unticked, timestamped, withdrawable
 * "Keep me updated by email about future fundraisers from this organization"
 * choice, THIS function is where it is read.
 *
 * ── 2. THE DESIGNATED SENDER'S MAILING ADDRESS (PREVIOUS-SUPPORTER-EMAIL-2.0B) ─
 *
 * The organization is the sender of a re-engagement email (FreezerIQ / the tenant
 * only delivers it), so the footer's physical address must be the ORGANIZATION's.
 * It lives in its own owner-approved columns on the organization's Customer row
 * (customers.mailing_address_line1 … mailing_postal_code, migration
 * 20261031120000), edited in the CRM's Organization Details. It is read for
 * exactly ONE organization, inside ONE tenant, and validated before use.
 *
 * Never read in its place: Customer.delivery_address (where meals are delivered —
 * a routing concept), a campaign's pickup_location (where supporters collect), the
 * tenant's StorefrontConfig.origin_address (the kitchen) or any platform address.
 * A missing or incomplete address means NO prepared email of either kind.
 *
 * The consent authority above deliberately reads nothing: there is nothing true
 * to read yet.
 */
import { prisma } from '@/lib/db';
/** A US-style mailing address, complete enough to print in a commercial-email footer. */
export interface OrganizationMailingAddress {
    line1: string;
    line2?: string | null;
    city: string;
    /** Two-letter state or territory code. */
    state: string;
    /** 5-digit ZIP or ZIP+4. */
    postalCode: string;
}

/** Letters, spaces, periods, apostrophes, hyphens. Constructed, so the `u` flag works on this TS target. */
const CITY = new RegExp("^[\\p{L} .'-]+$", 'u');

/** A free-text value as one bounded line, or '' when it holds nothing printable. */
function line(v: unknown, max = 120): string {
    if (typeof v !== 'string') return '';
    return v.replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g'), ' ')
        .replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

/**
 * The address, cleaned, or null when it is not a complete mailing address. A street
 * line, a city, a two-letter state and a valid ZIP are all required; anything
 * missing or malformed blocks automated sending rather than printing half an address.
 */
export function validateOrganizationMailingAddress(raw: unknown): OrganizationMailingAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const line1 = line(r.line1);
    const line2 = line(r.line2) || null;
    const city = line(r.city, 80);
    // Validated at full length: truncating first would turn "Illinois" into "IL".
    const state = line(r.state, 40).toUpperCase();
    const postalCode = line(r.postalCode, 40);
    if (!line1 || !/[a-z]/i.test(line1) || !/\d/.test(line1)) return null;   // "123 Main St", not "Hall"
    if (!city || !CITY.test(city)) return null;
    if (!/^[A-Z]{2}$/.test(state)) return null;
    if (!/^\d{5}(-\d{4})?$/.test(postalCode)) return null;
    return { line1, line2, city, state, postalCode };
}

/** The address as printed lines: street, optional second line, "City, ST 12345". */
export function mailingAddressLines(a: OrganizationMailingAddress): string[] {
    return [a.line1, a.line2 || '', `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean);
}

/**
 * What the CRM may store. All five blank clears the address; anything else must be
 * a COMPLETE, well-formed address — a half-typed one is refused with a reason
 * rather than stored and silently failing later.
 */
export function parseMailingAddressInput(body: unknown):
    | { kind: 'clear' }
    | { kind: 'set'; address: OrganizationMailingAddress }
    | { kind: 'invalid'; error: string } {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const fields = ['line1', 'line2', 'city', 'state', 'postalCode'].map((k) => (typeof b[k] === 'string' ? (b[k] as string).trim() : ''));
    if (fields.every((v) => !v)) return { kind: 'clear' };
    const address = validateOrganizationMailingAddress({ line1: b.line1, line2: b.line2, city: b.city, state: b.state, postalCode: b.postalCode });
    if (!address) {
        return {
            kind: 'invalid',
            error: 'Enter a complete mailing address: street address, city, two-letter state and ZIP code.',
        };
    }
    return { kind: 'set', address };
}

/** "Open in my email" needs the organization's address too (2.0B); FreezerIQ's own send needs more. */
export function describePersonalEmail(mailingAddress: OrganizationMailingAddress | null): {
    available: boolean;
    code: 'available' | 'mailing_address_required';
    reason: string;
} {
    return mailingAddress
        ? { available: true, code: 'available', reason: 'Prepared emails include the organization’s mailing address.' }
        : { available: false, code: 'mailing_address_required', reason: 'Email draft unavailable — organization mailing address required.' };
}

/** The raw columns, exactly as stored. */
export interface OrganizationMailingAddressRow {
    mailing_address_line1: string | null;
    mailing_address_line2: string | null;
    mailing_city: string | null;
    mailing_state: string | null;
    mailing_postal_code: string | null;
}

export function mailingAddressFromRow(row: OrganizationMailingAddressRow | null | undefined): OrganizationMailingAddress | null {
    if (!row) return null;
    return validateOrganizationMailingAddress({
        line1: row.mailing_address_line1,
        line2: row.mailing_address_line2,
        city: row.mailing_city,
        state: row.mailing_state,
        postalCode: row.mailing_postal_code,
    });
}

/** Just enough of a Prisma client to read one row by raw SQL — injectable for tests. */
export interface MailingAddressDb {
    $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
}

/**
 * The designated sender's mailing address — the organization running THIS campaign,
 * in THIS tenant, or null when it is missing or incomplete.
 *
 * Read by raw SQL on purpose: these columns are newer than some locally generated
 * Prisma clients, and the WHERE clause must carry both the organization id AND the
 * tenant id, so another organization's or another tenant's address can never come
 * back. Only the five mailing columns are selected — never delivery_address.
 */
export async function loadOrganizationMailingAddress(
    scope: { businessId: string; organizationCustomerId: string },
    db: MailingAddressDb = prisma as unknown as MailingAddressDb,
): Promise<OrganizationMailingAddress | null> {
    if (!scope.businessId || !scope.organizationCustomerId) return null;
    const rows = await db.$queryRaw<OrganizationMailingAddressRow[]>`
        SELECT mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_postal_code
        FROM customers
        WHERE id = ${scope.organizationCustomerId} AND business_id = ${scope.businessId}
        LIMIT 1
    `;
    return mailingAddressFromRow(Array.isArray(rows) ? rows[0] : null);
}

/**
 * Normalized addresses with recorded, explicit permission for future fundraiser
 * email from THIS organization. Today: none (see header) — an empty set, never a
 * guess. Purchase history, order email and the absence of an opt-out are NOT
 * permission and must never be passed in as if they were.
 */
export async function loadExplicitEmailConsent(_scope: {
    businessId: string;
    organizationCustomerId: string;
}): Promise<ReadonlySet<string>> {
    return new Set<string>();
}

export type AutomatedSendCode = 'available' | 'mailing_address_required' | 'consent_not_recorded';

export interface AutomatedSendGate {
    available: boolean;
    code: AutomatedSendCode;
    /** Coordinator-facing. Never shown to supporters. */
    reason: string;
}

/**
 * Whether FreezerIQ may send ANY automated re-engagement email for this campaign.
 * The address is checked first: without it no email can be compliant, whoever
 * consented. Per-supporter consent is then checked again person by person.
 */
export function describeAutomatedSend(input: {
    mailingAddress: OrganizationMailingAddress | null;
    consentedCount: number;
}): AutomatedSendGate {
    if (!input.mailingAddress) {
        return {
            available: false,
            code: 'mailing_address_required',
            reason: 'Automated email unavailable — organization mailing address required.',
        };
    }
    if (input.consentedCount <= 0) {
        return {
            available: false,
            code: 'consent_not_recorded',
            reason: 'FreezerIQ send unavailable — no previous supporter has given permission for future fundraiser email yet. You can still email them yourself with "Open in my email".',
        };
    }
    return { available: true, code: 'available', reason: 'FreezerIQ can email supporters who gave permission.' };
}
