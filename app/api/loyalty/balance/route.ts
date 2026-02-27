import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const email = searchParams.get('email');
        const businessId = searchParams.get('businessId');

        if (!email || !businessId) {
            return NextResponse.json({ error: 'Email and Business ID required' }, { status: 400 });
        }

        const customer = await prisma.customer.findFirst({
            where: {
                business_id: businessId,
                contact_email: { equals: email, mode: 'insensitive' }
            },
            select: {
                id: true,
                name: true,
                loyalty_balance: true
            }
        });

        if (!customer) {
            return NextResponse.json({ balance: 0, customerId: null, message: 'No account found for this email.' });
        }

        return NextResponse.json({
            balance: Number(customer.loyalty_balance) || 0,
            customerId: customer.id,
            name: customer.name
        });

    } catch (e: any) {
        console.error('Failed to fetch loyalty balance:', e);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
