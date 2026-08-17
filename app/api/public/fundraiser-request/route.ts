/**
 * Public fundraiser inquiry (Stage 1 — LEAD).
 *
 * FR-FLOW-1: this route previously validated its input, ignored the tenant slug
 * the form was already sending, wrote NOTHING, and returned `{ success: true }`
 * — while the storefront told the submitter "Request Received! We'll be in touch
 * within 1-2 business days." Every fundraiser inquiry made through a tenant
 * storefront was silently discarded.
 *
 * WHAT THIS PERSISTS, AND WHY IT IS A Customer
 * The Fundraiser CRM's organization list is a customer.findMany in
 * app/api/campaigns/route.ts, and a Customer with no campaign renders there as a
 * "Lead Placeholder" row. So the inquiry is written as a tenant-scoped Customer
 * and appears in the CRM the tenant already uses — no new model, no new
 * dashboard, no new workflow enum.
 *
 * FR-FLOW-1R: visibility is carried by the FUNDRAISER_INQUIRY_TAG, not by the
 * customer's `type`. A NEW organization is created as `fundraiser_org`, but an
 * inquiry from someone who already exists (a storefront buyer or waitlist
 * signup, both `direct_customer`) must not have their type rewritten —
 * marketing audiences, growth analytics and the Customers page all route on
 * that field. Both branches therefore write the tag, and the CRM query includes
 * on the tag as well as on type. See lib/fundraiserLead.ts.
 *
 * NO CAMPAIGN IS CREATED. An inquiry is not a fundraiser: the date is not
 * confirmed, no bundle pool is chosen, and no coordinator has set anything up.
 * Creating a FundraiserCampaign here would manufacture a campaign that the rest
 * of the system would treat as real.
 *
 * TENANT RESOLUTION is from the storefront slug, server-side, never from the
 * client — the same rule as app/api/public/order/route.ts.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { FUNDRAISER_INQUIRY_TAG, FUNDRAISER_INQUIRY_SOURCE } from '@/lib/fundraiserLead';

/** Trim, collapse whitespace, and cap length on free-text the public can send. */
function clean(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim().replace(/\s+/g, ' ').slice(0, max);
    return v.length > 0 ? v : null;
}

/**
 * Deliberately permissive: this only rejects input that cannot be an address at
 * all. A lead is more valuable than a perfectly-formatted contact, and a real
 * prospect must never be dropped over strictness.
 */
function isPlausibleEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { name, email, phone, orgName, deliveryLocation, website, cause, notes, slug } = body;

        // Basic validation
        if (!name || !email || !phone || !orgName || !deliveryLocation) {
            return NextResponse.json(
                { error: 'Name, email, phone, organization, and delivery location are required.' },
                { status: 400 }
            );
        }

        const contactName = clean(name, 200);
        const contactEmail = clean(email, 254);
        const contactPhone = clean(phone, 50);
        const organizationName = clean(orgName, 200);

        if (!contactName || !contactEmail || !contactPhone || !organizationName) {
            return NextResponse.json(
                { error: 'Name, email, phone, organization, and delivery location are required.' },
                { status: 400 }
            );
        }

        if (!isPlausibleEmail(contactEmail)) {
            return NextResponse.json(
                { error: 'Please enter a valid email address.' },
                { status: 400 }
            );
        }

        // ── Tenant resolution: server-trusted, from the storefront slug ───────
        if (!slug || typeof slug !== 'string') {
            return NextResponse.json({ error: 'Unknown storefront.' }, { status: 400 });
        }

        const business = await prisma.business.findFirst({
            where: { slug: { equals: slug.toLowerCase().trim(), mode: 'insensitive' } },
            select: { id: true },
        });

        if (!business) {
            return NextResponse.json({ error: 'Unknown storefront.' }, { status: 404 });
        }
        const businessId = business.id;

        // ── Inquiry context — collected by the form, previously dropped ───────
        // These have no dedicated columns, so they are preserved as readable
        // notes on the lead rather than being thrown away. No schema change.
        const inquiryContext = [
            `Fundraiser inquiry submitted from the ${slug} storefront.`,
            `Delivery/pickup area: ${clean(deliveryLocation, 300) ?? '—'}`,
            website ? `Website: ${clean(website, 300)}` : null,
            cause ? `Cause: ${clean(cause, 500)}` : null,
            notes ? `Notes: ${clean(notes, 2000)}` : null,
        ].filter(Boolean).join('\n');

        // ── Idempotency: a double-click or retry must not create a second org ─
        // Matched within the tenant on contact email, which is how the fundraiser
        // CSV import already matches organizations. An existing organization is
        // enriched, never overwritten: only blank fields are filled in, so a
        // tenant's own corrections are not clobbered by a resubmission. A real
        // returning prospect therefore updates one row instead of creating rows.
        const existing = await prisma.customer.findFirst({
            where: {
                business_id: businessId,
                contact_email: { equals: contactEmail, mode: 'insensitive' },
            },
        });

        let customerId: string;
        let created: boolean;

        if (existing) {
            const patch: Record<string, unknown> = {};
            if (!existing.contact_name) patch.contact_name = contactName;
            if (!existing.contact_phone) patch.contact_phone = contactPhone;
            if (!existing.notes) patch.notes = inquiryContext;

            const tags = existing.tags || [];
            if (!tags.includes(FUNDRAISER_INQUIRY_TAG)) {
                patch.tags = [...tags, FUNDRAISER_INQUIRY_TAG];
            }

            if (Object.keys(patch).length > 0) {
                await prisma.customer.update({ where: { id: existing.id }, data: patch });
            }
            customerId = existing.id;
            created = false;
        } else {
            const lead = await prisma.customer.create({
                data: {
                    business_id: businessId,
                    name: organizationName,
                    contact_name: contactName,
                    contact_email: contactEmail,
                    contact_phone: contactPhone,
                    // fundraiser_org is what the Fundraiser CRM query filters on.
                    type: 'fundraiser_org',
                    status: 'LEAD',
                    // `source` distinguishes this from a hand-typed lead, which
                    // defaults to "Manual".
                    source: FUNDRAISER_INQUIRY_SOURCE,
                    notes: inquiryContext,
                    tags: [FUNDRAISER_INQUIRY_TAG],
                },
            });
            customerId = lead.id;
            created = true;
        }

        // ── Tenant notification — best effort, AFTER the lead is durable ──────
        // Deliberately outside the persistence path and individually caught: a
        // mail outage must never be able to lose a lead that is already saved.
        try {
            const owner = await prisma.user.findFirst({
                where: { business_id: businessId, role: 'ADMIN' as any },
                select: { email: true },
            }) ?? await prisma.user.findFirst({
                where: { business_id: businessId },
                select: { email: true },
            });

            if (owner?.email) {
                const { sendLeadNotificationEmail } = await import('@/lib/email');
                await sendLeadNotificationEmail(owner.email, {
                    name: contactName,
                    email: contactEmail,
                    phone: contactPhone,
                    source: FUNDRAISER_INQUIRY_SOURCE,
                    notes: inquiryContext,
                }, businessId);
            }
        } catch (notifyError) {
            // Logged, not surfaced: the submitter's request genuinely succeeded.
            console.error('[FUNDRAISER_REQUEST] lead saved but notification failed', notifyError);
        }

        return NextResponse.json({ success: true, customerId, created });
    } catch (error: any) {
        console.error('[FUNDRAISER_REQUEST]', error);
        return NextResponse.json(
            { error: 'Something went wrong. Please try again.' },
            { status: 500 }
        );
    }
}
