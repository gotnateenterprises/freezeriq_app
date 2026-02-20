
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET() {
    try {
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

        // TODO: Calc total spend if purchase orders exist
        return NextResponse.json(suppliers);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const data = await req.json();

        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
