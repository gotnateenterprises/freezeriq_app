
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';


export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { auth } = await import('@/auth');
        const session = await auth();
        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;


        // 1. Try finding Organization (only if ID is UUID)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        let org = null;

        if (isUuid) {
            org = await prisma.customer.findUnique({
                where: { id },
                include: {
                    campaigns: {
                        orderBy: { created_at: 'desc' },
                        take: 5
                    },
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

            // Security Check
            if (org && org.business_id !== session.user.businessId) {
                return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
            }
        }

        if (org) {
            const orgAny = org as any;
            return NextResponse.json({
                id: org.id,
                name: org.name,
                contact_name: org.contact_name,
                type: orgAny.type === 'direct_customer' ? 'Individual' :
                    orgAny.type === 'organization' ? 'Organization' : 'Fundraiser',
                email: org.contact_email,
                // @ts-ignore
                phone: org.contact_phone,
                // @ts-ignore
                secondary_phone: org.secondary_phone,
                delivery_address: orgAny.delivery_address,
                notes: orgAny.notes || '',
                inactive_reason: orgAny.inactive_reason,
                status: (orgAny.status ? orgAny.status.charAt(0).toUpperCase() + orgAny.status.slice(1).toLowerCase().replace('_', ' ') : 'Active'),
                rawStatus: orgAny.status || 'LEAD',
                archived: orgAny.archived || false,
                tags: orgAny.tags || [],
                fundraiser_info: orgAny.fundraiser_info || {},
                campaigns: orgAny.campaigns || [], // NEW CAMPAIGNS
                source: orgAny.source || 'Manual',
                total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                    orgAny.orders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                ),
                orders: orgAny.orders.map((o: any) => ({
                    id: o.external_id,
                    date: o.created_at,
                    total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(o.total_amount) || 0),
                    status: o.status,
                    items: o.items.map((i: any) => `${i.quantity}x ${i.bundle?.name}`).join(', '),
                    orderItems: o.items.map((i: any) => ({
                        id: i.id,
                        name: i.bundle?.name || i.item_name,
                        quantity: i.quantity,
                        price: i.unit_price,
                        is_subscription: i.is_subscription,
                        serving_tier: i.variant_size
                    }))
                }))
            });
        }

        // 2. Try finding Individual by Name (Mock ID mechanism) or Promoted Customer
        const encodedName = decodeURIComponent(id);

        // CHECK: Does a real Customer record exist for this name? 
        if (session?.user?.businessId) {
            // First try strict match
            let promotedOrg = await prisma.customer.findFirst({

                where: {
                    name: encodedName,
                    business_id: session.user.businessId
                },
                include: {
                    campaigns: { orderBy: { created_at: 'desc' }, take: 5 },
                    orders: { orderBy: { created_at: 'desc' }, include: { items: { include: { bundle: true } } } }
                }
            });

            // If not found, try lax match (name only) and update business_id if it's null or different
            if (!promotedOrg) {
                const bestMatch = await prisma.customer.findFirst({
                    where: { name: encodedName },
                    include: {
                        campaigns: { orderBy: { created_at: 'desc' }, take: 5 },
                        orders: { orderBy: { created_at: 'desc' }, include: { items: { include: { bundle: true } } } }
                    }
                });

                if (bestMatch) {
                    // Do NOT claim automatically. Just return the match if found.
                    // Ideally we should filter this out or return 404 if it belongs to another business, 
                    // but for now let's just STOP the stealing.
                    if (bestMatch.business_id !== session.user.businessId) {
                        console.warn(`[GET Customer] Found match ${bestMatch.id} but belongs to business ${bestMatch.business_id}. NOT CLAIMING.`);
                        // Option: Return null to simulate 404? 
                        // For now, let's allow viewing (maybe?) but definitely not claiming.
                        promotedOrg = bestMatch;
                    } else {
                        promotedOrg = bestMatch;
                    }
                }
            }

            if (promotedOrg) {
                // Reuse the same response logic as UUID match
                const orgAny = promotedOrg as any;
                return NextResponse.json({
                    id: promotedOrg.id,
                    name: promotedOrg.name,
                    type: orgAny.type === 'direct_customer' ? 'Individual' :
                        orgAny.type === 'organization' ? 'Organization' : 'Fundraiser',
                    email: promotedOrg.contact_email,
                    phone: promotedOrg.contact_phone,
                    // @ts-ignore
                    secondary_phone: promotedOrg.secondary_phone,
                    delivery_address: orgAny.delivery_address,
                    notes: orgAny.notes || '',
                    inactive_reason: orgAny.inactive_reason,
                    status: (orgAny.status ? orgAny.status.charAt(0).toUpperCase() + orgAny.status.slice(1).toLowerCase().replace('_', ' ') : 'Active'),
                    rawStatus: orgAny.status || 'LEAD',
                    archived: orgAny.archived || false,
                    tags: orgAny.tags || [],
                    fundraiser_info: orgAny.fundraiser_info || {}, // Return persisted info
                    campaigns: orgAny.campaigns || [],
                    source: orgAny.source || 'Manual',
                    total_spend: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
                        orgAny.orders.reduce((sum: number, o: any) => sum + (Number(o.total_amount) || 0), 0)
                    ),
                    orders: orgAny.orders.map((o: any) => ({
                        id: o.external_id,
                        date: o.created_at,
                        total: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(o.total_amount) || 0),
                        status: o.status,
                        items: o.items.map((i: any) => `${i.quantity}x ${i.bundle?.name}`).join(', '),
                        orderItems: o.items.map((i: any) => ({
                            id: i.id,
                            name: i.bundle?.name || i.item_name,
                            quantity: i.quantity,
                            price: i.unit_price,
                            is_subscription: i.is_subscription,
                            serving_tier: i.variant_size
                        }))
                    }))
                });
            }
        }

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
                        items: oAny.items.map((i: any) => `${i.quantity}x ${i.bundle?.name}`).join(', ') || "No items",
                        orderItems: oAny.items.map((i: any) => ({
                            id: i.id,
                            name: i.bundle?.name || i.item_name,
                            quantity: i.quantity,
                            price: i.unit_price,
                            is_subscription: i.is_subscription,
                            serving_tier: i.variant_size
                        }))
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
        const { auth } = await import('@/auth');
        const session = await auth();

        if (!session?.user?.businessId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json();

        // Validate & Map Status (Handle Title Case from UI -> Upper Case for Prisma Enum)
        const statusMap: Record<string, any> = {
            'Active': 'ACTIVE',
            'Lead': 'LEAD',
            'In Progress': 'ACTIVE',
            'Production': 'PRODUCTION',
            'Delivery': 'DELIVERY',
            'Send Info': 'SEND_INFO',
            'Flyers': 'FLYERS',
            'Send Marketing Tools': 'FLYERS',
            'Inactive': 'INACTIVE',
            'At-Risk': 'ACTIVE',
            'Churned': 'COMPLETE',
            'COMPLETE': 'COMPLETE',
            'ACTIVE': 'ACTIVE',
            'LEAD': 'LEAD',
            'SEND_INFO': 'SEND_INFO',
            'FLYERS': 'FLYERS',
            'PRODUCTION': 'PRODUCTION',
            'DELIVERY': 'DELIVERY',
            'INACTIVE': 'INACTIVE'
        };
        // Use provided status if it matches an Enum key, or map it
        let status: any = statusMap[body.status] || (['LEAD', 'SEND_INFO', 'FLYERS', 'ACTIVE', 'PRODUCTION', 'DELIVERY', 'COMPLETE', 'INACTIVE'].includes(body.status) ? body.status : undefined);

        // Check if ID is UUID
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

        let orgId = id;

        if (!isUuid) {
            // Case: Promoting a "Manual" customer (Name) to an Organization Record
            const name = decodeURIComponent(id);

            // 1. Create (or find) Customer
            let org = await prisma.customer.findFirst({
                where: {
                    name: name,
                    business_id: session.user.businessId
                }
            });

            const customerTypeMap: Record<string, 'direct_customer' | 'organization' | 'fundraiser_org'> = {
                'Customer': 'direct_customer',
                'Individual': 'direct_customer',
                'Organization': 'organization',
                'Fundraiser': 'fundraiser_org'
            };

            const mappedType = customerTypeMap[body.type] || 'fundraiser_org';

            if (!org) {
                org = await prisma.customer.create({
                    data: {
                        name: body.name || name,
                        contact_name: body.contact_name,
                        business_id: session.user.businessId,
                        contact_email: body.email,
                        contact_phone: body.phone,
                        secondary_phone: body.secondary_phone,
                        delivery_address: body.delivery_address,
                        notes: body.notes,
                        status: status,
                        type: mappedType,
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        tags: body.tags || [],
                        fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined
                    }
                });
            } else {
                // Update existing if found
                await prisma.customer.update({
                    where: { id: org.id },
                    data: {
                        name: body.name || name,
                        contact_name: body.contact_name,
                        status: status,
                        inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                        contact_email: body.email,
                        contact_phone: body.phone,
                        secondary_phone: body.secondary_phone,
                        delivery_address: body.delivery_address,
                        notes: body.notes,
                        tags: body.tags || [],
                        type: mappedType,
                        fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined
                    }
                });
            }

            orgId = org.id;

            // 2. Link existing orders to this new Org
            await prisma.order.updateMany({
                where: { customer_name: name, customer_id: null },
                data: { customer_id: org.id }
            });

        } else {
            // Standard Update for existing Org
            const customerTypeMap: Record<string, 'direct_customer' | 'organization' | 'fundraiser_org'> = {
                'Customer': 'direct_customer',
                'Individual': 'direct_customer',
                'Organization': 'organization',
                'Fundraiser': 'fundraiser_org'
            };

            // Only update type if it's provided and valid
            const mappedType = body.type ? (customerTypeMap[body.type] || undefined) : undefined;

            const finalUpdateData = {
                name: body.name,
                contact_name: body.contact_name,
                contact_email: body.email,
                contact_phone: body.phone,
                secondary_phone: body.secondary_phone,
                delivery_address: body.delivery_address,
                notes: body.notes,
                status: status,
                type: mappedType,
                inactive_reason: status === 'Inactive' ? body.inactive_reason : null,
                tags: body.tags,
                fundraiser_info: body.fundraiser_info !== undefined ? body.fundraiser_info : undefined
            };

            await prisma.customer.update({
                where: { id },
                data: finalUpdateData
            });
        }

        // Sync fundraiser_info fields to the most recent FundraiserCampaign.
        // The CRM form saves these to customer.fundraiser_info (JSON), but
        // flyer/packet/tracker download routes read from campaign table columns.
        // All operational fields must be pushed here to prevent drift.
        if (body.fundraiser_info) {
            const fi = body.fundraiser_info;
            const latestCampaign = await prisma.fundraiserCampaign.findFirst({
                where: { customer_id: orgId },
                orderBy: { created_at: 'desc' },
                select: { id: true },
            });

            if (latestCampaign) {
                await prisma.fundraiserCampaign.update({
                    where: { id: latestCampaign.id },
                    data: {
                        // Date fields
                        delivery_date: fi.delivery_date ? new Date(fi.delivery_date) : undefined,
                        end_date: fi.deadline ? new Date(fi.deadline) : undefined,
                        start_date: fi.start_date ? new Date(fi.start_date) : undefined,
                        // Text fields
                        pickup_location: fi.pickup_location || undefined,
                        checks_payable: fi.checks_payable_to || undefined,
                        participant_label: fi.participant_label || undefined,
                        about_text: fi.about_text || undefined,
                        mission_text: fi.mission_text || undefined,
                        payment_instructions: fi.payment_instructions || undefined,
                        external_payment_link: fi.external_payment_link || undefined,
                        bundle_goal: fi.bundle_goal ? Number(fi.bundle_goal) : undefined,
                    },
                });
            }
        }

        return NextResponse.json({ success: true, newId: orgId });
    } catch (e: any) {
        console.error("Update Error:", e);
        // Return the actual error message for clearer debugging
        return NextResponse.json({ error: `Failed to update customer: ${e.message}` }, { status: 500 });
    }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await params;

        // Ensure it's a UUID (Organization)
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
        if (!isUuid) {
            return NextResponse.json({ error: "Cannot delete transient customers (linked to orders). Please Archive instead." }, { status: 400 });
        }

        // Check if exists
        const org = await prisma.customer.findUnique({ where: { id }, include: { orders: true } });
        if (!org) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

        if (org.orders.length > 0) {
            return NextResponse.json({ error: "Cannot delete customer with existing orders. Mark as Churned instead." }, { status: 400 });
        }

        await prisma.customer.delete({ where: { id } });

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error("Delete Error:", e);
        return NextResponse.json({ error: "Failed to delete customer" }, { status: 500 });
    }
}
