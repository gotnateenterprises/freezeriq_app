import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Helper to determine the "From" address
// In development/testing without a verified domain, Resend requires 'onboarding@resend.dev'
const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';

export async function sendInviteEmail(email: string, tempPassword: string) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY is missing. Skipping email.');
        return;
    }

    try {
        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: email,
            subject: 'Welcome to FreezerIQ™!',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #4f46e5;">Welcome to FreezerIQ™</h1>
                    <p>You have been invited to join the <strong>FreezerIQ™</strong> team.</p>
                    <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 0; font-size: 14px; color: #6b7280;">Your Temporary Password:</p>
                        <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold; font-family: monospace; color: #111827;">${tempPassword}</p>
                    </div>
                    <p>Please log in and change your password immediately.</p>
                    <a href="${process.env.NEXTAUTH_URL}/login" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Log In Now</a>
                    <p style="margin-top: 30px; font-size: 12px; color: #9ca3af;">If you didn't expect this invitation, please ignore this email.</p>
                </div>
            `
        });

        if (error) {
            console.error('[EMAIL ERROR]', error);
            return false;
        }

        console.log(`[EMAIL SENT] Invite sent to ${email} (ID: ${data?.id})`);
        return true;
    } catch (e) {
        console.error('[EMAIL EXCEPTION]', e);
        return false;
    }
}

export async function sendPasswordResetEmail(email: string, tempPassword: string) {
    if (!process.env.RESEND_API_KEY) return;

    try {
        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: email,
            subject: 'FreezerIQ™ Password Reset',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #e11d48;">Password Reset Request</h1>
                    <p>An administrator has reset your password for <strong>FreezerIQ™</strong>.</p>
                    <div style="background: #fff1f2; padding: 20px; border-radius: 8px; margin: 20px 0; border: 1px solid #fda4af;">
                        <p style="margin: 0; font-size: 14px; color: #881337;">Your New Temporary Password:</p>
                        <p style="margin: 5px 0 0 0; font-size: 24px; font-weight: bold; font-family: monospace; color: #e11d48;">${tempPassword}</p>
                    </div>
                    <p>Please use this password to log in, then update your password in Settings.</p>
                    <a href="${process.env.NEXTAUTH_URL}/login" style="display: inline-block; background: #e11d48; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Log In Now</a>
                </div>
            `
        });

        if (error) {
            console.error('[EMAIL ERROR]', error);
            return false;
        }

        console.log(`[EMAIL SENT] Reset sent to ${email} (ID: ${data?.id})`);
        return true;
    } catch (e) {
        console.error('[EMAIL EXCEPTION]', e);
        return false;
    }
}

export async function sendOrderConfirmationEmail(
    toEmail: string,
    order: any,
    items: any[],
    orgContactEmail?: string | null,
    paymentInstructions?: string | null,
    externalPaymentLink?: string | null
) {
    if (!process.env.RESEND_API_KEY) return;

    const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const total = currency.format(Number(order.total_amount));

    // Construct Item List
    const itemsHtml = items.map(i => `
        <div style="border-bottom: 1px solid #e5e7eb; padding: 10px 0;">
            <p style="margin: 0; font-weight: bold; color: #1f2937;">${i.quantity}x ${i.bundle?.name || 'Item'}</p>
            <p style="margin: 0; font-size: 12px; color: #6b7280;">Size: ${i.variant_size}</p>
        </div>
    `).join('');

    // Payment Section
    let paymentHtml = '';
    if (externalPaymentLink) {
        paymentHtml += `
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0 0 10px 0; font-weight: bold; color: #1e3a8a;">Payment Required</p>
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #1e40af;">Please complete your payment using the link below:</p>
                <a href="${externalPaymentLink}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">Pay Now</a>
            </div>
        `;
    }
    if (paymentInstructions) {
        paymentHtml += `
            <div style="background: #f9fafb; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0 0 5px 0; font-weight: bold; color: #374151;">Payment Instructions:</p>
                <p style="margin: 0; font-size: 14px; white-space: pre-wrap; color: #4b5563;">${paymentInstructions}</p>
            </div>
        `;
    }

    const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #4f46e5;">Order Received!</h1>
            <p>Thank you, <strong>${order.customer_name}</strong>. We have received your order.</p>
            
            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0; color: #111827;">Order Summary</h3>
                <p style="margin: 0; color: #6b7280;">Order ID: ${order.external_id}</p>
                <div style="margin-top: 15px;">
                    ${itemsHtml}
                </div>
                <div style="margin-top: 15px; border-top: 2px solid #d1d5db; padding-top: 10px; display: flex; justify-content: space-between;">
                    <strong>Total</strong>
                    <strong>${total}</strong>
                </div>
            </div>

            ${paymentHtml}

            <p style="font-size: 13px; color: #6b7280; margin-top: 30px;">
                If you have questions, please reply to this email.
            </p>
        </div>
    `;

    try {
        const recipients = [toEmail];
        if (orgContactEmail) recipients.push(orgContactEmail);

        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: recipients, // Send to both customer and org
            subject: `Order Confirmation: ${order.customer_name}`,
            html: htmlContent
        });

        if (error) {
            console.error('[EMAIL ERROR]', error);
            return false;
        }

        console.log(`[EMAIL SENT] Order confirmation sent to ${recipients.join(', ')} (ID: ${data?.id})`);
        return true;
    } catch (e) {
        console.error('[EMAIL EXCEPTION]', e);
        return false;
    }
}

export async function sendLeadNotificationEmail(
    toBusinessEmail: string,
    lead: { name: string, email: string, phone?: string, source: string, notes?: string }
) {
    if (!process.env.RESEND_API_KEY) return;

    try {
        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: toBusinessEmail,
            subject: `New Lead Captured: ${lead.name}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #4f46e5;">New Lead!</h1>
                    <p>A new lead has been captured via the <strong>${lead.source}</strong>.</p>
                    <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 0;"><strong>Name:</strong> ${lead.name}</p>
                        <p style="margin: 5px 0 0 0;"><strong>Email:</strong> ${lead.email}</p>
                        ${lead.phone ? `<p style="margin: 5px 0 0 0;"><strong>Phone:</strong> ${lead.phone}</p>` : ''}
                        ${lead.notes ? `<p style="margin: 10px 0 0 0; font-size: 14px; color: #6b7280;"><strong>Notes:</strong> ${lead.notes}</p>` : ''}
                    </div>
                    <a href="${process.env.NEXTAUTH_URL}/pipeline" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">View Lead in CRM</a>
                </div>
            `
        });

        if (error) {
            console.error('[EMAIL ERROR]', error);
            return false;
        }

        console.log(`[EMAIL SENT] Lead notification sent to ${toBusinessEmail} (ID: ${data?.id})`);
        return true;
    } catch (e) {
        console.error('[EMAIL EXCEPTION]', e);
        return false;
    }
}

export async function sendEmail({ to, subject, html }: { to: string | string[], subject: string, html: string }) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY is missing. Skipping email.');
        return false;
    }

    try {
        const { data, error } = await resend.emails.send({
            from: FROM_EMAIL,
            to: Array.isArray(to) ? to : [to],
            subject,
            html
        });

        if (error) {
            console.error('[EMAIL ERROR]', error);
            return false;
        }

        console.log(`[EMAIL SENT] Email (${subject}) sent to ${to} (ID: ${data?.id})`);
        return true;
    } catch (e) {
        console.error('[EMAIL EXCEPTION]', e);
        return false;
    }
}
