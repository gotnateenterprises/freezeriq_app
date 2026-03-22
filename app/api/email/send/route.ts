
import { NextResponse } from 'next/server';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const EMAIL_TEMPLATES = {
    'lead_intro': (name: string, orgName?: string) => ({
        subject: `Delicious, stress-free fundraising for ${orgName || 'your group'}`,
        html: `
            <p>Hi ${name || 'there'}!</p>
            <p>I’d love to help <strong>${orgName || 'your organization'}</strong> raise funds in a way that truly supports your families—by solving dinner time!</p>
            <p>With a Freezer Chef fundraiser, you aren't just raising money; you're giving families the gift of a wholesome, homemade dinner without the prep work.</p>
            
            <h3>Why moms and groups love this:</h3>
            <ul>
                <li><strong>Families Love It:</strong> Everyone needs dinner! These are comforting, ready-to-go meals (like delicious casseroles and crockpot favorites) that make weeknights easier.</li>
                <li><strong>Totally Stress-Free:</strong> We handle all the prep and sorting. You just smile and hand out the boxes.</li>
                <li><strong>Meaningful Profit:</strong> Your group keeps <strong>20%</strong> of every sale to support your goals.</li>
            </ul>

            <h3>It’s super simple:</h3>
            <ol>
                <li><strong>Pick a Date:</strong> choose a Tuesday, Wednesday, or Thursday for delivery.</li>
                <li><strong>Share the Love:</strong> We provide beautiful flyers and forms plus your own online order page and a personal Coordinator Dashboard to track everything in real time.</li>
                <li><strong>Delivery Day:</strong> We bring the meals right to you—distribution takes just 15-30 minutes!</li>
            </ol>

            <p><strong>Ready to simplify dinner for your community?</strong><br>
            I’d love to get a tentative date on the calendar for you or just chat about how we can make this your easiest fundraiser yet.</p>
            
            <p>Just reply to let me know which month you're thinking of!</p>
            
            <p>Warmly,</p>
            <p><strong>Laurie</strong><br>
            <a href="mailto:Laurie@MyFreezerChef.com">Laurie@MyFreezerChef.com</a><br>
            <a href="https://MyFreezerChef.com">MyFreezerChef.com</a></p>
        `
    }),
    'thank_you': (name: string, orgName?: string) => ({
        subject: `Congratulations on a Successful Fundraiser!`,
        html: `
            <p>Hi ${name || 'there'}!</p>
            <p>Congratulations again on a fantastic fundraiser for <strong>${orgName || 'your organization'}</strong>! It was a pleasure working with you to bring delicious, stress-free meals to your community.</p>
            <p>We hope everyone is enjoying their meals. We'd love to help you reach your next goal—it's never too early to get a tentative date on the calendar for your next round!</p>
            
            <p><strong>Could you help us out?</strong><br>
            If you loved your experience, would you mind sharing a brief testimonial? We’d love to feature your success on our Facebook, Google, and future sales materials to show other groups how easy fundraising can be.</p>
            
            <p>Just reply to this email with your thoughts!</p>
            
            <p>Warmly,</p>
            <p><strong>The Freezer Chef Team</strong><br>
            <a href="https://MyFreezerChef.com">MyFreezerChef.com</a></p>
        `
    })
};

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
                const generated = templateGen(customerName, organizationName);
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

        // Use Resend ONLY if API key is present AND Safety Mode is OFF (EMAIL_LIVE=true)
        const isLive = process.env.RESEND_API_KEY && process.env.EMAIL_LIVE === 'true';

        if (!isLive) {
            console.log(`[SAFETY MODE / MOCK EMAIL] To: ${to}, Bcc: ${bcc?.length || 0}, Attachments: ${processedAttachments?.length || 0}`);
            // Still update status so the workflow appears to progress in the UI
            if (customerId && context) {
                try {
                    const { progressStatus } = await import('@/lib/statusWorkflow');
                    const { prisma } = await import('@/lib/db');
                    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { status: true } });

                    if (customer) {
                        const status = customer.status;
                        if (context === 'intro' && status === 'LEAD') {
                            await progressStatus(customerId, 'email_intro');
                        } else if (context === 'info' && status === 'SEND_INFO') {
                            await progressStatus(customerId, 'email_info');
                        } else if (context === 'marketing' && status === 'FLYERS') {
                            await progressStatus(customerId, 'email_marketing');
                        }
                    }
                } catch (err) {
                    console.error("Error updating status in mock mode:", err);
                }
            }
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
            return NextResponse.json({ error: data.error.message }, { status: 500 });
        }

        // Update status after successful send
        if (customerId && context) {
            try {
                const { progressStatus } = await import('@/lib/statusWorkflow');
                const { prisma } = await import('@/lib/db');
                const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { status: true } });

                if (customer) {
                    const status = customer.status;
                    if (context === 'intro' && status === 'LEAD') {
                        await progressStatus(customerId, 'email_intro');
                    } else if (context === 'info' && status === 'SEND_INFO') {
                        await progressStatus(customerId, 'email_info');
                    } else if (context === 'marketing' && status === 'FLYERS') {
                        await progressStatus(customerId, 'email_marketing');
                    }
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
