import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SupplierByIdRoute');

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id } = await params;
        const supplier = await prisma.supplier.findUnique({
            where: { id },
            include: {
                ingredients: {
                    orderBy: { name: 'asc' }
                }
            }
        });

        if (!supplier) return NextResponse.json({ error: 'Not Found' }, { status: 404 });

        // Global suppliers have no business_id; only scope-check tenant-owned ones
        if (supplier.business_id !== null && supplier.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        return NextResponse.json(supplier);
    } catch (e: any) {
        logger.error('GET supplier error', e);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id } = await params;
        const data = await req.json();

        const existing = await prisma.supplier.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: 'Not Found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const updated = await prisma.supplier.update({
            where: { id },
            data: {
                name: data.name,
                contact_email: data.contact_email,
                website_url: data.website_url,
                phone_number: data.phone_number,
                address: data.address,
                salesperson_name: data.salesperson_name,
                salesperson_email: data.salesperson_email,
                salesperson_phone: data.salesperson_phone,
                logo_url: data.logo_url,
                billing_address: data.billing_address,
                account_number: data.account_number,
                payment_terms: data.payment_terms,
                portal_type: data.portal_type,
                search_url_pattern: data.search_url_pattern
            }
        });

        return NextResponse.json(updated);
    } catch (e: any) {
        logger.error('PUT supplier error', e);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id } = await params;

        const existing = await prisma.supplier.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: 'Not Found' }, { status: 404 });
        if (existing.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        await prisma.supplier.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        logger.error('DELETE supplier error', e);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
