import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import crypto from 'crypto';
import { createCustomerSession } from '@/lib/customerAuth';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const token = searchParams.get('token');
        const email = searchParams.get('email');
        const businessId = searchParams.get('businessId');

        if (!token || !email || !businessId) {
            return new NextResponse('Invalid or missing link parameters.', { status: 400 });
        }

        const normalizedEmail = email.toLowerCase().trim();
        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        // 1. Verify token exists and is not expired
        const magicLink = await prisma.magicLinkToken.findUnique({
            where: { token: hashedToken }
        });

        if (!magicLink) {
            return new NextResponse('Invalid link. It might have already been used.', { status: 401 });
        }

        if (magicLink.expires_at < new Date()) {
            await prisma.magicLinkToken.delete({ where: { id: magicLink.id } });
            return new NextResponse('This link has expired. Please request a new one.', { status: 401 });
        }

        if (magicLink.email !== normalizedEmail || magicLink.business_id !== businessId) {
            return new NextResponse('Link mismatch. Please request a new one.', { status: 401 });
        }

        // 2. Token is valid. Fetch or Create Customer.
        let customer = await prisma.customer.findFirst({
            where: {
                business_id: businessId,
                OR: [
                    { contact_email: normalizedEmail },
                    // In some systems, the primary name field might hold the email for guests
                    { name: normalizedEmail }
                ]
            }
        });

        // 3. Auto-Create Customer if they don't exist yet
        if (!customer) {
            customer = await prisma.customer.create({
                data: {
                    business_id: businessId,
                    name: normalizedEmail.split('@')[0], // Give them a placeholder name
                    contact_email: normalizedEmail,
                    source: 'Magic Link',
                    status: 'ACTIVE'
                }
            });
        }

        // 4. Create the JWT Session Cookie
        await createCustomerSession({
            customerId: customer.id,
            email: normalizedEmail,
            businessId: businessId
        });

        // 5. Delete the one-time-use token to prevent replay attacks
        await prisma.magicLinkToken.delete({
            where: { id: magicLink.id }
        });

        // 6. Redirect them seamlessly into the Customer Portal!
        const business = await prisma.business.findUnique({ where: { id: businessId }, select: { slug: true } });

        if (!business) {
            return new NextResponse('Business not found', { status: 404 });
        }

        // 302 Redirect to the secure dashboard
        return NextResponse.redirect(new URL(`/shop/${business.slug}/account`, req.url));

    } catch (error: any) {
        console.error('[Customer Auth Verify] Error:', error);
        return new NextResponse('Internal server error during verification', { status: 500 });
    }
}
