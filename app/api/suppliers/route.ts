import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';
import { withErrorHandler } from '@/lib/api-middleware';
import { UnauthorizedError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SuppliersRoute');

export const GET = withErrorHandler(async () => {
    const session = await auth();
    if (!session?.user?.businessId) {
        throw new UnauthorizedError('Unauthorized');
    }

    const allSuppliers = await prisma.supplier.findMany({
        where: { business_id: session.user.businessId },
        orderBy: { name: 'asc' },
        include: {
            _count: {
                select: { ingredients: true }
            }
        }
    });

    // Filter out "Batch Item" supplier
    const suppliers = allSuppliers.filter(s => s.name.toLowerCase() !== 'batch item');

    return NextResponse.json(suppliers);
});

export const POST = withErrorHandler(async (req: Request) => {
    const data = await req.json();

    const session = await auth();
    if (!session?.user?.businessId) {
        throw new UnauthorizedError('Unauthorized');
    }

    const supplier = await prisma.supplier.create({
        data: {
            name: data.name,
            contact_email: data.contact_email,
            website_url: data.website_url,
            phone_number: data.phone_number,
            address: data.address,
            salesperson_name: data.salesperson_name,
            salesperson_email: data.salesperson_email,
            salesperson_phone: data.salesperson_phone,
            // New Fields
            logo_url: data.logo_url,
            billing_address: data.billing_address,
            account_number: data.account_number,
            payment_terms: data.payment_terms,
            business_id: session.user.businessId
        }
    });
    return NextResponse.json(supplier);
});
