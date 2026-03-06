
import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import DocumentEmail from '@/components/emails/DocumentEmail';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const body = await req.json();
        const { recipient, subject, htmlContent, attachments, documentName } = body;

        // Validation
        if (!recipient) {
            return NextResponse.json({ error: "Recipient required" }, { status: 400 });
        }

        if (!process.env.RESEND_API_KEY) {
            console.error("Missing RESEND_API_KEY");
            return NextResponse.json({ error: "Email service not configured (Missing API Key)" }, { status: 500 });
        }

        // Construct attachments for Resend
        // Resend expects: { filename: string, content: Buffer | string }
        // The frontend sends base64 data URIs
        const formattedAttachments = attachments?.map((att: any) => {
            // content is "data:application/pdf;base64,....."
            // clean it if needed, but Resend handles content strings well?
            // Actually Resend node SDK prefers Buffer for content if it's raw, or just 'content' string.
            // If it's a data URI, we might need to strip the prefix? 
            // Let's rely on Resend handling it or standard fetch buffer.
            return {
                filename: att.name,
                content: att.content // Base64 string from FileReader
            };
        }) || [];

        const data = await resend.emails.send({
            from: 'Freezer Chef <docs@freezeriq.com>', // Update this to your verified domain!
            to: [recipient],
            subject: subject || 'New Document',
            react: DocumentEmail({
                subject: subject || 'New Document',
                message: htmlContent ? 'Please review the attached or inline content.' : undefined,
                documentName: documentName || 'Document'
            }),
            attachments: formattedAttachments,
            // If we want to send HTML directly instead of React template:
            // html: htmlContent
        });

        if (data.error) {
            console.error("Resend API Error:", data.error);
            return NextResponse.json({ error: data.error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true, id: data.data?.id });

    } catch (e: any) {
        console.error("Send Error:", e);
        return NextResponse.json({ error: "Failed to send email" }, { status: 500 });
    }
}
