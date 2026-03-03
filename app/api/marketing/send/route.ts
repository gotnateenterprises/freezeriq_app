import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Resend } from 'resend';
import twilio from 'twilio';

// Initialize the Twilio client if credentials exist
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = accountSid && authToken ? twilio(accountSid, authToken) : null;

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';

export async function POST(request: Request) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const user = session.user as any;
        const businessId = user.businessId;
        const plan = user.plan;
        const isSuperAdmin = user.isSuperAdmin;

        if (!businessId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const hasAccess = plan === 'ENTERPRISE' || plan === 'ULTIMATE' || plan === 'FREE' || isSuperAdmin;
        if (!hasAccess) {
            return NextResponse.json({ error: "Upgrade Now" }, { status: 403 });
        }

        const body = await request.json();
        const { subject, body: messageBody, channel, audienceType, targetRecipient } = body;

        if (!subject || !messageBody) {
            return NextResponse.json({ error: 'Subject and Body are required' }, { status: 400 });
        }

        // 1. Fetch the Target Audience List
        let recipients: any[] = [];
        let queryArgs: any = { business_id: businessId, archived: false };

        if (audienceType === 'single') {
            if (!targetRecipient) return NextResponse.json({ error: 'Missing target recipient' }, { status: 400 });
            // For single, we don't need a DB query, just use the provided email/phone
        } else {
            if (audienceType === 'individual') {
                queryArgs.type = 'direct_customer';
            } else if (audienceType === 'organization') {
                queryArgs.type = { in: ['fundraiser_org', 'organization'] };
            } else if (audienceType === 'waitlist') {
                queryArgs.tags = { has: 'surplus_waitlist' };
            } else if (audienceType === 'subscribers') {
                queryArgs.stripe_subscription_id = { not: null };
            }
            // Execute Query to get raw list
            recipients = await prisma.customer.findMany({
                where: queryArgs,
                select: { contact_email: true, contact_phone: true, name: true }
            });
        }

        // Extract Contacts
        let phoneNumbers: string[] = [];
        let emailAddresses: string[] = [];

        if (audienceType === 'single') {
            if (channel === 'sms') phoneNumbers.push(targetRecipient);
            if (channel === 'email') emailAddresses.push(targetRecipient);
        } else {
            if (channel === 'sms') {
                phoneNumbers = recipients
                    .map(c => c.contact_phone)
                    .filter(p => p && p.trim().length > 0) as string[];
            } else if (channel === 'email') {
                emailAddresses = recipients
                    .map(c => c.contact_email)
                    .filter(e => e && e.trim().length > 0 && e.includes('@')) as string[];
            }
        }

        const audienceSize = channel === 'sms' ? phoneNumbers.length : emailAddresses.length;

        if (audienceSize === 0) {
            return NextResponse.json({ error: 'No valid recipients found for this audience' }, { status: 400 });
        }

        // 2. Dispatch
        let successCount = 0;
        let failCount = 0;

        if (channel === 'sms') {
            if (!twilioClient || !fromPhone) {
                return NextResponse.json({ error: 'SMS service is not configured. Add Twilio credentials to .env' }, { status: 503 });
            }

            console.log(`[Marketing] Sending ${audienceSize} SMS messages via Twilio...`);

            const sendPromises = phoneNumbers.map(async (phoneNumber: string) => {
                let formattedPhone = phoneNumber.trim();
                if (!formattedPhone.startsWith('+')) {
                    const digitsOnly = formattedPhone.replace(/\D/g, '');
                    if (digitsOnly.length === 10) formattedPhone = `+1${digitsOnly}`;
                    else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) formattedPhone = `+${digitsOnly}`;
                }

                try {
                    await twilioClient.messages.create({
                        body: messageBody,
                        from: fromPhone,
                        to: formattedPhone
                    });
                    return true;
                } catch (err: any) {
                    console.error(`[Twilio Error] Failed to send to ${formattedPhone}:`, err.message);
                    return false;
                }
            });

            const results = await Promise.all(sendPromises);
            successCount = results.filter(r => r === true).length;
            failCount = results.length - successCount;

        } else if (channel === 'email') {
            if (!process.env.RESEND_API_KEY) {
                return NextResponse.json({ error: 'Email service is not configured. Add Resend API key to .env' }, { status: 503 });
            }

            console.log(`[Marketing] Sending ${audienceSize} Emails via Resend (BCC limit chunking may apply for large lists)...`);

            // Resend BCC limit is 50. We will chunk the arrays.
            const chunkSize = 50;
            const chunks = [];
            for (let i = 0; i < emailAddresses.length; i += chunkSize) {
                chunks.push(emailAddresses.slice(i, i + chunkSize));
            }

            const formatHtml = (content: string) => `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.5;">
                    ${content.split('\\n').map(p => `<p>${p}</p>`).join('')}
                    <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0 20px;" />
                    <p style="font-size: 12px; color: #9ca3af; text-align: center;">
                        You are receiving this email because you are subscribed to updates from FreezerIQ™.
                    </p>
                </div>
            `;

            for (const chunk of chunks) {
                try {
                    const { error } = await resend.emails.send({
                        from: FROM_EMAIL,
                        to: FROM_EMAIL, // Must send to ourselves when BCCing
                        bcc: chunk,
                        subject: subject,
                        html: formatHtml(messageBody)
                    });
                    if (error) {
                        failCount += chunk.length;
                        console.error('[Resend Error]', error);
                    } else {
                        successCount += chunk.length;
                    }
                } catch (e: any) {
                    failCount += chunk.length;
                }
            }
        }

        // 3. Log Activity to Database (TODO: Add a Campaign Model, for now just returning success)

        if (successCount === 0 && failCount > 0) {
            return NextResponse.json({ error: `All ${failCount} messages failed to send.` }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            message: `Sent successfully to ${successCount} recipients${failCount > 0 ? ` (${failCount} failed)` : ''}`,
            stats: {
                sent: successCount,
                failed: failCount
            }
        });

    } catch (e: any) {
        return NextResponse.json({ error: e.message || 'Failed to process campaign' }, { status: 500 });
    }
}

export async function GET() {
    // Returning empty array for now until a true Campaign model is built.
    return NextResponse.json([]);
}
