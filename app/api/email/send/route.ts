
import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { EMAIL_TEMPLATES } from '@/lib/emailTemplates';

const resend = new Resend(process.env.RESEND_API_KEY);

// FR-ACCEPTANCE-1C: the stock bodies moved to lib/emailTemplates.ts so they can
// be rendered and read by a test. See that file for why they had to change.

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { to, bcc, customerName, organizationName, template, subject: customSubject, html: customHtml, attachments, customerId, context } = body;

        if (!to && !bcc) {
            return NextResponse.json({ error: "No recipient (to/bcc) provided" }, { status: 400 });
        }

        let finalSubject = customSubject;
        let finalHtml = customHtml;

        // processing template if no custom content provided
        if (!finalHtml || !finalSubject) {
            const templateGen = EMAIL_TEMPLATES[template as keyof typeof EMAIL_TEMPLATES];
            if (templateGen) {
                // FR-ACCEPTANCE-1C: render the stock body as THIS tenant.
                //
                // Read from Business, which is the same row getTenantSender uses
                // to build the From header — so the signature inside the message
                // and the name on the envelope cannot disagree.
                //
                // Deliberately NOT TenantBranding: its business_name column
                // defaults to the literal "Freezer Chef", so a tenant who has
                // never opened the branding screen would sign their mail with
                // another company's name — the exact failure this replaces.
                const { prisma } = await import('@/lib/db');
                const business = await prisma.business.findUnique({
                    where: { id: session.user.businessId },
                    select: { name: true, display_name: true, custom_domain: true, contact_email: true, slug: true },
                });
                // FR-ACCEPTANCE-2A: the brand a CUSTOMER should read, and the
                // tenant's own website — not the platform storefront path when
                // they have a domain of their own. Both resolved in one place so
                // no template has to know the rules.
                const { resolveTenantBrand } = await import('@/lib/tenantBrand');
                const base = process.env.NEXTAUTH_URL?.replace(/\/+$/, '');
                const brand = business ? resolveTenantBrand(business, base) : null;
                const generated = templateGen(
                    customerName,
                    organizationName,
                    business && brand
                        ? {
                            name: brand.name,
                            email: business.contact_email ?? undefined,
                            site: brand.websiteUrl ?? undefined,
                            siteLabel: brand.websiteLabel ?? undefined,
                        }
                        : undefined
                );
                if (!finalSubject) finalSubject = generated.subject;
                if (!finalHtml) finalHtml = generated.html;
            } else if (!customHtml) {
                return NextResponse.json({ error: "Invalid template or missing content" }, { status: 400 });
            }
        }

        // Process attachments: Convert base64 strings to Buffers
        const processedAttachments = attachments?.map((att: any) => {
            if (typeof att.content === 'string') {
                return {
                    ...att,
                    content: Buffer.from(att.content, 'base64')
                };
            }
            return att;
        });

        // Preflight: verify customerId ownership before touching Resend or status workflow
        let verifiedCustomer: { status: string } | null = null;
        if (customerId) {
            const { prisma } = await import('@/lib/db');
            const customer = await prisma.customer.findUnique({
                where: { id: customerId },
                select: { business_id: true, status: true }
            });
            if (!customer) {
                return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
            }
            if (customer.business_id !== session.user.businessId) {
                return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
            }
            verifiedCustomer = customer;
        }

        // Use Resend ONLY if API key is present AND Safety Mode is OFF (EMAIL_LIVE=true)
        const isLive = process.env.RESEND_API_KEY && process.env.EMAIL_LIVE === 'true';

        if (!isLive) {
            console.log(`[SAFETY MODE / MOCK EMAIL] To: ${to}, Bcc: ${bcc?.length || 0}, Attachments: ${processedAttachments?.length || 0}`);
            // FR-ACCEPTANCE-1C: safety mode records NOTHING.
            //
            // This branch used to advance the customer's pipeline status here —
            // "Still update status so the workflow appears to progress in the UI".
            // That was written for a demo, where nobody is waiting on the email.
            // In a tenant's account it moved a real organization from Lead to
            // Send Info because of a message that never left the building, and
            // nothing anywhere recorded that the advance was fictional.
            //
            // Safety mode is not a demo switch: it is on whenever EMAIL_LIVE is
            // not exactly 'true'. (An earlier version of this comment asserted
            // that Production was in that state; it was never verified and is
            // now known to be false — EMAIL_LIVE is on. The code is correct in
            // either mode, which is the point.) The
            // tenants getting the fabricated progress were the paying ones.
            //
            // A simulated send now does exactly what it says — it logs, and it
            // tells the caller `mocked: true` so the caller can be honest too.
            // Demos that need to move a customer forward can use the explicit
            // status endpoint, which is what it is for.
            return NextResponse.json({ success: true, mocked: true });
        }

        // Resolve tenant-branded sender
        const { getTenantSender } = await import('@/lib/email');
        const sender = await getTenantSender(session.user.businessId);

        const data = await resend.emails.send({
            from: sender.from,
            to: Array.isArray(to) ? to : [to],
            bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined,
            replyTo: sender.replyTo,
            subject: finalSubject,
            html: finalHtml,
            attachments: processedAttachments
        });

        if (data.error) {
            console.error("Resend Error:", data.error);
            return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
        }

        // Update status after successful send
        if (customerId && context && verifiedCustomer) {
            try {
                const { progressStatus } = await import('@/lib/statusWorkflow');
                const status = verifiedCustomer.status;
                if (context === 'intro' && status === 'LEAD') {
                    await progressStatus(customerId, 'email_intro', session.user.businessId);
                } else if (context === 'info' && status === 'SEND_INFO') {
                    await progressStatus(customerId, 'email_info', session.user.businessId);
                } else if (context === 'marketing' && status === 'FLYERS') {
                    await progressStatus(customerId, 'email_marketing', session.user.businessId);
                }
            } catch (err) {
                console.error("Error updating status:", err);
            }
        }

        return NextResponse.json({ success: true, id: data.data?.id });

    } catch (e: any) {
        console.error("Email Send Error:", e);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
