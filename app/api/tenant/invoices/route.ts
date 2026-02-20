
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { prisma } from '@/lib/db';

export async function GET() {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // @ts-ignore - Stale Prisma Client
        const invoices = await prisma.invoice.findMany({
            where: { business_id: businessId },
            include: {
                customer: {
                    select: { name: true, contact_email: true, delivery_address: true }
                },
                items: true
            },
            orderBy: { created_at: 'desc' }
        });

        return NextResponse.json(invoices);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch invoices' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
        body = await request.json();
        console.log('[API] POST Invoice Body:', JSON.stringify(body, null, 2));
        const {
            customer_id,
            items,
            total_amount,
            tax_amount,
            due_date,
            payment_method,
            status,
            fundraiser_profit_percent,
            fundraiser_profit_amount
        } = body;

        const result = await prisma.$transaction(async (tx) => {
            // @ts-ignore - New bundle_id field
            const invoice = await tx.invoice.create({
                data: {
                    business: { connect: { id: businessId } },
                    customer: { connect: { id: customer_id } },
                    total_amount,
                    tax_amount: tax_amount || 0,
                    due_date: due_date ? new Date(due_date) : null,
                    payment_method: payment_method || 'check',
                    status: status || 'PENDING',
                    fundraiser_profit_percent: fundraiser_profit_percent || 0,
                    fundraiser_profit_amount: fundraiser_profit_amount || 0,
                    items: {
                        create: items.map((item: any) => ({
                            bundle_id: item.bundle_id || null,
                            description: item.description,
                            quantity: item.quantity,
                            unit_price: item.unit_price,
                            total: item.total
                        }))
                    }
                },
                include: {
                    items: true,
                    customer: {
                        select: { name: true, contact_email: true, delivery_address: true, type: true }
                    }
                }
            });

            // AUTO-POPULATE ORDER
            // We only create an order if there are items linked to bundles
            const fulfillableItems = items.filter((i: any) => i.bundle_id);
            if (fulfillableItems.length > 0) {
                // @ts-ignore - New invoice_id field
                await tx.order.create({
                    data: {
                        external_id: `INV-${invoice.id.split('-')[0].toUpperCase()}`,
                        source: 'manual',
                        customer_name: invoice.customer.name,
                        customer_id: customer_id,
                        business_id: businessId,
                        invoice_id: invoice.id,
                        status: status === 'PAID' ? 'production_ready' : 'pending',
                        total_amount: total_amount,
                        delivery_address: invoice.customer.delivery_address,
                        items: {
                            create: fulfillableItems.map((i: any) => ({
                                bundle_id: i.bundle_id,
                                quantity: Math.floor(Number(i.quantity)),
                                variant_size: 'serves_5'
                            }))
                        }
                    }
                });
            }

            // If created as PAID, add loyalty points (Direct Customers/Orgs only)
            if (status === 'PAID' && invoice.customer.type !== 'fundraiser_org') {
                const points = Math.floor(Number(total_amount));
                // @ts-ignore - Stale Prisma Client
                await tx.loyaltyPoint.create({
                    data: {
                        customer_id,
                        points,
                        reason: `Invoice ${invoice.id}`
                    }
                });

                await tx.customer.update({
                    where: { id: customer_id },
                    data: {
                        // @ts-ignore - Stale Prisma Client
                        loyalty_balance: { increment: points }
                    }
                });
            }

            return invoice;
        });

        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Invoice Creation Error Full:', {
            message: error.message,
            stack: error.stack,
            body: body
        });
        return NextResponse.json({
            error: error.message || 'Unknown creation error',
            details: error.toString()
        }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    const session = await auth();
    const businessId = session?.user?.businessId;

    if (!businessId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body;
    try {
        body = await request.json();
        console.log('[API] PUT Invoice Body:', JSON.stringify(body, null, 2));
        const {
            id,
            customer_id,
            items,
            total_amount,
            tax_amount,
            due_date,
            payment_method,
            status,
            fundraiser_profit_percent,
            fundraiser_profit_amount
        } = body;

        if (!id) {
            return NextResponse.json({ error: 'Invoice ID is required' }, { status: 400 });
        }

        const result = await prisma.$transaction(async (tx) => {
            // Delete existing items
            // @ts-ignore
            await tx.invoiceItem.deleteMany({
                where: { invoice_id: id }
            });

            // Update invoice and recreate items
            // @ts-ignore
            const invoice = await tx.invoice.update({
                where: { id, business_id: businessId },
                data: {
                    customer: { connect: { id: customer_id } },
                    total_amount,
                    tax_amount: tax_amount || 0,
                    due_date: due_date ? new Date(due_date) : null,
                    payment_method: payment_method || 'check',
                    status: status || 'PENDING',
                    fundraiser_profit_percent: fundraiser_profit_percent || 0,
                    fundraiser_profit_amount: fundraiser_profit_amount || 0,
                    items: {
                        create: items.map((item: any) => ({
                            bundle_id: item.bundle_id || null,
                            description: item.description,
                            quantity: item.quantity,
                            unit_price: item.unit_price,
                            total: item.total
                        }))
                    }
                },
                include: {
                    items: true,
                    customer: {
                        select: { name: true, contact_email: true, delivery_address: true, type: true }
                    },
                    order: true
                }
            });

            // SYNC LINKED ORDER
            const fulfillableItems = items.filter((i: any) => i.bundle_id);
            // @ts-ignore
            const existingOrder = invoice.order;

            if (existingOrder) {
                if (fulfillableItems.length > 0) {
                    // Update existing order items
                    await tx.orderItem.deleteMany({ where: { order_id: existingOrder.id } });
                    await tx.order.update({
                        where: { id: existingOrder.id },
                        data: {
                            total_amount,
                            status: status === 'PAID' ? 'production_ready' : existingOrder.status,
                            items: {
                                create: fulfillableItems.map((i: any) => ({
                                    bundle_id: i.bundle_id,
                                    quantity: Math.floor(Number(i.quantity)),
                                    variant_size: 'serves_5'
                                }))
                            }
                        }
                    });
                } else {
                    // If no fulfillable items left, maybe delete order? 
                    // For now, keep it but empty.
                    await tx.orderItem.deleteMany({ where: { order_id: existingOrder.id } });
                    await tx.order.update({
                        where: { id: existingOrder.id },
                        data: { total_amount: 0 }
                    });
                }
            } else if (fulfillableItems.length > 0) {
                // Create new order if it didn't exist
                // @ts-ignore
                await tx.order.create({
                    data: {
                        external_id: `INV-${invoice.id.split('-')[0].toUpperCase()}`,
                        source: 'manual',
                        customer_name: invoice.customer.name,
                        customer_id: customer_id,
                        business_id: businessId,
                        // @ts-ignore - New invoice_id field
                        invoice_id: invoice.id,
                        status: status === 'PAID' ? 'production_ready' : 'pending',
                        total_amount: total_amount,
                        delivery_address: invoice.customer.delivery_address,
                        items: {
                            create: fulfillableItems.map((i: any) => ({
                                bundle_id: i.bundle_id,
                                quantity: Math.floor(Number(i.quantity)),
                                variant_size: 'serves_5'
                            }))
                        }
                    }
                });
            }

            // If updated to PAID, add loyalty points (Direct Customers/Orgs only)
            if (status === 'PAID' && invoice.customer.type !== 'fundraiser_org') {
                const points = Math.floor(Number(total_amount));
                // Check if points already awarded? 
                // For simplicity, typically we'd check if a LoyaltyPoint record exists for this invoice.
                const existingPoints = await tx.loyaltyPoint.findFirst({
                    where: { reason: `Invoice ${invoice.id}` }
                });

                if (!existingPoints) {
                    await tx.loyaltyPoint.create({
                        data: {
                            customer_id,
                            points,
                            reason: `Invoice ${invoice.id}`
                        }
                    });

                    await tx.customer.update({
                        where: { id: customer_id },
                        data: {
                            loyalty_balance: { increment: points }
                        }
                    });
                }
            }

            return invoice;
        });

        return NextResponse.json(result);
    } catch (error: any) {
        console.error('Invoice Update Error Full:', {
            message: error.message,
            stack: error.stack,
            body: body
        });
        return NextResponse.json({
            error: error.message || 'Unknown update error',
            details: error.toString()
        }, { status: 500 });
    }
}
