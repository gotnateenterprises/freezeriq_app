
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        // FR-FLOW-1: the tenant is resolved from the storefront slug SERVER-SIDE.
        //
        // This route previously used the request's `businessId` directly as the
        // tenant authority — it was the WHERE for the duplicate lookup, the
        // business_id written on the new lead, and the lookup for whom to
        // notify. Anyone could POST an arbitrary businessId and plant a lead in
        // any tenant's CRM (and trigger mail to that tenant's user). The `slug`
        // was already being sent and simply ignored.
        //
        // Same pattern as app/api/public/order/route.ts: "Resolve Business from
        // slug (server-trusted, never from client businessId)". Any businessId
        // still present in the body is deliberately not read.
        const { name, email, slug } = await req.json();

        if (!email || !slug || typeof slug !== 'string') {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        const business = await prisma.business.findFirst({
            where: { slug: { equals: slug.toLowerCase().trim(), mode: 'insensitive' } },
            select: { id: true },
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }
        const businessId = business.id;

        // Check if customer exists - using contact_email as it's the unique identifier for contact
        const existingCustomer = await prisma.customer.findFirst({
            where: {
                contact_email: email,
                business_id: businessId
            }
        });

        if (existingCustomer) {
            // Update existing customer with tag if not present
            const currentTags = existingCustomer.tags || [];
            if (!currentTags.includes('surplus_waitlist')) {
                await prisma.customer.update({
                    where: { id: existingCustomer.id },
                    data: {
                        tags: [...currentTags, 'surplus_waitlist']
                    }
                });
            }
        } else {
            // Create new customer lead
            const newLead = await prisma.customer.create({
                data: {
                    business_id: businessId,
                    name: name || 'Waitlist Lead', // Name is required
                    contact_name: name,
                    contact_email: email,
                    type: 'direct_customer', // Correct enum value
                    status: 'LEAD',
                    tags: ['surplus_waitlist']
                }
            });

            // Trigger lead notification to business owner
            const owner = await prisma.user.findFirst({
                where: { business_id: businessId }
            });
            if (owner?.email) {
                const { sendLeadNotificationEmail } = await import('@/lib/email');
                // FR-FLOW-1: pass businessId so the notification uses the tenant's
                // own sender (getTenantSender) instead of falling back to the
                // platform FROM_EMAIL. Same call, third argument was omitted.
                await sendLeadNotificationEmail(owner.email, {
                    name: name || 'Waitlist Lead',
                    email: email,
                    source: 'Surplus Waitlist'
                }, businessId);
            }
        }

        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error('Waitlist Error:', error);
        return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
    }
}
