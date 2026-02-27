import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Resend } from 'resend';
import crypto from 'crypto';

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');

export async function POST(req: Request) {
    try {
        const { email, businessId } = await req.json();

        if (!email || !businessId) {
            return NextResponse.json({ error: 'Email and businessId are required' }, { status: 400 });
        }

        // Verify the customer exists
        const customer = await prisma.customer.findFirst({
            where: { contact_email: email.toLowerCase(), business_id: businessId }
        });

        if (!customer) {
            // Standard security practice: Don't reveal if email exists or not
            return NextResponse.json({ success: true, message: 'If an account exists, a link has been sent.' });
        }

        // Generate a secure token
        const token = crypto.randomBytes(32).toString('hex');

        // Save token to DB, valid for 30 minutes
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 30);

        await prisma.magicLinkToken.create({
            data: {
                email: customer.contact_email || email,
                token,
                expires_at: expiresAt,
                business_id: businessId
            }
        });

        // Generate the magic link URL
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

        // We get the business slug to route them back to the correct storefront
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { slug: true, name: true }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }

        const magicLink = `${baseUrl}/api/customer/auth/verify?token=${token}&slug=${business.slug}`;

        if (!process.env.RESEND_API_KEY) {
            console.log("\n\n=== DEVELOPMENT MAGIC LINK ===");
            console.log(magicLink);
            console.log("==============================\n\n");
            return NextResponse.json({ success: true, simulated: true, link: magicLink });
        }

        // Send Email
        await resend.emails.send({
            from: `${business.name} <orders@freezeriq.com>`, // Must be verified in Resend for production
            to: [customer.contact_email || email],
            subject: `Log in to your ${business.name} account`,
            text: `Hello!\n\nClick the link below to securely log in to your account. This link expires in 30 minutes.\n\n${magicLink}\n\nIf you did not request this, you can safely ignore this email.`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2>Secure Login for ${business.name}</h2>
                    <p>Click the button below to securely access your account. No password required.</p>
                    <a href="${magicLink}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; margin: 20px 0;">
                        Log In Now
                    </a>
                    <p style="font-size: 14px; color: #666;">Or copy and paste this link: <br/> ${magicLink}</p>
                    <p style="font-size: 12px; color: #999; margin-top: 40px;">This link will expire in 30 minutes. If you did not request this, please ignore this email.</p>
                </div>
            `
        });

        return NextResponse.json({ success: true });

    } catch (error) {
        console.error("Magic Link Request Error:", error);
        return NextResponse.json({ error: 'Failed to process request' }, { status: 500 });
    }
}
