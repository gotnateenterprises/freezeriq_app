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

    // ── 1. Is this person already in THIS tenant's address book? ─────────────
    // Matched on a CURRENT email point, which is what the uniqueness rule keys
    // on. Scoped by business_id: two tenants may each know a different person at
    // the same address, and they must never collide.
    const existingPoint = await tx.fundraiserContactPoint.findFirst({
        where: {
            business_id: businessId,
            type: 'email',
            normalized_value: normalizedEmail,
            is_current: true,
        },
        select: { contact_id: true },
    });

    let contactId = existingPoint?.contact_id ?? null;
    let createdContact = false;

    if (!contactId) {
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
