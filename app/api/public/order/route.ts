import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { items, customer, businessId, slug, campaignId } = body;

        if (!items || items.length === 0) {
            return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
        }

        if (!customer || !customer.email || !customer.name) {
            return NextResponse.json({ error: "Customer details required" }, { status: 400 });
        }

        // 1. Validate Business
        const business = await prisma.business.findUnique({
            where: { id: businessId }
        });

        if (!business) {
            return NextResponse.json({ error: "Business not found" }, { status: 404 });
        }

        // 1.5 Fetch Campaign & Org Details (if campaignId provided)
        let campaign: any = null;
        let orgContactEmail: string | null = null;
        let paymentInstructions: string | null = null;
        let externalPaymentLink: string | null = null;
        let orgName: string | null = null;

        if (campaignId) {
            campaign = await prisma.fundraiserCampaign.findUnique({
                where: { id: campaignId },
                include: { customer: true } // Get the Organization customer
            });

            if (campaign) {
                // @ts-ignore - Schema fields exist
                paymentInstructions = campaign.payment_instructions;
                // @ts-ignore
                externalPaymentLink = campaign.external_payment_link;
                orgName = campaign.customer?.name || null;

                if (campaign.customer?.contact_email) {
                    orgContactEmail = campaign.customer.contact_email;
                }
            }
        }

        // 2. Find or Create Customer (Individual)
        // We try to find by email AND type='Individual' to avoid mixing with Org contacts
        let dbCustomer = await prisma.customer.findFirst({
            where: {
                business_id: businessId,
                contact_email: customer.email,
                type: 'direct_customer' // Enum value for Individual
            }
        });

        const formattedAddress = customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : null;

        if (!dbCustomer) {
            // Create new "Lead" customer
            dbCustomer = await prisma.customer.create({
                data: {
                    business_id: businessId,
                    name: customer.name,
                    contact_email: customer.email,
                    contact_phone: customer.phone,
                    delivery_address: formattedAddress,
                    type: 'direct_customer',
                    status: 'LEAD',
                    source: campaignId ? 'Fundraiser' : 'Storefront',
                    notes: `Created via ${campaignId ? 'Fundraiser' : 'Storefront'} Order.${campaign ? ` Campaign: ${campaign.name}` : ''}`,
                    external_id: `sf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
                }
            });

            // Trigger lead notification to business owner
            const owner = await prisma.user.findFirst({
                where: { business_id: businessId }
            });
            if (owner?.email) {
                const { sendLeadNotificationEmail } = await import('@/lib/email');
                await sendLeadNotificationEmail(owner.email, {
                    name: customer.name,
                    email: customer.email,
                    phone: customer.phone,
                    source: campaignId ? 'Fundraiser' : 'Storefront'
                });
            }
        } else if (formattedAddress && dbCustomer.delivery_address !== formattedAddress) {
            // Update existing customer with new address if it changed or was empty
            dbCustomer = await prisma.customer.update({
                where: { id: dbCustomer.id },
                data: { delivery_address: formattedAddress, contact_phone: customer.phone } // Opportunistically update phone as well
            });
        }

        // 3. Create Order
        const order = await prisma.order.create({
            data: {
                business_id: businessId,
                customer_id: dbCustomer.id,
                customer_name: customer.name,
                participant_name: customer.participantCode || null,
                // @ts-ignore - 'storefront' was just added to enum
                source: 'storefront',
                status: 'pending',
                total_amount: items.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0),
                delivery_address: customer.address ? `${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}` : customer.notes,
                external_id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                campaign_id: campaignId || null,
                items: {
                    create: items.map((item: any) => ({
                        bundle_id: (item.bundleId === 'manual_upsell' || !item.bundleId) ? null : item.bundleId,
                        quantity: item.quantity,
                        variant_size: item.serving_tier === 'Family Size' ? 'serves_5' : 'serves_2',
                        item_name: item.name,
                        unit_price: item.price,
                        is_subscription: !!item.isSubscription
                    }))
                }
            },
            include: {
                items: {
                    include: { bundle: true }
                }
            }
        });

        // 4. Update Stock (Simple subtraction for Bundles only)
        for (const item of items) {
            if (item.bundleId && item.bundleId !== 'manual_upsell') {
                await prisma.bundle.update({
                    where: { id: item.bundleId },
                    data: {
                        stock_on_hand: {
                            decrement: item.quantity
                        }
                    } as any // Cast to any to avoid partial type mismatch on Decimal decrement
                });
            }
        }

        // 5. Send Confirmation Email
        // Import dynamically to avoid circular deps if any, though likely fine
        const { sendOrderConfirmationEmail } = await import('@/lib/email');
        await sendOrderConfirmationEmail(
            customer.email,
            order,
            (order as any).items, // Cast to any because TS isn't inferring the include 
            orgContactEmail,
            paymentInstructions,
            externalPaymentLink
        );

        return NextResponse.json({
            success: true,
            orderId: order.id,
            paymentData: {
                paymentInstructions,
                externalPaymentLink,
                orgName
            }
        });

    } catch (e: any) {
        console.error("Failed to place storefront order:", e);
        return NextResponse.json({ error: e.message || "Internal Server Error" }, { status: 500 });
    }
}
