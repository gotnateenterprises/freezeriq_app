/**
 * FR-ACCEPTANCE-2A — adding a coordinator to an organization, from the CRM.
 *
 * Until now the fundraiser address book had exactly two writers: the public
 * intake route (lib/inquiryContact.ts) and the retention backfill script. So the
 * only person who could ever appear in the Launch Fundraiser coordinator picker
 * was whoever happened to submit the inquiry form. If the volunteer who wrote in
 * was not the person who would actually run the fundraiser — which is the normal
 * case, and the reason the intake asks who the coordinator will be — the tenant
 * had nowhere to put the real coordinator without abandoning the launch.
 *
 * This is that missing writer, and nothing more. It creates a FundraiserContact,
 * its contact points, and an ACTIVE FundraiserOrganizationContact relationship to
 * ONE organization, using the same models and the same rules as the intake path.
 * It does not introduce a second coordinator identity model, and it does not
 * appoint anybody: `role` is 'relationship_contact', exactly as the intake path
 * records it. Becoming the campaign's Primary Coordinator remains a separate,
 * deliberate choice the tenant makes in the launch dialog.
 *
 * TENANCY. The organization is re-read under the caller's own business_id before
 * anything is written, so a caller cannot add a contact to an organization they
 * do not own by putting someone else's id in the path.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { normalizeContactValue } from '@/lib/inquiryContact';

/** Same shape the intake path uses, so both writers agree on what a name is. */
const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_PHONE = 40;

function isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX_EMAIL;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const businessId = session.user.businessId;
        const { id: customerId } = await params;

        const body = await req.json().catch(() => ({} as any));
        const displayName = String(body?.name ?? '').trim();
        const email = String(body?.email ?? '').trim();
        const phone = String(body?.phone ?? '').trim();

        if (!displayName || displayName.length > MAX_NAME) {
            return NextResponse.json({ error: 'Enter the contact’s name.' }, { status: 400 });
        }
        // Email is the identity key in this address book — a contact with no way
        // to reach them cannot be a coordinator, who must receive a setup link.
        if (!email || !isPlausibleEmail(email)) {
            return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
        }
        if (phone && phone.length > MAX_PHONE) {
            return NextResponse.json({ error: 'That phone number is too long.' }, { status: 400 });
        }

        // TENANT GATE. Read the organization under THIS business before writing.
        const organization = await prisma.customer.findFirst({
            where: { id: customerId, business_id: businessId },
            select: { id: true },
        });
        if (!organization) {
            // Deliberately 404, not 403: a caller who guessed another tenant's
            // customer id learns nothing about whether it exists.
            return NextResponse.json({ error: 'Organization not found.' }, { status: 404 });
        }

        const normalizedEmail = normalizeContactValue(email);

        const result = await prisma.$transaction(async (tx) => {
            // Is this person already a contact of THIS organization? The same
            // org-scoped-first question lib/inquiryContact.ts asks, and for the
            // same reason: one address can legitimately belong to several people
            // across a tenant, so the organization is the disambiguator.
            const existing = await tx.fundraiserContactPoint.findMany({
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

            if (existing.length > 0) {
                // Already here. Adding them twice is not what the tenant meant.
                return { contactId: existing[0].contact_id, created: false };
            }

            const contact = await tx.fundraiserContact.create({
                data: {
                    business_id: businessId,
                    display_name: displayName,
                    // A tenant typed this in themselves, which is a stronger
                    // claim than a public form — but nobody has confirmed the
                    // address, so it stays provisional like every other contact
                    // this product creates.
                    identity_status: 'provisional',
                    source: 'tenant',
                },
                select: { id: true },
            });

            await createContactPoint(tx, businessId, contact.id, 'email', email, normalizedEmail);
            if (phone) {
                await createContactPoint(tx, businessId, contact.id, 'phone', phone, normalizeContactValue(phone));
            }

            const activeCount = await tx.fundraiserOrganizationContact.count({
                where: { business_id: businessId, customer_id: customerId, ended_at: null },
            });

            await tx.fundraiserOrganizationContact.create({
                data: {
                    business_id: businessId,
                    contact_id: contact.id,
                    customer_id: customerId,
                    // NOT 'coordinator'. Adding someone to the address book is
                    // not appointing them; the launch dialog is where a person
                    // becomes the campaign's Primary Coordinator.
                    role: 'relationship_contact',
                    is_primary_relationship: activeCount === 0,
                    source: 'tenant',
                    tenant_notes: 'Added from the Launch Fundraiser dialog.',
                },
            });

            return { contactId: contact.id, created: true };
        });

        return NextResponse.json({
            contactId: result.contactId,
            created: result.created,
            // The caller refreshes candidates and lets the tenant choose. It is
            // deliberately NOT told to select this person automatically.
            autoSelect: false,
        }, { status: result.created ? 201 : 200 });
    } catch (e: any) {
        console.error('[ORG_CONTACT_CREATE]', e);
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}

/**
 * Write one contact point without tripping the partial unique indexes.
 *
 * A brand-new contact has no points, so `is_primary` is true for the first of
 * each type and the one_current_value / one_primary_current indexes are
 * satisfied by construction.
 */
async function createContactPoint(
    tx: any,
    businessId: string,
    contactId: string,
    type: 'email' | 'phone',
    value: string,
    normalized: string
): Promise<void> {
    await tx.fundraiserContactPoint.create({
        data: {
            business_id: businessId,
            contact_id: contactId,
            type,
            label: 'work',
            value,
            normalized_value: normalized,
            is_primary: true,
            is_current: true,
            source: 'tenant',
        },
    });
}
