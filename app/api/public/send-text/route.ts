import { NextResponse } from 'next/server';
import twilio from 'twilio';

// Initialize the Twilio client if credentials exist in the environment
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_PHONE_NUMBER;

const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { to, message } = body;

        // Basic validation
        if (!to || !Array.isArray(to) || to.length === 0) {
            return NextResponse.json({ error: 'Recipient phone numbers (array) are required' }, { status: 400 });
        }
        if (!message || message.trim() === '') {
            return NextResponse.json({ error: 'Message body cannot be empty' }, { status: 400 });
        }

        // Check if Twilio is configured
        if (!client || !fromPhone) {
            console.warn('[Twilio] Attempted to send SMS but Twilio credentials are not fully configured in .env');
            return NextResponse.json({
                error: 'SMS service is not configured. Please add Twilio credentials to your environment variables.'
            }, { status: 503 }); // 503 Service Unavailable
        }

        console.log(`[Twilio API] Preparing to send SMS blast to ${to.length} recipients...`);

        // Send the SMS messages concurrently
        // Note: For very large lists (1000+), you would want to batch these or use Twilio Notify/Messaging Services.
        // For standard small local lists, Promise.all is perfectly fine.
        const sendPromises = to.map(async (phoneNumber: string) => {
            // Ensure phone number starts with +1 (US format) if it doesn't already have a country code
            let formattedPhone = phoneNumber.trim();
            if (!formattedPhone.startsWith('+')) {
                // Remove non-numeric characters just to be safe
                const digitsOnly = formattedPhone.replace(/\D/g, '');
                if (digitsOnly.length === 10) {
                    formattedPhone = `+1${digitsOnly}`;
                } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
                    formattedPhone = `+${digitsOnly}`;
                }
            }

            try {
                const result = await client.messages.create({
                    body: message,
                    from: fromPhone,
                    to: formattedPhone
                });
                return { success: true, phone: formattedPhone, sid: result.sid };
            } catch (err: any) {
                console.error(`[Twilio Error] Failed to send to ${formattedPhone}:`, err.message);
                return { success: false, phone: formattedPhone, error: err.message };
            }
        });

        const results = await Promise.all(sendPromises);

        // Check if there were any failures
        const failures = results.filter(r => !r.success);

        if (failures.length === results.length) {
            console.error('[Twilio API] ALL messages failed to send:', failures);
            return NextResponse.json({ error: 'All messages failed to send', details: failures }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            message: `Sent ${results.length - failures.length} out of ${results.length} messages successfully.`,
            results
        });

    } catch (error: any) {
        console.error('[Twilio API Generic Error]:', error);
        return NextResponse.json({ error: 'Internal server error while processing SMS request' }, { status: 500 });
    }
}
