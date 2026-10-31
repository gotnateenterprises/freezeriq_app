/**
 * PREVIOUS-SUPPORTER-EMAIL-2.0A — the two facts FreezerIQ must PROVE before it may
 * send a previous supporter a fundraiser email itself (Resend), and the honest
 * answer today for both: it cannot.
 *
 *   previous supporter + usable email + not opted out          → may be emailed PERSONALLY
 *                                                                ("Open in my email" — the
 *                                                                coordinator's own mailbox)
 *   … + explicit future-email permission + organization address → may ALSO be sent
 *                                                                automatically by FreezerIQ
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
 * ── 2. THE DESIGNATED SENDER'S MAILING ADDRESS ──────────────────────────────
 *
 * The organization is the sender of a re-engagement email (FreezerIQ / the tenant
 * only delivers it), so the footer's physical address must be the ORGANIZATION's.
 * Audited 2026-10-31: no organization mailing address exists. Customer has a single
 * free-text `delivery_address` — labelled "Delivery address" in the CRM and used to
 * route meal deliveries — which is a different business concept and is never read
 * here; a fundraiser's pickup_location is a third concept and is never read either.
 * The tenant's StorefrontConfig.origin_address is the kitchen's delivery origin and
 * belongs to a different entity. So this authority returns null, and automated
 * sending stays closed until an organization mailing address is recorded.
 *
 * Both functions are deliberately free of database reads today: there is nothing
 * true to read. They exist so the gate is one place, testable, and so the day the
 * data exists the change is a loader, not a rewrite of the send path.
 */

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
 * The designated sender's mailing address — the organization running THIS campaign.
 * Today: no authority exists, so null (see header). Takes the organization id so a
 * future loader is scoped by construction; it is never given another organization.
 */
export async function loadOrganizationMailingAddress(_scope: {
    businessId: string;
    organizationCustomerId: string;
}): Promise<OrganizationMailingAddress | null> {
    return null;
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
            reason: 'Automated email unavailable — organization mailing address required. You can still email supporters yourself with "Open in my email".',
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
