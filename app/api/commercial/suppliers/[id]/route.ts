
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/auth';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id } = await params;
        const supplier = await prisma.supplier.findUnique({
            where: { id },
            include: {
                ingredients: true
            }
        });

        if (!supplier) {
            return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
        }

        // Global suppliers have no business_id; only scope-check tenant-owned ones
        if (supplier.business_id !== null && supplier.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        return NextResponse.json(supplier);
    } catch (e) {
        console.error("GET Supplier Error:", e);
        return NextResponse.json({ error: "Error fetching supplier" }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const session = await auth();
    if (!session?.user?.businessId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const { id } = await params;
        const body = await req.json();

        const existing = await prisma.supplier.findUnique({ where: { id }, select: { business_id: true } });
        if (!existing) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
        if (existing.business_id !== session.user.businessId) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Allowed fields
        const {
            name,
            contact_email,
            website_url,
            phone_number,
            address,
            salesperson_name,
            salesperson_email,
            salesperson_phone
        } = body;

        const updated = await prisma.supplier.update({
            where: { id },
            data: {
                name,
                contact_email,
                website_url,
                phone_number,
                address,
                salesperson_name,
                salesperson_email,
                salesperson_phone
            }
        });

        return NextResponse.json(updated);
    } catch (e) {
        console.error("Update Supplier Error:", e);
        return NextResponse.json({ error: "Error updating supplier", details: String(e) }, { status: 500 });
    }
}
