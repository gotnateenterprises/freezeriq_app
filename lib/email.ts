import { Resend } from 'resend';
// FR-ACCEPTANCE-2A.1 — one subject sanitiser, not two. lib/emailTemplates.ts
// imports nothing at all (deliberately, so its bodies stay testable without a
// mail provider), so this dependency runs one way and cannot cycle.
import { safeSubject } from '@/lib/emailTemplates';

const resend = new Resend(process.env.RESEND_API_KEY);

// Platform-level sender (invites, password resets, etc.)
const FROM_EMAIL = process.env.EMAIL_FROM || 'onboarding@resend.dev';

/**
 * Build tenant-branded sender info for emails sent on behalf of a tenant business.
 * Returns { from, replyTo } where:
 *   from = "Freezer Chef via FreezerIQ <notifications@freezeriq.com>"
 *   replyTo = tenant's contact_email (if set)
 */
export async function getTenantSender(businessId: string): Promise<{ from: string; replyTo?: string }> {
    const { prisma } = await import('@/lib/db');

    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { name: true, contact_email: true }
    });

    if (!business) {
        return { from: FROM_EMAIL };
    }

    // Use platform domain as the actual sender, but display tenant name
    const platformDomain = FROM_EMAIL.match(/<(.+)>/)?.[1] || FROM_EMAIL;
    const from = `${business.name} via FreezerIQ <${platformDomain}>`;
    const replyTo = business.contact_email || undefined;

    return { from, replyTo };
}

// --- Platform-level emails (no tenant branding) ---

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

// --- HTML safety ---

/**
 * Escapes text before it is interpolated into an email HTML body.
 * Names, campaign/organization names, item names and phone numbers are
 * user- or database-controlled and must never be injected as raw markup.
 */
function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Presentation-only label for a variant size ("serves_5" → "Serves 5"). */
function formatVariantLabel(variantSize: string | null | undefined): string {
    const raw = (variantSize || '').trim();
    if (!raw) return '';
    const spaced = raw.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// --- Tenant-branded emails ---

export async function sendOrderConfirmationEmail(
    toEmail: string,
    order: any,
    items: any[],
    orgContactEmail?: string | null,
    paymentInstructions?: string | null,
    externalPaymentLink?: string | null,
    businessId?: string
) {
    if (!process.env.RESEND_API_KEY) return;

    // Resolve tenant sender if businessId provided
    const sender = businessId
        ? await getTenantSender(businessId)
        : { from: FROM_EMAIL };

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
        // FR-LAUNCH-1D: the customer confirmation goes to the CUSTOMER ONLY.
        // The campaign organization contact was previously appended to this same
        // recipient array, which (a) exposed the supporter's and coordinator's
        // addresses to each other in one To header and (b) sent the coordinator a
        // buyer-shaped "Order Received!" copy with no fundraiser context. The
        // coordinator now receives a separate, purpose-built notification —
        // sendFundraiserCoordinatorNotification below.
        //
        // orgContactEmail is intentionally retained in the signature (positional
        // compatibility for existing and future callers) but is no longer a recipient.
        const recipients = [toEmail];

        const { data, error } = await resend.emails.send({
            from: sender.from,
            to: recipients,
            replyTo: sender.replyTo,
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

// ── FR-LAUNCH-1D: fundraiser coordinator order notification ──────────────────

export interface FundraiserCoordinatorNotificationItem {
    item_name?: string | null;
    quantity?: number | null;
    variant_size?: string | null;
}

export interface FundraiserCoordinatorNotificationInput {
    /** The ONLY recipient. Campaign → Customer.contact_email, tenant-validated by the caller. */
    coordinatorEmail: string;
    campaignName?: string | null;
    organizationName?: string | null;
    supporterName?: string | null;
    /** Included so the coordinator can contact the supporter to collect payment. */
    supporterEmail?: string | null;
    supporterPhone?: string | null;
    participantName?: string | null;
    items: FundraiserCoordinatorNotificationItem[];
    /** Persisted server-authoritative order total — never a client-supplied value. */
    totalAmount: number;
    /** Safe external order reference (Order.external_id), not a raw database id. */
    orderReference: string;
    /** Enables the existing tenant-aware sender (from = tenant name, replyTo = tenant contact). */
    businessId?: string;
}

/**
 * Sends the fundraiser coordinator a purpose-built notification for one new
 * held order. Transactional and operational — NOT marketing automation.
 *
 * Exactly one recipient (the coordinator). The supporter is never included, and
 * this never carries the private coordinator portal_token, delivery address,
 * provider details, or loyalty data.
 *
 * Delivery is best-effort: returns the existing boolean convention from
 * sendEmail() and never throws for provider failures. Callers must treat a
 * false result as a delivery failure only — never as an order failure.
 */
export async function sendFundraiserCoordinatorNotification(
    input: FundraiserCoordinatorNotificationInput
): Promise<boolean> {
    const {
        coordinatorEmail,
        campaignName,
        organizationName,
        supporterName,
        supporterEmail,
        supporterPhone,
        participantName,
        items,
        totalAmount,
        orderReference,
        businessId,
    } = input;

    if (!coordinatorEmail || coordinatorEmail.trim().length === 0) return false;

    const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const total = currency.format(Number(totalAmount) || 0);
    const supporter = supporterName || 'A supporter';

    const itemsHtml = (items || []).map(i => {
        const variantLabel = formatVariantLabel(i.variant_size);
        return `
        <div style="border-bottom: 1px solid #e5e7eb; padding: 8px 0;">
            <p style="margin: 0; font-weight: bold; color: #1f2937;">${escapeHtml(i.quantity ?? 0)}x ${escapeHtml(i.item_name || 'Item')}</p>
            ${variantLabel ? `<p style="margin: 2px 0 0 0; font-size: 12px; color: #6b7280;">${escapeHtml(variantLabel)}</p>` : ''}
        </div>
    `;
    }).join('');

    const htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h1 style="color: #4f46e5; font-size: 22px;">New fundraiser order</h1>
            <p style="color: #374151;">
                <strong>${escapeHtml(supporter)}</strong> just placed an order
                ${campaignName ? `for <strong>${escapeHtml(campaignName)}</strong>` : ''}
                ${organizationName ? `(${escapeHtml(organizationName)})` : ''}.
            </p>

            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p style="margin: 0; color: #6b7280;">Order reference: ${escapeHtml(orderReference)}</p>
                ${supporterEmail ? `<p style="margin: 5px 0 0 0; color: #374151;"><strong>Email:</strong> <a href="mailto:${escapeHtml(supporterEmail)}" style="color: #4f46e5;">${escapeHtml(supporterEmail)}</a></p>` : ''}
                ${supporterPhone ? `<p style="margin: 5px 0 0 0; color: #374151;"><strong>Phone:</strong> ${escapeHtml(supporterPhone)}</p>` : ''}
                ${participantName ? `<p style="margin: 5px 0 0 0; color: #374151;"><strong>Supporting:</strong> ${escapeHtml(participantName)}</p>` : ''}
                <div style="margin-top: 15px;">
                    ${itemsHtml}
                </div>
                <div style="margin-top: 15px; border-top: 2px solid #d1d5db; padding-top: 10px;">
                    <strong style="color: #111827;">Total to collect: ${escapeHtml(total)}</strong>
                </div>
            </div>

            <p style="font-size: 13px; color: #6b7280;">
                This order is held for the fundraiser. It stays in the fundraiser workflow
                until the campaign is closed out, and payment is collected by you directly —
                no online payment was taken.
            </p>
        </div>
    `;

    return sendEmail({
        to: coordinatorEmail.trim(),
        subject: `New fundraiser order — ${supporter} · ${total} to collect`,
        html: htmlContent,
        businessId,
    });
}

export async function sendLeadNotificationEmail(
    toBusinessEmail: string,
    lead: {
        name: string, email: string, phone?: string, source: string, notes?: string,
        /**
         * FR-ACCEPTANCE-2A.1 — what happened to the automatic acknowledgement.
         *
         * A CALLER-CONTROLLED LITERAL, never user text and never provider error
         * text. It comes from a fixed mapping — acknowledgementNotice() in the
         * public intake route — so that this line cannot be made to say an
         * acknowledgement was sent when one was not.
         *
         * It is escaped along with everything else below. The mapping contains no
         * markup, so escaping is a no-op today; it is there so that a future
         * edit which routes something less trustworthy through this field cannot
         * reintroduce injection.
         *
         * Present so the tenant is never left guessing whether the person who
         * wrote in has already heard something back.
         */
        acknowledgement?: string,
    },
    businessId?: string
) {
    // FR-ACCEPTANCE-2A.1 — every interpolated field in the body below is ESCAPED.
    //
    // These values arrive from the UNAUTHENTICATED public fundraiser form: name,
    // email and phone are typed by the submitter, and `notes` is the assembled
    // free text of their website, cause and message. They were interpolated raw,
    // so anything typed into a public form on the open internet was rendered as
    // markup inside the tenant's own inbox — including a working link to an
    // attacker's site, sitting under a "New Lead!" heading the tenant trusts.
    //
    // The sibling sendFundraiserCoordinatorNotification already escaped every
    // field; this one simply did not.
    if (!process.env.RESEND_API_KEY) return;

    const sender = businessId
        ? await getTenantSender(businessId)
        : { from: FROM_EMAIL };

    try {
        const { data, error } = await resend.emails.send({
            from: sender.from,
            to: toBusinessEmail,
            replyTo: sender.replyTo,
            // FR-ACCEPTANCE-2A.1 — a HEADER built from public input.
            //
            // Escaping is the wrong tool here and would not have helped: a header
            // value has no escaping mechanism, and a newline inside one ENDS the
            // header so that whatever follows becomes a new one. That is how a
            // name typed into the public form becomes a `Bcc:` on the tenant's
            // own lead alert. safeSubject strips C0 controls and DEL while
            // leaving ordinary punctuation intact, so "Ben & Jerry's PTO"
            // survives unchanged.
            subject: safeSubject(`New Lead Captured: ${lead.name}`),
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #4f46e5;">New Lead!</h1>
                    <p>A new lead has been captured via the <strong>${escapeHtml(lead.source)}</strong>.</p>
                    <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                        <p style="margin: 0;"><strong>Name:</strong> ${escapeHtml(lead.name)}</p>
                        <p style="margin: 5px 0 0 0;"><strong>Email:</strong> ${escapeHtml(lead.email)}</p>
                        ${lead.phone ? `<p style="margin: 5px 0 0 0;"><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p>` : ''}
                        ${lead.notes ? `<p style="margin: 10px 0 0 0; font-size: 14px; color: #6b7280;"><strong>Notes:</strong> ${escapeHtml(lead.notes)}</p>` : ''}
                    </div>
                    ${lead.acknowledgement ? `<p style="margin: 0 0 20px 0; font-size: 14px; color: #374151;">${escapeHtml(lead.acknowledgement)}</p>` : ''}
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

export async function sendEmail({
    to,
    subject,
    html,
    businessId
}: {
    to: string | string[],
    subject: string,
    html: string,
    businessId?: string
}) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY is missing. Skipping email.');
        return false;
    }

    const sender = businessId
        ? await getTenantSender(businessId)
        : { from: FROM_EMAIL };

    try {
        const { data, error } = await resend.emails.send({
            from: sender.from,
            to: Array.isArray(to) ? to : [to],
            replyTo: sender.replyTo,
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

