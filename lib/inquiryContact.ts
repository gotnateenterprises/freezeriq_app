/**
 * FR-ACCEPTANCE-1 — the person who submits a fundraiser inquiry becomes a
 * contact of that organisation.
 *
 * WHY THIS EXISTS
 * Intake wrote the submitter's name, email and phone onto Customer scalars and
 * onto the immutable FundraiserInquiry row, and stopped there. The fundraiser
 * address book — FundraiserContact / FundraiserContactPoint /
 * FundraiserOrganizationContact — was never touched by any API route; its only
 * writer was a one-off backfill script. So a brand-new organisation had no
 * address-book entry at all, and FR-FLOW-2's coordinator picker, which reads
 * exactly that table, correctly reported "no active contacts" about the very
 * person who had just written in.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not make them the fundraiser's coordinator. Filling in a web form is
 * not the same act as agreeing to run a fundraiser: the person asking is often
 * a parent, an office administrator, or whoever happened to find the page. The
 * relationship is recorded as `relationship_contact`, which makes them
 * SELECTABLE at launch and nothing more. The tenant still chooses, deliberately,
 * who the primary coordinator is — and FR-FLOW-2A's
 * FundraiserCampaignCoordinator remains the only thing that records that choice.
 *
 * DEDUPLICATION
 * Two constraints do the real work, so this cannot create duplicates even under
 * a race:
 *   fundraiser_contact_points_one_current_value  (contact_id, type, normalized_value) WHERE is_current
 *   fundraiser_organization_contacts_one_active  (contact_id, customer_id)            WHERE ended_at IS NULL
 * A repeat inquiry from the same address resolves to the existing person and
 * adds nothing.
 */

import type { Prisma } from '@prisma/client';

/** The same normalisation the retention backfill uses, so both agree on identity. */
export function normalizeContactValue(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Is this plausibly the same person's name?
 *
 * Deliberately conservative — collapse whitespace and case, nothing more. No
 * nickname table, no initials, no fuzzy distance. This decides whether to file
 * one person's inquiry under another person's record, and the cost of a false
 * match (a volunteer's enquiry attached to a stranger) is much higher than the
 * cost of a false miss (a new contact row flagged for review).
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
    const norm = (v: string | null | undefined) =>
        (v || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const x = norm(a);
    const y = norm(b);
    return x !== '' && x === y;
}

export interface InquiryContactInput {
    businessId: string;
    /** The organisation the inquiry resolved to. Already tenant-verified by the caller. */
    customerId: string;
    name: string;
    email: string;
    phone?: string | null;
}

export interface InquiryContactResult {
    contactId: string | null;
    createdContact: boolean;
    createdRelationship: boolean;
    reusedContact: boolean;
}

/** Minimal transaction surface, so this can be exercised without a database. */
type Tx = Prisma.TransactionClient;

/**
 * Ensure the inquiry submitter exists as a contact of this organisation.
 *
 * MUST be called inside the intake transaction: an inquiry that is recorded
 * while its author is not is exactly the split this fixes.
 *
 * Returns quietly when there is no usable email — identity here is the email
 * address, and a contact with no way to reach them is not worth a row.
 */
export async function ensureInquiryOrganizationContact(
    tx: Tx,
    input: InquiryContactInput
): Promise<InquiryContactResult> {
    const { businessId, customerId } = input;
    const displayName = (input.name || '').trim();
    const email = (input.email || '').trim();
    const phone = (input.phone || '').trim();

    const none: InquiryContactResult = {
        contactId: null, createdContact: false, createdRelationship: false, reusedContact: false,
    };
    if (!email || !displayName) return none;

    const normalizedEmail = normalizeContactValue(email);

    // ── 1. Which person in the address book is this? ─────────────────────────
    //
    // FR-ACCEPTANCE-1C. This used to be a single tenant-wide `findFirst` on the
    // email, with no ordering — so when one address mapped to several people,
    // Postgres handed back whichever row it felt like and the submitter was
    // silently filed as somebody else. Production already contains exactly that
    // shape: one volunteer who coordinates for three different county groups is
    // three contacts sharing one address, which is not a bug — the address book
    // deliberately keeps one contact per person per organisation, so that
    // ending a relationship with one group does not disturb the other two.
    //
    // A shared office inbox makes it worse: two genuinely different people at
    // office@school.org would collapse into one, and the second person's name
    // was thrown away without ever being compared.
    //
    // Resolution now goes narrowest-first, and refuses to guess at the end. It
    // is the same shape the customer-identity resolver in the intake route uses.

    // 1a. Someone already attached to THIS organisation with this address. This
    //     is the strongest evidence available and it settles every duplicate in
    //     Production today, because no organisation has two active contacts.
    const orgScoped = await tx.fundraiserContactPoint.findMany({
        where: {
            business_id: businessId,
            type: 'email',
            normalized_value: normalizedEmail,
            is_current: true,
            contact: { org_contacts: { some: { customer_id: customerId, ended_at: null } } },
        },
        select: { contact_id: true },
        orderBy: { contact_id: 'asc' },
    });

    // 1b. Nobody here yet — look tenant-wide, but take the whole set, ordered.
    //     `findFirst` is what caused this defect; the fix is not a better
    //     `findFirst`, it is refusing to reduce a set of people to one row.
    const tenantWide = orgScoped.length > 0 ? [] : await tx.fundraiserContactPoint.findMany({
        where: {
            business_id: businessId,
            type: 'email',
            normalized_value: normalizedEmail,
            is_current: true,
        },
        select: { contact_id: true, contact: { select: { id: true, display_name: true } } },
        orderBy: { contact_id: 'asc' },
    });

    let contactId: string | null = null;
    let ambiguousCandidates = 0;

    if (orgScoped.length === 1) {
        // Unambiguous: this person, this organisation, this address.
        contactId = orgScoped[0].contact_id;
    } else if (orgScoped.length > 1) {
        // Should not happen — one active relationship per (contact, org) is an
        // index — but if it ever does, that is precisely a case for not guessing.
        ambiguousCandidates = orgScoped.length;
    } else if (tenantWide.length === 1) {
        // One person tenant-wide on this address. Reuse them, but only if the
        // name agrees: a lone match on a shared inbox is still the wrong person.
        const only = tenantWide[0];
        if (namesMatch(only.contact?.display_name, displayName)) {
            contactId = only.contact_id;
        } else {
            ambiguousCandidates = 1;
        }
    } else if (tenantWide.length > 1) {
        // Several people share this address and none of them is attached to this
        // organisation. A name match would have to be unique to be evidence.
        const byName = tenantWide.filter((p) => namesMatch(p.contact?.display_name, displayName));
        if (byName.length === 1) {
            contactId = byName[0].contact_id;
        } else {
            ambiguousCandidates = tenantWide.length;
        }
    }

    let createdContact = false;

    if (!contactId) {
        // Either nobody matched, or too many did. Both end here, and neither
        // attaches this inquiry to a person we are not sure about.
        //
        // Creating a fresh contact is safe under every uniqueness rule on these
        // tables — they are all keyed on a surrogate id or on contact_id, so a
        // new row always fits — and it converges rather than multiplying: the
        // next inquiry from this address for this organisation matches at 1a.
        const contact = await tx.fundraiserContact.create({
            data: {
                business_id: businessId,
                display_name: displayName,
                // Provisional: they typed this themselves and nobody has confirmed
                // it. The retention model already distinguishes that from a
                // tenant-verified identity.
                identity_status: 'provisional',
                // `source` has no value meaning "arrived through the public form".
                // 'tenant' is the closest true statement — the record entered
                // FreezerIQ through this tenant's own storefront and the tenant
                // owns it — and the relationship below carries the real provenance
                // in words. Adding an enum value would be a schema change this
                // acceptance pass is not authorised to make.
                source: 'tenant',
                // Flag the ambiguous ones for a human. The columns already exist
                // and the rebooking review surface already reads them. Recording
                // the doubt without surfacing it would leave nobody to resolve it.
                ...(ambiguousCandidates > 0
                    ? {
                        needs_review: true,
                        review_reason:
                            `IDENTITY REVIEW: this address book already holds ${ambiguousCandidates} ` +
                            `contact${ambiguousCandidates === 1 ? '' : 's'} using ${email}, and none could be ` +
                            `matched to "${displayName}" with confidence. A new contact was recorded rather ` +
                            `than attaching this inquiry to the wrong person. Merge them if they are the same.`,
                    }
                    : {}),
            },
            select: { id: true },
        });
        contactId = contact.id;
        createdContact = true;
    }

    // ── 2. Contact points, without tripping the partial unique indexes ───────
    await ensureContactPoint(tx, businessId, contactId, 'email', email, normalizedEmail);
    if (phone) {
        await ensureContactPoint(tx, businessId, contactId, 'phone', phone, normalizeContactValue(phone));
    }

    // ── 3. The organisation relationship ─────────────────────────────────────
    const existingRelationship = await tx.fundraiserOrganizationContact.findFirst({
        where: { business_id: businessId, customer_id: customerId, contact_id: contactId, ended_at: null },
        select: { id: true },
    });

    let createdRelationship = false;
    if (!existingRelationship) {
        // First active contact for this organisation? Then this is its primary
        // relationship. Otherwise it is simply another known person. The column
        // has no backing unique index, so it is set truthfully rather than
        // defaulted to true for everyone.
        const activeCount = await tx.fundraiserOrganizationContact.count({
            where: { business_id: businessId, customer_id: customerId, ended_at: null },
        });

        await tx.fundraiserOrganizationContact.create({
            data: {
                business_id: businessId,
                contact_id: contactId,
                customer_id: customerId,
                // NOT 'coordinator'. Submitting the form is not agreeing to run
                // the fundraiser; this makes them selectable, never assigned.
                role: 'relationship_contact',
                is_primary_relationship: activeCount === 0,
                source: 'tenant',
                tenant_notes: 'Added automatically from a public fundraiser inquiry.',
            },
        });
        createdRelationship = true;
    }

    return {
        contactId,
        createdContact,
        createdRelationship,
        reusedContact: !createdContact,
    };
}

/**
 * Add a contact point unless an equivalent CURRENT one already exists.
 *
 * Two partial unique indexes constrain this table:
 *   one_current_value    (contact_id, type, normalized_value) WHERE is_current
 *   one_primary_current  (contact_id, type)                   WHERE is_primary AND is_current AND valid_to IS NULL
 *
 * So a repeat submission adds nothing, and a NEW address for a known person is
 * added as a secondary rather than displacing the one already on file — the
 * tenant decides what someone's main address is, not whichever form they most
 * recently filled in.
 */
async function ensureContactPoint(
    tx: Tx,
    businessId: string,
    contactId: string,
    type: 'email' | 'phone',
    value: string,
    normalized: string
): Promise<void> {
    const already = await tx.fundraiserContactPoint.findFirst({
        where: { contact_id: contactId, type, normalized_value: normalized, is_current: true },
        select: { id: true },
    });
    if (already) return;

    const hasPrimary = await tx.fundraiserContactPoint.findFirst({
        where: { contact_id: contactId, type, is_primary: true, is_current: true, valid_to: null },
        select: { id: true },
    });

    await tx.fundraiserContactPoint.create({
        data: {
            business_id: businessId,
            contact_id: contactId,
            type,
            label: 'work',
            value,
            normalized_value: normalized,
            is_primary: !hasPrimary,
            is_current: true,
            source: 'tenant',
        },
    });
}
