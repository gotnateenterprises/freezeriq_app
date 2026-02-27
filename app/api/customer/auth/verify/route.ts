import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createCustomerSession } from '@/lib/customerAuth';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const token = searchParams.get('token');
        const slug = searchParams.get('slug');

        if (!token || !slug) {
            return new NextResponse('Invalid or missing parameters', { status: 400 });
        }

        // 1. Find and validate the token
        const magicLink = await prisma.magicLinkToken.findUnique({
            where: { token }
        });

        if (!magicLink) {
            return new NextResponse('Invalid link. It may have expired or already been used.', { status: 400 });
        }

        if (new Date() > magicLink.expires_at) {
            // Cleanup expired token
            await prisma.magicLinkToken.delete({ where: { token } });
            return new NextResponse('This login link has expired. Please request a new one.', { status: 400 });
        }

        // 2. Look up the specific customer
        const customer = await prisma.customer.findFirst({
            where: {
                contact_email: magicLink.email,
                business_id: magicLink.business_id
            }
        });

        if (!customer) {
            return new NextResponse('Customer account not found.', { status: 404 });
        }

        // 3. Create the HTTP-Only secure session cookie
        await createCustomerSession({
            customerId: customer.id,
            email: customer.contact_email || magicLink.email,
            businessId: customer.business_id!
        });

        // 4. Burn the used token to prevent replay attacks
        await prisma.magicLinkToken.delete({
            where: { token: magicLink.token }
        });

        // 5. Redirect the user into their secure Customer Portal
        const portalUrl = new URL(`/shop/${slug}/account`, request.url);
        return NextResponse.redirect(portalUrl);

    } catch (error) {
        console.error("Token verification error:", error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
