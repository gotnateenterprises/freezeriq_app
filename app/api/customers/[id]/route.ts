
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // 1. Try finding Organization (only if ID is UUID)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let org = null;

        if (isUuid) {
            org = await prisma.organization.findUnique({
                where: { id },
                include: {
                    orders: {
                        orderBy: { created_at: 'desc' },
                        include: {
                            items: {
                                include: { bundle: true }
                            }
                        }
                    }
                }
            });
        }

        if (org) {
            const orgAny = org as any;
            return NextResponse.json({
                id: org.id,
                name: org.name,
                type: org.type === 'direct_customer' ? 'Individual' : 'Organization',
                email: org.contact_email,
                // @ts-ignore
                phone: org.contact_phone,
                address: orgAny.shipping_address,
                notes: orgAny.notes || '',
                inactive_reason: orgAny.inactive_reason,
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orgAny.orders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                ),
                orders: orgAny.orders.map((o: any) => ({
                    id: o.external_id,
                    date: o.created_at,
                    total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(o.total_amount) || 0),
                    status: o.status,
                    items: o.items.map((i: any) => `${i.quantity}x ${i.bundle?.name}`).join(', ')
                }))
            });
        }

        // 2. Try finding Individual by Name (Mock ID mechanism)
        const encodedName = decodeURIComponent(id);
        const orders = await prisma.order.findMany({
            where: { customer_name: encodedName },
            orderBy: { created_at: 'desc' },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        if (orders.length > 0) {
            return NextResponse.json({
                id: encodedName,
                name: encodedName,
                type: 'Individual',
                email: null,
                notes: "Individual customer notes not supported in MVP Schema yet.",
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orders.reduce((sum: number, o: any) => sum + (Number((o as any).total_amount) || 0), 0)
                ),
                orders: orders.map(o => {
                    const oAny = o as any;
                    return {
                        id: o.external_id,
                        date: o.created_at,
                        total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(oAny.total_amount) || 0),
                        status: o.status,
                        items: oAny.items.map((i: any) => `${i.quantity}x ${i.bundle?.name}`).join(', ') || "No items"
                    };
                })
            });
        }

        return NextResponse.json({ error: "Customer not found" }, { status: 404 });

    } catch (e) {
        return NextResponse.json({ error: "Server Error" }, { status: 500 });
    }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;
        const body = await req.json();

        // Validate Status
        const status = ['Active', 'Lead', 'At-Risk', 'Inactive', 'Churned'].includes(body.status) ? body.status : undefined;

        // Check if ID is UUID
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        let orgId = id;

        if (!isUuid) {
            // Case: Promoting a "Manual" customer (Name) to an Organization Record
            const name = decodeURIComponent(id);

            // 1. Create (or find) Organization
            let org = await prisma.organization.findFirst({ where: { name: name } });

            if (!org) {
                // @ts-ignore
                org = await prisma.organization.create({
                    data: {
                        name: body.name || name,
                        type: 'direct_customer', // Default type for promoted individuals
                        contact_email: body.email,
                        // @ts-ignore
                        contact_phone: body.phone,
                        shipping_address: body.address,
                        notes: body.notes,
                        status: status,
                        // @ts-ignore
                        type: body.type === 'Individual' ? 'direct_customer' : 'fundraiser_org',
                        // @ts-ignore
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        tags: body.tags
                    }
                });
            } else {
                // Update existing if found
                await prisma.organization.update({
                    where: { id: org.id },
                    data: {
                        status: status,
                        // @ts-ignore
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        contact_email: body.email,
                        shipping_address: body.address,
                        notes: body.notes,
                        tags: body.tags
                    }
                });
            }

            orgId = org.id;

            // 2. Link existing orders to this new Org
            await prisma.order.updateMany({
                where: { customer_name: name, organization_id: null },
                data: { organization_id: org.id }
            });

        } else {
            // Standard Update for existing Org
            await prisma.organization.update({
                where: { id },
                data: {
                    name: body.name,
                    contact_email: body.email,
                    // @ts-ignore
                    contact_phone: body.phone,
                    shipping_address: body.address,
                    notes: body.notes,
                    status: status,
                    // @ts-ignore
                    type: body.type === 'Individual' ? 'direct_customer' : 'fundraiser_org',
                    // @ts-ignore
                    inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                    tags: body.tags
                }
            });
        }

        return NextResponse.json({ success: true, newId: orgId });
    } catch (e: any) {
        console.error("Update Error:", e);
        return NextResponse.json({ error: `Failed to update customer: ${e.message}` }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // Ensure it's a UUID (Organization)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        if (!isUuid) {
            return NextResponse.json({ error: "Cannot delete non-organization customers" }, { status: 400 });
        }

        // Check if exists
        const org = await prisma.organization.findUnique({ where: { id }, include: { orders: true } });
        if (!org) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

        if (org.orders.length > 0) {
            return NextResponse.json({ error: "Cannot delete customer with existing orders. Mark as Churned instead." }, { status: 400 });
        }

        await prisma.organization.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("Delete Error:", e);
        return NextResponse.json({ error: "Failed to delete customer" }, { status: 500 });
    }
}
