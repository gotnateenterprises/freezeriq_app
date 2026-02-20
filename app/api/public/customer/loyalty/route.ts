
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    const slug = searchParams.get('slug');

    if (!email || !slug) {
        return NextResponse.json({ error: 'Email and Slug are required' }, { status: 400 });
    }

    try {
        // 1. Find the business by slug
        const business = await prisma.business.findUnique({
            where: { slug },
            include: {
                users: {
                    include: { branding: true },
                    take: 1 // Assuming single-tenant or first user has branding for now
                }
            }
        });

        if (!business) {
            return NextResponse.json({ error: 'Business not found' }, { status: 404 });
        }

        const branding = business.users[0]?.branding;

        // 2. Find the customer in this business by email
        const customer = await prisma.customer.findFirst({
            where: {
                contact_email: email,
                business_id: business.id
            },
            include: {
                loyalty_points: {
                    orderBy: { created_at: 'desc' },
                    take: 20
                }
            }
        });

        if (!customer) {
            return NextResponse.json({ error: 'No loyalty record found for this email.' }, { status: 404 });
        }

        // 3. Return summary
        return NextResponse.json({
            // @ts-ignore - Stale Prisma Client
            balance: customer.loyalty_balance || 0,
            // @ts-ignore - Stale Prisma Client
            points: customer.loyalty_points,
            business_name: business.name,
            primary_color: branding?.primary_color || '#4f46e5'
        });

    } catch (error: any) {
        console.error('Loyalty Lookup Error:', error);
        return NextResponse.json({ error: 'Failed to fetch loyalty data' }, { status: 500 });
    }
}
