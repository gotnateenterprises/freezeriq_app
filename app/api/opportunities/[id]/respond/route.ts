/**
 * FR-REBOOK-1A — reply to a fundraiser inquiry, with the actual message in front
 * of you.
 *
 * WHY THIS EXISTS AS ITS OWN ROUTE
 *
 * The respond dialog used to POST /api/email/send with `{ to, template:
 * 'lead_intro' }`. Two things were wrong with that for this surface:
 *
 *   1. The owner could not see or change a word of what went out. The dialog
 *      described the email — "Your standard fundraiser introduction" — and the
 *      server rendered the real thing after the click. You cannot personalise a
 *      message you are not shown.
 *   2. `to` travelled from the browser. /api/email/send takes the recipient
 *      verbatim and its tenant-ownership preflight is keyed on `customerId`,
 *      which that call never sent — so nothing tied the address to the
 *      organization being answered, or to the tenant at all.
 *
 * GET  returns the canonical draft: the recipient this tenant is actually
 *      replying to, plus the subject and body rendered by the SAME
 *      EMAIL_TEMPLATES.lead_intro generator the automatic path uses.
 * POST sends it, taking the subject and body the owner edited — and nothing else.
 *
 * ONE TEMPLATE, NOT TWO. The draft is rendered server-side by the canonical
 * generator rather than reimplemented in the browser, because the tenant brand it
 * needs (business name, contact address, website, signature block) is resolved
 * from the database through resolveTenantBrand. A client-side copy would drift
 * from the acknowledgement the moment either changed, and the two are supposed to
 * be the same letter.
 *
 * RECIPIENT AUTHORITY IS SERVER-SIDE, ALWAYS. It is derived from the
 * opportunity's own customer inside this tenant. The client cannot propose one,
 * so it cannot redirect a reply to another organization or another tenant — the
 * same rule INV-C's invoice send already follows.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { Resend } from 'resend';
import { EMAIL_TEMPLATES, safeSubject } from '@/lib/emailTemplates';
import { resolveTenantBrand } from '@/lib/tenantBrand';
import { htmlToEditableText, editableTextToEmailHtml } from '@/lib/plainTextEmail';

/** Bounds for what the owner may edit. Generous for prose, closed for abuse. */
export const RESPOND_SUBJECT_MAX = 200;
export const RESPOND_BODY_MAX = 20_000;

/**
 * The opportunity, its organization, and whether a real inquiry exists.
 * Everything the draft and the send need, resolved once, tenant-scoped.
 */
async function loadTarget(opportunityId: string, businessId: string) {
    return prisma.fundraiserOpportunity.findFirst({
        where: { id: opportunityId, business_id: businessId },
        select: {
            id: true,
            status: true,
            customer: { select: { id: true, name: true, contact_name: true, contact_email: true } },
            _count: { select: { inquiries: true } },
        },
    });
}

/** The canonical draft, rendered by the shared generator with this tenant's brand. */
async function renderDraft(businessId: string, contactName: string, organizationName: string) {
    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true },
    });
    const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
    const brand = business ? resolveTenantBrand(business, base) : null;
    return EMAIL_TEMPLATES.lead_intro(
        contactName,
        organizationName,
        business && brand
            ? {
                name: brand.name,
                email: business.contact_email ?? undefined,
                site: brand.websiteUrl ?? undefined,
                siteLabel: brand.websiteLabel ?? undefined,
            }
            : undefined,
    );
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;
        if (!session?.user || !businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const { id } = await ctx.params;

        const target = await loadTarget(id, businessId);
        if (!target) {
            // Same answer for "not yours" as for "does not exist".
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        const draft = await renderDraft(
            businessId,
            target.customer?.contact_name ?? '',
            target.customer?.name ?? '',
        );

        return NextResponse.json({
            // Shown, never accepted back. The dialog renders this read-only, and
            // it is the SAME field the send resolves from — the UI cannot show one
            // address while the server writes to another.
            to: target.customer?.contact_email ?? null,
            organizationName: target.customer?.name ?? '',
            contactName: target.customer?.contact_name ?? null,
            subject: draft.subject,
            // TEXT, not HTML. The owner edits prose; the markup is chosen by the
            // server at send time. Derived from the canonical template rather than
            // written out again, so there is still exactly one letter.
            text: htmlToEditableText(draft.html),
            // FR-REBOOK-1A: an owner-initiated opportunity has no inquiry, and
            // nothing here should imply one is waiting for an answer.
            hasInquiry: target._count.inquiries > 0,
        });
    } catch (e: any) {
        console.error('[OPPORTUNITY_RESPOND_GET]', e);
        return NextResponse.json({ error: 'Failed to load the draft' }, { status: 500 });
    }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
    try {
        const session = await auth();
        const businessId = (session?.user as any)?.businessId as string | undefined;
        if (!session?.user || !businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
        const { id } = await ctx.params;

        const target = await loadTarget(id, businessId);
        if (!target) {
            return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 });
        }

        // ── RECIPIENT AUTHORITY. Derived here, never accepted. A `to` in the
        //    request body is ignored entirely rather than validated, because
        //    there is no version of this feature where the browser gets to choose
        //    who a reply reaches.
        const recipient = target.customer?.contact_email?.trim();
        if (!recipient) {
            return NextResponse.json(
                { error: 'This organization has no email address on file.' },
                { status: 400 },
            );
        }

        // ── FAIL CLOSED WITHOUT AN INQUIRY.
        //
        // This endpoint answers a fundraiser inquiry. An opportunity the tenant
        // opened themselves has none, so there is nothing here to reply to — and
        // hiding the button in the panel is not a control, it is a suggestion.
        // Anyone who reaches the route directly gets the same answer the UI gives.
        if (target._count.inquiries === 0) {
            return NextResponse.json(
                {
                    error: 'This organization has no website inquiry to reply to. Set a preferred date to move it forward.',
                    code: 'no_inquiry',
                },
                { status: 409 },
            );
        }

        let body: any = {};
        try { body = await req.json(); } catch { /* validated below */ }

        const rawSubject = typeof body?.subject === 'string' ? body.subject.trim() : '';
        // TEXT ONLY. `html` is not read from the request at all — accepting markup
        // from the browser would turn a personalisation box into a general HTML
        // email sender for any authenticated user.
        const rawText = typeof body?.text === 'string' ? body.text : '';

        if (!rawSubject || !rawText.trim()) {
            return NextResponse.json(
                { error: 'A subject and a message are required.' },
                { status: 400 },
            );
        }
        if (rawSubject.length > RESPOND_SUBJECT_MAX) {
            return NextResponse.json(
                { error: `Keep the subject under ${RESPOND_SUBJECT_MAX} characters.` },
                { status: 400 },
            );
        }
        if (rawText.length > RESPOND_BODY_MAX) {
            return NextResponse.json(
                { error: 'That message is too long to send.' },
                { status: 400 },
            );
        }

        // safeSubject strips newlines — the same treatment every templated subject
        // gets — so an edited subject cannot inject headers.
        const subject = safeSubject(rawSubject);

        // ── Safety mode, honoured exactly as /api/email/send honours it. A 200
        //    here does not mean anyone was written to, and the caller is told so
        //    plainly rather than being allowed to record a reply that never left.
        // The owner's words, escaped and wrapped in markup this file chose. The
        // tenant signature is composed from server-resolved fields, never posted.
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true },
        });
        const brandBase = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
        const brand = business ? resolveTenantBrand(business, brandBase) : null;
        const finalHtml = editableTextToEmailHtml(rawText, brand
            ? { name: brand.name, email: business?.contact_email, site: brand.websiteUrl, siteLabel: brand.websiteLabel }
            : undefined);

        const isLive = Boolean(process.env.RESEND_API_KEY) && process.env.EMAIL_LIVE === 'true';
        if (!isLive) {
            console.log(`[SAFETY MODE / MOCK EMAIL] opportunity respond ${target.id} to=${recipient} — nothing sent`);
            return NextResponse.json({ success: true, mocked: true, to: recipient });
        }

        try {
            const { getTenantSender } = await import('@/lib/email');
            const sender = await getTenantSender(businessId);
            const resend = new Resend(process.env.RESEND_API_KEY);
            const data = await resend.emails.send({
                from: sender.from,
                to: [recipient],
                replyTo: sender.replyTo,
                subject,
                html: finalHtml,
            });
            if (data.error) {
                console.error('[OPPORTUNITY_RESPOND] provider error:', data.error);
                // Provider text never reaches the browser.
                return NextResponse.json(
                    { success: false, error: 'The email could not be sent. Please try again.' },
                    { status: 502 },
                );
            }
            return NextResponse.json({ success: true, mocked: false, to: recipient });
        } catch (err: any) {
            console.error('[OPPORTUNITY_RESPOND] send failed:', err?.message);
            return NextResponse.json(
                { success: false, error: 'The email could not be sent. Please try again.' },
                { status: 502 },
            );
        }
    } catch (e: any) {
        console.error('[OPPORTUNITY_RESPOND_POST]', e);
        return NextResponse.json({ error: 'Something went wrong sending that reply.' }, { status: 500 });
    }
}
