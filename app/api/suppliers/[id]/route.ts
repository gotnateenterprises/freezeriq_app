
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// Helper to reliably get ID (Next.js 15 params are async, but in Route Handlers the 2nd arg is { params } object which doesn't need await in quite the same way as Page props, BUT in Next 15 it's changing. 
// Standard pattern: 
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
        return NextResponse.json(supplier);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const data = await req.json();

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
                payment_terms: data.payment_terms
            }
        });

        return NextResponse.json(updated);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        await prisma.supplier.delete({ where: { id } });
        return NextResponse.json({ success: true });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
