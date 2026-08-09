/**
 * FR-RETENTION-3 — email preview / message.
 *
 *   GET  → render the preview from the FROZEN audience snapshot.
 *   POST → persist and approve the message.
 *
 * Neither verb sends email.
 *
 * The preview is built from the stored OutreachRecipient rows, never by
 * silently recalculating the audience — the tenant must see what they reviewed.
 *
 * COUNT HONESTY: "people/organizations represented" and "emails that will be
 * delivered" are reported as separate numbers. Six people sharing three inboxes
 * is three emails, and the UI is never told otherwise.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { getTenantSender } from '@/lib/email';
import { renderSeasonalUpdate, resolveRebookingCta, checkSenderReadiness } from '@/lib/outreachMessage';

async function loadContext(businessId: string, lineupId: string) {
    const lineup = await prisma.seasonalOffering.findFirst({
        where: { id: lineupId, business_id: businessId },
        select: { id: true, name: true, starts_at: true, ends_at: true },
    });
    if (!lineup) return null;

    const batch = await prisma.outreachBatch.findFirst({
        where: { business_id: businessId, seasonal_offering_id: lineupId },
        select: { id: true, status: true, audience_calculated_at: true },
    });
    if (!batch) return null;

    const recipients = await prisma.outreachRecipient.findMany({
        where: { business_id: businessId, outreach_batch_id: batch.id },
        select: {
            id: true, display_name: true, email_masked: true, normalized_email: true,
            is_shared_inbox: true, eligibility: true, is_selected: true,
            represented_org_names: true,
            contacts: { select: { contact_id: true, contact_display_name: true } },
            orgs: { select: { customer_id: true, organization_name: true } },
        },
        orderBy: { display_name: 'asc' },
    });

    return { lineup, batch, recipients };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const context = await loadContext(businessId, id);
        if (!context) return NextResponse.json({ error: 'Audience not found. Review the audience first.' }, { status: 404 });
        const { lineup, batch, recipients } = context;

        const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
        const sender = await getTenantSender(businessId);

        // Deliverable = included, still selected, and has a usable address.
        const deliverable = recipients.filter((r) => r.eligibility === 'included' && r.is_selected && r.normalized_email);

        const representedContacts = new Set(deliverable.flatMap((r) => r.contacts.map((c) => c.contact_id))).size;
        const representedOrgs = new Set(deliverable.flatMap((r) => r.orgs.map((o) => o.customer_id))).size;

        // Preview only: `ready` says a link CAN be built, and the rendered CTA
        // shows the masked /rebook/••• form. No credential is minted here, so
        // the persisted preview HTML never contains a working link.
        const cta = resolveRebookingCta(req);
        const senderReadiness = checkSenderReadiness(process.env.EMAIL_FROM);

        // Preview renders the first deliverable recipient as the representative
        // sample, so the tenant sees a real message rather than a template.
        const sample = deliverable[0];
        const rendered = renderSeasonalUpdate({
            tenantName: business.name,
            organizationNames: sample ? sample.orgs.map((o) => o.organization_name) : [],
            lineupName: lineup.name,
            lineupStartsAt: lineup.starts_at,
            lineupEndsAt: lineup.ends_at,
            hasPreviousFundraiser: true,
            previousCampaignName: null,
            cta,
        });

        const existing = await prisma.outreachMessage.findFirst({
            where: { business_id: businessId, outreach_batch_id: batch.id },
            select: { id: true, subject: true, status: true, approved_at: true, version: true },
        });

        return NextResponse.json({
            lineupName: lineup.name,
            from: sender.from,
            replyTo: sender.replyTo ?? null,
            subject: rendered.subject,
            html: rendered.html,
            counts: {
                // These three are intentionally distinct.
                deliveryAddresses: deliverable.length,
                representedContacts,
                representedOrganizations: representedOrgs,
                sharedInboxes: deliverable.filter((r) => r.is_shared_inbox).length,
            },
            ctaReady: cta.ready,
            ctaBlockedReason: cta.blockedReason,
            senderReady: senderReadiness.ready,
            senderBlockedReason: senderReadiness.blockedReason,
            approved: Boolean(existing?.approved_at),
            audienceReviewedAt: batch.audience_calculated_at?.toISOString() ?? null,
        });
    } catch (e) {
        console.error('[Outreach message] GET failed:', e);
        return NextResponse.json({ error: 'Failed to build the email preview' }, { status: 500 });
    }
}

/** Persist + approve the message. Still sends nothing. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const businessId = session.user.businessId;
        const { id } = await ctx.params;

        const context = await loadContext(businessId, id);
        if (!context) return NextResponse.json({ error: 'Audience not found' }, { status: 404 });
        const { lineup, batch, recipients } = context;

        const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } });
        const deliverable = recipients.filter((r) => r.eligibility === 'included' && r.is_selected && r.normalized_email);
        // Masked CTA — the stored approved message must not contain a real link.
        const cta = resolveRebookingCta(req);

        const sample = deliverable[0];
        const rendered = renderSeasonalUpdate({
            tenantName: business.name,
            organizationNames: sample ? sample.orgs.map((o) => o.organization_name) : [],
            lineupName: lineup.name,
            lineupStartsAt: lineup.starts_at,
            lineupEndsAt: lineup.ends_at,
            hasPreviousFundraiser: true,
            previousCampaignName: null,
            cta,
        });

        const existing = await prisma.outreachMessage.findFirst({
            where: { business_id: businessId, outreach_batch_id: batch.id },
            select: { id: true, version: true },
        });

        const message = existing
            ? await prisma.outreachMessage.update({
                where: { id: existing.id },
                data: {
                    subject: rendered.subject, html_body: rendered.html, text_body: rendered.text,
                    version: existing.version + 1, status: 'approved', approved_at: new Date(),
                },
                select: { id: true, version: true },
            })
            : await prisma.outreachMessage.create({
                data: {
                    business_id: businessId, outreach_batch_id: batch.id,
                    subject: rendered.subject, html_body: rendered.html, text_body: rendered.text,
                    status: 'approved', approved_at: new Date(),
                    created_by_user_id: (session.user as { id?: string }).id ?? null,
                },
                select: { id: true, version: true },
            });

        return NextResponse.json({ ok: true, approved: true, version: message.version });
    } catch (e) {
        console.error('[Outreach message] POST failed:', e);
        return NextResponse.json({ error: 'Failed to save the email' }, { status: 500 });
    }
}
