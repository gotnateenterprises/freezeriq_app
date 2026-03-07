import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { Resend } from 'resend';
import crypto from 'crypto';

const resend = new Resend(process.env.RESEND_API_KEY!);
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

export async function POST(req: Request) {
    try {
        const { email, businessId } = await req.json();

        if (!email || !businessId) {
            return NextResponse.json({ error: 'Email and Business ID are required' }, { status: 400 });
        }

        // 1. Fetch the business to get the slug for the magic link URL
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: { slug: true, name: true }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }

        const normalizedEmail = email.toLowerCase().trim();

        // 2. See if the customer already exists for this business. If not, we still send a link, and we'll create the account on first pass.
        // Actually, to keep our database clean, maybe we only create the Customer record ONCE they click the link.
        // For now, let's just create the Magic Link Token regardless.

        // 3. Generate a secure random token
        const rawToken = crypto.randomBytes(32).toString('hex');

        // Hash it before storing in DB for security (if DB leaks, tokens can't be used)
        const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

        // Set expiration (e.g., 30 minutes from now)
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

        // 4. Store the token in the database
        await prisma.magicLinkToken.create({
            data: {
                email: normalizedEmail,
                token: hashedToken,
                expires_at: expiresAt,
                business_id: businessId
            }
        });

        // 5. Construct the magic link URL exactly as they will click it
        // We pass the RAW token in the URL. When they click, we hash it and compare to DB.
        const magicLink = `${APP_URL}/api/public/customer/auth/verify?token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}&businessId=${businessId}`;

        // 6. Send the email via Resend
        await resend.emails.send({
            from: `Login <login@freezeriq.com>`, // Or a tenant-specific verified domain if available
            to: normalizedEmail,
            subject: `Sign in to ${business.name}`,
            html: `
                <div style="font-family: sans-serif; max-w: 600px; margin: 0 auto; padding: 20px; text-align: center;">
                    <h2>Welcome to ${business.name}</h2>
                    <p>Click the button below to sign in securely to your account. This link will expire in 30 minutes.</p>
                    <a href="${magicLink}" style="display: inline-block; background-color: #4f46e5; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; margin-top: 20px;">
                        Sign In Now
                    </a>
                    <p style="margin-top: 40px; color: #666; font-size: 12px;">
                        If you did not request this email, you can safely ignore it.
                    </p>
                </div>
            `
        });

        return NextResponse.json({ success: true, message: 'Magic link sent' });

    } catch (error: any) {
        console.error('[Customer Auth Request] Error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
