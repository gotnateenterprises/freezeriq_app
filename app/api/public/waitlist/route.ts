
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const { name, email, phone, businessId, slug } = await req.json();

        if (!email || !businessId) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

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
            if (!currentTags.includes('surplus_waitlist') || (phone && !existingCustomer.contact_phone)) {
                await prisma.customer.update({
                    where: { id: existingCustomer.id },
                    data: {
                        tags: currentTags.includes('surplus_waitlist') ? currentTags : [...currentTags, 'surplus_waitlist'],
                        contact_phone: existingCustomer.contact_phone || phone || null
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
                    contact_phone: phone || null,
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
                await sendLeadNotificationEmail(owner.email, {
                    name: name || 'Waitlist Lead',
                    email: email,
                    source: 'Surplus Waitlist'
                });
            }
        }

        return NextResponse.json({ success: true });

    } catch (error: any) {
        console.error('Waitlist Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
